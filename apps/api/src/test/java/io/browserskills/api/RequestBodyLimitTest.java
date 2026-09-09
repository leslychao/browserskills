package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.*;

class RequestBodyLimitTest {
  @Test
  void anonymousRequestPassesAndChunkedOversizeIsRejected() throws Exception {
    var request = new MockHttpServletRequest("POST", "/api/runs");
    request.setContent("{}".getBytes());
    var chain = new MockFilterChain();
    var guard = new RequestBodyLimit(Json.mapper());
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
    large.setContent(new byte[32769]);
    var rejected = new MockHttpServletResponse();
    guard.doFilter(large, rejected, new MockFilterChain());
    assertEquals(413, rejected.getStatus());
  }
}
