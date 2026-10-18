package dev.portfolio.signuplab;

import static dev.portfolio.signuplab.Db.*;

import jakarta.servlet.http.*;
import java.util.*;
import java.util.concurrent.Semaphore;
import org.springframework.stereotype.Service;

@Service
public class AuthService {
  private final Db db;
  private final Crypto crypto;
  private final Contexts contexts;
  private final Limiter limiter;
  private final TraceLog trace;
  private final Runs runs;
  private final String dummy;
  private final Semaphore checks = new Semaphore(4);

  public AuthService(
      Db db, Crypto crypto, Contexts contexts, Limiter limiter, TraceLog trace, Runs runs) {
    this.db = db;
    this.crypto = crypto;
    this.contexts = contexts;
    this.limiter = limiter;
    this.trace = trace;
    this.runs = runs;
    this.dummy = crypto.encode("Unused!LongDummyPassword");
  }

  private void passwordSize(String value) {
    if (value == null
        || value.length() > 512
        || value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 1024)
      throw new Failure(400, "INVALID_PASSWORD_INPUT", "비밀번호 입력 길이를 확인해 주세요.");
  }

  private boolean matches(String password, String encoded) {
    passwordSize(password);
    if (!checks.tryAcquire()) throw new Failure(429, "HASH_CAPACITY", "비밀번호 확인 자원이 사용 중입니다.");
    try {
      return crypto.matches(password, encoded == null ? dummy : encoded);
    } finally {
      checks.release();
    }
  }

  // flow:AuthService.login
  public Object login(
      HttpServletRequest req, HttpServletResponse res, String run, String email, String password) {
    String key = Crypto.email(email);
    limiter.limit(run, "login", key, 10, 60);
    var user =
        db.one(
            "SELECT a.id,a.status,p.encoded_hash FROM account_emails e JOIN accounts a ON a.id=e.account_id LEFT JOIN password_credentials p ON p.account_id=a.id WHERE e.realm_id=? AND e.email_key=?",
            run,
            key);
    boolean matched = matches(password, user == null ? null : (String) user.get("encoded_hash"));
    if (user == null || !matched || !"ACTIVE".equals(user.get("status")))
      throw new Failure(401, "AUTHENTICATION_FAILED", "이메일 또는 비밀번호를 확인해 주세요.");
    contexts.authenticate(req, res, run, uuid(user, "id"), "PASSWORD", db.now());
    trace.step(
        "DB", "password_authenticated", "기존 자격정보를 실제 검증하고 별도 로그인 문맥 발급", "AuthService.login");
    return info(req, run);
  }

  // flow:AuthService.reauthenticate
  public Object reauthenticate(
      HttpServletRequest req, HttpServletResponse res, String run, String password) {
    var p = contexts.principal(req, run);
    limiter.limit(run, "reauth", p.get("account_id").toString(), 10, 60);
    var credential =
        db.one(
            "SELECT encoded_hash FROM password_credentials WHERE account_id=?",
            p.get("account_id"));
    if (credential == null || !matches(password, credential.get("encoded_hash").toString()))
      throw new Failure(401, "REAUTHENTICATION_FAILED", "기존 로그인 수단의 비밀번호를 확인해 주세요.");
    contexts.authenticate(
        req, res, run, uuid(p, "account_id"), "PASSWORD", db.now(), time(p, "expires_at"));
    trace.step("DB", "reauthenticated", "기존 계정의 비밀번호 재확인과 세션 교체", "AuthService.reauthenticate");
    return map("code", "REAUTHENTICATED");
  }

  public Map<String, Object> info(HttpServletRequest req, String run) {
    var p = contexts.principal(req, run);
    var user =
        db.one(
            "SELECT a.id,a.name,e.original_email FROM accounts a JOIN account_emails e ON e.account_id=a.id WHERE a.id=? AND a.realm_id=?",
            p.get("account_id"),
            run);
    var identities =
        db
            .sql
            .queryForList(
                "SELECT id,provider,subject FROM external_identities WHERE account_id=? AND realm_id=?",
                p.get("account_id"),
                run)
            .stream()
            .map(
                row ->
                    map(
                        "id",
                        row.get("id"),
                        "provider",
                        row.get("provider"),
                        "subjectHint",
                        Crypto.hash(row.get("subject").toString()).substring(0, 10)))
            .toList();
    return map(
        "accountId",
        user.get("id"),
        "name",
        user.get("name"),
        "email",
        user.get("original_email"),
        "method",
        p.get("method"),
        "authenticatedAt",
        time(p, "authenticated_at").toString(),
        "identities",
        identities);
  }
}
