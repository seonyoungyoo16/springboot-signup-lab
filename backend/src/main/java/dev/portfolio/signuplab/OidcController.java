package dev.portfolio.signuplab;

import jakarta.servlet.http.*;
import java.io.IOException;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
public class OidcController {
  private final OidcService oidc;
  private final TraceLog trace;

  public OidcController(OidcService oidc, TraceLog trace) {
    this.oidc = oidc;
    this.trace = trace;
  }

  @PostMapping("/api/signup/oidc/start")
  public Object start(HttpServletRequest req, @RequestBody Map<String, String> body) {
    return oidc.start(req, RequestFilter.run(req), body.get("provider"), body.get("intent"));
  }

  @GetMapping("/oidc/callback/{provider}")
  public void callback(
      HttpServletRequest req,
      HttpServletResponse res,
      @PathVariable String provider,
      @RequestParam(required = false) String state,
      @RequestParam(required = false) String code,
      @RequestParam(required = false) String error)
      throws IOException {
    try {
      res.setStatus(303);
      res.setHeader("Location", oidc.callback(req, res, provider, state, code, error));
    } catch (Failure f) {
      String run = oidc.runForState(state);
      trace.step("Server", "oidc_rejected", f.code, "OidcService.validate");
      res.setStatus(303);
      res.setHeader(
          "Location",
          "https://localhost:8470/?run="
              + (run == null ? "invalid-callback" : run)
              + "&oidcError="
              + f.code);
    }
  }

  @PostMapping("/api/account/identities/link/complete")
  public Object link(HttpServletRequest req) {
    return oidc.link(req, RequestFilter.run(req));
  }
}
