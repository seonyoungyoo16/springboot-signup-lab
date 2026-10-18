package dev.portfolio.signuplab;

import static dev.portfolio.signuplab.Db.*;

import jakarta.servlet.http.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.stereotype.Service;

@Service
public class OidcService {
  public record Provider(String id, String realm) {
    public String issuer() {
      return "https://localhost:18443/realms/" + realm;
    }

    public String back() {
      return "http://127.0.0.1:18445/realms/" + realm;
    }
  }

  private final Db db;
  private final Crypto crypto;
  private final SignupService signup;
  private final Runs runs;
  private final Contexts contexts;
  private final TraceLog trace;
  private final Faults faults;
  private final String secret;
  private final HttpClient http =
      HttpClient.newBuilder()
          .connectTimeout(Duration.ofSeconds(3))
          .followRedirects(HttpClient.Redirect.NEVER)
          .build();

  public OidcService(
      Db db,
      Crypto crypto,
      SignupService signup,
      Runs runs,
      Contexts contexts,
      TraceLog trace,
      Faults faults,
      @Value("${lab.oidc-secret}") String secret) {
    this.db = db;
    this.crypto = crypto;
    this.signup = signup;
    this.runs = runs;
    this.contexts = contexts;
    this.trace = trace;
    this.faults = faults;
    this.secret = secret;
  }

  public Provider provider(String id) {
    return switch (id == null ? "" : id) {
      case "main" -> new Provider("main", "signup-lab");
      case "team" -> new Provider("team", "signup-team");
      default -> throw new Failure(400, "PROVIDER_NOT_ALLOWED", "허용한 공급자를 선택해 주세요.");
    };
  }

  private static String encode(String v) {
    return URLEncoder.encode(v, StandardCharsets.UTF_8);
  }

  private static String challenge(String v) {
    try {
      return Base64.getUrlEncoder()
          .withoutPadding()
          .encodeToString(
              MessageDigest.getInstance("SHA-256").digest(v.getBytes(StandardCharsets.US_ASCII)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  // flow:OidcService.start
  public Map<String, Object> start(
      HttpServletRequest req, String run, String providerId, String intent) {
    Provider provider = provider(providerId);
    if (!Set.of("SIGNUP", "LINK", "LOGIN", "REAUTH").contains(intent))
      throw new Failure(400, "INTENT_NOT_ALLOWED", "외부 인증 목적을 확인해 주세요.");
    Policy policy = runs.policy(run);
    var context = contexts.load(req);
    if (context == null) throw new Failure(403, "CONTEXT_REQUIRED", "브라우저 문맥을 준비해 주세요.");
    Map<String, Object> account = null, f = null;
    if (intent.equals("SIGNUP")) f = signup.flow(req, run, false, true);
    if (intent.equals("LINK") || intent.equals("REAUTH")) {
      account = contexts.principal(req, run);
      if (intent.equals("LINK")) contexts.recent(account, policy);
    }
    String state = crypto.random(), nonce = crypto.random(), verifier = crypto.random();
    UUID tx = UUID.randomUUID();
    Map<String, Object> target = account, flow = f;
    db.tx.executeWithoutResult(
        t -> {
          db.sql.update(
              "INSERT INTO oidc_transactions(id,realm_id,flow_id,state_hash,nonce_hash,verifier_ciphertext,context_hash,provider,issuer,intent,target_account_id,auth_record_id,auth_version,expires_at,client_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              tx,
              run,
              flow == null ? null : flow.get("id"),
              Crypto.hash(state),
              Crypto.hash(nonce),
              crypto.encrypt("oidc", tx.toString(), verifier),
              Crypto.hash(context.id()),
              provider.id(),
              provider.issuer(),
              intent,
              target == null ? null : target.get("account_id"),
              target == null ? null : target.get("id"),
              target == null ? null : target.get("auth_version"),
              stamp(db.now().plusSeconds(policy.oidc())),
              "signup-lab");
          if (flow != null)
            db.sql.update(
                "UPDATE signup_flows SET intent='OIDC',provider_transaction_id=? WHERE id=?",
                tx,
                flow.get("id"));
          if (intent.equals("LINK"))
            db.sql.update(
                "INSERT INTO identity_link_requests(transaction_id,account_id) VALUES(?,?)",
                tx,
                target.get("account_id"));
        });
    context.data().put("oidcTransaction", tx.toString());
    contexts.save(context);
    String redirect = "https://localhost:8470/oidc/callback/" + provider.id();
    String url =
        provider.issuer()
            + "/protocol/openid-connect/auth?client_id=signup-lab&response_type=code&scope="
            + encode("openid profile email")
            + "&redirect_uri="
            + encode(redirect)
            + "&state="
            + state
            + "&nonce="
            + nonce
            + "&code_challenge="
            + challenge(verifier)
            + "&code_challenge_method=S256";
    if (!intent.equals("LOGIN")) url += "&prompt=login";
    if (intent.equals("REAUTH")) url += "&max_age=0";
    trace.step(
        "IdP", "redirect_prepared", "목적·브라우저·state·nonce·PKCE S256을 한 거래에 결합", "OidcService.start");
    return map("url", url, "transactionId", tx.toString());
  }

  public String runForState(String state) {
    if (state == null || !state.matches("[A-Za-z0-9_-]{43}")) return null;
    var t = db.one("SELECT realm_id FROM oidc_transactions WHERE state_hash=?", Crypto.hash(state));
    return t == null ? null : t.get("realm_id").toString();
  }

  private Map<String, Object> owned(HttpServletRequest req, String state, String expectedProvider) {
    if (state == null || !state.matches("[A-Za-z0-9_-]{43}"))
      throw new Failure(403, "OIDC_STATE_INVALID", "외부 인증 state가 올바르지 않습니다.");
    var t = db.one("SELECT * FROM oidc_transactions WHERE state_hash=?", Crypto.hash(state));
    if (t == null) throw new Failure(403, "OIDC_STATE_INVALID", "외부 인증 거래를 찾을 수 없습니다.");
    trace.run(t.get("realm_id").toString());
    var c = contexts.load(req);
    if (c == null
        || !Crypto.equal(Crypto.hash(c.id()), t.get("context_hash").toString())
        || !expectedProvider.equals(t.get("provider")))
      throw new Failure(403, "OIDC_CONTEXT_MISMATCH", "외부 인증을 시작한 브라우저에서 진행해 주세요.");
    if (!time(t, "expires_at").isAfter(db.now()))
      throw new Failure(410, "OIDC_TRANSACTION_EXPIRED", "외부 인증 거래가 만료되었습니다.");
    return t;
  }

  // flow:OidcService.callback
  public String callback(
      HttpServletRequest req,
      HttpServletResponse res,
      String providerId,
      String state,
      String code,
      String error) {
    Provider provider = provider(providerId);
    var tx = owned(req, state, providerId);
    String run = tx.get("realm_id").toString(), intent = tx.get("intent").toString();
    if (error != null) {
      db.sql.update(
          "UPDATE oidc_transactions SET status='FAILED',verifier_ciphertext=NULL WHERE id=?",
          tx.get("id"));
      throw new Failure(400, "OIDC_CANCELLED", "외부 인증을 취소했습니다.");
    }
    if (Set.of("VERIFIED", "LINKED").contains(tx.get("status")))
      return "https://localhost:8470/?run=" + run + "&oidc=" + intent;
    if (code == null || code.length() > 4096)
      throw new Failure(400, "OIDC_CODE_INVALID", "외부 인가 코드가 올바르지 않습니다.");
    int claimed =
        db.sql.update(
            "UPDATE oidc_transactions SET status='EXCHANGING' WHERE id=? AND status='PENDING'",
            tx.get("id"));
    if (claimed != 1)
      throw new Failure(409, "OIDC_ALREADY_PROCESSING", "이미 처리 중인 외부 인증입니다. 새 인증이 필요할 수 있습니다.");
    String verifier =
        crypto.decrypt("oidc", tx.get("id").toString(), tx.get("verifier_ciphertext").toString());
    Map<String, Object> token;
    try {
      String form =
          "grant_type=authorization_code&client_id=signup-lab&client_secret="
              + encode(secret)
              + "&code="
              + encode(code)
              + "&redirect_uri="
              + encode("https://localhost:8470/oidc/callback/" + providerId)
              + "&code_verifier="
              + encode(verifier);
      var response =
          http.send(
              HttpRequest.newBuilder(URI.create(provider.back() + "/protocol/openid-connect/token"))
                  .timeout(Duration.ofSeconds(5))
                  .header("Content-Type", "application/x-www-form-urlencoded")
                  .POST(HttpRequest.BodyPublishers.ofString(form))
                  .build(),
              HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() != 200)
        throw new Failure(
            response.statusCode() >= 500 ? 503 : 400,
            "OIDC_EXCHANGE_FAILED",
            "외부 인가 코드의 교환을 확인할 수 없습니다.");
      token = signup.parse(response.body());
      trace.step(
          "IdP",
          "code_exchanged",
          "실제 Keycloak 인가 코드와 PKCE verifier 서버 교환",
          "OidcService.callback");
    } catch (Failure f) {
      throw f;
    } catch (Exception e) {
      throw new Failure(503, "IDP_UNAVAILABLE", "실제 IdP 연결을 확인할 수 없습니다.");
    }
    faults.check(run, "after-token-exchange");
    String raw = (String) token.get("id_token");
    Map<String, Object> proof = validate(run, provider, tx, raw);
    db.tx.executeWithoutResult(
        t -> {
          var row = db.one("SELECT * FROM oidc_transactions WHERE id=? FOR UPDATE", tx.get("id"));
          owned(req, state, providerId);
          Instant until =
              SignupService.min(
                  db.now().plusSeconds(runs.policy(run).oidc()), time(row, "expires_at"));
          db.sql.update(
              "UPDATE oidc_transactions SET status='VERIFIED',proof=?::jsonb,proof_until=?,verifier_ciphertext=NULL WHERE id=?",
              signup.json(proof),
              stamp(until),
              tx.get("id"));
          if (intent.equals("SIGNUP")) applySignupProof(req, run, tx, proof, until);
          signup.audit(run, "OIDC_PROOF_VERIFIED", "SUCCESS");
          db.committed(
              () ->
                  trace.step(
                      "DB",
                      "provider_verified",
                      "검증된 외부 신원만 저장 · 아직 가입·연결 확정 아님",
                      "OidcService.validate"));
        });
    if (intent.equals("LOGIN") || intent.equals("REAUTH")) {
      var identity =
          db.one(
              "SELECT * FROM external_identities WHERE realm_id=? AND issuer=? AND subject=?",
              run,
              proof.get("issuer"),
              proof.get("subject"));
      if (identity == null)
        throw new Failure(403, "IDENTITY_NOT_LINKED", "이 외부 신원은 기존 계정에 연결되지 않았습니다.");
      if (intent.equals("REAUTH")) {
        var principal = contexts.principal(req, run);
        if (!principal.get("account_id").equals(identity.get("account_id"))
            || !principal.get("id").equals(tx.get("auth_record_id")))
          throw new Failure(403, "REAUTH_IDENTITY_MISMATCH", "기존 계정에 연결된 로그인 수단으로 확인해 주세요.");
        if (!Boolean.TRUE.equals(proof.get("authTimePresent")))
          throw new Failure(403, "REAUTH_NOT_FRESH", "외부 재인증의 auth_time이 필요합니다.");
        Instant at = Instant.ofEpochSecond(((Number) proof.get("authTime")).longValue());
        if (at.isBefore(time(tx, "created_at").minusSeconds(2)))
          throw new Failure(403, "REAUTH_NOT_FRESH", "최근 외부 인증 시각을 확인할 수 없습니다.");
      }
      contexts.authenticate(
          req,
          res,
          run,
          uuid(identity, "account_id"),
          "OIDC",
          Instant.ofEpochSecond(((Number) proof.get("authTime")).longValue()),
          intent.equals("REAUTH") ? time(contexts.principal(req, run), "expires_at") : null);
    }
    return "https://localhost:8470/?run=" + run + "&oidc=" + intent;
  }

  // flow:OidcService.validate
  private Map<String, Object> validate(
      String run, Provider provider, Map<String, Object> tx, String raw) {
    if (raw == null) throw new Failure(400, "ID_TOKEN_REQUIRED", "ID Token을 확인할 수 없습니다.");
    String fault = faults.get(run);
    if (fault.startsWith("oidc-invalid-"))
      trace.step("Server", "validation_fault", "실제 토큰 검증의 기대값·검증 시각에 통제된 시험 입력 적용", "Faults.check");
    if (fault.equals("fail-jwks")) {
      faults.take(run, fault);
      throw new Failure(503, "JWKS_UNAVAILABLE", "서명 키 확인 지점에서 중단했습니다.");
    }
    if (fault.equals("oidc-invalid-signature")) {
      faults.take(run, fault);
      String[] parts = raw.split("\\.");
      byte[] sig = Base64.getUrlDecoder().decode(parts[2]);
      sig[0] ^= 1;
      raw =
          parts[0]
              + "."
              + parts[1]
              + "."
              + Base64.getUrlEncoder().withoutPadding().encodeToString(sig);
    }
    Jwt jwt;
    try {
      var decoder =
          NimbusJwtDecoder.withJwkSetUri(provider.back() + "/protocol/openid-connect/certs")
              .jwsAlgorithm(SignatureAlgorithm.RS256)
              .build();
      decoder.setJwtValidator(
          JwtValidators.createDefaultWithIssuer(
              fault.equals("oidc-invalid-issuer")
                  ? provider.issuer() + "/wrong"
                  : provider.issuer()));
      jwt = decoder.decode(raw);
    } catch (Exception e) {
      throw new Failure(
          400, "OIDC_SIGNATURE_OR_ISSUER_INVALID", "ID Token 서명·issuer·기본 유효성 검증에 실패했습니다.");
    }
    String expectedAudience =
        fault.equals("oidc-invalid-audience") ? "different-client" : tx.get("client_id").toString();
    String expectedNonce =
        fault.equals("oidc-invalid-nonce") ? Crypto.hash("wrong") : tx.get("nonce_hash").toString();
    Instant validationTime =
        fault.equals("oidc-invalid-expiry") ? db.now().plusSeconds(86400) : db.now();
    if (fault.startsWith("oidc-invalid-")) faults.take(run, fault);
    if (!jwt.getAudience().contains(expectedAudience)
        || (jwt.getAudience().size() > 1 && jwt.getClaimAsString("azp") == null)
        || (jwt.getClaimAsString("azp") != null
            && !expectedAudience.equals(jwt.getClaimAsString("azp"))))
      throw new Failure(400, "OIDC_AUDIENCE_INVALID", "외부 토큰의 대상 클라이언트가 일치하지 않습니다.");
    if (!Crypto.equal(
        expectedNonce, Crypto.hash(Optional.ofNullable(jwt.getClaimAsString("nonce")).orElse(""))))
      throw new Failure(400, "OIDC_NONCE_INVALID", "외부 토큰의 nonce가 일치하지 않습니다.");
    if (jwt.getExpiresAt() == null || !jwt.getExpiresAt().isAfter(validationTime))
      throw new Failure(400, "OIDC_TOKEN_EXPIRED", "외부 토큰이 만료되었습니다.");
    String subject = jwt.getSubject();
    if (subject == null || subject.isBlank() || subject.length() > 255)
      throw new Failure(400, "OIDC_SUBJECT_INVALID", "외부 신원 식별자가 올바르지 않습니다.");
    Object at = jwt.getClaims().get("auth_time");
    long authTime = at instanceof Number n ? n.longValue() : 0;
    trace.step(
        "Server", "token_validated", "실제 서명·issuer·audience·nonce·exp를 검증", "OidcService.validate");
    return map(
        "issuer",
        provider.issuer(),
        "subject",
        subject,
        "provider",
        provider.id(),
        "email",
        jwt.getClaimAsString("email"),
        "emailVerified",
        Boolean.TRUE.equals(jwt.getClaims().get("email_verified")),
        "authTime",
        authTime,
        "authTimePresent",
        at instanceof Number);
  }

  private void applySignupProof(
      HttpServletRequest req,
      String run,
      Map<String, Object> tx,
      Map<String, Object> proof,
      Instant until) {
    var f = signup.flow(req, run, true, true);
    if (!tx.get("id").equals(f.get("provider_transaction_id")))
      throw new Failure(403, "OIDC_INTENT_CHANGED", "현재 가입의 외부 인증 목적이 바뀌었습니다.");
    String email = null;
    try {
      if (proof.get("email") != null) email = Crypto.email(proof.get("email").toString());
    } catch (Failure ignored) {
    }
    if (email != null && f.get("email_key") == null)
      db.sql.update(
          "UPDATE signup_flows SET email_key=?,email_original=? WHERE id=?",
          email,
          proof.get("email"),
          f.get("id"));
    boolean trusted =
        "main".equals(proof.get("provider"))
            && Boolean.TRUE.equals(runs.row(run).get("trust_email"))
            && Boolean.TRUE.equals(proof.get("emailVerified"));
    if (trusted
        && email != null
        && (f.get("email_key") == null || email.equals(f.get("email_key"))))
      db.sql.update(
          "UPDATE signup_flows SET email_key=?,email_original=?,verified_at=clock_timestamp(),verified_until=?,proof_source='OIDC_TRUSTED' WHERE id=?",
          email,
          proof.get("email"),
          stamp(SignupService.min(until, time(f, "expires_at"))),
          f.get("id"));
    var identity =
        db.one(
            "SELECT account_id FROM external_identities WHERE realm_id=? AND issuer=? AND subject=?",
            run,
            proof.get("issuer"),
            proof.get("subject"));
    if (identity != null)
      throw new Failure(
          409, "IDENTITY_ALREADY_REGISTERED", "이미 연결된 외부 신원입니다. 기존 SSO 로그인으로 진행해 주세요.");
  }

  // flow:OidcService.link
  public Map<String, Object> link(HttpServletRequest req, String run) {
    var p = contexts.principal(req, run);
    contexts.recent(p, runs.policy(run));
    var c = contexts.load(req);
    Object transaction = c.data().get("oidcTransaction");
    if (transaction == null)
      throw new Failure(403, "LINK_PROOF_REQUIRED", "연결할 외부 신원을 먼저 확인해 주세요.");
    try {
      return db.tx.execute(
          t -> {
            db.one("SELECT id FROM accounts WHERE id=? FOR UPDATE", p.get("account_id"));
            contexts.principal(req, run);
            var tx =
                db.one(
                    "SELECT * FROM oidc_transactions WHERE id=? AND realm_id=? FOR UPDATE",
                    id(transaction.toString()),
                    run);
            if (tx == null
                || !"LINK".equals(tx.get("intent"))
                || !p.get("account_id").equals(tx.get("target_account_id"))
                || !p.get("id").equals(tx.get("auth_record_id"))
                || number(p, "auth_version") != number(tx, "auth_version")
                || !Crypto.equal(Crypto.hash(c.id()), tx.get("context_hash").toString()))
              throw new Failure(403, "LINK_CONTEXT_CHANGED", "연결을 시작한 기존 인증 문맥이 바뀌었습니다.");
            if ("LINKED".equals(tx.get("status")))
              return map("code", "IDENTITY_LINKED", "replayed", true);
            if (!"VERIFIED".equals(tx.get("status"))
                || time(tx, "proof_until") == null
                || !time(tx, "proof_until").isAfter(db.now()))
              throw new Failure(403, "LINK_PROOF_EXPIRED", "외부 신원을 다시 확인해 주세요.");
            var proof = signup.parse(tx.get("proof"));
            var current =
                db.one(
                    "SELECT * FROM external_identities WHERE realm_id=? AND issuer=? AND subject=?",
                    run,
                    proof.get("issuer"),
                    proof.get("subject"));
            if (current != null && !p.get("account_id").equals(current.get("account_id")))
              throw new Failure(409, "IDENTITY_ALREADY_LINKED", "이 외부 신원은 다른 계정에 연결되어 있습니다.");
            if (current == null)
              db.sql.update(
                  "INSERT INTO external_identities(id,realm_id,account_id,issuer,subject,provider) VALUES(?,?,?,?,?,?)",
                  UUID.randomUUID(),
                  run,
                  p.get("account_id"),
                  proof.get("issuer"),
                  proof.get("subject"),
                  proof.get("provider"));
            db.sql.update("UPDATE oidc_transactions SET status='LINKED' WHERE id=?", tx.get("id"));
            db.sql.update(
                "UPDATE identity_link_requests SET status='COMPLETED',linked_at=clock_timestamp() WHERE transaction_id=?",
                tx.get("id"));
            signup.audit(run, "IDENTITY_LINKED", "COMMITTED");
            db.committed(
                () ->
                    trace.step(
                        "DB",
                        "identity_linked",
                        "기존 계정과 외부 신원 양쪽을 확인한 명시적 연결 커밋",
                        "OidcService.link"));
            return map("code", "IDENTITY_LINKED", "message", "현재 계정에 확인한 외부 신원을 연결했습니다.");
          });
    } catch (DataIntegrityViolationException e) {
      throw new Failure(409, "IDENTITY_ALREADY_LINKED", "이 외부 신원은 이미 연결되었습니다.");
    }
  }
}
