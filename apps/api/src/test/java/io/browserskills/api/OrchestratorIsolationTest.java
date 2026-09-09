package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.Test;

class OrchestratorIsolationTest {
  @Test
  void multipleChoiceReadbackComparesSelectionsIndependentlyOfDomOrder() {
    var s = SnapshotValidationTest.snapshot("suite");
    var p = s.parts().getFirst();
    var old = p.fields().getFirst();
    var field =
        new Contracts.TaskField(
            old.id(),
            old.label(),
            "MULTI_CHOICE",
            true,
            old.options(),
            List.of("b", "a"),
            0,
            null,
            null,
            null);
    var task =
        new Contracts.TaskSet(
            s.poolId(),
            s.suiteId(),
            List.of(
                new Contracts.TaskPart(
                    p.id(), p.title(), p.text(), p.media(), List.of(field), List.of())),
            s.instruction(),
            s.snapshotHash(),
            null,
            s.adapterVersion());
    Orchestrator.verifyValues(
        task, List.of(new Contracts.FieldAnswer(p.id(), field.id(), List.of("a", "b"))));
    assertThrows(
        ApiException.class,
        () ->
            Orchestrator.verifyValues(
                task, List.of(new Contracts.FieldAnswer(p.id(), field.id(), List.of("a")))));
  }

  private Orchestrator create(
      Store store, WorkerClient worker, Materials materials, ManualLeases leases) {
    return new Orchestrator(
        store,
        worker,
        materials,
        mock(AnalysisQueue.class),
        mock(InferenceClient.class),
        mock(InstructionCompiler.class),
        mock(QualityGates.class),
        leases,
        Clock.systemUTC());
  }

  private Contracts.BrowserStatus browser(String mode, String generation, String run) {
    return new Contracts.BrowserStatus(
        "browser-1",
        generation,
        mode,
        null,
        run,
        new Contracts.YangSession("READY", Instant.now(), null, null, null));
  }

  @Test
  void stopIsSerializedAndCannotRevokeALaterManualLease() throws Exception {
    var store = mock(Store.class);
    var worker = mock(WorkerClient.class);
    var materials = new Materials();
    var leases = spy(new ManualLeases(Clock.systemUTC()));
    UUID user = UUID.randomUUID(), run = UUID.randomUUID();
    var state = new AtomicReference<>("ANALYZING");
    when(store.user(user)).thenReturn(new Store.User(user, "alice", "hash", true, 1));
    when(store.owned(user, run)).thenAnswer(c -> AnalysisQueueTest.run(user, run, state.get()));
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
    var api = create(store, worker, materials, leases);
    try (var pool = Executors.newFixedThreadPool(2)) {
      var first = pool.submit(() -> api.stop(user, run));
      assertTrue(entered.await(1, TimeUnit.SECONDS));
      var second = pool.submit(() -> api.stop(user, run));
      assertThrows(TimeoutException.class, () -> second.get(100, TimeUnit.MILLISECONDS));
      release.countDown();
      assertEquals("STOPPED", first.get(2, TimeUnit.SECONDS).status());
      assertEquals("STOPPED", second.get(2, TimeUnit.SECONDS).status());
      leases.acquire(user, 1, "new-session", "new-gen", Instant.now().plusSeconds(60));
      clearInvocations(leases);
      api.stop(user, run);
      assertTrue(leases.valid(user, "new-session"));
      verify(leases, never()).revoke(user);
      verify(worker, times(1)).command(1, "STOP", "gen", run, null, Contracts.BrowserStatus.class);
    } finally {
      release.countDown();
      api.close();
      materials.close();
    }
  }

  @Test
  void openingBrowserOnlyReleasesItsVerifiedTerminalRun() {
    var store = mock(Store.class);
    var worker = mock(WorkerClient.class);
    var materials = new Materials();
    UUID user = UUID.randomUUID(), run = UUID.randomUUID();
    when(store.user(user)).thenReturn(new Store.User(user, "alice", "hash", true, 1));
    when(store.manualAllowed(user)).thenReturn(true);
    when(store.owned(user, run)).thenReturn(AnalysisQueueTest.run(user, run, "UNKNOWN"));
    when(worker.status(1)).thenReturn(browser("AUTOMATION", "old-gen", run.toString()));
    when(worker.command(1, "OPEN", null, null, null, Contracts.BrowserStatus.class))
        .thenReturn(browser("IDLE", "new-gen", null));
    var api = create(store, worker, materials, new ManualLeases(Clock.systemUTC()));
    try {
      assertEquals("IDLE", api.browser(user, true).mode());
      verify(worker).command(1, "STOP", "old-gen", run, null, Contracts.BrowserStatus.class);
    } finally {
      api.close();
      materials.close();
    }
  }

  @Test
  void unavailableWorkerDoesNotHoldOtherUsersInitializationLock() throws Exception {
    var store = mock(Store.class);
    var worker = mock(WorkerClient.class);
    var materials = new Materials();
    UUID first = UUID.randomUUID(), second = UUID.randomUUID();
    when(store.user(first)).thenReturn(new Store.User(first, "first", "hash", true, 1));
    when(store.user(second)).thenReturn(new Store.User(second, "second", "hash", true, 2));
    var entered = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    when(worker.command(1, "CLOSE", null, null, null, Contracts.BrowserStatus.class))
        .thenAnswer(
            c -> {
              entered.countDown();
              release.await(5, TimeUnit.SECONDS);
              throw new ApiException(503, "DOWN", "Down");
            });
    when(worker.status(2)).thenReturn(browser("IDLE", "g2", null));
    var api = create(store, worker, materials, new ManualLeases(Clock.systemUTC()));
    try (var pool = Executors.newFixedThreadPool(2)) {
      var failing =
          pool.submit(() -> assertThrows(ApiException.class, () -> api.browser(first, false)));
      assertTrue(entered.await(1, TimeUnit.SECONDS));
      assertEquals(
          "IDLE", pool.submit(() -> api.browser(second, false)).get(1, TimeUnit.SECONDS).mode());
      release.countDown();
      failing.get(1, TimeUnit.SECONDS);
    } finally {
      release.countDown();
      api.close();
      materials.close();
    }
  }

  @Test
  void reorderingMaterialsOrChangingExistingChoicesInvalidatesTheFilledSet() {
    var before = SnapshotValidationTest.snapshot("suite");
    var p = before.parts().getFirst();
    var changed =
        new Contracts.TaskPart(
            p.id(), p.title(), "different text", p.media(), p.fields(), List.of());
    var after =
        new Contracts.TaskSet(
            before.poolId(),
            before.suiteId(),
            List.of(changed),
            before.instruction(),
            before.snapshotHash(),
            null,
            before.adapterVersion());
    assertThrows(ApiException.class, () -> Orchestrator.stableAfterApply(before, after));
    assertThrows(
        ApiException.class,
        () -> Orchestrator.verifyValues(before, SnapshotValidationTest.answer().answers()));
    assertEquals(
        Set.of("TEXT", "SOUND_PROSODY"),
        Orchestrator.capabilities(
            List.of("text", "audio"), new InstructionCompiler.Compiled("hash", List.of(), false)));
    assertEquals(
        Set.of("SPEECH"),
        Orchestrator.capabilities(
            List.of("audio"), new InstructionCompiler.Compiled("hash", List.of(), true)));
  }
}
