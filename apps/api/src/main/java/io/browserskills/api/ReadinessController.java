package io.browserskills.api;

import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.net.http.HttpRequest;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.web.bind.annotation.*;

@RestController
@ConditionalOnWebApplication
public class ReadinessController {
  private final DataSource db;
  private final WorkerClient workers;
  private final URI inference;
  private final BoundedHttp http = new BoundedHttp();
  private final ExecutorService probes =
      new ThreadPoolExecutor(
          7,
          7,
          0,
          TimeUnit.SECONDS,
          new ArrayBlockingQueue<>(7),
          Thread.ofPlatform().name("readiness-", 0).factory(),
          new ThreadPoolExecutor.AbortPolicy());

  public ReadinessController(
      DataSource db, WorkerClient workers, @Value("${api.inference-url}") String inference) {
    this.db = db;
    this.workers = workers;
    this.inference = URI.create(inference);
  }

  @GetMapping("/health/ready")
  public Map<String, Object> ready(HttpServletRequest request) {
    if (!Set.of("127.0.0.1", "::1", "0:0:0:0:0:0:0:1").contains(request.getRemoteAddr()))
      throw new ApiException(404, "NOT_FOUND", "Resource not found.");
    var results = new LinkedHashMap<String, CompletableFuture<String>>();
    results.put(
        "database",
        probe(
            () -> {
              try (var connection = db.getConnection();
                  var statement = connection.createStatement()) {
                statement.setQueryTimeout(2);
                try (var row = statement.executeQuery("SELECT 1")) {
                  return row.next() ? "UP" : "DOWN";
                }
              }
            }));
    for (int i = 1; i <= 5; i++) {
      int worker = i;
      results.put(
          "browser-" + i,
          probe(
              () ->
                  status(
                      HttpRequest.newBuilder(workers.uri(worker, "/internal/status"))
                          .header("Authorization", "Bearer " + workers.token(worker))
                          .timeout(Duration.ofSeconds(1))
                          .build())));
    }
    results.put(
        "inference",
        probe(
            () ->
                status(
                    HttpRequest.newBuilder(inference.resolve("/health"))
                        .timeout(Duration.ofSeconds(1))
                        .build())));
    var values = new LinkedHashMap<String, String>();
    results.forEach((name, future) -> values.put(name, future.join()));
    return Map.of(
        "status",
        values.values().stream().allMatch("UP"::equals) ? "READY" : "DEGRADED",
        "components",
        values,
        "manualBrowserAvailable",
        values.get("database").equals("UP")
            && values.entrySet().stream()
                .anyMatch(e -> e.getKey().startsWith("browser-") && e.getValue().equals("UP")));
  }

  private String status(HttpRequest request) {
    return http.send(request, 64 * 1024, Duration.ofSeconds(1)).statusCode() == 200 ? "UP" : "DOWN";
  }

  private CompletableFuture<String> probe(Callable<String> action) {
    try {
      return CompletableFuture.supplyAsync(
              () -> {
                try {
                  return action.call();
                } catch (Exception e) {
                  return "DOWN";
                }
              },
              probes)
          .completeOnTimeout("DOWN", 2, TimeUnit.SECONDS);
    } catch (RejectedExecutionException e) {
      return CompletableFuture.completedFuture("BUSY");
    }
  }

  @PreDestroy
  void close() {
    probes.shutdownNow();
  }
}
