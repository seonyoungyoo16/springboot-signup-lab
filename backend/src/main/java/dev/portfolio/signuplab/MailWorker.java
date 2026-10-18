package dev.portfolio.signuplab;

import static dev.portfolio.signuplab.Db.*;

import java.time.*;
import java.util.*;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class MailWorker {
  private final Db db;
  private final Crypto crypto;
  private final SignupService signup;
  private final JavaMailSender sender;
  private final Faults faults;
  private final TraceLog trace;
  private final Runs runs;
  private final String instance;

  public MailWorker(
      Db db,
      Crypto crypto,
      SignupService signup,
      JavaMailSender sender,
      Faults faults,
      TraceLog trace,
      Runs runs,
      @org.springframework.beans.factory.annotation.Value("${lab.instance}") String instance) {
    this.db = db;
    this.crypto = crypto;
    this.signup = signup;
    this.sender = sender;
    this.faults = faults;
    this.trace = trace;
    this.runs = runs;
    this.instance = instance;
  }

  // flow:MailWorker.claim
  @Scheduled(fixedDelay = 350, initialDelay = 1500)
  public void poll() {
    try {
      var candidates =
          db.sql.queryForList(
              "SELECT id,realm_id FROM mail_outbox WHERE payload_ciphertext IS NOT NULL AND ((state IN('PENDING','RETRY_WAIT','DELIVERY_UNKNOWN') AND next_attempt_at<=clock_timestamp()) OR (state='LEASED' AND lease_until<=clock_timestamp())) ORDER BY created_at LIMIT 8");
      for (var candidate : candidates) {
        String run = candidate.get("realm_id").toString();
        if (faults.heldMail.contains(run)) continue;
        Policy p = runs.policy(run);
        UUID lease = UUID.randomUUID();
        var rows =
            db.sql.queryForList(
                "UPDATE mail_outbox SET state='LEASED',lease_token=?,lease_until=clock_timestamp()+(? * interval '1 second'),attempts=attempts+1,lease_owner=? WHERE id=? AND ((state IN('PENDING','RETRY_WAIT','DELIVERY_UNKNOWN') AND next_attempt_at<=clock_timestamp()) OR (state='LEASED' AND lease_until<=clock_timestamp())) RETURNING *",
                lease,
                p.lease(),
                instance,
                candidate.get("id"));
        if (!rows.isEmpty() && !faults.get(run).equals("hold-after-mail-claim"))
          send(rows.getFirst(), lease, p);
      }
    } catch (Exception ignored) {
      /* A dependency outage leaves durable jobs for the next poll. */
    }
  }

  // flow:MailWorker.send
  private void send(Map<String, Object> job, UUID lease, Policy p) {
    String run = job.get("realm_id").toString();
    UUID mid = uuid(job, "id");
    trace.begin(run, "SMTP", "/mail-outbox", UUID.randomUUID().toString());
    int result = 200;
    try {
      var f = db.one("SELECT * FROM signup_flows WHERE id=?", job.get("flow_id"));
      Instant now = db.now();
      if (f == null
          || !"OPEN".equals(f.get("status"))
          || number(f, "generation") != number(job, "generation")
          || !time(job, "expires_at").isAfter(now)) {
        finish(mid, lease, "EXPIRED", true);
        trace.step("DB", "mail_expired", "만료·이전 세대의 미발송 메일 정리", "MailWorker.claim");
        return;
      }
      var payload =
          signup.parse(
              crypto.decrypt("mail", mid.toString(), job.get("payload_ciphertext").toString()));
      var message = sender.createMimeMessage();
      var helper = new MimeMessageHelper(message, "UTF-8");
      helper.setFrom("signup@lab.test");
      helper.setTo(payload.get("to").toString());
      helper.setSubject("Signup Lab [run:" + run + "]");
      helper.setText(
          "Confirm your email in the browser that started signup. Opening the link alone does not verify.\nFlow: "
              + f.get("id")
              + "\n\n"
              + payload.get("url")
              + "\n");
      message.setHeader("X-Signup-Run", run);
      sender.send(message);
      trace.step("SMTP", "accepted", "실제 SMTP 서버가 메일을 접수함 · 인터넷 도착·읽음과 구분", "MailWorker.send");
      faults.check(run, "after-smtp-accept");
      finish(mid, lease, "SMTP_ACCEPTED", true);
      db.sql.update(
          "INSERT INTO mail_attempts(id,message_id,outcome) VALUES(?,?,'SMTP_ACCEPTED')",
          UUID.randomUUID(),
          mid);
    } catch (Exception failure) {
      result = 503;
      try {
        boolean dead = number(job, "attempts") >= 5 || !time(job, "expires_at").isAfter(db.now());
        String state = dead ? "DEAD" : "DELIVERY_UNKNOWN";
        long[] delay = p.cooldown() < 10 ? new long[] {1, 1, 2, 3} : new long[] {5, 30, 120, 300};
        long seconds = delay[Math.min(3, (int) number(job, "attempts") - 1)];
        db.sql.update(
            "UPDATE mail_outbox SET state=?,next_attempt_at=clock_timestamp()+(? * interval '1 second'),lease_until=NULL,payload_ciphertext=CASE WHEN ? THEN NULL ELSE payload_ciphertext END WHERE id=? AND lease_token=?",
            state,
            seconds,
            dead,
            mid,
            lease);
        db.sql.update(
            "INSERT INTO mail_attempts(id,message_id,outcome) VALUES(?,?,?)",
            UUID.randomUUID(),
            mid,
            state);
        trace.step("SMTP", "delivery_unknown", "SMTP 응답 확인 불가 · 같은 메시지 재시도 가능", "MailWorker.send");
      } catch (Exception ignored) {
      }
    } finally {
      trace.finish(result);
    }
  }

  private void finish(UUID id, UUID lease, String state, boolean scrub) {
    db.sql.update(
        "UPDATE mail_outbox SET state=?,lease_until=NULL,payload_ciphertext=CASE WHEN ? THEN NULL ELSE payload_ciphertext END WHERE id=? AND lease_token=?",
        state,
        scrub,
        id,
        lease);
  }
}
