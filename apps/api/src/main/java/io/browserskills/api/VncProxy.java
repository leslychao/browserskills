package io.browserskills.api;

import jakarta.annotation.PreDestroy;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.*;
import org.springframework.web.socket.*;
import org.springframework.web.socket.config.annotation.*;
import org.springframework.web.socket.handler.BinaryWebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

@Configuration
@EnableWebSocket
@ConditionalOnWebApplication
public class VncProxy implements WebSocketConfigurer {
  private final Store store;
  private final WorkerClient worker;
  private final ManualLeases leases;
  private final String origin;
  private final Map<String, Link> links = new ConcurrentHashMap<>();
  private final Map<UUID, Object> connectionLocks = new ConcurrentHashMap<>();
  private final ScheduledExecutorService timer =
      Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().name("vnc-expiry").factory());
  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

  private static final class Link {
    final WebSocketSession browser;
    final String session;
    final UUID user;
    final AtomicBoolean closed = new AtomicBoolean();
    volatile java.net.http.WebSocket upstream;
    volatile CompletableFuture<java.net.http.WebSocket> pending;

    Link(WebSocketSession browser, String session, UUID user) {
      this.browser = browser;
      this.session = session;
      this.user = user;
    }

    WebSocketSession browser() {
      return browser;
    }

    String session() {
      return session;
    }

    UUID user() {
      return user;
    }

    java.net.http.WebSocket upstream() {
      return upstream;
    }
  }

  public VncProxy(
      Store store,
      WorkerClient worker,
      ManualLeases leases,
      @Value("${api.public-origin}") String origin) {
    this.store = store;
    this.worker = worker;
    this.leases = leases;
    this.origin = origin;
    leases.onRevoke(
        session ->
            links.values().stream()
                .filter(l -> l.session().equals(session))
                .toList()
                .forEach(this::close));
    timer.scheduleWithFixedDelay(
        () ->
            links
                .values()
                .forEach(
                    l -> {
                      if (!valid(l)) close(l);
                    }),
        1,
        1,
        TimeUnit.SECONDS);
  }

  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry
        .addHandler(new Handler(), "/api/browser/view")
        .setAllowedOrigins(origin)
        .addInterceptors(
            new HandshakeInterceptor() {
              public boolean beforeHandshake(
                  ServerHttpRequest request,
                  ServerHttpResponse response,
                  WebSocketHandler handler,
                  Map<String, Object> attributes) {
                try {
                  if (!origin.equals(request.getHeaders().getOrigin())
                      || !(request instanceof ServletServerHttpRequest servlet)) return false;
                  var session = servlet.getServletRequest().getSession(false);
                  if (session == null) return false;
                  UUID user = store.localWorkspace().id();
                  store.user(user);
                  var controlId =
                      UUID.fromString(servlet.getServletRequest().getParameter("controlId"));
                  var controller = ManualLeases.controller(session.getId(), controlId);
                  leases.lease(user, controller);
                  attributes.put("session", controller);
                  attributes.put("user", user);
                  return true;
                } catch (Exception e) {
                  return false;
                }
              }

              public void afterHandshake(
                  ServerHttpRequest request,
                  ServerHttpResponse response,
                  WebSocketHandler handler,
                  Exception exception) {}
            });
  }

  private boolean valid(Link link) {
    try {
      return link.browser().isOpen() && leases.valid(link.user(), link.session());
    } catch (Exception e) {
      return false;
    }
  }

  private void close(Link link) {
    close(link, "CONTROL_ENDED");
  }

  private void close(Link link, String reason) {
    if (!link.closed.compareAndSet(false, true)) return;
    links.remove(link.browser().getId(), link);
    if (link.pending != null) link.pending.cancel(true);
    if (link.upstream() != null) link.upstream().abort();
    try {
      org.slf4j.LoggerFactory.getLogger(VncProxy.class).info("Browser view closed: {}", reason);
      link.browser().close(CloseStatus.POLICY_VIOLATION.withReason(reason));
    } catch (Exception ignored) {
    }
  }

  private final class Handler extends BinaryWebSocketHandler implements SubProtocolCapable {
    public List<String> getSubProtocols() {
      return List.of("binary");
    }

    public void afterConnectionEstablished(WebSocketSession browser) {
      browser.setBinaryMessageSizeLimit(1024 * 1024);
      UUID user = (UUID) browser.getAttributes().get("user");
      String session = (String) browser.getAttributes().get("session");
      var lease = leases.lease(user, session);
      URI http = worker.uri(lease.worker(), "/internal/view");
      URI ws =
          URI.create(
              (http.getScheme().equals("https") ? "wss" : "ws")
                  + "://"
                  + http.getRawAuthority()
                  + http.getRawPath());
      var pending = new Link(browser, session, user);
      synchronized (connectionLocks.computeIfAbsent(user, ignored -> new Object())) {
        if (links.values().stream().anyMatch(link -> link.user().equals(user))) {
          close(pending, "VIEW_ALREADY_CONNECTED");
          return;
        }
        if (!browser.isOpen() || !leases.valid(user, session)) return;
        links.put(browser.getId(), pending);
        pending.pending =
            client
                .newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .header("Authorization", "Bearer " + worker.token(lease.worker()))
                .subprotocols("binary")
                .buildAsync(
                    ws,
                    new java.net.http.WebSocket.Listener() {
                      public void onOpen(java.net.http.WebSocket upstream) {
                        pending.upstream = upstream;
                        if (links.get(browser.getId()) != pending
                            || pending.closed.get()
                            || !valid(pending)) {
                          upstream.abort();
                          close(pending);
                          return;
                        }
                        upstream.request(1);
                      }

                      public CompletionStage<?> onBinary(
                          java.net.http.WebSocket socket, ByteBuffer bytes, boolean last) {
                        var link = links.get(browser.getId());
                        if (link == null || !valid(link) || bytes.remaining() > 1024 * 1024) {
                          socket.abort();
                          if (link != null) close(link);
                          return null;
                        }
                        try {
                          synchronized (browser) {
                            browser.sendMessage(new BinaryMessage(bytes));
                          }
                          socket.request(1);
                        } catch (Exception e) {
                          close(link);
                        }
                        return null;
                      }

                      public CompletionStage<?> onText(
                          java.net.http.WebSocket socket, CharSequence data, boolean last) {
                        socket.abort();
                        close(pending);
                        return null;
                      }

                      public CompletionStage<?> onClose(
                          java.net.http.WebSocket socket, int code, String reason) {
                        var link = links.get(browser.getId());
                        if (link != null) close(link, "UPSTREAM_CLOSED");
                        return null;
                      }

                      public void onError(java.net.http.WebSocket socket, Throwable error) {
                        var link = links.get(browser.getId());
                        if (link != null) close(link, "UPSTREAM_ERROR");
                      }
                    });
        if (pending.closed.get() || !browser.isOpen()) pending.pending.cancel(true);
        pending.pending.exceptionally(
            error -> {
              close(pending, "UPSTREAM_CONNECT_FAILED");
              return null;
            });
      }
    }

    protected void handleBinaryMessage(WebSocketSession browser, BinaryMessage message) {
      var link = links.get(browser.getId());
      if (link == null || link.upstream() == null || !valid(link)) {
        if (link != null) close(link);
        return;
      }
      try {
        link.upstream().sendBinary(message.getPayload(), true).get(5, TimeUnit.SECONDS);
      } catch (Exception e) {
        close(link);
      }
    }

    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
      var link = links.get(session.getId());
      if (link != null) close(link, "CLIENT_CLOSED_" + status.getCode());
    }

    public void handleTransportError(WebSocketSession session, Throwable error) {
      var link = links.get(session.getId());
      if (link != null) close(link, "CLIENT_TRANSPORT_ERROR");
    }
  }

  @PreDestroy
  void destroy() {
    timer.shutdownNow();
    links.values().forEach(this::close);
  }
}
