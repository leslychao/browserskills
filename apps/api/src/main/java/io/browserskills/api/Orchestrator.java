package io.browserskills.api;

import jakarta.annotation.PreDestroy;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

@Service
@ConditionalOnWebApplication
public class Orchestrator {
  private final Store store;
  private final WorkerClient worker;
  private final Materials materials;
  private final AnalysisQueue ai;
  private final InferenceClient model;
  private final InstructionCompiler compiler;
  private final QualityGates gates;
  private final ManualLeases leases;
  private final Clock clock;
  private final ExecutorService executor =
      Executors.newFixedThreadPool(5, Thread.ofPlatform().name("run-", 0).factory());
  private final Map<UUID, Object> locks = new ConcurrentHashMap<>();
  private final Set<Integer> initialized = ConcurrentHashMap.newKeySet();
  private final Object[] initializationLocks = {
    new Object(), new Object(), new Object(), new Object(), new Object()
  };
  private final Map<UUID, Map<String, InstructionCompiler.Compiled>> compiled =
      new ConcurrentHashMap<>();
  private final Map<UUID, Contracts.Catalogue> catalogues = new ConcurrentHashMap<>();
  private final Map<UUID, Map<String, Contracts.ApiError>> blockedProjects =
      new ConcurrentHashMap<>();

  public Orchestrator(
      Store store,
      WorkerClient worker,
      Materials materials,
      AnalysisQueue ai,
      InferenceClient model,
      InstructionCompiler compiler,
      QualityGates gates,
      ManualLeases leases,
      Clock clock) {
    this.store = store;
    this.worker = worker;
    this.materials = materials;
    this.ai = ai;
    this.model = model;
    this.compiler = compiler;
    this.gates = gates;
    this.leases = leases;
    this.clock = clock;
  }

  private Object lock(UUID user) {
    return locks.computeIfAbsent(user, x -> new Object());
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
    synchronized (initializationLocks[id - 1]) {
      if (initialized.add(id))
        try {
          worker.command(id, "CLOSE", null, null, null, Contracts.BrowserStatus.class);
        } catch (RuntimeException e) {
          initialized.remove(id);
          throw e;
        }
    }
  }

  public Contracts.BrowserStatus browser(UUID user, boolean open) {
    var u = store.user(user);
    synchronized (lock(user)) {
      initialize(u.workerId());
      if (!open) return worker.status(u.workerId());
      if (!store.manualAllowed(user))
        throw new ApiException(409, "RUN_ACTIVE", "Pause or stop the run first.");
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
        if (!store.manualAllowed(user))
          throw new ApiException(409, "RUN_ACTIVE", "Pause or stop the run first.");
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
      boolean owner = leases.valid(user, session);
      leases.revokeSession(session);
      if (owner)
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
    }
  }

  public Contracts.YangSession session(UUID user) {
    var u = store.user(user);
    initialize(u.workerId());
    return worker.command(
        u.workerId(), "YANG_SESSION", null, null, null, Contracts.YangSession.class);
  }

  public Contracts.Catalogue catalogue(UUID user, boolean refresh) {
    var u = store.user(user);
    initialize(u.workerId());
    if (refresh && !store.manualAllowed(user))
      throw new ApiException(409, "RUN_ACTIVE", "Catalogue refresh is available between runs.");
    if (refresh) blockedProjects.remove(user);
    if (!refresh && catalogues.containsKey(user)) return catalogues.get(user);
    var c =
        decorate(
            user,
            worker.command(
                u.workerId(),
                "CATALOGUE",
                null,
                null,
                Map.of("refresh", refresh),
                Contracts.Catalogue.class));
    catalogues.put(user, c);
    return c;
  }

  private Contracts.Catalogue decorate(UUID user, Contracts.Catalogue catalogue) {
    var blocked = blockedProjects.getOrDefault(user, Map.of());
    var items =
        catalogue.items().stream()
            .map(
                item -> {
                  Contracts.ApiError error = blocked.get(item.poolId());
                  if (item.poolId().equals("94777297"))
                    error =
                        new Contracts.ApiError(
                            "UNSUPPORTED_IDENTITY_TASK",
                            ApiErrors.message("UNSUPPORTED_IDENTITY_TASK"));
                  if (error == null
                      && ((!gates.allowed("TEXT"))
                          || (item.modalities().contains("image") && !gates.allowed("IMAGE"))
                          || (item.modalities().contains("audio")
                              && !gates.allowed("SPEECH")
                              && !gates.allowed("SOUND_PROSODY"))))
                    error =
                        new Contracts.ApiError(
                            "QUALITY_NOT_VERIFIED", ApiErrors.message("QUALITY_NOT_VERIFIED"));
                  return error == null
                      ? item
                      : new Contracts.CatalogueItem(
                          item.poolId(),
                          item.title(),
                          item.reward(),
                          item.availability(),
                          item.kind(),
                          item.modalities(),
                          "BLOCKED",
                          error);
                })
            .toList();
    return new Contracts.Catalogue(
        items, catalogue.refreshedAt(), catalogue.activePoolId(), catalogue.activeSuiteId());
  }

  public Contracts.RunView start(UUID user, Contracts.StartRun request) {
    synchronized (lock(user)) {
      var u = store.user(user);
      initialize(u.workerId());
      var created = store.create(user, request);
      if (created.fresh()) {
        blockedProjects.remove(user);
        catalogues.remove(user);
        leases.revoke(user);
        materials.begin(user, created.run().id());
        executor.execute(() -> launch(user, created.run().id()));
      }
      return view(user, created.run().id());
    }
  }

  public Contracts.RunView resume(UUID user, UUID run) {
    synchronized (lock(user)) {
      var r = store.owned(user, run);
      if (!Set.of("WAITING_FOR_AUTH", "WAITING_FOR_USER").contains(r.status()))
        throw new ApiException(409, "RUN_NOT_PAUSED", "This run is not paused.");
      if (!"READY".equals(session(user).state()))
        throw new ApiException(409, "YANG_LOGIN_REQUIRED", "Complete Yang login first.");
      if (store.state(user, run, r.status(), "SELECTING", null)) {
        blockedProjects.remove(user);
        catalogues.remove(user);
        leases.revoke(user);
        executor.execute(() -> launch(user, run));
      }
      return view(user, run);
    }
  }

  private void launch(UUID user, UUID run) {
    try {
      var r = active(user, run);
      int w = store.user(user).workerId();
      var status = worker.status(w);
      if ("CLOSED".equals(status.mode()))
        status = worker.command(w, "OPEN", null, null, null, Contracts.BrowserStatus.class);
      active(user, run);
      store.generation(user, run, status.generation());
      var begun =
          worker.command(w, "BEGIN", status.generation(), run, null, Contracts.BrowserStatus.class);
      if (!Objects.equals(status.generation(), begun.generation()))
        throw new ApiException(409, "STALE_GENERATION", "Browser restarted before claiming run.");
      cycle(user, run);
    } catch (ApiException e) {
      handle(user, run, e);
    } catch (Exception e) {
      handle(user, run, new ApiException(503, "WORKER_UNAVAILABLE", "Browser worker unavailable."));
    }
  }

  private Store.Run active(UUID user, UUID run) {
    var r = store.owned(user, run);
    if (!Set.of("SELECTING", "PREPARING", "ANALYZING", "FILLING", "SUBMITTING")
        .contains(r.status()))
      throw new ApiException(409, "RUN_STOPPED", "Run is no longer executing.");
    return r;
  }

  private <T> T command(UUID user, UUID run, String type, Object payload, Class<T> result) {
    var r = active(user, run);
    return worker.command(store.user(user).workerId(), type, r.generation(), run, payload, result);
  }

  private void authenticated(UUID user, UUID run) {
    var session = command(user, run, "YANG_SESSION", null, Contracts.YangSession.class);
    if (!"READY".equals(session.state()))
      throw new ApiException(
          409,
          session.state().equals("TWO_FACTOR_REQUIRED")
              ? "TWO_FACTOR_REQUIRED"
              : "YANG_LOGIN_REQUIRED",
          "Yang sign-in is required.");
  }

  private void stage(UUID user, UUID run, String state) {
    var r = active(user, run);
    if (!r.status().equals(state) && !store.state(user, run, r.status(), state, null))
      throw new ApiException(409, "RUN_STOPPED", "Run was stopped.");
  }

  private void download(UUID user, UUID run, Contracts.InstructionBundle instruction) {
    SnapshotValidation.instruction(instruction);
    materials.source(user, run, instruction);
    for (var block : instruction.blocks())
      if (block.asset() != null) download(user, run, block.asset());
  }

  private void download(UUID user, UUID run, Contracts.MediaAsset asset) {
    active(user, run);
    if (!materials.has(run, asset))
      materials.register(user, run, store.user(user).workerId(), asset);
  }

  private InstructionCompiler.Compiled prepareInstruction(
      UUID user, UUID run, Contracts.InstructionBundle instruction, Instant expires) {
    stage(user, run, "PREPARING");
    download(user, run, instruction);
    var cache = compiled.computeIfAbsent(run, x -> new HashMap<>());
    String key = instruction.sourceKey() + ":" + instruction.hash();
    var result = cache.get(key);
    if (result == null) {
      result = compiler.compile(user, run, instruction, expires);
      cache.clear();
      cache.put(key, result);
    }
    return result;
  }

  private void cycle(UUID user, UUID run) {
    while (true) {
      authenticated(user, run);
      stage(user, run, "SELECTING");
      var catalogue =
          decorate(
              user,
              command(user, run, "CATALOGUE", Map.of("refresh", true), Contracts.Catalogue.class));
      catalogues.put(user, catalogue);
      var r = active(user, run);
      var project = ProjectSelection.choose(catalogue, r.selection());
      if (project == null) {
        if (r.selection().mode().equals("MANUAL")) {
          var requested =
              catalogue.items().stream()
                  .filter(i -> i.poolId().equals(r.selection().poolId()) && i.reason() != null)
                  .findFirst();
          if (requested.isPresent())
            throw new ApiException(
                409, requested.get().reason().code(), requested.get().reason().message());
        }
        store.state(user, run, "SELECTING", "COMPLETED", "NO_MATCHING_TASKS");
        cleanup(user, run, r.generation());
        return;
      }
      store.selected(
          user,
          run,
          project,
          catalogue.activePoolId() != null
              ? "Продолжение зарезервированного набора"
              : r.selection().mode().equals("MANUAL")
                  ? "Проект выбран пользователем"
                  : "Максимальная сопоставимая цена среди подходящих проектов");
      InstructionCompiler.Compiled prepared;
      try {
        Contracts.TaskSet reserved = null;
        if (catalogue.activePoolId() != null) {
          if (catalogue.activeSuiteId() == null)
            command(
                user,
                run,
                "SELECT_PROJECT",
                Map.of("poolId", project.poolId()),
                Contracts.BrowserStatus.class);
          reserved = command(user, run, "SNAPSHOT", null, Contracts.TaskSet.class);
          SnapshotValidation.validate(reserved);
          deadline(reserved);
          if (!reserved.poolId().equals(project.poolId()))
            throw new ApiException(409, "PROJECT_CHANGED", "Browser opened a different project.");
        }
        var instruction =
            reserved != null
                ? reserved.instruction()
                : command(
                    user,
                    run,
                    "INSTRUCTION",
                    Map.of("poolId", project.poolId()),
                    Contracts.InstructionBundle.class);
        prepared =
            prepareInstruction(
                user, run, instruction, reserved == null ? null : reserved.expiresAt());
        var preliminary = capabilities(project.modalities(), prepared);
        if (!preliminary.isEmpty()) gates.require(preliminary);
      } catch (ApiException error) {
        if (!Set.of(
                    "YANG_LOGIN_REQUIRED",
                    "LOGIN_REQUIRED",
                    "TWO_FACTOR_REQUIRED",
                    "AUTH_EXPIRED",
                    "RUN_STOPPED",
                    "AI_QUOTA",
                    "AI_BUSY",
                    "AI_QUEUE_TIMEOUT")
                .contains(error.code())
            && catalogue.activePoolId() == null) {
          blockedProjects
              .computeIfAbsent(user, x -> new ConcurrentHashMap<>())
              .put(
                  project.poolId(),
                  new Contracts.ApiError(error.code(), ApiErrors.message(error.code())));
          if (r.selection().mode().equals("AUTO")) {
            stage(user, run, "SELECTING");
            continue;
          }
        }
        throw error;
      }
      if (catalogue.activePoolId() == null) {
        authenticated(user, run);
        command(
            user,
            run,
            "SELECT_PROJECT",
            Map.of("poolId", project.poolId()),
            Contracts.BrowserStatus.class);
      }
      Contracts.TaskSet snapshot = null;
      int rebuilds = 0;
      while (true) {
        try {
          snapshot = command(user, run, "SNAPSHOT", null, Contracts.TaskSet.class);
          SnapshotValidation.validate(snapshot);
          deadline(snapshot);
          if (!snapshot.poolId().equals(project.poolId()))
            throw new ApiException(409, "PROJECT_CHANGED", "Browser opened a different project.");
          if (!snapshot.instruction().hash().equals(prepared.hash()))
            prepared = prepareInstruction(user, run, snapshot.instruction(), snapshot.expiresAt());
          for (var a : SnapshotValidation.assets(snapshot)) download(user, run, a);
          gates.require(capabilities(snapshot, prepared));
          var item = store.draft(user, run, snapshot);
          if (item == null) throw new ApiException(409, "RUN_STOPPED", "Run stopped.");
          materials.put(run, new Materials.Current(run, item.id(), snapshot));
          snapshot = mapFields(user, run, snapshot);
          snapshot = fill(user, run, item, snapshot, prepared);
          var answer = allAnswers(snapshot);
          SnapshotValidation.answers(snapshot, answer, true);
          authenticated(user, run);
          var fresh = command(user, run, "SNAPSHOT", null, Contracts.TaskSet.class);
          SnapshotValidation.validate(fresh);
          deadline(fresh);
          if (!same(snapshot, fresh))
            throw new ApiException(409, "STALE_TASK", "Task content or instruction changed.");
          SnapshotValidation.answers(fresh, answer, true);
          verifyValues(fresh, answer.answers());
          synchronized (lock(user)) {
            active(user, run);
            store.updateDraft(user, run, item.id(), fresh);
            if (!store.intent(user, run, item.id(), fresh, answer))
              throw new ApiException(
                  409, "SUBMISSION_ALREADY_ATTEMPTED", "This suite was already dispatched.");
          }
          var payload =
              new Contracts.SubmitPayload(
                  fresh.poolId(),
                  fresh.suiteId(),
                  fresh.snapshotHash(),
                  fresh.instruction().hash(),
                  answer.answers());
          Contracts.SubmitResult result;
          try {
            result = command(user, run, "SUBMIT", payload, Contracts.SubmitResult.class);
            if (result == null
                || !Set.of("SUBMITTED", "COMPLETE", "UNKNOWN", "REJECTED")
                    .contains(result.outcome()))
              result = new Contracts.SubmitResult("UNKNOWN", null, "INVALID_SUBMIT_RESULT");
          } catch (Exception e) {
            result = new Contracts.SubmitResult("UNKNOWN", null, "SUBMIT_OUTCOME_UNKNOWN");
          }
          boolean next = store.finish(user, run, result);
          if (Set.of("SUBMITTED", "COMPLETE").contains(result.outcome()))
            materials.completeSuite(run, fresh.instruction());
          if (!next) {
            cleanup(user, run, r.generation());
            return;
          }
          break;
        } catch (ApiException e) {
          if (Set.of("STALE_TASK", "SNAPSHOT_CHANGED", "INSTRUCTION_CHANGED").contains(e.code())
              && rebuilds++ < 2) {
            stage(user, run, "PREPARING");
            continue;
          }
          throw e;
        }
      }
    }
  }

  private Contracts.TaskSet mapFields(UUID user, UUID run, Contracts.TaskSet snapshot) {
    if (snapshot.parts().stream().noneMatch(p -> !p.unmappedControls().isEmpty())) return snapshot;
    stage(user, run, "ANALYZING");
    var mapping =
        ai.call(
            user,
            run,
            snapshot.snapshotHash(),
            snapshot.instruction().hash(),
            snapshot.expiresAt(),
            t -> model.map(snapshot, t));
    var mapped = command(user, run, "MAP_FIELDS", mapping, Contracts.TaskSet.class);
    SnapshotValidation.validate(mapped);
    if (!snapshot.poolId().equals(mapped.poolId())
        || !snapshot.suiteId().equals(mapped.suiteId())
        || !snapshot.instruction().hash().equals(mapped.instruction().hash()))
      throw new ApiException(409, "STALE_TASK", "Task changed during mapping.");
    stableAfterApply(snapshot, mapped);
    if (mapped.parts().stream().anyMatch(p -> !p.unmappedControls().isEmpty()))
      throw new ApiException(
          422, "UNMAPPED_CONTROLS", "Not every observed control could be mapped.");
    return mapped;
  }

  private Contracts.TaskSet fill(
      UUID user,
      UUID run,
      Store.Item item,
      Contracts.TaskSet snapshot,
      InstructionCompiler.Compiled instruction) {
    var answered = new LinkedHashMap<String, Contracts.FieldAnswer>();
    int rounds = 0;
    while (true) {
      if (++rounds > 500)
        throw new ApiException(422, "FORM_UNSTABLE", "Form changed too many times.");
      deadline(snapshot);
      snapshot = mapFields(user, run, snapshot);
      verifyValues(snapshot, List.copyOf(answered.values()));
      Contracts.TaskPart next = null;
      List<Contracts.TaskField> fields = List.of();
      for (var part : snapshot.parts()) {
        var pending =
            part.fields().stream()
                .filter(f -> f.required() && !answered.containsKey(part.id() + "/" + f.id()))
                .toList();
        if (!pending.isEmpty()) {
          next = part;
          int stage = pending.stream().mapToInt(Contracts.TaskField::stage).min().orElseThrow();
          fields = pending.stream().filter(f -> f.stage() == stage).toList();
          break;
        }
      }
      if (next == null) break;
      stage(user, run, "ANALYZING");
      var part = next;
      var targets = fields;
      var current = snapshot;
      var selection =
          ai.call(
              user,
              run,
              snapshot.snapshotHash(),
              instruction.hash(),
              snapshot.expiresAt(),
              t -> model.sources(part, targets, instruction, t));
      var result =
          ai.call(
              user,
              run,
              snapshot.snapshotHash(),
              instruction.hash(),
              snapshot.expiresAt(),
              t -> model.answer(run, part, targets, instruction, selection.sourceIds(), t));
      if (result == null || !"ANSWER".equals(result.decision()))
        throw new ApiException(
            422, "MODEL_ABSTAINED", "The model cannot answer this suite unambiguously.");
      SnapshotValidation.answers(snapshot, result, false);
      Set<String> expected =
          targets.stream()
              .map(f -> part.id() + "/" + f.id())
              .collect(java.util.stream.Collectors.toSet());
      Set<String> received =
          result.answers().stream()
              .map(a -> a.partId() + "/" + a.fieldId())
              .collect(java.util.stream.Collectors.toSet());
      if (!expected.equals(received))
        throw new ApiException(
            502,
            "INVALID_MODEL_RESPONSE",
            "The answer does not cover exactly the requested stage.");
      for (var a : result.answers()) answered.put(a.partId() + "/" + a.fieldId(), a);
      stage(user, run, "FILLING");
      authenticated(user, run);
      var payload =
          new Contracts.SubmitPayload(
              snapshot.poolId(),
              snapshot.suiteId(),
              snapshot.snapshotHash(),
              snapshot.instruction().hash(),
              List.copyOf(answered.values()));
      var applied = command(user, run, "APPLY", payload, Contracts.TaskSet.class);
      SnapshotValidation.validate(applied);
      if (!snapshot.poolId().equals(applied.poolId())
          || !snapshot.suiteId().equals(applied.suiteId())
          || !snapshot.instruction().hash().equals(applied.instruction().hash()))
        throw new ApiException(409, "STALE_TASK", "Task or instruction changed while filling.");
      // Material, text and existing field definitions must remain stable; only conditional
      // additions are expected.
      stableAfterApply(snapshot, applied);
      verifyValues(applied, List.copyOf(answered.values()));
      for (var a : SnapshotValidation.assets(applied)) download(user, run, a);
      snapshot = applied;
      materials.put(run, new Materials.Current(run, item.id(), snapshot));
    }
    stage(user, run, "FILLING");
    return snapshot;
  }

  static void stableAfterApply(Contracts.TaskSet before, Contracts.TaskSet after) {
    if (before.parts().size() != after.parts().size())
      throw new ApiException(409, "STALE_TASK", "Task parts changed.");
    for (int i = 0; i < before.parts().size(); i++) {
      var a = before.parts().get(i);
      var b = after.parts().get(i);
      if (!a.id().equals(b.id()) || !a.text().equals(b.text()) || !a.media().equals(b.media()))
        throw new ApiException(409, "STALE_TASK", "Task material changed.");
      for (var f : a.fields()) {
        var other = b.fields().stream().filter(x -> x.id().equals(f.id())).findFirst().orElse(null);
        if (other == null
            || !f.label().equals(other.label())
            || !f.kind().equals(other.kind())
            || !f.options().equals(other.options())
            || f.stage() != other.stage()
            || f.required() != other.required()
            || !Objects.equals(f.maxLength(), other.maxLength())
            || !Objects.equals(f.min(), other.min())
            || !Objects.equals(f.max(), other.max()))
          throw new ApiException(409, "STALE_TASK", "An existing field changed.");
      }
    }
  }

  static void verifyValues(Contracts.TaskSet snapshot, List<Contracts.FieldAnswer> answers) {
    for (var a : answers) {
      var f =
          snapshot.parts().stream()
              .filter(p -> p.id().equals(a.partId()))
              .flatMap(p -> p.fields().stream())
              .filter(x -> x.id().equals(a.fieldId()))
              .findFirst()
              .orElseThrow(ApiException::invalid);
      boolean equal =
          a.value() instanceof Number n && f.value() instanceof Number m
              ? Double.compare(n.doubleValue(), m.doubleValue()) == 0
              : f.kind().equals("MULTI_CHOICE")
                      && a.value() instanceof List<?> selected
                      && f.value() instanceof List<?> actual
                  ? new HashSet<>(selected).equals(new HashSet<>(actual))
                  : Objects.equals(a.value(), f.value());
      if (!equal)
        throw new ApiException(
            409, "ANSWER_READBACK_FAILED", "Observed form values differ from requested answers.");
    }
  }

  private Contracts.AnswerSet allAnswers(Contracts.TaskSet snapshot) {
    return new Contracts.AnswerSet(
        "ANSWER",
        snapshot.parts().stream()
            .flatMap(
                p ->
                    p.fields().stream()
                        .filter(f -> !SnapshotValidation.empty(f.value()))
                        .map(f -> new Contracts.FieldAnswer(p.id(), f.id(), f.value())))
            .toList(),
        null);
  }

  private boolean same(Contracts.TaskSet a, Contracts.TaskSet b) {
    return a.poolId().equals(b.poolId())
        && a.suiteId().equals(b.suiteId())
        && a.snapshotHash().equals(b.snapshotHash())
        && a.instruction().hash().equals(b.instruction().hash());
  }

  private void deadline(Contracts.TaskSet s) {
    if (s.expiresAt() != null && !s.expiresAt().isAfter(clock.instant()))
      throw new ApiException(409, "TASK_EXPIRED", "Task expired.");
  }

  static Set<String> capabilities(List<String> modalities, InstructionCompiler.Compiled c) {
    var result = new HashSet<String>();
    if (modalities.contains("text")) result.add("TEXT");
    if (modalities.contains("image")) result.add("IMAGE");
    if (modalities.contains("audio"))
      result.add(c.contentOnlySpeech() ? "SPEECH" : "SOUND_PROSODY");
    return result;
  }

  static Set<String> capabilities(Contracts.TaskSet s, InstructionCompiler.Compiled c) {
    var kinds = new HashSet<String>();
    kinds.add("text");
    for (var p : s.parts()) for (var a : p.media()) kinds.add(a.kind());
    return capabilities(List.copyOf(kinds), c);
  }

  private void handle(UUID user, UUID run, ApiException error) {
    synchronized (lock(user)) {
      var r = store.owned(user, run);
      if (!Store.ACTIVE.contains(r.status())) {
        cleanup(user, run, r.generation());
        return;
      }
      if (r.status().equals("SUBMITTING")) {
        store.finish(user, run, new Contracts.SubmitResult("UNKNOWN", null, error.code()));
        cleanup(user, run, r.generation());
        return;
      }
      if (Set.of("YANG_LOGIN_REQUIRED", "LOGIN_REQUIRED", "TWO_FACTOR_REQUIRED", "AUTH_EXPIRED")
          .contains(error.code())) {
        store.state(user, run, r.status(), "WAITING_FOR_AUTH", error.code());
        try {
          worker.command(
              store.user(user).workerId(),
              "PAUSE",
              r.generation(),
              run,
              null,
              Contracts.BrowserStatus.class);
        } catch (Exception ignored) {
        }
        return;
      }
      if (Set.of(
              "QUALITY_NOT_VERIFIED",
              "ACTIVE_SUITE_UNSUPPORTED",
              "ACTIVE_SUITE_CONFLICT",
              "PROJECT_REQUIRED",
              "INSTRUCTION_INCOMPLETE",
              "INSTRUCTION_UNAVAILABLE",
              "INSTRUCTION_CONTEXT_UNSUPPORTED",
              "MODEL_CONTEXT_UNSUPPORTED",
              "MODEL_ABSTAINED",
              "UNMAPPED_CONTROLS",
              "REWARD_UNITS_DIFFER")
          .contains(error.code())) {
        store.state(user, run, r.status(), "WAITING_FOR_USER", error.code());
        try {
          worker.command(
              store.user(user).workerId(),
              "PAUSE",
              r.generation(),
              run,
              null,
              Contracts.BrowserStatus.class);
        } catch (Exception ignored) {
        }
        return;
      }
      store.fail(user, run, error.code());
      cleanup(user, run, r.generation());
    }
  }

  private void cleanup(UUID user, UUID run, String generation) {
    compiled.remove(run);
    materials.remove(run);
    try {
      worker.command(
          store.user(user).workerId(),
          "STOP",
          generation,
          run,
          null,
          Contracts.BrowserStatus.class);
    } catch (Exception ignored) {
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
    var r = store.owned(user.id(), run);
    if (Store.ACTIVE.contains(r.status())
        && !Set.of("WAITING_FOR_AUTH", "WAITING_FOR_USER").contains(r.status()))
      throw new ApiException(409, "RUN_ACTIVE", "Run is active.");
    worker.command(
        user.workerId(),
        Set.of("WAITING_FOR_AUTH", "WAITING_FOR_USER").contains(r.status()) ? "PAUSE" : "STOP",
        status.generation(),
        run,
        null,
        Contracts.BrowserStatus.class);
  }

  public Contracts.RunView stop(UUID user, UUID run) {
    synchronized (lock(user)) {
      var r = store.owned(user, run);
      if (Store.ACTIVE.contains(r.status())) {
        store.stop(user, run);
        leases.revoke(user);
        cleanup(user, run, r.generation());
      }
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
            : new Contracts.ApiError(r.errorCode(), ApiErrors.message(r.errorCode())),
        r.selection(),
        r.selectedProject(),
        r.selectionReason(),
        r.instructionProgress());
  }

  public Contracts.RunView view(UUID user, UUID run) {
    var r = store.owned(user, run);
    var c = materials.get(run);
    var s = summary(r);
    return new Contracts.RunView(
        r.id(),
        r.status(),
        r.maxTasks(),
        r.processed(),
        r.createdAt(),
        r.updatedAt(),
        s.error(),
        r.selection(),
        r.selectedProject(),
        r.selectionReason(),
        r.instructionProgress(),
        c == null ? null : c.snapshot(),
        store.items(run).stream()
            .map(
                i ->
                    new Contracts.RunItemResult(
                        i.poolId(),
                        i.suiteId(),
                        i.ordinal(),
                        i.status(),
                        i.answer() == null ? null : i.answer().answers(),
                        i.code(),
                        i.createdAt()))
            .toList());
  }

  @PreDestroy
  void close() {
    executor.shutdownNow();
  }
}
