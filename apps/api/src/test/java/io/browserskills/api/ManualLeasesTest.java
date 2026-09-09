package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class ManualLeasesTest {
  @Test
  void explicitTakeoverRevokesTheOldControllerAndSessionScopesTheTabId() {
    var now = Instant.parse("2026-09-09T00:00:00Z");
    var leases = new ManualLeases(Clock.fixed(now, ZoneOffset.UTC));
    var user = UUID.randomUUID();
    var tab = UUID.randomUUID();
    var first = ManualLeases.controller("one", tab);
    var second = ManualLeases.controller("two", tab);
    var revoked = new ArrayList<String>();
    leases.onRevoke(revoked::add);
    assertEquals("AVAILABLE", leases.status(user, first).state());
    leases.acquire(user, 1, first, "gen", now.plusSeconds(60), false);
    assertEquals("OWNED", leases.status(user, first).state());
    assertEquals("IN_USE", leases.status(user, second).state());
    assertThrows(ApiException.class, () -> leases.acquire(user, 1, second, "gen", now.plusSeconds(60), false));
    leases.acquire(user, 1, second, "gen", now.plusSeconds(60), true);
    assertEquals(List.of(first), revoked);
    assertFalse(leases.valid(user, first));
    assertTrue(leases.valid(user, second));
    leases.acquire(user, 1, second, "gen", now, false);
    assertEquals("AVAILABLE", leases.status(user, second).state());
  }

  @Test
  void exclusiveSessionRevocationAndAbsoluteExpiry() {
    Instant now = Instant.parse("2026-09-09T00:00:00Z");
    var leases = new ManualLeases(Clock.fixed(now, ZoneOffset.UTC));
    UUID user = UUID.randomUUID();
    var revocations = new AtomicInteger();
    leases.onRevoke(s -> revocations.incrementAndGet());
    leases.acquire(user, 1, "one", "gen", now.plusSeconds(10), false);
    assertTrue(leases.valid(user, "one"));
    assertFalse(leases.valid(user, "two"));
    assertThrows(
        ApiException.class, () -> leases.acquire(user, 1, "two", "gen", now.plusSeconds(10), false));
    assertEquals(1, leases.lease(user, "one").worker());
    leases.revoke(user);
    assertFalse(leases.valid(user, "one"));
    assertTrue(revocations.get() > 0);
    leases.acquire(user, 1, "expired", "gen", now.minusSeconds(1), false);
    assertThrows(ApiException.class, () -> leases.lease(user, "expired"));
    leases.acquire(user, 1, "replacement", "gen", now.plusSeconds(5), false);
    assertTrue(leases.valid(user, "replacement"));
  }
}
