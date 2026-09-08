package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import java.time.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.mock.web.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

class SessionGuardTest {
  @AfterEach
  void clear() {
    SecurityContextHolder.clearContext();
  }

  @Test
  void absoluteHourExpiryRevokesControlEvenIfSessionWasRecentlyUsed() throws Exception {
    Instant now = Instant.now();
    UUID user = UUID.randomUUID();
    var store = mock(Store.class);
    var leases = new ManualLeases(Clock.fixed(now, ZoneOffset.UTC));
    var session = new MockHttpSession();
    session.setAttribute("authenticatedAt", now.minusSeconds(3600));
    leases.acquire(user, 1, session.getId(), "gen", now.plusSeconds(10));
    SecurityContextHolder.getContext()
        .setAuthentication(
            UsernamePasswordAuthenticationToken.authenticated(user.toString(), null, List.of()));
    var request = new MockHttpServletRequest("GET", "/api/me");
    request.setSession(session);
    var response = new MockHttpServletResponse();
    var chain = new MockFilterChain();
    new SessionGuard(store, leases, Clock.fixed(now, ZoneOffset.UTC), Json.mapper())
        .doFilter(request, response, chain);
    assertEquals(401, response.getStatus());
    assertTrue(session.isInvalid());
    assertFalse(leases.valid(user, session.getId()));
    assertNull(chain.getRequest());
    verifyNoInteractions(store);
  }

  @Test
  void validSessionPassesAndChunkedOversizeIsRejected() throws Exception {
    UUID user = UUID.randomUUID();
    var store = mock(Store.class);
    when(store.user(user)).thenReturn(new Store.User(user, "alice", "hash", true, 1));
    SecurityContextHolder.getContext()
        .setAuthentication(
            UsernamePasswordAuthenticationToken.authenticated(user.toString(), null, List.of()));
    var request = new MockHttpServletRequest("POST", "/api/runs");
    request.getSession().setAttribute("authenticatedAt", Instant.now());
    request.setContent("{}".getBytes());
    var chain = new MockFilterChain();
    var guard =
        new SessionGuard(
            store, new ManualLeases(Clock.systemUTC()), Clock.systemUTC(), Json.mapper());
    var response = new MockHttpServletResponse();
    guard.doFilter(request, response, chain);
    assertNotNull(chain.getRequest());
    assertEquals("{}", new String(chain.getRequest().getInputStream().readAllBytes()));
    var large =
        new MockHttpServletRequest("POST", "/api/runs") {
          @Override
          public long getContentLengthLong() {
            return -1;
          }
        };
    large.getSession().setAttribute("authenticatedAt", Instant.now());
    large.setContent(new byte[32769]);
    var rejected = new MockHttpServletResponse();
    guard.doFilter(large, rejected, new MockFilterChain());
    assertEquals(413, rejected.getStatus());
  }
}
