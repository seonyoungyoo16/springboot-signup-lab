package dev.portfolio.signuplab;

import static dev.portfolio.signuplab.Db.*;

import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class Runs {
  private final Db db;
  private final Crypto crypto;

  public Runs(Db db, Crypto crypto) {
    this.db = db;
    this.crypto = crypto;
  }

  public static String valid(String run) {
    if (run == null || !run.matches("[A-Za-z0-9_-]{1,80}"))
      throw new Failure(400, "INVALID_RUN", "실행 식별자를 확인해 주세요.");
    return run;
  }

  public Map<String, Object> row(String run) {
    var row = db.one("SELECT * FROM lab_runs WHERE id=?", valid(run));
    if (row == null) throw new Failure(404, "RUN_REQUIRED", "실험 실행을 먼저 준비해 주세요.");
    return row;
  }

  public Policy policy(String run) {
    return Policy.of(row(run).get("policy").toString());
  }

  public synchronized void create(String run, String policy) {
    valid(run);
    if (!Set.of("normal", "short", "expiry").contains(policy))
      throw new Failure(400, "INVALID_POLICY", "정책을 확인해 주세요.");
    if (db.one("SELECT id FROM lab_runs WHERE id=?", run) != null) return;
    String hash = crypto.encode("Signup!2026LongPass");
    db.tx.executeWithoutResult(
        t -> {
          db.sql.update("INSERT INTO lab_runs(id,policy) VALUES(?,?)", run, policy);
          UUID id = UUID.randomUUID();
          db.sql.update("INSERT INTO accounts(id,realm_id,name) VALUES(?,?,?)", id, run, "기존 회원");
          db.sql.update(
              "INSERT INTO account_emails(account_id,realm_id,original_email,email_key,verified_at,proof_source) VALUES(?,?,?,?,now(),'FIXTURE')",
              id,
              run,
              "existing@lab.test",
              "existing@lab.test");
          db.sql.update(
              "INSERT INTO password_credentials(account_id,encoded_hash) VALUES(?,?)", id, hash);
        });
  }
}
