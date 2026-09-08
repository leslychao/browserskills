package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class AnalysisQueueTest {
  @Test
  void oneRunningFourWaitingAndExpiryBeforeItsTurnDoesNotConsumeQuota() throws Exception {
    var store = mock(Store.class);
    var model = mock(InferenceClient.class);
    var started = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    when(store.owned(any(), any()))
        .thenAnswer(
            c ->
                new Store.Run(
                    c.getArgument(1),
                    c.getArgument(0),
                    "ANALYZING",
                    1,
                    0,
                    "gen",
                    null,
                    Instant.now(),
                    Instant.now()));
    when(store.reserveAi(any(), any(), any())).thenReturn(true);
    when(model.analyze(any(), any()))
        .thenAnswer(
            c -> {
              started.countDown();
              release.await(5, TimeUnit.SECONDS);
              return new Contracts.Decision("ANSWER", "a");
            });
    var queue = new AnalysisQueue(store, model, Json.mapper(), Clock.systemUTC(), "modelhash");
    UUID first = UUID.randomUUID();
    var complete = new CompletableFuture<Contracts.Decision>();
    try {
      queue.submit(first, UUID.randomUUID(), current(null), (p, e) -> complete.complete(p));
      assertTrue(started.await(1, TimeUnit.SECONDS));
      var duplicate = new CompletableFuture<Contracts.ApiError>();
      queue.submit(first, UUID.randomUUID(), current(null), (p, e) -> duplicate.complete(e));
      assertEquals("AI_BUSY", duplicate.get(1, TimeUnit.SECONDS).code());
      UUID expiring = UUID.randomUUID();
      var deadline = new CompletableFuture<Contracts.ApiError>();
      queue.submit(
          expiring,
          UUID.randomUUID(),
          current(Instant.now().plusMillis(150)),
          (p, e) -> deadline.complete(e));
      assertEquals("AI_QUEUE_TIMEOUT", deadline.get(1, TimeUnit.SECONDS).code());
      verify(store, never()).reserveAi(eq(expiring), any(), any());
      for (int i = 0; i < 4; i++)
        queue.submit(UUID.randomUUID(), UUID.randomUUID(), current(null), (p, e) -> {});
      var full = new CompletableFuture<Contracts.ApiError>();
      queue.submit(UUID.randomUUID(), UUID.randomUUID(), current(null), (p, e) -> full.complete(e));
      assertEquals("AI_BUSY", full.get(1, TimeUnit.SECONDS).code());
      release.countDown();
      assertEquals("a", complete.get(2, TimeUnit.SECONDS).optionId());
    } finally {
      release.countDown();
      queue.close();
    }
  }

  private Materials.Current current(Instant expires) {
    var s = SnapshotValidationTest.snapshot("t");
    return new Materials.Current(
        UUID.randomUUID(),
        new Contracts.TaskSnapshot(
            s.projectId(),
            s.taskId(),
            s.question(),
            s.instruction(),
            null,
            null,
            s.options(),
            s.snapshotHash(),
            expires,
            s.adapterVersion()),
        "nonce",
        Map.of(),
        null,
        null);
  }
}
