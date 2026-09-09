package io.browserskills.api;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.*;
import java.time.*;
import java.util.*;
import org.springframework.web.filter.OncePerRequestFilter;
import tools.jackson.databind.json.JsonMapper;

final class RequestBodyLimit extends OncePerRequestFilter {
  private final JsonMapper json;

  RequestBodyLimit(JsonMapper json) {
    this.json = json;
  }

  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
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
