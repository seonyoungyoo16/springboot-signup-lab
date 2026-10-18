package dev.portfolio.signuplab;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class Cleanup {
  private final Db db;

  public Cleanup(Db db) {
    this.db = db;
  }

  // flow:Cleanup.expire
  @Scheduled(fixedDelay = 5000, initialDelay = 5000)
  public void expire() {
    try {
      db.sql.update(
          "UPDATE email_challenges SET state='EXPIRED' WHERE state='ACTIVE' AND expires_at<=clock_timestamp()");
      db.sql.update(
          "UPDATE mail_outbox SET state='EXPIRED',payload_ciphertext=NULL WHERE expires_at<=clock_timestamp() AND state NOT IN('SMTP_ACCEPTED','DEAD','EXPIRED')");
      db.sql.update(
          "UPDATE oidc_transactions SET status='EXPIRED',verifier_ciphertext=NULL,proof=NULL WHERE expires_at<=clock_timestamp() AND status NOT IN('LINKED','EXPIRED')");
      db.sql.update(
          "DELETE FROM signup_operation_results WHERE created_at<clock_timestamp()-interval '24 hours'");
    } catch (Exception ignored) {
      /* Cleanup never grants eligibility and resumes after storage recovery. */
    }
  }
}
