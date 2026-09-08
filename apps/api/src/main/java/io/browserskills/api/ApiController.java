package io.browserskills.api;

import jakarta.servlet.http.*;
import java.time.*;
import java.util.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.http.*;
import org.springframework.security.authentication.*;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.session.SessionAuthenticationStrategy;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.*;

@RestController
@ConditionalOnWebApplication
public class ApiController {
  private final Store store;
  private final Orchestrator runs;
  private final Materials materials;
  private final AuthenticationManager auth;
  private final SessionAuthenticationStrategy strategy;
  private final SecurityContextRepository contexts;
  private final LoginRateLimiter limiter;
  private final Clock clock;

  public ApiController(
      Store store,
      Orchestrator runs,
      Materials materials,
      AuthenticationManager auth,
      SessionAuthenticationStrategy strategy,
      SecurityContextRepository contexts,
      LoginRateLimiter limiter,
      Clock clock) {
    this.store = store;
    this.runs = runs;
    this.materials = materials;
    this.auth = auth;
    this.strategy = strategy;
    this.contexts = contexts;
    this.limiter = limiter;
    this.clock = clock;
  }

  static UUID user(Authentication auth) {
    if (auth == null) throw ApiException.unauthorized();
    return UUID.fromString(auth.getName());
  }

  @GetMapping("/health/live")
  Map<String, String> live() {
    return Map.of("status", "UP");
  }

  @GetMapping("/api/auth/csrf")
  Map<String, String> csrf(CsrfToken token) {
    return Map.of("token", token.getToken(), "headerName", token.getHeaderName());
  }

  @PostMapping("/api/auth/login")
  Contracts.UserView login(
      @RequestBody Contracts.LoginRequest body,
      HttpServletRequest request,
      HttpServletResponse response) {
    if (body.login() == null
        || !body.login().matches("[a-zA-Z0-9_.@-]{1,128}")
        || body.password() == null
        || body.password().isEmpty()
        || body.password().getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 72)
      throw ApiException.invalid();
    limiter.check(body.login(), request.getRemoteAddr());
    Authentication authenticated;
    try {
      authenticated =
          auth.authenticate(
              UsernamePasswordAuthenticationToken.unauthenticated(body.login(), body.password()));
    } catch (org.springframework.security.core.AuthenticationException e) {
      throw new ApiException(401, "INVALID_CREDENTIALS", "Login or password is incorrect.");
    }
    var old = request.getSession(false);
    if (old != null) runs.logout(user(authenticated), old.getId());
    strategy.onAuthentication(authenticated, request, response);
    var context = SecurityContextHolder.createEmptyContext();
    context.setAuthentication(authenticated);
    SecurityContextHolder.setContext(context);
    contexts.saveContext(context, request, response);
    request.getSession().setAttribute("authenticatedAt", clock.instant());
    var u = store.user(user(authenticated));
    return new Contracts.UserView(u.id(), u.login());
  }

  @PostMapping("/api/auth/logout")
  ResponseEntity<Void> logout(Authentication auth, HttpServletRequest request) {
    var session = request.getSession(false);
    if (session != null) {
      runs.logout(user(auth), session.getId());
      session.invalidate();
    }
    SecurityContextHolder.clearContext();
    return ResponseEntity.noContent().build();
  }

  @GetMapping("/api/me")
  Contracts.Me me(Authentication auth) {
    var u = store.user(user(auth));
    return new Contracts.Me(u.id(), u.login(), store.quota(u.id()));
  }

  @GetMapping("/api/browser")
  Contracts.BrowserStatus browser(Authentication auth) {
    return runs.browser(user(auth), false);
  }

  @PostMapping("/api/browser")
  Contracts.BrowserStatus open(Authentication auth) {
    return runs.browser(user(auth), true);
  }

  @PostMapping("/api/browser/manual-control")
  Contracts.BrowserStatus control(Authentication auth, HttpServletRequest request) {
    var session = request.getSession(false);
    return runs.manual(
        user(auth),
        session.getId(),
        ((Instant) session.getAttribute("authenticatedAt")).plusSeconds(3600),
        true);
  }

  @DeleteMapping("/api/browser/manual-control")
  Contracts.BrowserStatus release(Authentication auth, HttpServletRequest request) {
    return runs.manual(user(auth), request.getSession(false).getId(), null, false);
  }

  @PostMapping("/api/runs")
  Contracts.RunView start(Authentication auth, @RequestBody Contracts.StartRun request) {
    return runs.start(user(auth), request);
  }

  @GetMapping("/api/runs")
  List<Contracts.RunSummary> list(Authentication auth) {
    return runs.list(user(auth));
  }

  @GetMapping("/api/runs/{id}")
  Contracts.RunView get(Authentication auth, @PathVariable UUID id) {
    return runs.view(user(auth), id);
  }

  @PostMapping("/api/runs/{id}/confirm")
  Contracts.RunView confirm(
      Authentication auth, @PathVariable UUID id, @RequestBody Contracts.Confirm request) {
    return runs.confirm(user(auth), id, request);
  }

  @PostMapping("/api/runs/{id}/stop")
  Contracts.RunView stop(Authentication auth, @PathVariable UUID id) {
    return runs.stop(user(auth), id);
  }

  @GetMapping("/api/runs/{id}/media/{assetId}")
  ResponseEntity<byte[]> media(
      Authentication auth,
      @PathVariable UUID id,
      @PathVariable String assetId,
      @RequestHeader(value = "Range", required = false) String range) {
    store.owned(user(auth), id);
    var material = materials.asset(id, assetId);
    return MediaRanges.response(material.bytes(), material.asset().mimeType(), range);
  }
}
