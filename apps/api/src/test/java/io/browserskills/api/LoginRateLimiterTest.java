package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Clock;
import org.junit.jupiter.api.Test;

class LoginRateLimiterTest {
  @Test
  void limitsBothAccountAndIpEvenWhenAttackerRotatesOtherKey() {
    var limiter = new LoginRateLimiter(Clock.systemUTC());
    for (int i = 0; i < 5; i++) limiter.check("user", "ip" + i);
    assertEquals(
        "LOGIN_RATE_LIMIT",
        assertThrows(ApiException.class, () -> limiter.check("user", "fresh")).code());
    for (int i = 0; i < 20; i++) limiter.check("other" + i, "shared");
    assertThrows(ApiException.class, () -> limiter.check("fresh", "shared"));
  }
}
