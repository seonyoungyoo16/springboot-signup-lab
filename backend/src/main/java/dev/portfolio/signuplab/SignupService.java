package dev.portfolio.signuplab;

import static dev.portfolio.signuplab.Db.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.Semaphore;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;

@Service
public class SignupService {
  public record Outcome(int status, Map<String, Object> body) {}

  public record Complete(
      String name,
      String password,
      String confirmation,
      boolean terms,
      boolean marketing,
      int termsVersion,
      String idempotencyKey) {}

  private final Db db;
  private final Crypto crypto;
  private final Runs runs;
  private final Limiter limiter;
  private final TraceLog trace;
  private final Faults faults;
  private final ObjectMapper json;
  private final Semaphore hashing = new Semaphore(4);

  public SignupService(
      Db db,
      Crypto crypto,
      Runs runs,
      Limiter limiter,
      TraceLog trace,
      Faults faults,
      ObjectMapper json) {
    this.db = db;
    this.crypto = crypto;
    this.runs = runs;
    this.limiter = limiter;
    this.trace = trace;
    this.faults = faults;
    this.json = json;
  }

  public String json(Object value) {
    try {
      return json.writeValueAsString(value);
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  public Map<String, Object> parse(Object value) {
    try {
      return json.readValue(value.toString(), Map.class);
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  public static String key(String key) {
    if (key == null || !key.matches("[A-Za-z0-9_-]{8,80}"))
      throw new Failure(400, "IDEMPOTENCY_KEY_REQUIRED", "요청의 고정 멱등 키가 필요합니다.");
    return key;
  }

  public Map<String, Object> flow(HttpServletRequest req, String run, boolean lock, boolean open) {
    String cookie = Contexts.cookie(req, Contexts.FLOW);
    if (cookie == null || !cookie.matches("[A-Za-z0-9_-]{43}"))
      throw new Failure(404, "FLOW_REQUIRED", "가입을 시작한 브라우저에서 진행해 주세요.");
    var f =
        db.one(
            "SELECT * FROM signup_flows WHERE realm_id=? AND cookie_hash=?"
                + (lock ? " FOR UPDATE" : ""),
            run,
            Crypto.hash(cookie));
    if (f == null) throw new Failure(403, "FLOW_OWNER_MISMATCH", "가입을 시작한 브라우저에서 링크를 열어 주세요.");
    if (!time(f, "expires_at").isAfter(db.now()))
      throw new Failure(410, "FLOW_EXPIRED", "가입 흐름이 만료되었습니다. 새로 시작해 주세요.");
    if ("CANCELLED".equals(f.get("status")))
      throw new Failure(410, "FLOW_CANCELLED", "종료된 가입 흐름입니다.");
    if (open && !"OPEN".equals(f.get("status")))
      throw new Failure(409, "FLOW_COMPLETED", "이미 완료한 가입 흐름입니다. 결과를 확인해 주세요.");
    return f;
  }

  // flow:SignupService.create
  public Map<String, Object> create(HttpServletRequest req, HttpServletResponse res, String run) {
    Policy p = runs.policy(run);
    limiter.ping();
    String secret = crypto.random();
    UUID id = UUID.randomUUID();
    db.tx.executeWithoutResult(
        t -> {
          String old = Contexts.cookie(req, Contexts.FLOW);
          if (old != null)
            db.sql.update(
                "UPDATE signup_flows SET status='CANCELLED' WHERE realm_id=? AND cookie_hash=? AND status='OPEN'",
                run,
                Crypto.hash(old));
          db.sql.update(
              "INSERT INTO signup_flows(id,realm_id,cookie_hash,expires_at) VALUES(?,?,?,?)",
              id,
              run,
              Crypto.hash(secret),
              stamp(db.now().plusSeconds(p.flow())));
        });
    Contexts.cookie(res, Contexts.FLOW, secret, p.flow());
    trace.step("DB", "flow_created", "인증 권한 없는 독립 가입 흐름 준비", "SignupService.create");
    return status(req, run, id);
  }

  public void audit(String run, String event, String outcome) {
    db.sql.update(
        "INSERT INTO account_audit_events(id,realm_id,request_id,event,outcome) VALUES(?,?,?,?,?)",
        UUID.randomUUID(),
        run,
        trace.id(),
        event,
        outcome);
  }

  private Outcome existing(UUID flow, String operation, String idem, String fingerprint) {
    var result =
        db.one(
            "SELECT * FROM signup_operation_results WHERE flow_id=? AND operation=? AND idem_key=?",
            flow,
            operation,
            idem);
    if (result == null) return null;
    if (!Crypto.equal(fingerprint, result.get("request_hmac").toString()))
      throw new Failure(409, "IDEMPOTENCY_KEY_REUSED", "같은 요청 키에 다른 입력을 사용할 수 없습니다.");
    var body = parse(result.get("outcome"));
    body.put("replayed", true);
    return new Outcome(
        operation.equals("complete") && number(result, "status") == 201
            ? 200
            : (int) number(result, "status"),
        body);
  }

  private void result(UUID flow, String operation, String idem, String fingerprint, Outcome value) {
    db.sql.update(
        "INSERT INTO signup_operation_results(flow_id,operation,idem_key,request_hmac,status,outcome) VALUES(?,?,?,?,?,?::jsonb)",
        flow,
        operation,
        idem,
        fingerprint,
        value.status(),
        json(value.body()));
  }

  // flow:SignupService.requestEmail
  public Outcome requestEmail(HttpServletRequest req, String run, String original, String idem) {
    String email = Crypto.email(original);
    key(idem);
    var f = flow(req, run, false, true);
    UUID fid = uuid(f, "id");
    String fp = crypto.hmac("idempotency", "email\0" + email);
    var old = existing(fid, "email", idem, fp);
    if (old != null) return old;
    Policy p = runs.policy(run);
    limiter.limit(
        run,
        "ip",
        Optional.ofNullable(req.getHeader("X-Lab-Client-IP")).orElse("loopback"),
        p.ipMax(),
        Math.min(p.rateWindow(), 600));
    limiter.limit(run, "email", email, p.emailMax(), p.rateWindow());
    return db.tx.execute(
        t -> {
          var row = flow(req, run, true, true);
          Outcome replay = existing(fid, "email", idem, fp);
          if (replay != null) return replay;
          Instant now = db.now(), last = time(row, "last_issued_at");
          if (last != null && last.plusSeconds(p.cooldown()).isAfter(now))
            throw new Failure(
                429,
                "RESEND_COOLDOWN",
                "재발송 가능 시간이 지나면 다시 시도해 주세요.",
                Math.max(
                    1,
                    java.time.Duration.between(now, last.plusSeconds(p.cooldown())).toSeconds()
                        + 1));
          if (number(row, "issued_count") >= p.mailMax())
            throw new Failure(
                429,
                "FLOW_MAIL_LIMIT",
                "이 가입 흐름의 발급 한도에 도달했습니다.",
                Math.max(
                    1, java.time.Duration.between(now, time(row, "expires_at")).toSeconds() + 1));
          int generation = (int) number(row, "generation") + 1;
          UUID cid = UUID.randomUUID(), mid = UUID.randomUUID();
          String token = crypto.random();
          Instant end = min(now.plusSeconds(p.link()), time(row, "expires_at"));
          db.sql.update(
              "UPDATE email_challenges SET state='SUPERSEDED' WHERE flow_id=? AND state='ACTIVE'",
              fid);
          db.sql.update(
              "UPDATE signup_flows SET email_original=?,email_key=?,generation=?,issued_count=issued_count+1,last_issued_at=?,verified_at=NULL,verified_until=NULL,proof_source=NULL WHERE id=?",
              original.strip(),
              email,
              generation,
              stamp(now),
              fid);
          db.sql.update(
              "INSERT INTO email_challenges(id,flow_id,generation,email_key,token_hash,expires_at) VALUES(?,?,?,?,?,?)",
              cid,
              fid,
              generation,
              email,
              Crypto.hash(token),
              stamp(end));
          String payload =
              crypto.encrypt(
                  "mail",
                  mid.toString(),
                  json(
                      map(
                          "to",
                          Crypto.deliveryEmail(original),
                          "url",
                          "https://localhost:8470/?run=" + run + "#verify=" + cid + "." + token)));
          db.sql.update(
              "INSERT INTO mail_outbox(id,realm_id,flow_id,generation,payload_ciphertext,expires_at) VALUES(?,?,?,?,?,?)",
              mid,
              run,
              fid,
              generation,
              payload,
              stamp(end));
          Outcome value =
              new Outcome(
                  202,
                  map(
                      "code",
                      "REQUEST_ACCEPTED",
                      "generation",
                      generation,
                      "linkExpiresAt",
                      end.toString(),
                      "resendAt",
                      now.plusSeconds(p.cooldown()).toString(),
                      "message",
                      "메일 요청을 접수했습니다. 실제 수신함에서 확인해 주세요."));
          result(fid, "email", idem, fp, value);
          audit(run, "EMAIL_REQUESTED", "QUEUED");
          faults.check(run, "before-email-commit");
          db.committed(
              () ->
                  trace.step(
                      "DB",
                      "email_committed",
                      "확인 토큰 해시와 암호화한 메일 작업을 같은 트랜잭션에 저장",
                      "SignupService.requestEmail"));
          return value;
        });
  }

  // flow:SignupService.change
  public Map<String, Object> change(HttpServletRequest req, String run, String email) {
    String normalized = Crypto.email(email);
    db.tx.executeWithoutResult(
        t -> {
          var f = flow(req, run, true, true);
          db.sql.update(
              "UPDATE signup_flows SET email_original=?,email_key=?,generation=generation+1,verified_at=NULL,verified_until=NULL,proof_source=NULL WHERE id=?",
              email.strip(),
              normalized,
              uuid(f, "id"));
          db.sql.update(
              "UPDATE email_challenges SET state='SUPERSEDED' WHERE flow_id=? AND state='ACTIVE'",
              uuid(f, "id"));
        });
    trace.step("DB", "email_changed", "주소 변경으로 이전 확인 증명과 링크 무효화", "SignupService.change");
    return map("code", "EMAIL_CHANGED");
  }

  // flow:SignupService.verify
  public Map<String, Object> verify(HttpServletRequest req, String run, String token) {
    var before = flow(req, run, false, true);
    limiter.ping();
    Policy p = runs.policy(run);
    if (token == null || !token.matches("[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}")) {
      limiter.limit(run, "verify-failure", before.get("id").toString(), 5, p.rateWindow());
      throw new Failure(400, "INVALID_CHALLENGE", "확인 링크가 올바르지 않습니다.");
    }
    String[] parts = token.split("\\.", 2);
    return db.tx.execute(
        t -> {
          var f = flow(req, run, true, true);
          var c =
              db.one(
                  "SELECT * FROM email_challenges WHERE id=? AND flow_id=? FOR UPDATE",
                  id(parts[0]),
                  uuid(f, "id"));
          if (c == null || !Crypto.equal(Crypto.hash(parts[1]), c.get("token_hash").toString())) {
            limiter.limit(run, "verify-failure", f.get("id").toString(), 5, p.rateWindow());
            throw new Failure(403, "CHALLENGE_INVALID", "확인 링크가 현재 가입 흐름과 일치하지 않습니다.");
          }
          Instant now = db.now();
          if ("CONSUMED".equals(c.get("state"))
              && number(c, "generation") == number(f, "generation")
              && time(f, "verified_until") != null
              && time(f, "verified_until").isAfter(now))
            return map("code", "EMAIL_VERIFIED", "alreadyVerified", true);
          if (!"ACTIVE".equals(c.get("state"))
              || number(c, "generation") != number(f, "generation")
              || !c.get("email_key").equals(f.get("email_key"))
              || !time(c, "expires_at").isAfter(now))
            throw new Failure(410, "CHALLENGE_EXPIRED", "만료되었거나 이전 세대의 링크입니다.");
          Instant end = min(now.plusSeconds(p.proof()), time(f, "expires_at"));
          db.sql.update(
              "UPDATE email_challenges SET state='CONSUMED',consumed_at=? WHERE id=?",
              stamp(now),
              uuid(c, "id"));
          db.sql.update(
              "UPDATE signup_flows SET verified_at=?,verified_until=?,proof_source='EMAIL' WHERE id=?",
              stamp(now),
              stamp(end),
              uuid(f, "id"));
          audit(run, "EMAIL_VERIFIED", "SUCCESS");
          db.committed(
              () ->
                  trace.step(
                      "DB",
                      "email_verified",
                      "토큰 소비와 현재 이메일 소유 확인을 한 번에 커밋",
                      "SignupService.verify"));
          return map("code", "EMAIL_VERIFIED", "verifiedUntil", end.toString());
        });
  }

  public static Instant min(Instant a, Instant b) {
    return a.isBefore(b) ? a : b;
  }

  public Map<String, Object> providerProof(Map<String, Object> f) {
    if (f.get("provider_transaction_id") == null) return null;
    var tx =
        db.one(
            "SELECT * FROM oidc_transactions WHERE id=? AND flow_id=? AND status='VERIFIED'",
            uuid(f, "provider_transaction_id"),
            uuid(f, "id"));
    if (tx == null || time(tx, "proof_until") == null || !time(tx, "proof_until").isAfter(db.now()))
      return null;
    return parse(tx.get("proof"));
  }

  // flow:SignupService.complete
  public Outcome complete(HttpServletRequest req, String run, Complete body, boolean oidc) {
    key(body.idempotencyKey());
    var before = flow(req, run, false, false);
    UUID fid = uuid(before, "id");
    String fp =
        crypto.hmac(
            "idempotency",
            json(
                map(
                    "name",
                    body.name(),
                    "password",
                    body.password(),
                    "confirmation",
                    body.confirmation(),
                    "terms",
                    body.terms(),
                    "marketing",
                    body.marketing(),
                    "termsVersion",
                    body.termsVersion(),
                    "oidc",
                    oidc)));
    Outcome prior = existing(fid, "complete", body.idempotencyKey(), fp);
    if (prior != null) return prior;
    if (!"OPEN".equals(before.get("status")))
      throw new Failure(409, "FLOW_COMPLETED", "기존 완료 결과를 확인해 주세요.");
    if (body.name() == null || body.name().isBlank() || body.name().length() > 60)
      throw new Failure(400, "INVALID_NAME", "표시 이름은 1~60자로 입력해 주세요.");
    if (!body.terms()) throw new Failure(400, "TERMS_REQUIRED", "필수 동의가 필요합니다.");
    limiter.ping();
    String encoded = null;
    if (!oidc) {
      crypto.password(body.password());
      if (!Objects.equals(body.password(), body.confirmation()))
        throw new Failure(400, "PASSWORD_MISMATCH", "비밀번호 확인이 일치하지 않습니다.");
      if (!hashing.tryAcquire()) throw new Failure(429, "HASH_CAPACITY", "비밀번호 검증 자원이 사용 중입니다.");
      try {
        encoded = crypto.encode(body.password());
      } finally {
        hashing.release();
      }
    }
    String hash = encoded;
    try {
      return db.tx.execute(
          t -> {
            var f = flow(req, run, true, false);
            Outcome old = existing(fid, "complete", body.idempotencyKey(), fp);
            if (old != null) return old;
            if (!"OPEN".equals(f.get("status")))
              throw new Failure(409, "FLOW_COMPLETED", "이미 가입이 완료되었습니다.");
            Instant now = db.now();
            if (time(f, "verified_until") == null || !time(f, "verified_until").isAfter(now))
              throw new Failure(403, "EMAIL_VERIFICATION_REQUIRED", "현재 이메일을 다시 확인해 주세요.");
            if (number(runs.row(run), "terms_version") != body.termsVersion())
              throw new Failure(409, "TERMS_UPDATED", "최신 필수 약관에 다시 동의해 주세요.");
            Map<String, Object> proof = oidc ? providerProof(f) : null;
            if (oidc && proof == null)
              throw new Failure(403, "PROVIDER_PROOF_REQUIRED", "외부 인증을 다시 진행해 주세요.");
            if (!oidc && "OIDC".equals(f.get("intent")))
              throw new Failure(409, "INTENT_MISMATCH", "외부 인증 가입을 계속해 주세요.");
            UUID aid = UUID.randomUUID();
            db.sql.update(
                "INSERT INTO accounts(id,realm_id,name) VALUES(?,?,?)",
                aid,
                run,
                body.name().strip());
            db.sql.update(
                "INSERT INTO account_emails(account_id,realm_id,original_email,email_key,verified_at,proof_source) VALUES(?,?,?,?,?,?)",
                aid,
                run,
                f.get("email_original"),
                f.get("email_key"),
                f.get("verified_at"),
                f.get("proof_source"));
            if (!oidc)
              db.sql.update(
                  "INSERT INTO password_credentials(account_id,encoded_hash) VALUES(?,?)",
                  aid,
                  hash);
            else
              db.sql.update(
                  "INSERT INTO external_identities(id,realm_id,account_id,issuer,subject,provider) VALUES(?,?,?,?,?,?)",
                  UUID.randomUUID(),
                  run,
                  aid,
                  proof.get("issuer"),
                  proof.get("subject"),
                  proof.get("provider"));
            db.sql.update(
                "INSERT INTO consent_records(account_id,purpose,version,agreed) VALUES(?,'TERMS',?,true),(?,'MARKETING',1,?)",
                aid,
                body.termsVersion(),
                aid,
                body.marketing());
            db.sql.update(
                "UPDATE signup_flows SET status='COMPLETED',account_id=? WHERE id=?", aid, fid);
            Outcome value =
                new Outcome(
                    201,
                    map(
                        "code",
                        "ACCOUNT_CREATED",
                        "accountId",
                        aid.toString(),
                        "message",
                        "가입이 완료되었습니다. 로그인은 별도 단계입니다."));
            result(fid, "complete", body.idempotencyKey(), fp, value);
            audit(run, "ACCOUNT_CREATED", "COMMITTED");
            faults.check(run, "before-account-commit");
            db.committed(
                () ->
                    trace.step(
                        "DB",
                        "account_committed",
                        "계정·이메일·자격정보·동의·멱등 결과 원자 커밋",
                        "SignupService.complete"));
            return value;
          });
    } catch (DataIntegrityViolationException conflict) {
      return db.tx.execute(
          t -> {
            flow(req, run, true, true);
            Outcome old = existing(fid, "complete", body.idempotencyKey(), fp);
            if (old != null) return old;
            Outcome rejected =
                new Outcome(
                    409,
                    map(
                        "code",
                        "ACCOUNT_ALREADY_EXISTS",
                        "message",
                        "이미 가입한 주소 또는 외부 신원입니다. 기존 계정으로 로그인 후 연결해 주세요."));
            result(fid, "complete", body.idempotencyKey(), fp, rejected);
            audit(run, "SIGNUP_CONFLICT", "ROLLED_BACK");
            trace.step(
                "DB",
                "unique_conflict",
                "유일 제약 충돌로 패자 전체 롤백 · 기존 계정에 자동 연결하지 않음",
                "SignupService.complete");
            return rejected;
          });
    }
  }

  public Map<String, Object> status(HttpServletRequest req, String run) {
    return status(req, run, null);
  }

  private Map<String, Object> status(HttpServletRequest req, String run, UUID justCreated) {
    var f =
        justCreated == null
            ? flow(req, run, false, false)
            : db.one("SELECT * FROM signup_flows WHERE id=? AND realm_id=?", justCreated, run);
    Instant now = db.now();
    boolean verified = time(f, "verified_until") != null && time(f, "verified_until").isAfter(now);
    boolean exists =
        verified
            && db.one(
                    "SELECT account_id FROM account_emails WHERE realm_id=? AND email_key=?",
                    run,
                    f.get("email_key"))
                != null;
    Map<String, Object> proof = providerProof(f);
    return map(
        "flowId",
        f.get("id").toString(),
        "state",
        f.get("status"),
        "intent",
        f.get("intent"),
        "email",
        f.get("email_original"),
        "generation",
        f.get("generation"),
        "flowExpiresAt",
        time(f, "expires_at").toString(),
        "verifiedUntil",
        time(f, "verified_until") == null ? null : time(f, "verified_until").toString(),
        "emailVerified",
        verified,
        "existingAccount",
        exists && !"COMPLETED".equals(f.get("status")),
        "accountId",
        f.get("account_id"),
        "termsVersion",
        runs.row(run).get("terms_version"),
        "policy",
        runs.policy(run),
        "providerVerified",
        proof != null,
        "provider",
        proof == null ? null : proof.get("provider"));
  }
}
