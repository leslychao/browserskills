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

  private String envelope(Object value) {
    return Json.mapper()
        .writeValueAsString(
            Map.of(
                "choices",
                List.of(
                    Map.of(
                        "finish_reason",
                        "stop",
                        "message",
                        Map.of("content", Json.mapper().writeValueAsString(value))))));
  }

  @Test
  void modelRequiresStructuredCompleteSourcesAndSendsStageOnly() {
    var materials = new Materials();
    UUID user = UUID.randomUUID(), run = UUID.randomUUID();
    materials.begin(user, run);
    var model = new InferenceClient(Json.mapper(), mock(AudioNormalizer.class), materials, base);
    var task = SnapshotValidationTest.snapshot("suite");
    var source = task.instruction().blocks().getFirst();
    reply(envelope(new InstructionCompiler.Interpretation("rule", "Complete rule", true, false)));
    assertTrue(model.interpret(run, source, "", Duration.ofSeconds(2)).complete());
    assertTrue(requestBody.get().contains("Choose the correct letter"));
    var prepared =
        new InstructionCompiler.Compiled(
            task.instruction().hash(),
            List.of(new InstructionCompiler.Section("rule", source, "Complete rule", false)),
            false);
    reply(envelope(new InferenceClient.SourceSelection(List.of("rule"))));
    assertEquals(
        List.of("rule"),
        model
            .sources(
                task.parts().getFirst(),
                task.parts().getFirst().fields(),
                prepared,
                Duration.ofSeconds(2))
            .sourceIds());
    reply(envelope(SnapshotValidationTest.answer()));
    var answer =
        model.answer(
            run,
            task.parts().getFirst(),
            task.parts().getFirst().fields(),
            prepared,
            List.of("rule"),
            Duration.ofSeconds(2));
    assertEquals("ANSWER", answer.decision());
    assertTrue(requestBody.get().contains("ORIGINAL SOURCE rule"));
    assertTrue(requestBody.get().contains("cache_prompt"));
    status.set(400);
    assertEquals(
        "MODEL_CONTEXT_UNSUPPORTED",
        assertThrows(
                ApiException.class, () -> model.interpret(run, source, "", Duration.ofSeconds(2)))
            .code());
    status.set(200);
    reply("{}");
    assertEquals(
        "INVALID_MODEL_RESPONSE",
        assertThrows(
                ApiException.class, () -> model.interpret(run, source, "", Duration.ofSeconds(2)))
            .code());
    materials.close();
  }

  @Test
  void oversizedSelectedMediaIsRejectedBeforeAnyBytesAreRead() {
    var materials = mock(Materials.class);
    var model = new InferenceClient(Json.mapper(), mock(AudioNormalizer.class), materials, base);
    var s = SnapshotValidationTest.snapshot("suite");
    var media = new ArrayList<Contracts.MediaAsset>();
    for (int i = 0; i < 4; i++)
      media.add(
          new Contracts.MediaAsset(
              "asset" + i, "image", "image/png", 20 * 1024 * 1024, "a".repeat(64), null));
    var p = s.parts().getFirst();
    var part = new Contracts.TaskPart(p.id(), p.title(), p.text(), media, p.fields(), List.of());
    var prepared = new InstructionCompiler.Compiled(s.instruction().hash(), List.of(), false);
    assertThrows(
        ApiException.class,
        () ->
            model.answer(
                UUID.randomUUID(), part, p.fields(), prepared, List.of(), Duration.ofSeconds(2)));
    verifyNoInteractions(materials);
  }
}
