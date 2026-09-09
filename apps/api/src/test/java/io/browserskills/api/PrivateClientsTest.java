package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.*;
import org.springframework.mock.env.MockEnvironment;

class PrivateClientsTest {
  private HttpServer server;
  private String base;
  private final AtomicReference<byte[]> reply = new AtomicReference<>();
  private final AtomicReference<Integer> status = new AtomicReference<>(200);
  private final AtomicReference<String> requestBody = new AtomicReference<>();
  private final AtomicReference<String> token = new AtomicReference<>();
  private final AtomicReference<Function<String, String>> responseFunction =
      new AtomicReference<>();
  private ExecutorService requests;

  @BeforeEach
  void setup() throws Exception {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    requests = Executors.newFixedThreadPool(4);
    server.setExecutor(requests);
    server.createContext(
        "/",
        exchange -> {
          String body =
              new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
          requestBody.set(body);
          token.set(exchange.getRequestHeaders().getFirst("Authorization"));
          var function = responseFunction.get();
          byte[] response =
              function == null
                  ? reply.get()
                  : function.apply(body).getBytes(StandardCharsets.UTF_8);
          exchange.sendResponseHeaders(status.get(), response.length);
          exchange.getResponseBody().write(response);
          exchange.close();
        });
    server.start();
    base = "http://127.0.0.1:" + server.getAddress().getPort();
  }

  @AfterEach
  void close() {
    server.stop(0);
    requests.shutdownNow();
  }

  private void reply(String value) {
    responseFunction.set(null);
    reply.set(value.getBytes(StandardCharsets.UTF_8));
  }

  private List<Contracts.Option> sentOptions(String body) {
    var content = Json.mapper().readTree(body).path("messages").get(1).path("content");
    String block = content.get(content.size() - 1).path("text").asString();
    return Arrays.asList(
        Json.mapper()
            .readValue(block.substring("AVAILABLE OPTIONS:\n".length()), Contracts.Option[].class));
  }

  private String answer(String option) {
    return Json.mapper()
        .writeValueAsString(
            Map.of(
                "choices",
                List.of(
                    Map.of(
                        "finish_reason",
                        "stop",
                        "message",
                        Map.of(
                            "content",
                            Json.mapper()
                                .writeValueAsString(new Contracts.Decision("ANSWER", option)))))));
  }

  @Test
  void opaqueAliasesMapToOriginalIdsAndRejectOriginalOrUnknownReplies() {
    var options =
        List.of(
            new Contracts.Option("o0", "1"),
            new Contracts.Option("o1", "2"),
            new Contracts.Option("o2", "5"));
    var s = SnapshotValidationTest.snapshot("numeric-looking-options");
    var snapshot =
        new Contracts.TaskSnapshot(
            s.projectId(),
            s.taskId(),
            s.question(),
            s.instruction(),
            s.image(),
            s.audio(),
            options,
            s.snapshotHash(),
            s.expiresAt(),
            s.adapterVersion());
    var current = new Materials.Current(UUID.randomUUID(), snapshot, "nonce", Map.of(), null, null);
    var model = new InferenceClient(Json.mapper(), mock(AudioNormalizer.class), base);
    responseFunction.set(body -> answer(sentOptions(body).get(2).id()));
    assertEquals(
        new Contracts.Decision("ANSWER", "o2"), model.analyze(current, Duration.ofSeconds(2)));
    var aliases = sentOptions(requestBody.get());
    assertEquals(List.of("1", "2", "5"), aliases.stream().map(Contracts.Option::label).toList());
    assertEquals(3, aliases.stream().map(Contracts.Option::id).distinct().count());
    assertTrue(aliases.stream().allMatch(o -> o.id().matches("[a-z]{10}")));
    assertEquals(
        aliases.stream().map(Contracts.Option::id).toList(),
        Json.mapper()
            .convertValue(
                Json.mapper()
                    .readTree(requestBody.get())
                    .path("response_format")
                    .path("json_schema")
                    .path("schema")
                    .path("oneOf")
                    .get(0)
                    .path("properties")
                    .path("optionId")
                    .path("enum"),
                List.class));
    assertEquals(options, current.snapshot().options());
    reply(answer("o2"));
    assertEquals(
        "INVALID_MODEL_RESPONSE",
        assertThrows(ApiException.class, () -> model.analyze(current, Duration.ofSeconds(2)))
            .code());
    reply(answer("unknownalias"));
    assertEquals(
        "INVALID_MODEL_RESPONSE",
        assertThrows(ApiException.class, () -> model.analyze(current, Duration.ofSeconds(2)))
            .code());
    reply(
        "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"{\\\"decision\\\":\\\"ABSTAIN\\\"}\"}}]}");
    assertEquals(
        new Contracts.Decision("ABSTAIN", null), model.analyze(current, Duration.ofSeconds(2)));
  }

  @Test
  void concurrentAnalysesKeepMappingsLocalAndCannotReuseAnotherCallsAlias() throws Exception {
    var model = new InferenceClient(Json.mapper(), mock(AudioNormalizer.class), base);
    var received = new ConcurrentHashMap<String, List<Contracts.Option>>();
    var both = new CountDownLatch(2);
    var crossed = new java.util.concurrent.atomic.AtomicBoolean();
    responseFunction.set(
        body -> {
          String question =
              Json.mapper()
                  .readTree(body)
                  .path("messages")
                  .get(1)
                  .path("content")
                  .get(2)
                  .path("text")
                  .asString();
          received.put(question, sentOptions(body));
          both.countDown();
          try {
            if (!both.await(2, TimeUnit.SECONDS))
              throw new IllegalStateException("Parallel request missing");
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
          }
          var options =
              crossed.get()
                  ? received.entrySet().stream()
                      .filter(e -> !e.getKey().equals(question))
                      .findFirst()
                      .orElseThrow()
                      .getValue()
                  : received.get(question);
          return answer(options.get(0).id());
        });
    var first = numericTask("first", "17");
    var second = numericTask("second", "42");
    try (var pool = Executors.newFixedThreadPool(2)) {
      var a = pool.submit(() -> model.analyze(first, Duration.ofSeconds(5)));
      var b = pool.submit(() -> model.analyze(second, Duration.ofSeconds(5)));
      assertEquals("17", a.get(6, TimeUnit.SECONDS).optionId());
      assertEquals("42", b.get(6, TimeUnit.SECONDS).optionId());
      assertEquals(
          4,
          received.values().stream()
              .flatMap(List::stream)
              .map(Contracts.Option::id)
              .distinct()
              .count());
      crossed.set(true);
      assertEquals(
          "INVALID_MODEL_RESPONSE",
          assertThrows(ApiException.class, () -> model.analyze(first, Duration.ofSeconds(5)))
              .code());
    }
  }

  private Materials.Current numericTask(String name, String id) {
    var s = SnapshotValidationTest.snapshot(name);
    var snapshot =
        new Contracts.TaskSnapshot(
            s.projectId(),
            s.taskId(),
            name,
            s.instruction(),
            s.image(),
            s.audio(),
            List.of(new Contracts.Option(id, "1"), new Contracts.Option(id + "0", "2")),
            s.snapshotHash(),
            s.expiresAt(),
            s.adapterVersion());
    return new Materials.Current(UUID.randomUUID(), snapshot, "nonce", Map.of(), null, null);
  }

  @Test
  void privateWorkerRequiresTokenAndValidatesOriginalBytes() {
    var env =
        new MockEnvironment()
            .withProperty("api.workers.1", base)
            .withProperty("worker_1_token", "private-fixture-token");
    var client = new WorkerClient(env, Json.mapper());
    reply(
        "{\"workerId\":\"browser-1\",\"generation\":\"g\",\"mode\":\"IDLE\",\"url\":null,\"runId\":null}");
    assertEquals("IDLE", client.status(1).mode());
    assertEquals("Bearer private-fixture-token", token.get());
    assertEquals(
        "IDLE", client.command(1, "OPEN", null, null, null, Contracts.BrowserStatus.class).mode());
    assertEquals("OPEN", Json.mapper().readTree(requestBody.get()).path("type").asString());
    byte[] media = "original-audio-bytes".getBytes();
    reply.set(media);
    var asset =
        new Contracts.MediaAsset(
            "safe-id", "audio", "audio/wav", media.length, SnapshotValidation.sha256(media), 1000L);
    assertArrayEquals(media, client.media(1, asset));
    reply("changed");
    assertThrows(ApiException.class, () -> client.media(1, asset));
    reply("bad JSON");
    assertEquals(
        "INVALID_WORKER_RESPONSE", assertThrows(ApiException.class, () -> client.status(1)).code());
    status.set(409);
    reply("{\"code\":\"TASK_CHANGED\",\"message\":\"private data\"}");
    assertEquals("TASK_CHANGED", assertThrows(ApiException.class, () -> client.status(1)).code());
    reply("notjson");
    assertThrows(ApiException.class, () -> client.status(1));
    env.setProperty("worker_1_token", "");
    assertEquals(
        "WORKER_NOT_CONFIGURED", assertThrows(ApiException.class, () -> client.status(1)).code());
    assertThrows(IllegalArgumentException.class, () -> client.uri(9, "/"));
  }

  @Test
  void rejectsOversizedPrivateResponse() {
    reply.set(new byte[10000]);
    var response = new BoundedHttp();
    assertThrows(
        ApiException.class,
        () ->
            response.send(
                HttpRequest.newBuilder(URI.create(base)).build(), 128, Duration.ofSeconds(2)));
  }

  @Test
  void modelReceivesEveryInstructionAndOriginalSoundRepresentation() throws Exception {
    var normalizer = mock(AudioNormalizer.class);
    when(normalizer.wav(any(), anyLong(), any())).thenReturn(new byte[] {1, 2, 3});
    var model = new InferenceClient(Json.mapper(), normalizer, base);
    byte[] raw = new byte[] {9, 8};
    var audio =
        new Contracts.MediaAsset(
            "clip", "audio", "audio/mpeg", raw.length, SnapshotValidation.sha256(raw), 1000L);
    var image =
        new Contracts.MediaAsset(
            "example", "image", "image/png", raw.length, SnapshotValidation.sha256(raw), null);
    var basic = SnapshotValidationTest.snapshot("audio-task");
    var s =
        new Contracts.TaskSnapshot(
            "project",
            "audio-task",
            "Identify background sound and emotional prosody",
            new Contracts.InstructionBundle(
                "rules",
                "a".repeat(64),
                List.of(
                    new Contracts.InstructionBlock(
                        "text", "Full rules. Speech alone is insufficient.", null, null),
                    new Contracts.InstructionBlock("image", null, image, "Reference image"),
                    new Contracts.InstructionBlock(
                        "audio", null, audio, "Instruction sound example"))),
            null,
            audio,
            basic.options(),
            "b".repeat(64),
            null,
            "v1");
    var current =
        new Materials.Current(
            UUID.randomUUID(), s, "nonce", Map.of("clip", raw, "example", raw), null, null);
    responseFunction.set(body -> answer(sentOptions(body).get(0).id()));
    assertEquals("a", model.analyze(current, Duration.ofSeconds(2)).optionId());
    String sent = requestBody.get();
    assertEquals(false, Json.mapper().readTree(sent).path("cache_prompt").asBoolean(true));
    assertEquals(
        new org.springframework.core.io.ClassPathResource("decision-system.txt")
            .getContentAsString(StandardCharsets.UTF_8)
            .strip(),
        Json.mapper().readTree(sent).path("messages").get(0).path("content").asString());
    assertTrue(sent.contains("Full rules. Speech alone is insufficient."));
    assertTrue(sent.contains("background sound and emotional prosody"));
    assertTrue(sent.contains("input_audio"));
    assertTrue(sent.contains("data:image/png;base64"));
    assertFalse(sent.contains("tools" + "\":"));
    status.set(413);
    assertEquals(
        "MODEL_CONTEXT_UNSUPPORTED",
        assertThrows(ApiException.class, () -> model.analyze(current, Duration.ofSeconds(2)))
            .code());
    status.set(503);
    assertEquals(
        "MODEL_UNAVAILABLE",
        assertThrows(ApiException.class, () -> model.analyze(current, Duration.ofSeconds(2)))
            .code());
    status.set(200);
    reply("{\"choices\":[{\"finish_reason\":\"length\"}]}");
    assertEquals(
        "INVALID_MODEL_RESPONSE",
        assertThrows(ApiException.class, () -> model.analyze(current, Duration.ofSeconds(2)))
            .code());
  }
}
