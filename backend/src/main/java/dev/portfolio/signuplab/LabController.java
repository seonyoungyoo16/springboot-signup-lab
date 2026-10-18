package dev.portfolio.signuplab;

import static dev.portfolio.signuplab.Db.*;

import java.util.*;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/internal/lab")
public class LabController {
  private final Runs runs;
  private final Db db;
  private final TraceLog trace;
  private final Faults faults;
  private final StringRedisTemplate redis;

  public LabController(Runs runs, Db db, TraceLog trace, Faults faults, StringRedisTemplate redis) {
    this.runs = runs;
    this.db = db;
    this.trace = trace;
    this.faults = faults;
    this.redis = redis;
  }

  @PostMapping("/runs")
  public Object create(@RequestBody Map<String, String> body) {
    runs.create(body.get("run"), body.getOrDefault("policy", "normal"));
    return Map.of("status", "ready");
  }

  @GetMapping("/traces")
  public Object traces(@RequestParam String run) {
    return trace.list(Runs.valid(run));
  }

  @PostMapping("/fault")
  public Object fault(@RequestBody Map<String, String> body) {
    String run = Runs.valid(body.get("run"));
    faults.set(run, body.getOrDefault("point", "none"));
    return map("point", faults.get(run), "mailHeld", faults.heldMail.contains(run));
  }

  @PostMapping("/policy")
  public Object policy(@RequestBody Map<String, Object> body) {
    String run = Runs.valid(body.get("run").toString());
    if (body.containsKey("trustEmail"))
      db.sql.update("UPDATE lab_runs SET trust_email=? WHERE id=?", body.get("trustEmail"), run);
    if (body.containsKey("termsVersion"))
      db.sql.update(
          "UPDATE lab_runs SET terms_version=? WHERE id=?", body.get("termsVersion"), run);
    return map("status", "updated");
  }

  @PostMapping("/revoke-auth")
  public Object revoke(@RequestBody Map<String, String> body) {
    String run = Runs.valid(body.get("run"));
    db.sql.update("UPDATE accounts SET auth_version=auth_version+1 WHERE realm_id=?", run);
    return map("status", "revoked");
  }

  // flow:LabController.snapshot
  @GetMapping("/snapshot")
  public Object snapshot(@RequestParam String run) {
    Runs.valid(run);
    Map<String, Object> counts = new LinkedHashMap<>();
    for (String table :
        List.of(
            "accounts", "external_identities", "signup_flows", "mail_outbox", "oidc_transactions"))
      counts.put(
          table, db.one("SELECT count(*) AS n FROM " + table + " WHERE realm_id=?", run).get("n"));
    counts.put(
        "signup_accounts",
        db.one(
                "SELECT count(*) AS n FROM signup_flows WHERE realm_id=? AND status='COMPLETED'",
                run)
            .get("n"));
    counts.put(
        "password_credentials",
        db.one(
                "SELECT count(*) AS n FROM password_credentials p JOIN accounts a ON a.id=p.account_id WHERE a.realm_id=?",
                run)
            .get("n"));
    counts.put(
        "consent_records",
        db.one(
                "SELECT count(*) AS n FROM consent_records c JOIN accounts a ON a.id=c.account_id WHERE a.realm_id=?",
                run)
            .get("n"));
    var flows =
        db.sql.queryForList(
            "SELECT id,status,intent,generation,issued_count,verified_at,verified_until,expires_at,account_id FROM signup_flows WHERE realm_id=? ORDER BY created_at",
            run);
    var mail =
        db.sql.queryForList(
            "SELECT id,generation,state,attempts,lease_owner,lease_until,next_attempt_at,expires_at FROM mail_outbox WHERE realm_id=? ORDER BY created_at",
            run);
    var challenges =
        db.sql.queryForList(
            "SELECT c.id,c.generation,c.state,c.expires_at,c.consumed_at FROM email_challenges c JOIN signup_flows f ON f.id=c.flow_id WHERE f.realm_id=?",
            run);
    var oidc =
        db.sql.queryForList(
            "SELECT id,provider,intent,status,expires_at,proof_until FROM oidc_transactions WHERE realm_id=? ORDER BY created_at",
            run);
    Object limits;
    try {
      var keys = redis.keys("signup:limit:" + run + ":*");
      limits =
          keys == null
              ? List.of()
              : keys.stream()
                  .map(k -> map("kind", k.split(":")[3], "ttl", redis.getExpire(k)))
                  .toList();
    } catch (Exception e) {
      limits = map("status", "unavailable");
    }
    return map(
        "observedAt",
        java.time.Instant.now().toString(),
        "counts",
        counts,
        "flows",
        flows,
        "mail",
        mail,
        "challenges",
        challenges,
        "oidc",
        oidc,
        "limits",
        limits);
  }
}
