package io.browserskills.api;

import jakarta.annotation.PreDestroy;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Function;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

@Component
@org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
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
  private final Store store;
  private final JsonMapper json;
  private final Clock clock;
  private final String modelHash;

  public AnalysisQueue(
      Store store,
      JsonMapper json,
      Clock clock,
      @Value("${API_MODEL_SHA256:unverified}") String modelHash) {
    this.store = store;
    this.json = json;
    this.clock = clock;
    this.modelHash = modelHash;
  }

  public <T> T call(
      UUID user,
      UUID run,
      String snapshotHash,
      String instructionHash,
      Instant expires,
      Function<Duration, T> action) {
    if (!queued.add(user))
      throw new ApiException(503, "AI_BUSY", "An inference is already active for this user.");
    Instant enqueued = clock.instant();
    Instant deadline = enqueued.plusSeconds(120);
    if (expires != null && expires.isBefore(deadline)) deadline = expires;
    long wait = Math.max(1, Duration.between(enqueued, deadline).toMillis());
    var started = new java.util.concurrent.atomic.AtomicBoolean();
    Future<T> future;
    try {
      future =
          executor.submit(
              () -> {
                started.set(true);
                try {
                  var r = store.owned(user, run);
                  if (!Set.of("SELECTING", "PREPARING", "ANALYZING", "FILLING")
                      .contains(r.status()))
                    throw new ApiException(409, "RUN_STOPPED", "Run stopped.");
                  Instant now = clock.instant();
                  if (!now.isBefore(enqueued.plusSeconds(120)))
                    throw new ApiException(
                        503, "AI_QUEUE_TIMEOUT", "Inference queue deadline exceeded.");
                  Duration timeout = Duration.ofSeconds(120);
                  if (expires != null) {
                    Duration left = Duration.between(now, expires);
                    if (left.isZero() || left.isNegative())
                      throw new ApiException(409, "TASK_EXPIRED", "Task expired.");
                    if (left.compareTo(timeout) < 0) timeout = left;
                  }
                  UUID request = UUID.randomUUID();
                  if (!store.reserveAi(user, request, snapshotHash, instructionHash))
                    throw new ApiException(
                        409, "ANALYSIS_ALREADY_ATTEMPTED", "Inference was already attempted.");
                  try {
                    T result = action.apply(timeout);
                    store.completeAi(
                        user,
                        request,
                        json.writeValueAsString(
                            Map.of(
                                "resultSha256",
                                SnapshotValidation.sha256(json.writeValueAsBytes(result)))),
                        null,
                        modelHash);
                    return result;
                  } catch (ApiException e) {
                    store.completeAi(user, request, null, e.code(), modelHash);
                    throw e;
                  } catch (Exception e) {
                    store.completeAi(user, request, null, "AI_UNAVAILABLE", modelHash);
                    throw new ApiException(503, "AI_UNAVAILABLE", "Inference failed.");
                  }
                } finally {
                  queued.remove(user);
                }
              });
    } catch (RejectedExecutionException e) {
      queued.remove(user);
      throw new ApiException(503, "AI_BUSY", "Inference queue is full.");
    }
    try {
      // Wait for queue entry first; processing gets its own bounded 120-second deadline.
      long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(wait);
      while (!started.get()) {
        long left = until - System.nanoTime();
        if (left <= 0) {
          future.cancel(false);
          executor.purge();
          queued.remove(user);
          throw new ApiException(503, "AI_QUEUE_TIMEOUT", "Inference queue deadline exceeded.");
        }
        try {
          return future.get(
              Math.min(TimeUnit.NANOSECONDS.toMillis(left) + 1, 20), TimeUnit.MILLISECONDS);
        } catch (TimeoutException ignored) {
        }
      }
      return future.get(121, TimeUnit.SECONDS);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      future.cancel(true);
      throw new ApiException(409, "RUN_STOPPED", "Run interrupted.");
    } catch (TimeoutException e) {
      future.cancel(true);
      throw new ApiException(503, "MODEL_TIMEOUT", "Inference deadline exceeded.");
    } catch (ExecutionException e) {
      if (e.getCause() instanceof ApiException api) throw api;
      throw new ApiException(503, "AI_UNAVAILABLE", "Inference failed.");
    }
  }

  @PreDestroy
  void close() {
    executor.shutdownNow();
  }
}
