package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class AnalysisQueueTest {
  static Store.Run run(UUID user, UUID run, String state) {
    return new Store.Run(
        run,
        user,
        state,
        1,
        0,
        "gen",
        null,
        Instant.now(),
        Instant.now(),
        Contracts.SelectionSettings.defaults(),
        null,
        null,
        null);
  }

  @Test
  void oneRunningFourWaitingAndExpiryBeforeStartingConsumesNoQuota() throws Exception {
    var store = mock(Store.class);
    when(store.owned(any(), any()))
        .thenAnswer(c -> run(c.getArgument(0), c.getArgument(1), "ANALYZING"));
    when(store.reserveAi(any(), any(), any(), any())).thenReturn(true);
    var queue = new AnalysisQueue(store, Json.mapper(), Clock.systemUTC(), "model");
    var entered = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    UUID first = UUID.randomUUID();
    try (var pool = Executors.newFixedThreadPool(8)) {
      var running =
          pool.submit(
              () ->
                  queue.call(
                      first,
                      UUID.randomUUID(),
                      "a".repeat(64),
                      "a".repeat(64),
                      null,
                      t -> {
                        entered.countDown();
                        try {
                          release.await(5, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                          Thread.currentThread().interrupt();
                        }
                        return "done";
                      }));
      assertTrue(entered.await(1, TimeUnit.SECONDS));
      assertEquals(
          "AI_BUSY",
          assertThrows(
                  ApiException.class,
                  () ->
                      queue.call(
                          first, UUID.randomUUID(), "a".repeat(64), "a".repeat(64), null, t -> "x"))
              .code());
      UUID expired = UUID.randomUUID();
      assertEquals(
          "AI_QUEUE_TIMEOUT",
          assertThrows(
                  ApiException.class,
                  () ->
                      queue.call(
                          expired,
                          UUID.randomUUID(),
                          "a".repeat(64),
                          "a".repeat(64),
                          Instant.now().plusMillis(100),
                          t -> "x"))
              .code());
      verify(store, never()).reserveAi(eq(expired), any(), any(), any());
      var waiting = new ArrayList<Future<String>>();
      for (int i = 0; i < 4; i++)
        waiting.add(
            pool.submit(
                () ->
                    queue.call(
                        UUID.randomUUID(),
                        UUID.randomUUID(),
                        "a".repeat(64),
                        "a".repeat(64),
                        null,
                        t -> "queued")));
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
      var executor =
          (ThreadPoolExecutor)
              org.springframework.test.util.ReflectionTestUtils.getField(queue, "executor");
      while (executor.getQueue().size() < 4 && System.nanoTime() < deadline) Thread.sleep(5);
      assertEquals(
          "AI_BUSY",
          assertThrows(
                  ApiException.class,
                  () ->
                      queue.call(
                          UUID.randomUUID(),
                          UUID.randomUUID(),
                          "a".repeat(64),
                          "a".repeat(64),
                          null,
                          t -> "x"))
              .code());
      release.countDown();
      assertEquals("done", running.get(2, TimeUnit.SECONDS));
      for (var f : waiting) assertEquals("queued", f.get(2, TimeUnit.SECONDS));
    } finally {
      release.countDown();
      queue.close();
    }
  }
}
