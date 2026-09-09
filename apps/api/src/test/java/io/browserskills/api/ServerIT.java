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
  @MockitoBean WorkerClient worker;
  @MockitoBean InferenceClient model;
  @MockitoBean QualityGates gates;
  private final AtomicBoolean applied = new AtomicBoolean();
  private final AtomicReference<String> yangState = new AtomicReference<>("READY");
  private final AtomicInteger task = new AtomicInteger(1), clicks = new AtomicInteger();
  private final AtomicReference<String> instruction = new AtomicReference<>("a".repeat(64));
  private HttpClient client;
  private UUID user;
  private String csrf;
  private UUID controlId = UUID.randomUUID();

  @Test
  void manualControlRejectsMissingOrInvalidTabIdsWithoutBypassingCsrf() throws Exception {
    prepareBrowserClient();
    for (String method : List.of("GET", "POST", "DELETE")) {
      for (String tab : new String[] {null, "not-a-uuid"}) {
        var request =
            HttpRequest.newBuilder(uri("/api/browser/manual-control"))
                .timeout(Duration.ofSeconds(10))
                .header("X-CSRF-TOKEN", csrf)
                .method(method, HttpRequest.BodyPublishers.noBody());
        if (tab != null) request.header("X-Browser-Control", tab);
        var response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(400, response.statusCode(), method + " tab=" + tab + ": " + response.body());
        assertEquals("INVALID_REQUEST", json(response).path("code").asString());
      }
    }
    for (String method : List.of("POST", "DELETE")) {
      var request =
          HttpRequest.newBuilder(uri("/api/browser/manual-control?takeOver=true"))
              .timeout(Duration.ofSeconds(10))
              .header("X-Browser-Control", controlId.toString())
              .method(method, HttpRequest.BodyPublishers.noBody());
      var response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
      assertEquals(403, response.statusCode(), response.body());
      assertEquals("FORBIDDEN", json(response).path("code").asString());
    }
    verify(worker, never()).command(anyInt(), eq("ENTER_MANUAL"), any(), any(), any(), any());
    verify(worker, never()).command(anyInt(), eq("EXIT_MANUAL"), any(), any(), any(), any());
    assertEquals("AVAILABLE", leases.status(user, "unclaimed").state());
  }

  @Test
  void tabOwnershipRequiresExplicitTakeoverAndRejectsStaleRelease() throws Exception {
    prepareBrowserClient();
    assertEquals(200, request("POST", "/api/browser/manual-control", null).statusCode());
    when(worker.status(1)).thenReturn(status("MANUAL"));
    assertEquals(
        "OWNED",
        json(request("GET", "/api/browser/manual-control", null)).path("state").asString());
    var first = controlId;
    controlId = UUID.randomUUID();
    assertEquals(
        "IN_USE",
        json(request("GET", "/api/browser/manual-control", null)).path("state").asString());
    assertEquals(409, request("POST", "/api/browser/manual-control", null).statusCode());
    assertEquals(403, request("DELETE", "/api/browser/manual-control", null).statusCode());
    assertEquals(
        200, request("POST", "/api/browser/manual-control?takeOver=true", null).statusCode());
    assertEquals(
        "OWNED",
        json(request("GET", "/api/browser/manual-control", null)).path("state").asString());
    var second = controlId;
    controlId = first;
    assertEquals(
        "IN_USE",
        json(request("GET", "/api/browser/manual-control", null)).path("state").asString());
    assertEquals(403, request("DELETE", "/api/browser/manual-control", null).statusCode());
    controlId = second;
    assertEquals(200, request("DELETE", "/api/browser/manual-control", null).statusCode());
    assertEquals(
        "AVAILABLE",
        json(request("GET", "/api/browser/manual-control", null)).path("state").asString());
  }

  @BeforeEach
  void setup() {
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
            nullable(Object.class),
            any()))
        .thenAnswer(
            call -> {
              String type = call.getArgument(1);
              return switch (type) {
                case "YANG_SESSION" -> yang();
                case "CATALOGUE" ->
                    new Contracts.Catalogue(
                        List.of(ProjectSelectionTest.item("pool", "15", "rub")),
                        Instant.now(),
                        "pool",
                        "suite-" + task.get());
                case "INSTRUCTION" -> snapshot().instruction();
                case "SNAPSHOT" -> snapshot();
                case "APPLY" -> {
                  applied.set(true);
                  yield snapshot();
                }
                case "SUBMIT" -> {
                  clicks.incrementAndGet();
                  task.incrementAndGet();
                  applied.set(false);
                  yield new Contracts.SubmitResult("SUBMITTED", "suite-" + task.get(), null);
                }
                case "BEGIN" -> status("AUTOMATION");
                case "ENTER_MANUAL" -> status("MANUAL");
                case "STOP", "CLOSE" -> status("CLOSED");
                default -> status("IDLE");
              };
            });
    when(model.interpret(any(), any(), any(), any()))
        .thenAnswer(
            c ->
                new InstructionCompiler.Interpretation(
                    ((Contracts.InstructionBlock) c.getArgument(1)).id(),
                    "Choose the correct answer",
                    true,
                    false));
    when(model.sources(any(), any(), any(), any()))
        .thenReturn(new InferenceClient.SourceSelection(List.of("rule")));
    when(model.answer(any(), any(), any(), any(), any(), any()))
        .thenReturn(SnapshotValidationTest.answer());
    yangState.set("READY");
    applied.set(false);
    when(gates.allowed(anyString())).thenReturn(true);
  }

  private Contracts.BrowserStatus status(String mode) {
    return new Contracts.BrowserStatus(
        "browser-1",
        "generation",
        mode,
        "https://yang.yandex-team.ru/task/pool/suite",
        null,
        yang());
  }

  private Contracts.TaskSet snapshot() {
    var s = SnapshotValidationTest.snapshot("suite-" + task.get());
    if (!applied.get()) return s;
    var p = s.parts().getFirst();
    var f = p.fields().getFirst();
    var field =
        new Contracts.TaskField(
            f.id(),
            f.label(),
            f.kind(),
            f.required(),
            f.options(),
            "a",
            f.stage(),
            f.maxLength(),
            f.min(),
            f.max());
    return new Contracts.TaskSet(
        s.poolId(),
        s.suiteId(),
        List.of(
            new Contracts.TaskPart(
                p.id(), p.title(), p.text(), p.media(), List.of(field), List.of())),
        s.instruction(),
        s.snapshotHash(),
        null,
        s.adapterVersion());
  }

  private URI uri(String path) {
    return URI.create("http://127.0.0.1:" + port + path);
  }

  private HttpResponse<String> request(String method, String path, Object body) throws Exception {
    var b = HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(10));
    if (path.startsWith("/api/browser/manual-control"))
      b.header("X-Browser-Control", controlId.toString());
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

  private void prepareBrowserClient() throws Exception {
    csrf = json(request("GET", "/api/csrf", null)).path("token").asString();
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

  @Test
  void anonymousWebsocketRequiresOriginAndLeaseAndRevokesConnectionOnManualRelease()
      throws Exception {
    prepareBrowserClient();
    URI websocket =
        URI.create("ws://127.0.0.1:" + port + "/api/browser/view?controlId=" + controlId);
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
      assertEquals(200, request("DELETE", "/api/browser/manual-control", null).statusCode());
      assertEquals(1008, closed.get(3, java.util.concurrent.TimeUnit.SECONDS));
    }
  }

  @Test
  void sharedWorkspaceNeedsNoLoginAndRetainsRequestBounds() throws Exception {
    assertEquals(200, request("GET", "/api/me", null).statusCode());
    assertEquals("alice", json(request("GET", "/api/me", null)).path("login").asString());
    var fresh = HttpClient.newHttpClient();
    assertEquals(
        user.toString(),
        json(fresh.send(
                HttpRequest.newBuilder(uri("/api/me")).GET().build(),
                HttpResponse.BodyHandlers.ofString()))
            .path("id")
            .asString());
    prepareBrowserClient();
    assertEquals(404, request("POST", "/api/auth/login", Map.of()).statusCode());
    assertEquals(404, request("POST", "/api/auth/logout", null).statusCode());
    assertEquals(404, request("GET", "/api/auth/csrf", null).statusCode());
    assertEquals(200, request("POST", "/api/browser", null).statusCode());
    assertEquals(200, request("POST", "/api/browser/manual-control", null).statusCode());
    assertEquals(200, request("DELETE", "/api/browser/manual-control", null).statusCode());
    store.disable("alice");
    assertEquals(200, request("GET", "/api/me", null).statusCode());
  }

  private Contracts.YangSession yang() {
    return new Contracts.YangSession(
        yangState.get(), Instant.now(), null, "pool", "suite-" + task.get());
  }

  @Test
  void autonomousRunSendsWholeSuitesAndRemovedConfirmEndpointCannotSend() throws Exception {
    prepareBrowserClient();
    var request = SnapshotValidationTest.start(3);
    var started = request("POST", "/api/runs", request);
    assertEquals(200, started.statusCode(), started.body());
    UUID run = UUID.fromString(json(started).path("id").asString());
    var completed = await(run, "COMPLETED");
    assertEquals(3, completed.path("processed").asInt());
    assertEquals(3, clicks.get());
    assertEquals(run.toString(), json(request("POST", "/api/runs", request)).path("id").asString());
    assertEquals(3, clicks.get());
    assertEquals(404, request("POST", "/api/runs/" + run + "/confirm", Map.of()).statusCode());
    assertEquals(3, clicks.get());
  }

  @Test
  void twoFactorPauseAndResumeRetainOneActiveRun() throws Exception {
    prepareBrowserClient();
    yangState.set("TWO_FACTOR_REQUIRED");
    var started = request("POST", "/api/runs", SnapshotValidationTest.start(1));
    UUID run = UUID.fromString(json(started).path("id").asString());
    await(run, "WAITING_FOR_AUTH");
    assertEquals(0, clicks.get());
    assertEquals(200, request("POST", "/api/browser/manual-control", null).statusCode());
    assertEquals(409, request("POST", "/api/runs", SnapshotValidationTest.start(1)).statusCode());
    assertEquals(409, request("POST", "/api/runs/" + run + "/resume", null).statusCode());
    yangState.set("READY");
    assertEquals(200, request("POST", "/api/runs/" + run + "/resume", null).statusCode());
    await(run, "COMPLETED");
    assertEquals(1, clicks.get());
  }

  @Test
  void selectionAndCatalogueAreOwnedAndUnverifiedQualityNeverSubmits() throws Exception {
    prepareBrowserClient();
    assertEquals(200, request("GET", "/api/yang/session", null).statusCode());
    assertEquals(200, request("POST", "/api/yang/catalogue/refresh", null).statusCode());
    assertEquals(
        200,
        request("PUT", "/api/yang/selection", Contracts.SelectionSettings.defaults()).statusCode());
    assertEquals(
        "MANUAL", json(request("GET", "/api/yang/selection", null)).path("mode").asString());
    doThrow(new ApiException(409, "QUALITY_NOT_VERIFIED", "Quality gate blocked"))
        .when(gates)
        .require(any());
    UUID run =
        UUID.fromString(
            json(request("POST", "/api/runs", SnapshotValidationTest.start(1)))
                .path("id")
                .asString());
    var failed = await(run, "WAITING_FOR_USER");
    assertEquals("QUALITY_NOT_VERIFIED", failed.path("error").path("code").asString());
    assertEquals(0, clicks.get());
    UUID foreign = store.provision("bob", "hash");
    UUID foreignRun = store.create(foreign, SnapshotValidationTest.start(1)).run().id();
    assertEquals(404, request("GET", "/api/runs/" + foreignRun, null).statusCode());
    assertEquals(404, request("GET", "/api/runs/" + foreignRun + "/media/x", null).statusCode());
    store.stop(foreign, foreignRun);
  }

  @Test
  void failedInstructionBeforeReservationSkipsToNextAutoCandidate() throws Exception {
    prepareBrowserClient();
    var catalogue =
        new Contracts.Catalogue(
            List.of(
                ProjectSelectionTest.item("high", "20", "rub"),
                ProjectSelectionTest.item("pool", "15", "rub")),
            Instant.now(),
            null,
            null);
    when(worker.command(
            anyInt(),
            eq("CATALOGUE"),
            anyString(),
            any(UUID.class),
            any(),
            eq(Contracts.Catalogue.class)))
        .thenReturn(catalogue);
    when(worker.command(
            anyInt(),
            eq("INSTRUCTION"),
            anyString(),
            any(UUID.class),
            eq(Map.of("poolId", "high")),
            eq(Contracts.InstructionBundle.class)))
        .thenThrow(new ApiException(422, "INSTRUCTION_UNAVAILABLE", "Unavailable"));
    var selection =
        new Contracts.SelectionSettings(
            "AUTO", null, List.of(), List.of(), null, List.of("text"), false, false);
    UUID run =
        UUID.fromString(
            json(request(
                    "POST", "/api/runs", new Contracts.StartRun(UUID.randomUUID(), 1, selection)))
                .path("id")
                .asString());
    assertEquals(1, await(run, "COMPLETED").path("processed").asInt());
    assertEquals(1, clicks.get());
    verify(worker, never())
        .command(
            anyInt(),
            eq("SELECT_PROJECT"),
            anyString(),
            any(UUID.class),
            eq(Map.of("poolId", "high")),
            any());
    verify(worker)
        .command(
            anyInt(),
            eq("SELECT_PROJECT"),
            anyString(),
            any(UUID.class),
            eq(Map.of("poolId", "pool")),
            any());
    UUID second =
        UUID.fromString(
            json(request(
                    "POST", "/api/runs", new Contracts.StartRun(UUID.randomUUID(), 1, selection)))
                .path("id")
                .asString());
    assertEquals(1, await(second, "COMPLETED").path("processed").asInt());
    verify(worker, times(2))
        .command(
            anyInt(),
            eq("INSTRUCTION"),
            anyString(),
            any(UUID.class),
            eq(Map.of("poolId", "high")),
            eq(Contracts.InstructionBundle.class));
    when(worker.command(
            anyInt(), eq("CATALOGUE"), isNull(), isNull(), any(), eq(Contracts.Catalogue.class)))
        .thenReturn(catalogue);
    var refreshed = json(request("POST", "/api/yang/catalogue/refresh", null));
    assertEquals("UNPREPARED", refreshed.path("items").get(0).path("preparation").asString());
  }

  @Test
  void knownQualityFailureBlocksCatalogueBeforeAnyInstructionCall() throws Exception {
    prepareBrowserClient();
    when(gates.allowed(anyString())).thenReturn(false);
    var catalogue =
        new Contracts.Catalogue(
            List.of(ProjectSelectionTest.item("pool", "15", "rub")), Instant.now(), null, null);
    when(worker.command(
            anyInt(),
            eq("CATALOGUE"),
            nullable(String.class),
            nullable(UUID.class),
            any(),
            eq(Contracts.Catalogue.class)))
        .thenReturn(catalogue);
    var listing = json(request("POST", "/api/yang/catalogue/refresh", null));
    assertEquals("BLOCKED", listing.path("items").get(0).path("preparation").asString());
    var selection =
        new Contracts.SelectionSettings(
            "MANUAL", "pool", List.of(), List.of(), null, List.of("text"), false, false);
    UUID run =
        UUID.fromString(
            json(request(
                    "POST", "/api/runs", new Contracts.StartRun(UUID.randomUUID(), 1, selection)))
                .path("id")
                .asString());
    await(run, "WAITING_FOR_USER");
    verifyNoInteractions(model);
    assertEquals(0, store.quota(user).used());
    assertEquals(0, clicks.get());
    request("POST", "/api/runs/" + run + "/stop", null);
  }

  @Test
  void lostSubmitResponseIsUnknownAndTheSameSuiteCannotBeSentInAnotherRun() throws Exception {
    prepareBrowserClient();
    when(worker.command(
            anyInt(),
            eq("SUBMIT"),
            anyString(),
            any(UUID.class),
            any(),
            eq(Contracts.SubmitResult.class)))
        .thenThrow(new ApiException(503, "WORKER_UNAVAILABLE", "Lost acknowledgement"));
    UUID run =
        UUID.fromString(
            json(request("POST", "/api/runs", SnapshotValidationTest.start(1)))
                .path("id")
                .asString());
    await(run, "UNKNOWN");
    UUID again =
        UUID.fromString(
            json(request("POST", "/api/runs", SnapshotValidationTest.start(1)))
                .path("id")
                .asString());
    var failed = await(again, "FAILED");
    assertEquals("UNRESOLVED_TASK", failed.path("error").path("code").asString());
    verify(worker, times(1))
        .command(
            anyInt(),
            eq("SUBMIT"),
            anyString(),
            any(UUID.class),
            any(),
            eq(Contracts.SubmitResult.class));
  }

  @Test
  void knownFaceIdentityProjectIsBlockedEvenWithPassingImageCapability() throws Exception {
    prepareBrowserClient();
    when(gates.allowed(anyString())).thenReturn(true);
    var identity =
        new Contracts.CatalogueItem(
            "94777297",
            "Identity comparison",
            new Contracts.Reward("30", "rub"),
            "AVAILABLE",
            "WORK",
            List.of("image"),
            "UNPREPARED",
            null);
    var catalogue = new Contracts.Catalogue(List.of(identity), Instant.now(), null, null);
    when(worker.command(
            anyInt(),
            eq("CATALOGUE"),
            nullable(String.class),
            nullable(UUID.class),
            any(),
            eq(Contracts.Catalogue.class)))
        .thenReturn(catalogue);
    var result = json(request("POST", "/api/yang/catalogue/refresh", null));
    assertEquals("BLOCKED", result.path("items").get(0).path("preparation").asString());
    assertEquals(
        "UNSUPPORTED_IDENTITY_TASK",
        result.path("items").get(0).path("reason").path("code").asString());
    verifyNoInteractions(model);
  }

  @Test
  void expiredReservedSuiteAfterTwoFactorConsumesNoModelCalls() throws Exception {
    prepareBrowserClient();
    yangState.set("TWO_FACTOR_REQUIRED");
    UUID run =
        UUID.fromString(
            json(request("POST", "/api/runs", SnapshotValidationTest.start(1)))
                .path("id")
                .asString());
    await(run, "WAITING_FOR_AUTH");
    var s = SnapshotValidationTest.snapshot("expired");
    var expired =
        new Contracts.TaskSet(
            s.poolId(),
            s.suiteId(),
            s.parts(),
            s.instruction(),
            s.snapshotHash(),
            Instant.now().minusSeconds(30),
            s.adapterVersion());
    var catalogue =
        new Contracts.Catalogue(
            List.of(ProjectSelectionTest.item("pool", "15", "rub")), Instant.now(), "pool", null);
    when(worker.command(
            anyInt(),
            eq("CATALOGUE"),
            anyString(),
            any(UUID.class),
            any(),
            eq(Contracts.Catalogue.class)))
        .thenReturn(catalogue);
    when(worker.command(
            anyInt(),
            eq("SNAPSHOT"),
            anyString(),
            any(UUID.class),
            isNull(),
            eq(Contracts.TaskSet.class)))
        .thenReturn(expired);
    yangState.set("READY");
    assertEquals(200, request("POST", "/api/runs/" + run + "/resume", null).statusCode());
    assertEquals("TASK_EXPIRED", await(run, "FAILED").path("error").path("code").asString());
    verifyNoInteractions(model);
    assertEquals(0, store.quota(user).used());
    assertEquals(0, clicks.get());
    verify(worker)
        .command(
            anyInt(),
            eq("SELECT_PROJECT"),
            anyString(),
            any(UUID.class),
            eq(Map.of("poolId", "pool")),
            eq(Contracts.BrowserStatus.class));
  }
}
