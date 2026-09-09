package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class OrchestratorIsolationTest {
  @Test
  void stopCancelsSlowConfirmationBeforeAnySubmissionIntent() throws Exception {
    var store = mock(Store.class);
    var worker = mock(WorkerClient.class);
    var materials = new Materials();
    UUID user = UUID.randomUUID(), run = UUID.randomUUID();
    var state = new AtomicReference<>("AWAITING_CONFIRMATION");
    when(store.user(user)).thenReturn(new Store.User(user, "alice", "hash", true, 1));
    when(store.owned(user, run))
        .thenAnswer(
            c ->
                new Store.Run(
                    run, user, state.get(), 1, 0, "gen", null, Instant.now(), Instant.now()));
    doAnswer(
            c -> {
              state.set("STOPPED");
              return null;
            })
        .when(store)
        .stop(user, run);
    var snapshot = SnapshotValidationTest.snapshot("task");
    String nonce = UUID.randomUUID().toString();
    materials.put(
        run, new Materials.Current(UUID.randomUUID(), snapshot, nonce, Map.of(), null, null));
    var entered = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    when(worker.command(
            eq(1), eq("SNAPSHOT"), eq("gen"), eq(run), isNull(), eq(Contracts.TaskSnapshot.class)))
        .thenAnswer(
            c -> {
              entered.countDown();
              release.await(5, TimeUnit.SECONDS);
              return snapshot;
            });
    var runs =
        new Orchestrator(
            store,
            worker,
            materials,
            mock(AnalysisQueue.class),
            new ManualLeases(Clock.systemUTC()),
            Json.mapper(),
            Clock.systemUTC());
    var confirm =
        new Contracts.Confirm(
            UUID.randomUUID(),
            snapshot.taskId(),
            snapshot.snapshotHash(),
            snapshot.instruction().hash(),
            "a",
            nonce);
    try (var pool = Executors.newFixedThreadPool(2)) {
      var pending =
          pool.submit(
              () -> assertThrows(ApiException.class, () -> runs.confirm(user, run, confirm)));
      assertTrue(entered.await(1, TimeUnit.SECONDS));
      assertEquals(
          "STOPPED", pool.submit(() -> runs.stop(user, run)).get(1, TimeUnit.SECONDS).status());
      verify(worker).command(1, "STOP", "gen", run, null, Contracts.BrowserStatus.class);
      release.countDown();
      assertEquals("STALE_CONFIRMATION", pending.get(1, TimeUnit.SECONDS).code());
      verify(store, never()).intent(any(), any(), any(), any());
      assertNull(materials.get(run));
    } finally {
      release.countDown();
      runs.close();
    }
  }

  @Test
  void concurrentStopsReadOwnershipOnlyAfterThePreviousStopFinishes() throws Exception {
    var store = mock(Store.class);
    var worker = mock(WorkerClient.class);
    var leases = spy(new ManualLeases(Clock.systemUTC()));
    UUID user = UUID.randomUUID(), run = UUID.randomUUID();
    var state = new AtomicReference<>("ANALYZING");
    when(store.user(user)).thenReturn(new Store.User(user, "alice", "hash", true, 1));
    when(store.owned(user, run))
        .thenAnswer(
            c ->
                new Store.Run(
                    run, user, state.get(), 1, 0, "gen", null, Instant.now(), Instant.now()));
    var entered = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    doAnswer(
            c -> {
              entered.countDown();
              release.await(5, TimeUnit.SECONDS);
              state.set("STOPPED");
              return null;
            })
        .when(store)
        .stop(user, run);
    var runs =
        new Orchestrator(
            store,
            worker,
            new Materials(),
            mock(AnalysisQueue.class),
            leases,
            Json.mapper(),
            Clock.systemUTC());
    try (var pool = Executors.newFixedThreadPool(2)) {
      var first = pool.submit(() -> runs.stop(user, run));
      assertTrue(entered.await(1, TimeUnit.SECONDS));
      var second = pool.submit(() -> runs.stop(user, run));
      assertThrows(TimeoutException.class, () -> second.get(150, TimeUnit.MILLISECONDS));
      verify(store, times(1)).owned(user, run);
      release.countDown();
      assertEquals("STOPPED", first.get(1, TimeUnit.SECONDS).status());
      assertEquals("STOPPED", second.get(1, TimeUnit.SECONDS).status());
      verify(leases, times(1)).revoke(user);
      leases.acquire(user, 1, "new-session", "new-gen", Instant.now().plusSeconds(60));
      clearInvocations(leases);
      runs.stop(user, run);
      assertTrue(leases.valid(user, "new-session"));
      verify(leases, never()).revoke(user);
      verify(worker, times(1)).command(1, "STOP", "gen", run, null, Contracts.BrowserStatus.class);
    } finally {
      release.countDown();
      runs.close();
    }
  }

  @Test
  void lateSnapshotFailureCannotTerminateANewerTask() throws Exception {
    var store = mock(Store.class);
    var worker = mock(WorkerClient.class);
    var materials = new Materials();
    UUID user = UUID.randomUUID(), run = UUID.randomUUID();
    when(store.user(user)).thenReturn(new Store.User(user, "alice", "hash", true, 1));
    when(store.owned(user, run))
        .thenReturn(
            new Store.Run(
                run,
                user,
                "AWAITING_CONFIRMATION",
                2,
                1,
                "gen",
                null,
                Instant.now(),
                Instant.now()));
    materials.put(
        run,
        new Materials.Current(
            UUID.randomUUID(),
            SnapshotValidationTest.snapshot("old"),
            "old-nonce",
            Map.of(),
            null,
            null));
    var entered = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    when(worker.command(
            eq(1), eq("SNAPSHOT"), eq("gen"), eq(run), isNull(), eq(Contracts.TaskSnapshot.class)))
        .thenAnswer(
            c -> {
              entered.countDown();
              release.await(5, TimeUnit.SECONDS);
              throw new ApiException(409, "TASK_CHANGED", "Earlier task changed.");
            });
    var runs =
        new Orchestrator(
            store,
            worker,
            materials,
            mock(AnalysisQueue.class),
            new ManualLeases(Clock.systemUTC()),
            Json.mapper(),
            Clock.systemUTC());
    try {
      runs.view(user, run);
      assertTrue(entered.await(1, TimeUnit.SECONDS));
      var next =
          new Materials.Current(
              UUID.randomUUID(),
              SnapshotValidationTest.snapshot("new"),
              "new-nonce",
              Map.of(),
              null,
              null);
      materials.put(run, next);
      release.countDown();
      var executor =
          (ExecutorService)
              org.springframework.test.util.ReflectionTestUtils.getField(runs, "executor");
      executor.shutdown();
      assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS));
      assertEquals(next, materials.get(run));
      verify(store, never()).fail(any(), any(), any());
      verify(worker, never()).command(anyInt(), eq("STOP"), any(), any(), any(), any());
    } finally {
      release.countDown();
      runs.close();
    }
  }

  @Test
  void openingBrowserRecoversOnlyItsVerifiedTerminalWorkerRun() {
    var store = mock(Store.class);
    var worker = mock(WorkerClient.class);
    UUID user = UUID.randomUUID(), oldRun = UUID.randomUUID();
    when(store.user(user)).thenReturn(new Store.User(user, "alice", "hash", true, 1));
    when(store.owned(user, oldRun))
        .thenReturn(
            new Store.Run(
                oldRun, user, "UNKNOWN", 1, 0, "old-gen", null, Instant.now(), Instant.now()));
    when(worker.status(1))
        .thenReturn(
            new Contracts.BrowserStatus(
                "browser-1", "old-gen", "AUTOMATION", null, oldRun.toString()));
    var ready = new Contracts.BrowserStatus("browser-1", "new-gen", "IDLE", null, null);
    when(worker.command(
            eq(1), eq("OPEN"), isNull(), isNull(), isNull(), eq(Contracts.BrowserStatus.class)))
        .thenReturn(ready);
    var runs =
        new Orchestrator(
            store,
            worker,
            new Materials(),
            mock(AnalysisQueue.class),
            new ManualLeases(Clock.systemUTC()),
            Json.mapper(),
            Clock.systemUTC());
    try {
      assertEquals(ready, runs.browser(user, true));
      verify(worker).command(1, "STOP", "old-gen", oldRun, null, Contracts.BrowserStatus.class);
    } finally {
      runs.close();
    }
  }

  @Test
  void staleOldRunCleanupCannotMakeStatusCloseANewerRun() {
    var store = mock(Store.class);
    var worker = mock(WorkerClient.class);
    UUID user = UUID.randomUUID(), oldRun = UUID.randomUUID();
    when(store.user(user)).thenReturn(new Store.User(user, "alice", "hash", true, 1));
    when(store.active(user)).thenReturn(true);
    var status =
        new Contracts.BrowserStatus(
            "browser-1", "new-generation", "AUTOMATION", null, UUID.randomUUID().toString());
    when(worker.status(1)).thenReturn(status);
    when(worker.command(
            eq(1),
            eq("STOP"),
            eq("old-generation"),
            eq(oldRun),
            isNull(),
            eq(Contracts.BrowserStatus.class)))
        .thenThrow(new ApiException(409, "STALE_GENERATION", "Old run"));
    var runs =
        new Orchestrator(
            store,
            worker,
            new Materials(),
            mock(AnalysisQueue.class),
            new ManualLeases(Clock.systemUTC()),
            Json.mapper(),
            Clock.systemUTC());
    try {
      runs.browser(user, false);
      clearInvocations(worker);
      org.springframework.test.util.ReflectionTestUtils.invokeMethod(
          runs, "releaseWorker", user, oldRun, "old-generation");
      assertEquals("new-generation", runs.browser(user, false).generation());
      verify(worker, never())
          .command(
              eq(1),
              eq("CLOSE"),
              nullable(String.class),
              nullable(UUID.class),
              isNull(),
              eq(Contracts.BrowserStatus.class));
      when(worker.command(
              eq(1),
              eq("STOP"),
              eq("old-generation"),
              eq(oldRun),
              isNull(),
              eq(Contracts.BrowserStatus.class)))
          .thenThrow(new ApiException(502, "UPSTREAM_UNAVAILABLE", "Unknown"));
      org.springframework.test.util.ReflectionTestUtils.invokeMethod(
          runs, "releaseWorker", user, oldRun, "old-generation");
      runs.browser(user, false);
      verify(worker, never())
          .command(
              eq(1),
              eq("CLOSE"),
              nullable(String.class),
              nullable(UUID.class),
              isNull(),
              eq(Contracts.BrowserStatus.class));
    } finally {
      runs.close();
    }
  }

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
