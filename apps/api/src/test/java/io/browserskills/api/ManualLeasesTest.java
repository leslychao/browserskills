package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class ManualLeasesTest {
  @Test
  void exclusiveSessionRevocationAndAbsoluteExpiry() {
    Instant now = Instant.parse("2026-09-09T00:00:00Z");
    var leases = new ManualLeases(Clock.fixed(now, ZoneOffset.UTC));
    UUID user = UUID.randomUUID();
    var revocations = new AtomicInteger();
    leases.onRevoke(s -> revocations.incrementAndGet());
    leases.acquire(user, 1, "one", "gen", now.plusSeconds(10));
    assertTrue(leases.valid(user, "one"));
    assertFalse(leases.valid(user, "two"));
    assertThrows(
        ApiException.class, () -> leases.acquire(user, 1, "two", "gen", now.plusSeconds(10)));
    assertEquals(1, leases.lease(user, "one").worker());
    leases.revokeSession("one");
    assertFalse(leases.valid(user, "one"));
    assertTrue(revocations.get() > 0);
    leases.acquire(user, 1, "expired", "gen", now.minusSeconds(1));
    assertThrows(ApiException.class, () -> leases.lease(user, "expired"));
    leases.acquire(user, 1, "replacement", "gen", now.plusSeconds(5));
    assertTrue(leases.valid(user, "replacement"));
  }
}
