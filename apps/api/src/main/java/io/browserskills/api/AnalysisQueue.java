package io.browserskills.api;

import jakarta.annotation.PreDestroy;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

@Component
public class AnalysisQueue {
  private final ThreadPoolExecutor executor =
      new ThreadPoolExecutor(
          1,
          1,
          0,
          TimeUnit.SECONDS,
          new ArrayBlockingQueue<>(4),
          Thread.ofPlatform().name("inference-", 0).factory(),
          new ThreadPoolExecutor.AbortPolicy());
  private final Set<UUID> queued = ConcurrentHashMap.newKeySet();
  private final ScheduledThreadPoolExecutor deadlines =
      new ScheduledThreadPoolExecutor(1, Thread.ofPlatform().name("analysis-deadlines").factory());
  private final Store store;
  private final InferenceClient model;
  private final JsonMapper json;
  private final Clock clock;
  private final String modelHash;

  public AnalysisQueue(
      Store store,
      InferenceClient model,
      JsonMapper json,
      Clock clock,
      @Value("${API_MODEL_SHA256:unverified}") String modelHash) {
    this.store = store;
    this.model = model;
    this.json = json;
    this.clock = clock;
    this.modelHash = modelHash;
    deadlines.setRemoveOnCancelPolicy(true);
  }

  public void submit(
      UUID user,
      UUID run,
      Materials.Current current,
      BiConsumer<Contracts.Decision, Contracts.ApiError> callback) {
    if (!queued.add(user)) {
      callback.accept(
          null, new Contracts.ApiError("AI_BUSY", "An analysis is already active for this user."));
      return;
    }
    Instant queuedAt = clock.instant();
    AtomicBoolean claimed = new AtomicBoolean();
    AtomicBoolean expired = new AtomicBoolean();
    AtomicReference<ScheduledFuture<?>> alarmReference = new AtomicReference<>();
    Runnable task =
        () -> {
          if (!claimed.compareAndSet(false, true) || expired.get()) return;
          var alarm = alarmReference.get();
          if (alarm != null) alarm.cancel(false);
          execute(user, run, current, callback, queuedAt);
        };
    Instant deadline = queuedAt.plusSeconds(120);
    if (current.snapshot().expiresAt() != null && current.snapshot().expiresAt().isBefore(deadline))
      deadline = current.snapshot().expiresAt();
    ScheduledFuture<?> alarm =
        deadlines.schedule(
            () -> {
              if (claimed.compareAndSet(false, true)) {
                expired.set(true);
                executor.remove(task);
                queued.remove(user);
                callback.accept(
                    null,
                    new Contracts.ApiError(
                        "AI_QUEUE_TIMEOUT",
                        "Analysis queue or task deadline exceeded. Select manually."));
              }
            },
            Math.max(0, Duration.between(queuedAt, deadline).toMillis()),
            TimeUnit.MILLISECONDS);
    alarmReference.set(alarm);
    try {
      executor.execute(task);
    } catch (RejectedExecutionException e) {
      alarm.cancel(false);
      if (claimed.compareAndSet(false, true)) {
        queued.remove(user);
        callback.accept(
            null, new Contracts.ApiError("AI_BUSY", "Analysis queue is full. Select manually."));
      }
    }
  }

  private void execute(
      UUID user,
      UUID run,
      Materials.Current current,
      BiConsumer<Contracts.Decision, Contracts.ApiError> callback,
      Instant queuedAt) {
    try {
      if (!store.owned(user, run).status().equals("ANALYZING")) return;
      Instant now = clock.instant(), expires = current.snapshot().expiresAt();
      if (now.isAfter(queuedAt.plusSeconds(120)))
        throw new ApiException(
            503, "AI_QUEUE_TIMEOUT", "Analysis queue deadline exceeded. Select manually.");
      Duration timeout = Duration.ofSeconds(120);
      if (expires != null) {
        timeout = Duration.between(now, expires);
        if (timeout.isNegative() || timeout.isZero())
          throw new ApiException(409, "TASK_EXPIRED", "Task has expired.");
        if (timeout.compareTo(Duration.ofSeconds(120)) > 0) timeout = Duration.ofSeconds(120);
      }
      if (!store.reserveAi(user, current.itemId(), current.snapshot()))
        throw new ApiException(
            409,
            "ANALYSIS_ALREADY_ATTEMPTED",
            "This analysis was already attempted. Select manually.");
      Contracts.Decision decision;
      try {
        decision = model.analyze(current, timeout);
        store.completeAi(
            user, current.itemId(), json.writeValueAsString(decision), null, modelHash);
      } catch (ApiException e) {
        store.completeAi(user, current.itemId(), null, e.code(), modelHash);
        throw e;
      }
      callback.accept(decision, null);
    } catch (ApiException e) {
      callback.accept(null, new Contracts.ApiError(e.code(), e.getMessage()));
    } catch (Exception e) {
      callback.accept(
          null,
          new Contracts.ApiError(
              "AI_UNAVAILABLE", "Analysis could not be completed. Select manually."));
    } finally {
      queued.remove(user);
    }
  }

  @PreDestroy
  void close() {
    executor.shutdownNow();
    deadlines.shutdownNow();
  }
}
