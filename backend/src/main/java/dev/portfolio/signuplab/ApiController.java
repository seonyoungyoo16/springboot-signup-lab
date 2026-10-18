package dev.portfolio.signuplab;

import static dev.portfolio.signuplab.Db.*;

import jakarta.servlet.http.*;
import java.util.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
public class ApiController {
  private final SignupService signup;
  private final Contexts contexts;
  private final Runs runs;
  private final Faults faults;

  public ApiController(SignupService signup, Contexts contexts, Runs runs, Faults faults) {
    this.signup = signup;
    this.contexts = contexts;
    this.runs = runs;
    this.faults = faults;
  }

  @GetMapping("/health")
  public Object health() {
    return Map.of("status", "up");
  }

  @GetMapping("/api/context")
  public Object context(HttpServletRequest req, HttpServletResponse res) {
    var c = contexts.prepare(req, res);
    return map("csrf", c.data().get("csrf"), "authenticated", c.data().containsKey("record"));
  }

  @PostMapping("/api/signup/flows")
  public Object create(HttpServletRequest req, HttpServletResponse res) {
    return ResponseEntity.status(201).body(signup.create(req, res, RequestFilter.run(req)));
  }

  @PostMapping({"/api/signup/email/request", "/api/signup/email/resend"})
  public Object email(HttpServletRequest req, @RequestBody Map<String, String> body) {
    var r =
        signup.requestEmail(
            req, RequestFilter.run(req), body.get("email"), body.get("idempotencyKey"));
    faults.check(RequestFilter.run(req), "after-email-commit");
    return ResponseEntity.status(r.status()).body(r.body());
  }

  @PostMapping("/api/signup/email/change")
  public Object change(HttpServletRequest req, @RequestBody Map<String, String> body) {
    return signup.change(req, RequestFilter.run(req), body.get("email"));
  }

  @PostMapping("/api/signup/email/verify")
  public Object verify(HttpServletRequest req, @RequestBody Map<String, String> body) {
    return signup.verify(req, RequestFilter.run(req), body.get("token"));
  }

  @GetMapping("/api/signup/status")
  public Object status(HttpServletRequest req) {
    return signup.status(req, RequestFilter.run(req));
  }

  @PostMapping({"/api/signup/complete", "/api/signup/oidc/complete"})
  public Object complete(HttpServletRequest req, @RequestBody SignupService.Complete body) {
    var value =
        signup.complete(req, RequestFilter.run(req), body, req.getRequestURI().contains("/oidc/"));
    faults.check(RequestFilter.run(req), "after-account-commit");
    return ResponseEntity.status(value.status()).body(value.body());
  }
}
