package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.*;

class VncPendingTest {
  @Test
  void closingPublicSocketCancelsThePendingPrivateHandshake() throws Exception {
    UUID user = UUID.randomUUID();
    var store = mock(Store.class);
    when(store.user(user)).thenReturn(new Store.User(user, "alice", "hash", true, 1));
    var worker = mock(WorkerClient.class);
    var leases = new ManualLeases(Clock.systemUTC());
    leases.acquire(user, 1, "session", "gen", Instant.now().plusSeconds(60), false);
    var accepted = new CountDownLatch(1);
    var eof = new CompletableFuture<Boolean>();
    var socketRef = new AtomicReference<Socket>();
    try (var server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
        var executor = Executors.newSingleThreadExecutor()) {
      executor.execute(
          () -> {
            try {
              var socket = server.accept();
              socketRef.set(socket);
              socket.setSoTimeout(3000);
              var input = socket.getInputStream();
              var header = new ByteArrayOutputStream();
              while (header.size() < 8192) {
                int b = input.read();
                if (b < 0) throw new EOFException();
                header.write(b);
                if (header.toString(StandardCharsets.ISO_8859_1).endsWith("\r\n\r\n")) break;
              }
              accepted.countDown();
              eof.complete(input.read() == -1);
            } catch (Exception e) {
              eof.completeExceptionally(e);
            }
          });
      when(worker.uri(1, "/internal/view"))
          .thenReturn(URI.create("http://127.0.0.1:" + server.getLocalPort() + "/internal/view"));
      when(worker.token(1)).thenReturn("fixture-token");
      var proxy = new VncProxy(store, worker, leases, "https://app.example");
      var browser = mock(WebSocketSession.class);
      var open = new AtomicBoolean(true);
      when(browser.getAttributes()).thenReturn(Map.of("user", user, "session", "session"));
      when(browser.getId()).thenReturn("browser-socket");
      when(browser.isOpen()).thenAnswer(c -> open.get());
      doAnswer(
              c -> {
                open.set(false);
                return null;
              })
          .when(browser)
          .close(any());
      try {
        var handlerType =
            Arrays.stream(VncProxy.class.getDeclaredClasses())
                .filter(type -> type.getSimpleName().equals("Handler"))
                .findFirst()
                .orElseThrow();
        var ctor = handlerType.getDeclaredConstructor(VncProxy.class);
        ctor.setAccessible(true);
        var handler = (WebSocketHandler) ctor.newInstance(proxy);
        handler.afterConnectionEstablished(browser);
        assertTrue(accepted.await(2, TimeUnit.SECONDS));
        var duplicate = mock(WebSocketSession.class);
        when(duplicate.getAttributes()).thenReturn(Map.of("user", user, "session", "session"));
        when(duplicate.getId()).thenReturn("duplicate-socket");
        when(duplicate.isOpen()).thenReturn(true);
        handler.afterConnectionEstablished(duplicate);
        verify(duplicate).close(CloseStatus.POLICY_VIOLATION.withReason("VIEW_ALREADY_CONNECTED"));
        verify(browser, never()).close(any());
        open.set(false);
        handler.afterConnectionClosed(browser, CloseStatus.NORMAL);
        assertTrue(eof.get(2, TimeUnit.SECONDS));
      } finally {
        proxy.destroy();
        if (socketRef.get() != null) socketRef.get().close();
      }
    }
  }
}
