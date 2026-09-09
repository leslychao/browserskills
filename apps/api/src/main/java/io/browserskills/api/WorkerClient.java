package io.browserskills.api;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

@Component
public class WorkerClient {
  private final Environment env;
  private final JsonMapper json;
  private final BoundedHttp http = new BoundedHttp();

  public WorkerClient(Environment env, JsonMapper json) {
    this.env = env;
    this.json = json;
  }

  public URI uri(int worker, String path) {
    if (worker < 1 || worker > 5) throw new IllegalArgumentException();
    String base = env.getProperty("api.workers." + worker, "http://browser-" + worker + ":3000");
    return URI.create(base + path);
  }

  public String token(int worker) {
    String token = env.getProperty("worker_" + worker + "_token");
    if (token == null || token.isBlank())
      throw new ApiException(503, "WORKER_NOT_CONFIGURED", "Browser worker is not configured.");
    return token.strip();
  }

  public Contracts.BrowserStatus status(int worker) {
    return request(worker, "/internal/status", null, Contracts.BrowserStatus.class);
  }

  public <T> T command(
      int worker, String type, String generation, UUID run, Object payload, Class<T> result) {
    return request(
        worker,
        "/internal/commands",
        new Contracts.WorkerCommand(
            UUID.randomUUID(), type, generation, run == null ? null : run.toString(), payload),
        result);
  }

  public <T> T request(int worker, String path, Object body, Class<T> result) {
    var builder =
        HttpRequest.newBuilder(uri(worker, path))
            .timeout(Duration.ofSeconds(65))
            .header("Authorization", "Bearer " + token(worker))
            .header("Accept", "application/json");
    if (body != null)
      builder
          .header("Content-Type", "application/json")
          .POST(HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(body)));
    var response = http.send(builder.build(), 1024 * 1024, Duration.ofSeconds(65));
    if (response.statusCode() / 100 != 2) throw error(response.statusCode(), response.body());
    try {
      return json.readValue(response.body(), result);
    } catch (Exception e) {
      throw new ApiException(
          502, "INVALID_WORKER_RESPONSE", "Browser worker returned an invalid response.");
    }
  }

  public byte[] media(int worker, Contracts.MediaAsset asset) {
    String path =
        "/internal/media/"
            + URLEncoder.encode(asset.id(), StandardCharsets.UTF_8).replace("+", "%20");
    var response =
        http.send(
            HttpRequest.newBuilder(uri(worker, path))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + token(worker))
                .build(),
            20 * 1024 * 1024,
            Duration.ofSeconds(30));
    if (response.statusCode() != 200
        || response.body().length != asset.byteLength()
        || !SnapshotValidation.sha256(response.body()).equals(asset.sha256()))
      throw new ApiException(502, "MEDIA_CHANGED", "Task media is unavailable or changed.");
    return response.body();
  }

  private ApiException error(int status, byte[] bytes) {
    try {
      var e = json.readValue(bytes, Contracts.ApiError.class);
      if (e.code() != null && e.code().matches("[A-Z_]{1,100}"))
        return new ApiException(
            status >= 400 && status < 500 ? 409 : 502,
            e.code(),
            "Browser cannot perform this action. Review the browser task.");
    } catch (Exception ignored) {
    }
    return new ApiException(502, "WORKER_UNAVAILABLE", "Browser worker is unavailable.");
  }
}
