package io.browserskills.api;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public final class LoginRateLimiter {
  private record Window(Instant start, int attempts) {}

  private final Clock clock;
  private final Map<String, Window> attempts = new HashMap<>();

  public LoginRateLimiter(Clock clock) {
    this.clock = clock;
  }

  public synchronized void check(String login, String ip) {
    Instant now = clock.instant();
    attempts
        .entrySet()
        .removeIf(entry -> entry.getValue().start().plus(Duration.ofMinutes(15)).isBefore(now));
    if (attempts.size() > 20_000) throw limited();
    String account = "login:" + login.toLowerCase(java.util.Locale.ROOT);
    String address = "ip:" + ip;
    if (count(account) >= 5 || count(address) >= 20) throw limited();
    record(account, now);
    record(address, now);
  }

  private int count(String key) {
    return attempts.containsKey(key) ? attempts.get(key).attempts() : 0;
  }

  private void record(String key, Instant now) {
    attempts.compute(
        key,
        (ignored, old) ->
            new Window(old == null ? now : old.start(), old == null ? 1 : old.attempts() + 1));
  }

  private ApiException limited() {
    return new ApiException(
        429, "LOGIN_RATE_LIMIT", "Too many login attempts. Try again in 15 minutes.");
  }
}
