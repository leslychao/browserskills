package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.net.*;
import java.net.http.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import tools.jackson.databind.JsonNode;

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
      "spring.profiles.active=dev",
      "server.ssl.enabled=false",
      "server.address=127.0.0.1"
    })
class ServerIT {
  @DynamicPropertySource
  static void db(DynamicPropertyRegistry registry) {
    var p = PostgresFixture.POSTGRES;
    registry.add("spring.datasource.url", p::getJdbcUrl);
    registry.add("spring.datasource.username", p::getUsername);
    registry.add("spring.datasource.password", p::getPassword);
  }

  @LocalServerPort int port;
  @Autowired Store store;
  @Autowired JdbcTemplate db;
  @Autowired PasswordEncoder encoder;
  @Autowired Materials materials;
  @Autowired ManualLeases leases;
  @Autowired LoginRateLimiter limiter;
  @MockitoBean WorkerClient worker;
  @MockitoBean InferenceClient model;
  private final AtomicInteger task = new AtomicInteger(1), clicks = new AtomicInteger();
  private final AtomicReference<String> instruction = new AtomicReference<>("a".repeat(64));
  private HttpClient client;
  private UUID user;
  private String csrf;

  @BeforeEach
  void setup() {
    ((Map<?, ?>) org.springframework.test.util.ReflectionTestUtils.getField(limiter, "attempts"))
        .clear();
    db.execute("TRUNCATE users CASCADE");
    user = store.provision("alice", encoder.encode("test-password-123"));
    client =
        HttpClient.newBuilder()
            .cookieHandler(new CookieManager(null, CookiePolicy.ACCEPT_ALL))
            .build();
    task.set(1);
    clicks.set(0);
    instruction.set("a".repeat(64));
    when(worker.status(anyInt())).thenReturn(status("IDLE"));
    when(worker.command(
            anyInt(),
            anyString(),
            nullable(String.class),
            nullable(UUID.class),
            nullable(Contracts.SubmitPayload.class),
            any()))
        .thenAnswer(
            call -> {
              String type = call.getArgument(1);
              return switch (type) {
                case "SNAPSHOT" -> snapshot();
                case "SUBMIT" -> {
                  clicks.incrementAndGet();
                  task.incrementAndGet();
                  yield new Contracts.SubmitResult("SUBMITTED", "task-" + task.get(), null);
                }
                case "BEGIN" -> status("AUTOMATION");
                case "ENTER_MANUAL" -> status("MANUAL");
                case "STOP", "CLOSE" -> status("CLOSED");
                default -> status("IDLE");
              };
            });
    when(model.analyze(any(), any())).thenReturn(new Contracts.Decision("ANSWER", "a"));
  }

  private Contracts.BrowserStatus status(String mode) {
    return new Contracts.BrowserStatus(
        "browser-1", "generation", mode, "https://tasks.yandex.ru/task", "run");
  }

  private Contracts.TaskSnapshot snapshot() {
    var s = SnapshotValidationTest.snapshot("task-" + task.get());
    return new Contracts.TaskSnapshot(
        s.projectId(),
        s.taskId(),
        s.question(),
        new Contracts.InstructionBundle("rules", instruction.get(), s.instruction().blocks()),
        null,
        null,
        s.options(),
        SnapshotValidation.sha256((s.taskId() + instruction.get()).getBytes()),
        null,
        "v1");
  }

  private URI uri(String path) {
    return URI.create("http://127.0.0.1:" + port + path);
  }

  private HttpResponse<String> request(String method, String path, Object body) throws Exception {
    var b = HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(10));
    if (csrf != null) b.header("X-CSRF-TOKEN", csrf);
    if (body == null) b.method(method, HttpRequest.BodyPublishers.noBody());
    else
      b.header("Content-Type", "application/json")
          .method(
              method, HttpRequest.BodyPublishers.ofString(Json.mapper().writeValueAsString(body)));
    return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
  }

  private JsonNode json(HttpResponse<String> response) {
    return Json.mapper().readTree(response.body());
  }

  private void login() throws Exception {
    csrf = json(request("GET", "/api/auth/csrf", null)).path("token").asString();
    assertEquals(
        200,
        request(
                "POST",
                "/api/auth/login",
                Map.of("login", "alice", "password", "test-password-123"))
            .statusCode());
    csrf = json(request("GET", "/api/auth/csrf", null)).path("token").asString();
  }

  private JsonNode await(UUID id, String state) throws Exception {
    for (int i = 0; i < 100; i++) {
      var response = request("GET", "/api/runs/" + id, null);
      assertEquals(200, response.statusCode(), response.body());
      var node = json(response);
      if (node.path("status").asString().equals(state)) return node;
      if (List.of("FAILED", "UNKNOWN").contains(node.path("status").asString()))
        fail(node.toString());
      Thread.sleep(30);
    }
    throw new AssertionError("run did not reach " + state);
  }

  private Map<String, Object> confirm(JsonNode current, UUID request) {
    return Map.of(
        "requestId",
        request,
        "taskId",
        current.path("taskId").asString(),
        "snapshotHash",
        current.path("snapshotHash").asString(),
        "instructionHash",
        current.path("instruction").path("hash").asString(),
        "optionId",
        "a",
        "confirmationNonce",
        current.path("confirmationNonce").asString());
  }

  @Test
  void websocketRequiresOriginAndLeaseAndRevokesAnExistingRfbConnectionOnLogout() throws Exception {
    login();
    URI websocket = URI.create("ws://127.0.0.1:" + port + "/api/browser/view");
    assertThrows(
        Exception.class,
        () ->
            client
                .newWebSocketBuilder()
                .header("Origin", "https://foreign.example")
                .subprotocols("binary")
                .buildAsync(websocket, new WebSocket.Listener() {})
                .get(3, java.util.concurrent.TimeUnit.SECONDS));
    assertThrows(
        Exception.class,
        () ->
            client
                .newWebSocketBuilder()
                .header("Origin", "http://127.0.0.1:8080")
                .subprotocols("binary")
                .buildAsync(websocket, new WebSocket.Listener() {})
                .get(3, java.util.concurrent.TimeUnit.SECONDS));
    try (var peer = new RawWebSocketPeer()) {
      when(worker.uri(1, "/internal/view")).thenReturn(peer.uri());
      when(worker.token(1)).thenReturn("worker-fixture-secret");
      assertEquals(200, request("POST", "/api/browser/manual-control", null).statusCode());
      var greeting = new java.util.concurrent.CompletableFuture<byte[]>();
      var closed = new java.util.concurrent.CompletableFuture<Integer>();
      WebSocket connection =
          client
              .newWebSocketBuilder()
              .header("Origin", "http://127.0.0.1:8080")
              .subprotocols("binary")
              .buildAsync(
                  websocket,
                  new WebSocket.Listener() {
                    public void onOpen(WebSocket socket) {
                      socket.request(1);
                    }

                    public java.util.concurrent.CompletionStage<?> onBinary(
                        WebSocket socket, java.nio.ByteBuffer data, boolean last) {
                      byte[] bytes = new byte[data.remaining()];
                      data.get(bytes);
                      greeting.complete(bytes);
                      socket.request(1);
                      return null;
                    }

                    public java.util.concurrent.CompletionStage<?> onClose(
                        WebSocket socket, int code, String reason) {
                      closed.complete(code);
                      return null;
                    }
                  })
              .get(5, java.util.concurrent.TimeUnit.SECONDS);
      assertEquals(
          "RFB 003.008\n", new String(greeting.get(5, java.util.concurrent.TimeUnit.SECONDS)));
      connection
          .sendBinary(java.nio.ByteBuffer.wrap("client-input".getBytes()), true)
          .get(2, java.util.concurrent.TimeUnit.SECONDS);
      assertEquals(
          "client-input", new String(peer.input.get(2, java.util.concurrent.TimeUnit.SECONDS)));
      assertEquals("Bearer worker-fixture-secret", peer.authorization.get());
      assertEquals(204, request("POST", "/api/auth/logout", null).statusCode());
      assertEquals(1008, closed.get(3, java.util.concurrent.TimeUnit.SECONDS));
    }
  }

  @Test
  void cookieCsrfLoginDisabledUserAndLogoutBoundaries() throws Exception {
    assertEquals(200, request("GET", "/health/live", null).statusCode());
    assertEquals(401, request("GET", "/api/me", null).statusCode());
    assertEquals(
        403,
        request(
                "POST",
                "/api/auth/login",
                Map.of("login", "alice", "password", "test-password-123"))
            .statusCode());
    login();
    assertEquals("alice", json(request("GET", "/api/me", null)).path("login").asString());
    assertEquals(200, request("POST", "/api/browser", null).statusCode());
    assertEquals(200, request("GET", "/api/browser", null).statusCode());
    assertEquals(200, request("POST", "/api/browser/manual-control", null).statusCode());
    assertEquals(200, request("DELETE", "/api/browser/manual-control", null).statusCode());
    assertEquals(204, request("POST", "/api/auth/logout", null).statusCode());
    assertEquals(401, request("GET", "/api/me", null).statusCode());
    login();
    store.disable("alice");
    assertEquals(401, request("GET", "/api/me", null).statusCode());
  }

  @Test
  void confirmedRunUsesFirstTaskOnceAndDuplicateConfirmDoesNotSendAgain() throws Exception {
    login();
    UUID requestId = UUID.randomUUID();
    var started = request("POST", "/api/runs", new Contracts.StartRun(requestId, 3));
    assertEquals(200, started.statusCode(), started.body());
    UUID id = UUID.fromString(json(started).path("id").asString());
    assertEquals(
        id.toString(),
        json(request("POST", "/api/runs", new Contracts.StartRun(requestId, 3)))
            .path("id")
            .asString());
    for (int n = 1; n <= 3; n++) {
      var current = await(id, "AWAITING_CONFIRMATION").path("current");
      assertEquals("task-" + n, current.path("taskId").asString());
      var confirmation = confirm(current, UUID.randomUUID());
      assertEquals(200, request("POST", "/api/runs/" + id + "/confirm", confirmation).statusCode());
      assertEquals(200, request("POST", "/api/runs/" + id + "/confirm", confirmation).statusCode());
    }
    var done = await(id, "COMPLETED");
    assertEquals(3, clicks.get());
    assertEquals(3, done.path("processed").asInt());
    assertTrue(done.path("current").isNull());
    assertEquals(1, json(request("GET", "/api/runs", null)).size());
  }

  @Test
  void changedInstructionsInvalidateConfirmationAndStopIsFinal() throws Exception {
    login();
    UUID id =
        UUID.fromString(
            json(request("POST", "/api/runs", new Contracts.StartRun(UUID.randomUUID(), 3)))
                .path("id")
                .asString());
    var current = await(id, "AWAITING_CONFIRMATION").path("current");
    instruction.set("c".repeat(64));
    var stale =
        request("POST", "/api/runs/" + id + "/confirm", confirm(current, UUID.randomUUID()));
    assertEquals(409, stale.statusCode(), stale.body());
    assertEquals(0, clicks.get());
    var refreshed = await(id, "AWAITING_CONFIRMATION");
    assertEquals(
        "c".repeat(64), refreshed.path("current").path("instruction").path("hash").asString());
    assertEquals(
        "STOPPED",
        json(request("POST", "/api/runs/" + id + "/stop", null)).path("status").asString());
    assertEquals(
        409,
        request(
                "POST",
                "/api/runs/" + id + "/confirm",
                confirm(refreshed.path("current"), UUID.randomUUID()))
            .statusCode());
  }

  @Test
  void unavailableModelAllowsManualReviewAndForeignMediaIsHidden() throws Exception {
    when(model.analyze(any(), any()))
        .thenThrow(new ApiException(503, "MODEL_UNAVAILABLE", "Unavailable"));
    login();
    UUID id =
        UUID.fromString(
            json(request("POST", "/api/runs", new Contracts.StartRun(UUID.randomUUID(), 1)))
                .path("id")
                .asString());
    var current = await(id, "AWAITING_CONFIRMATION").path("current");
    assertEquals("MODEL_UNAVAILABLE", current.path("aiError").path("code").asString());
    assertTrue(current.path("proposal").isNull());
    UUID foreign = store.provision("bob", "hash");
    UUID otherRun = store.create(foreign, new Contracts.StartRun(UUID.randomUUID(), 1)).run().id();
    assertEquals(404, request("GET", "/api/runs/" + otherRun, null).statusCode());
    assertEquals(404, request("GET", "/api/runs/" + otherRun + "/media/secret", null).statusCode());
    assertEquals(404, request("GET", "/api/runs/" + id + "/media/missing", null).statusCode());
    request("POST", "/api/runs/" + id + "/stop", null);
  }
}
