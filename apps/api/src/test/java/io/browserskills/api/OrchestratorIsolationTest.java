package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class OrchestratorIsolationTest {
  @Test
  void unavailableWorkerDoesNotDelayAHealthyUsersBrowser() throws Exception {
    var store = mock(Store.class);
    var worker = mock(WorkerClient.class);
    var model = mock(AnalysisQueue.class);
    var material = new Materials();
    var leases = new ManualLeases(Clock.systemUTC());
    UUID blockedUser = UUID.randomUUID(), healthyUser = UUID.randomUUID();
    when(store.user(blockedUser)).thenReturn(new Store.User(blockedUser, "one", "hash", true, 1));
    when(store.user(healthyUser)).thenReturn(new Store.User(healthyUser, "two", "hash", true, 2));
    var entered = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    when(worker.command(
            eq(1), eq("CLOSE"), isNull(), isNull(), isNull(), eq(Contracts.BrowserStatus.class)))
        .thenAnswer(
            c -> {
              entered.countDown();
              release.await(5, TimeUnit.SECONDS);
              throw new ApiException(502, "UNAVAILABLE", "Unavailable");
            });
    var healthy = new Contracts.BrowserStatus("browser-2", "gen", "IDLE", null, null);
    when(worker.command(
            eq(2), eq("CLOSE"), isNull(), isNull(), isNull(), eq(Contracts.BrowserStatus.class)))
        .thenReturn(healthy);
    when(worker.status(2)).thenReturn(healthy);
    var runs =
        new Orchestrator(store, worker, material, model, leases, Json.mapper(), Clock.systemUTC());
    try (var executor = Executors.newFixedThreadPool(2)) {
      var blocked =
          executor.submit(
              () -> assertThrows(ApiException.class, () -> runs.browser(blockedUser, false)));
      assertTrue(entered.await(1, TimeUnit.SECONDS));
      var ready = executor.submit(() -> runs.browser(healthyUser, false));
      assertEquals("browser-2", ready.get(1, TimeUnit.SECONDS).workerId());
      release.countDown();
      blocked.get(2, TimeUnit.SECONDS);
    } finally {
      release.countDown();
      runs.close();
    }
  }
}
