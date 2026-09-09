package io.browserskills.api;

import jakarta.annotation.PreDestroy;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

@Service
@ConditionalOnWebApplication
public class Orchestrator {
  private final Store store;
  private final WorkerClient worker;
  private final Materials materials;
  private final AnalysisQueue ai;
  private final ManualLeases leases;
  private final JsonMapper json;
  private final Clock clock;
  private final ExecutorService executor =
      Executors.newFixedThreadPool(5, Thread.ofPlatform().name("run-", 0).factory());
  private final Map<UUID, Object> locks = new ConcurrentHashMap<>();
  private final Set<Integer> initialized = ConcurrentHashMap.newKeySet();
  private final Object[] workerInitializationLocks = {
    new Object(), new Object(), new Object(), new Object(), new Object()
  };
  private final Map<UUID, Instant> refreshed = new ConcurrentHashMap<>();
  private final Set<UUID> refreshing = ConcurrentHashMap.newKeySet();

  public Orchestrator(
      Store store,
      WorkerClient worker,
      Materials materials,
      AnalysisQueue ai,
      ManualLeases leases,
      JsonMapper json,
      Clock clock) {
    this.store = store;
    this.worker = worker;
    this.materials = materials;
    this.ai = ai;
    this.leases = leases;
    this.json = json;
    this.clock = clock;
  }

  @EventListener(ApplicationReadyEvent.class)
  public void recover() {
    store.reconcile();
    for (int i = 1; i <= 5; i++) {
      int id = i;
      executor.execute(
          () -> {
            try {
              initialize(id);
            } catch (Exception ignored) {
            }
          });
    }
  }

  private void initialize(int id) {
    synchronized (workerInitializationLocks[id - 1]) {
      if (!initialized.contains(id)) {
        worker.command(id, "CLOSE", null, null, null, Contracts.BrowserStatus.class);
        initialized.add(id);
      }
    }
  }

  private Object lock(UUID user) {
    return locks.computeIfAbsent(user, ignored -> new Object());
  }

  public Contracts.BrowserStatus browser(UUID user, boolean open) {
    var u = store.user(user);
    synchronized (lock(user)) {
      initialize(u.workerId());
      if (!open) return worker.status(u.workerId());
      if (store.active(user))
        throw new ApiException(
            409, "RUN_ACTIVE", "Stop the active run before opening manual control.");
      releaseOrphanedTerminalRun(u);
      return worker.command(u.workerId(), "OPEN", null, null, null, Contracts.BrowserStatus.class);
    }
  }

  public Contracts.BrowserStatus manual(
      UUID user, String session, Instant expires, boolean acquire) {
    var u = store.user(user);
    synchronized (lock(user)) {
      initialize(u.workerId());
      if (acquire) {
        if (store.active(user))
          throw new ApiException(409, "RUN_ACTIVE", "Stop the active run first.");
        releaseOrphanedTerminalRun(u);
        var status = worker.status(u.workerId());
        leases.acquire(user, u.workerId(), session, status.generation(), expires);
        try {
          return worker.command(
              u.workerId(),
              "ENTER_MANUAL",
              status.generation(),
              null,
              null,
              Contracts.BrowserStatus.class);
        } catch (RuntimeException e) {
          leases.revoke(user);
          throw e;
        }
      }
      leases.lease(user, session);
      leases.revoke(user);
      return worker.command(
          u.workerId(), "EXIT_MANUAL", null, null, null, Contracts.BrowserStatus.class);
    }
  }

  public void logout(UUID user, String session) {
    synchronized (lock(user)) {
      if (leases.valid(user, session)) {
        leases.revokeSession(session);
        try {
          worker.command(
              store.user(user).workerId(),
              "EXIT_MANUAL",
              null,
              null,
              null,
              Contracts.BrowserStatus.class);
        } catch (Exception ignored) {
        }
      } else leases.revokeSession(session);
    }
  }

  public Contracts.RunView start(UUID user, Contracts.StartRun request) {
    var u = store.user(user);
    synchronized (lock(user)) {
      initialize(u.workerId());
      var created = store.create(user, request);
      if (!created.fresh()) return view(user, created.run().id());
      UUID run = created.run().id();
      leases.revoke(user);
      executor.execute(
          () -> {
            try {
              if (!store.owned(user, run).status().equals("PREPARING")) return;
              var status = worker.status(u.workerId());
              if (status.generation() == null || status.mode().equals("CLOSED"))
                throw new ApiException(409, "BROWSER_CLOSED", "Open the browser and a task first.");
              if (!store.owned(user, run).status().equals("PREPARING")) return;
              // Persist the expected generation before BEGIN so a lost BEGIN response can
              // still be stopped without clearing a later generation.
              store.generation(user, run, status.generation());
              var begun =
                  worker.command(
                      u.workerId(),
                      "BEGIN",
                      status.generation(),
                      run,
                      null,
                      Contracts.BrowserStatus.class);
              if (!status.generation().equals(begun.generation()))
                throw new ApiException(
                    409, "STALE_GENERATION", "Browser restarted before claiming the run.");
              if (!store.owned(user, run).status().equals("PREPARING")) {
                releaseWorker(user, run, begun.generation());
                return;
              }
              prepare(user, run);
            } catch (ApiException e) {
              fail(user, run, e.code());
            } catch (Exception e) {
              fail(user, run, "WORKER_UNAVAILABLE");
            }
          });
      return view(user, run);
    }
  }

  private void prepare(UUID user, UUID run) {
    var r = store.owned(user, run);
    if (!Set.of("PREPARING", "ANALYZING", "AWAITING_CONFIRMATION").contains(r.status())) return;
    int w = store.user(user).workerId();
    var snapshot =
        worker.command(w, "SNAPSHOT", r.generation(), run, null, Contracts.TaskSnapshot.class);
    install(user, run, snapshot, null);
  }

  private void install(UUID user, UUID run, Contracts.TaskSnapshot snapshot, UUID expectedItem) {
    SnapshotValidation.validate(snapshot);
    if (snapshot.expiresAt() != null && !snapshot.expiresAt().isAfter(clock.instant()))
      throw new ApiException(409, "TASK_EXPIRED", "Task expired.");
    Map<String, byte[]> bytes = new LinkedHashMap<>();
    int w = store.user(user).workerId();
    for (var asset : SnapshotValidation.assets(snapshot))
      bytes.put(asset.id(), worker.media(w, asset));
    synchronized (lock(user)) {
      var r = store.owned(user, run);
      var previous = materials.get(run);
      if (!Set.of("PREPARING", "ANALYZING", "AWAITING_CONFIRMATION").contains(r.status())
          || !Objects.equals(expectedItem, previous == null ? null : previous.itemId())) return;
      Store.Item item = store.draft(user, run, snapshot);
      if (item == null) return;
      var current =
          new Materials.Current(item.id(), snapshot, item.nonce().toString(), bytes, null, null);
      materials.put(run, current);
      ai.submit(
          user,
          run,
          current,
          (proposal, error) -> {
            synchronized (lock(user)) {
              var active = materials.get(run);
              if (!store.owned(user, run).status().equals("ANALYZING")
                  || active == null
                  || !active.itemId().equals(item.id())) return;
              materials.result(run, item.id(), proposal, error);
              store.awaiting(user, run, item.id());
            }
          });
    }
  }

  public Contracts.RunView confirm(UUID user, UUID run, Contracts.Confirm confirm) {
    if (confirm == null
        || confirm.requestId() == null
        || !SnapshotValidation.id(confirm.optionId())) throw ApiException.invalid();
    String hash = SnapshotValidation.sha256(json.writeValueAsBytes(confirm));
    if (store.duplicateConfirm(user, run, confirm, hash)) return view(user, run);
    Store.Run observed;
    Materials.Current current;
    synchronized (lock(user)) {
      observed = store.owned(user, run);
      current = materials.get(run);
      if (!observed.status().equals("AWAITING_CONFIRMATION") || current == null) throw stale();
      if (current.snapshot().options().stream().noneMatch(o -> o.id().equals(confirm.optionId())))
        throw ApiException.invalid();
    }
    // Keep worker I/O outside the ownership lock: STOP must be able to cancel an
    // outstanding snapshot. The state and item are checked again before persisting intent.
    var fresh =
        worker.command(
            store.user(user).workerId(),
            "SNAPSHOT",
            observed.generation(),
            run,
            null,
            Contracts.TaskSnapshot.class);
    SnapshotValidation.validate(fresh);
    synchronized (lock(user)) {
      if (store.duplicateConfirm(user, run, confirm, hash)) return view(user, run);
      var r = store.owned(user, run);
      var active = materials.get(run);
      if (!r.status().equals("AWAITING_CONFIRMATION")
          || active == null
          || !active.itemId().equals(current.itemId())) throw stale();
      if (fresh.expiresAt() != null && !fresh.expiresAt().isAfter(clock.instant())) {
        fail(user, run, "TASK_EXPIRED");
        throw stale();
      }
      if (sameTask(fresh, current.snapshot())) {
        if (!store.intent(user, run, confirm, hash)) return view(user, run);
        materials.remove(run);
        executor.execute(() -> dispatch(user, run, r.generation(), confirm));
        return view(user, run);
      }
    }
    install(user, run, fresh, current.itemId());
    throw stale();
  }

  private boolean sameTask(Contracts.TaskSnapshot a, Contracts.TaskSnapshot b) {
    return a.taskId().equals(b.taskId())
        && a.snapshotHash().equals(b.snapshotHash())
        && a.instruction().hash().equals(b.instruction().hash());
  }

  private ApiException stale() {
    return new ApiException(
        409, "STALE_CONFIRMATION", "Task or instructions changed. Review the current task.");
  }

  private void dispatch(UUID user, UUID run, String generation, Contracts.Confirm c) {
    Contracts.SubmitResult result;
    try {
      if (!store.owned(user, run).status().equals("SUBMITTING"))
        result = new Contracts.SubmitResult("REJECTED", null, "STOPPED_BEFORE_DISPATCH");
      else
        result =
            worker.command(
                store.user(user).workerId(),
                "SUBMIT",
                generation,
                run,
                new Contracts.SubmitPayload(
                    c.taskId(), c.snapshotHash(), c.instructionHash(), c.optionId()),
                Contracts.SubmitResult.class);
      if (result == null
          || !Set.of("SUBMITTED", "COMPLETE", "UNKNOWN", "REJECTED").contains(result.outcome()))
        result = new Contracts.SubmitResult("UNKNOWN", null, "INVALID_SUBMIT_RESULT");
    } catch (Exception e) {
      result = new Contracts.SubmitResult("UNKNOWN", null, "SUBMIT_OUTCOME_UNKNOWN");
    }
    try {
      if (store.finish(user, run, result)) {
        prepare(user, run);
      } else releaseWorker(user, run, generation);
    } catch (ApiException e) {
      fail(user, run, e.code());
    } catch (Exception e) {
      try {
        store.finish(
            user, run, new Contracts.SubmitResult("UNKNOWN", null, "PERSISTENCE_UNAVAILABLE"));
      } finally {
        releaseWorker(user, run, generation);
      }
    }
  }

  private void releaseWorker(UUID user, UUID run, String generation) {
    refreshed.remove(run);
    try {
      worker.command(
          store.user(user).workerId(),
          "STOP",
          generation,
          run,
          null,
          Contracts.BrowserStatus.class);
    } catch (Exception ignored) {
      // A late result can belong to an older generation. Never turn its failed STOP into
      // an unfenced CLOSE on the next request. Explicit browser opening can retry a
      // generation-bound STOP after verifying that the worker still owns this terminal run.
    }
  }

  private void releaseOrphanedTerminalRun(Store.User user) {
    var status = worker.status(user.workerId());
    if (!"AUTOMATION".equals(status.mode()) || status.runId() == null) return;
    UUID run;
    try {
      run = UUID.fromString(status.runId());
    } catch (IllegalArgumentException e) {
      throw new ApiException(409, "WORKER_BUSY", "Browser ownership could not be verified.");
    }
    var owned = store.owned(user.id(), run);
    if (Set.of("PREPARING", "ANALYZING", "AWAITING_CONFIRMATION", "SUBMITTING")
        .contains(owned.status()))
      throw new ApiException(409, "RUN_ACTIVE", "Stop the active run first.");
    worker.command(
        user.workerId(), "STOP", status.generation(), run, null, Contracts.BrowserStatus.class);
  }

  private void fail(UUID user, UUID run, String code) {
    synchronized (lock(user)) {
      store.fail(user, run, code);
      materials.remove(run);
      releaseWorker(user, run, store.owned(user, run).generation());
    }
  }

  public Contracts.RunView stop(UUID user, UUID run) {
    synchronized (lock(user)) {
      var r = store.owned(user, run);
      if (!Set.of("PREPARING", "ANALYZING", "AWAITING_CONFIRMATION", "SUBMITTING")
          .contains(r.status())) return view(user, run);
      store.stop(user, run);
      materials.remove(run);
      leases.revoke(user);
      releaseWorker(user, run, r.generation());
      return view(user, run);
    }
  }

  public List<Contracts.RunSummary> list(UUID user) {
    return store.runs(user).stream().map(this::summary).toList();
  }

  private Contracts.RunSummary summary(Store.Run r) {
    return new Contracts.RunSummary(
        r.id(),
        r.status(),
        r.maxTasks(),
        r.processed(),
        r.createdAt(),
        r.updatedAt(),
        r.errorCode() == null
            ? null
            : new Contracts.ApiError(r.errorCode(), "Run requires attention."));
  }

  private void refresh(UUID user, UUID run) {
    if (refreshed.getOrDefault(run, Instant.EPOCH).plusSeconds(2).isAfter(clock.instant())
        || !refreshing.add(run)) return;
    refreshed.put(run, clock.instant());
    executor.execute(
        () -> {
          Materials.Current observed = null;
          try {
            Store.Run r;
            synchronized (lock(user)) {
              r = store.owned(user, run);
              observed = materials.get(run);
              if (!r.status().equals("AWAITING_CONFIRMATION") || observed == null) return;
            }
            var fresh =
                worker.command(
                    store.user(user).workerId(),
                    "SNAPSHOT",
                    r.generation(),
                    run,
                    null,
                    Contracts.TaskSnapshot.class);
            SnapshotValidation.validate(fresh);
            if (fresh.expiresAt() != null && !fresh.expiresAt().isAfter(clock.instant())) {
              failObserved(user, run, observed, "TASK_EXPIRED");
            } else if (!sameTask(fresh, observed.snapshot())) {
              install(user, run, fresh, observed.itemId());
            }
          } catch (ApiException e) {
            failObserved(user, run, observed, e.code());
          } catch (Exception e) {
            failObserved(user, run, observed, "WORKER_UNAVAILABLE");
          } finally {
            refreshing.remove(run);
          }
        });
  }

  private void failObserved(UUID user, UUID run, Materials.Current observed, String code) {
    synchronized (lock(user)) {
      var current = materials.get(run);
      if (observed != null
          && current != null
          && current.itemId().equals(observed.itemId())
          && store.owned(user, run).status().equals("AWAITING_CONFIRMATION")) fail(user, run, code);
    }
  }

  public Contracts.RunView view(UUID user, UUID run) {
    var r = store.owned(user, run);
    var summary = summary(r);
    var current = materials.get(run);
    if (r.status().equals("AWAITING_CONFIRMATION")) refresh(user, run);
    var results =
        store.items(run).stream()
            .map(
                i ->
                    new Contracts.RunItemResult(
                        i.taskId(), i.ordinal(), i.status(), i.optionId(), i.code(), i.createdAt()))
            .toList();
    return new Contracts.RunView(
        r.id(),
        r.status(),
        r.maxTasks(),
        r.processed(),
        r.createdAt(),
        r.updatedAt(),
        summary.error(),
        current == null ? null : current.view(),
        results);
  }

  @PreDestroy
  void close() {
    executor.shutdownNow();
  }
}
