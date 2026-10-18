package dev.portfolio.signuplab;

import jakarta.servlet.http.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
public class AuthController {
  private final AuthService auth;
  private final Contexts contexts;

  public AuthController(AuthService auth, Contexts contexts) {
    this.auth = auth;
    this.contexts = contexts;
  }

  @PostMapping("/api/auth/login")
  public Object login(
      HttpServletRequest req, HttpServletResponse res, @RequestBody Map<String, String> body) {
    return auth.login(req, res, RequestFilter.run(req), body.get("email"), body.get("password"));
  }

  @GetMapping("/api/auth/me")
  public Object me(HttpServletRequest req) {
    return auth.info(req, RequestFilter.run(req));
  }

  @PostMapping("/api/auth/reauthenticate")
  public Object reauth(
      HttpServletRequest req, HttpServletResponse res, @RequestBody Map<String, String> body) {
    return auth.reauthenticate(req, res, RequestFilter.run(req), body.get("password"));
  }

  @PostMapping("/api/auth/logout")
  public Object logout(HttpServletRequest req, HttpServletResponse res) {
    contexts.logout(req, res, RequestFilter.run(req));
    return Map.of("code", "LOGGED_OUT");
  }
}
