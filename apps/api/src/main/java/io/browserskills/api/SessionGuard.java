package io.browserskills.api;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.*;
import java.time.*;
import java.util.*;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

final class SessionGuard extends OncePerRequestFilter {
  private final Store store;
  private final ManualLeases leases;
  private final Clock clock;
  private final JsonMapper json;

  SessionGuard(Store store, ManualLeases leases, Clock clock, JsonMapper json) {
    this.store = store;
    this.leases = leases;
    this.clock = clock;
    this.json = json;
  }

  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    var auth = SecurityContextHolder.getContext().getAuthentication();
    if (auth != null && auth.isAuthenticated() && !"anonymousUser".equals(auth.getName())) {
      var session = request.getSession(false);
      boolean valid = false;
      try {
        valid =
            session != null
                && session.getAttribute("authenticatedAt") instanceof Instant at
                && at.plusSeconds(3600).isAfter(clock.instant());
        if (valid) store.user(UUID.fromString(auth.getName()));
      } catch (Exception e) {
        valid = false;
      }
      if (!valid) {
        if (session != null) {
          leases.revokeSession(session.getId());
          session.invalidate();
        }
        SecurityContextHolder.clearContext();
        SecurityConfiguration.error(response, 401, "SESSION_EXPIRED", "Sign in again.", json);
        return;
      }
    }
    if (request.getContentLengthLong() > 32768) {
      SecurityConfiguration.error(
          response, 413, "REQUEST_TOO_LARGE", "Request body is too large.", json);
      return;
    }
    if (Set.of("POST", "PUT", "PATCH", "DELETE").contains(request.getMethod())) {
      byte[] body = request.getInputStream().readNBytes(32769);
      if (body.length > 32768) {
        SecurityConfiguration.error(
            response, 413, "REQUEST_TOO_LARGE", "Request body is too large.", json);
        return;
      }
      request = new BodyRequest(request, body);
    }
    chain.doFilter(request, response);
  }

  static final class BodyRequest extends HttpServletRequestWrapper {
    private final byte[] body;

    BodyRequest(HttpServletRequest request, byte[] body) {
      super(request);
      this.body = body;
    }

    public ServletInputStream getInputStream() {
      var input = new ByteArrayInputStream(body);
      return new ServletInputStream() {
        public int read() {
          return input.read();
        }

        public int read(byte[] buffer, int offset, int count) {
          return input.read(buffer, offset, count);
        }

        public boolean isFinished() {
          return input.available() == 0;
        }

        public boolean isReady() {
          return true;
        }

        public void setReadListener(ReadListener listener) {
          throw new UnsupportedOperationException("Request body uses blocking servlet IO.");
        }
      };
    }

    public BufferedReader getReader() {
      return new BufferedReader(
          new InputStreamReader(getInputStream(), java.nio.charset.StandardCharsets.UTF_8));
    }

    public int getContentLength() {
      return body.length;
    }

    public long getContentLengthLong() {
      return body.length;
    }
  }
}
