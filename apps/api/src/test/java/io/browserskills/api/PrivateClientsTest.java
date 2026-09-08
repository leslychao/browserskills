package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.*;
import org.springframework.mock.env.MockEnvironment;

class PrivateClientsTest {
  private HttpServer server;
  private String base;
  private final AtomicReference<byte[]> reply = new AtomicReference<>();
  private final AtomicReference<Integer> status = new AtomicReference<>(200);
  private final AtomicReference<String> requestBody = new AtomicReference<>();
  private final AtomicReference<String> token = new AtomicReference<>();

  @BeforeEach
  void setup() throws Exception {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/",
        exchange -> {
          requestBody.set(
              new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
          token.set(exchange.getRequestHeaders().getFirst("Authorization"));
          byte[] response = reply.get();
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
  }

  private void reply(String value) {
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

  @Test
  void modelReceivesEveryInstructionAndOriginalSoundRepresentation() {
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
    reply(
        "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":\"{\\\"decision\\\":\\\"ANSWER\\\",\\\"optionId\\\":\\\"a\\\"}\"}}]}");
    assertEquals("a", model.analyze(current, Duration.ofSeconds(2)).optionId());
    String sent = requestBody.get();
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
