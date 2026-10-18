package dev.portfolio.signuplab;

public record Policy(
    long flow,
    long link,
    long proof,
    long cooldown,
    long recent,
    long oidc,
    long lease,
    long rateWindow,
    int mailMax,
    int emailMax,
    int ipMax) {
  public static Policy of(String name) {
    return switch (name) {
      case "short" -> new Policy(60, 20, 20, 5, 5, 30, 5, 60, 3, 5, 20);
      case "expiry" -> new Policy(15, 3, 3, 1, 3, 5, 4, 4, 3, 5, 20);
      default -> new Policy(1800, 600, 600, 60, 300, 300, 20, 3600, 3, 5, 20);
    };
  }
}
