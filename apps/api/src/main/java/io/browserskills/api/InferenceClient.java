package io.browserskills.api;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

@Component
public class InferenceClient {
  private static final String SYSTEM = systemPrompt();
  private static final SecureRandom RANDOM = new SecureRandom();
  private final JsonMapper json;
  private final AudioNormalizer audio;
  private final URI base;
  private final BoundedHttp http = new BoundedHttp();

  private static String systemPrompt() {
    try {
      return new ClassPathResource("decision-system.txt")
          .getContentAsString(StandardCharsets.UTF_8)
          .strip();
    } catch (IOException e) {
      throw new IllegalStateException("The canonical decision system prompt is missing.", e);
    }
  }

  public InferenceClient(
      JsonMapper json,
      AudioNormalizer audio,
      @Value("${api.inference-url:http://inference:8080}") String url) {
    this.json = json;
    this.audio = audio;
    this.base = URI.create(url);
  }

  private List<Object> content(
      Materials.Current current, List<Contracts.Option> options, long deadline) {
    var snapshot = current.snapshot();
    var result = new ArrayList<Object>();
    result.add(text("PROJECT INSTRUCTIONS (all blocks, in order):"));
    for (var block : snapshot.instruction().blocks()) {
      if ("text".equals(block.type())) result.add(text(block.text()));
      else {
        if (block.caption() != null) result.add(text(block.caption()));
        result.add(media(block.asset(), current, deadline));
      }
    }
    result.add(text("CURRENT WHOLE TASK:\n" + snapshot.question()));
    if (snapshot.image() != null) result.add(media(snapshot.image(), current, deadline));
    if (snapshot.audio() != null) result.add(media(snapshot.audio(), current, deadline));
    result.add(text("AVAILABLE OPTIONS:\n" + json.writeValueAsString(options)));
    return result;
  }

  private Map<String, Object> text(String text) {
    return Map.of("type", "text", "text", text);
  }

  private Map<String, Object> media(
      Contracts.MediaAsset asset, Materials.Current current, long deadline) {
    byte[] bytes = current.media().get(asset.id());
    if (bytes == null)
      throw new ApiException(502, "MEDIA_UNAVAILABLE", "Complete task media is required.");
    if (asset.kind().equals("image"))
      return Map.of(
          "type",
          "image_url",
          "image_url",
          Map.of(
              "url",
              "data:" + asset.mimeType() + ";base64," + Base64.getEncoder().encodeToString(bytes)));
    return Map.of(
        "type",
        "input_audio",
        "input_audio",
        Map.of(
            "data",
            Base64.getEncoder()
                .encodeToString(audio.wav(bytes, asset.durationMs(), remaining(deadline))),
            "format",
            "wav"));
  }

  public Contracts.Decision analyze(Materials.Current current, Duration timeout) {
    long deadline = System.nanoTime() + timeout.toNanos();
    // Numeric-looking site IDs can be mistaken for answer values. Keep the model's
    // identifiers opaque and local to this request; the public snapshot is unchanged.
    var originals = current.snapshot().options().stream().map(Contracts.Option::id).toList();
    var actualIds = new LinkedHashMap<String, String>();
    var options = new ArrayList<Contracts.Option>();
    for (var option : current.snapshot().options()) {
      String alias;
      do {
        var letters = new char[10];
        for (int i = 0; i < letters.length; i++) letters[i] = (char) ('a' + RANDOM.nextInt(26));
        alias = new String(letters);
      } while (actualIds.containsKey(alias) || originals.contains(alias));
      actualIds.put(alias, option.id());
      options.add(new Contracts.Option(alias, option.label()));
    }
    var optionIds = List.copyOf(actualIds.keySet());
    var schema =
        Map.of(
            "oneOf",
            List.of(
                Map.of(
                    "type",
                    "object",
                    "properties",
                    Map.of(
                        "decision",
                        Map.of("const", "ANSWER"),
                        "optionId",
                        Map.of("type", "string", "enum", optionIds)),
                    "required",
                    List.of("decision", "optionId"),
                    "additionalProperties",
                    false),
                Map.of(
                    "type",
                    "object",
                    "properties",
                    Map.of("decision", Map.of("const", "ABSTAIN")),
                    "required",
                    List.of("decision"),
                    "additionalProperties",
                    false)));
    var body =
        Map.of(
            "model",
            "Qwen2.5-Omni-7B",
            "messages",
            List.of(
                Map.of("role", "system", "content", SYSTEM),
                Map.of("role", "user", "content", content(current, options, deadline))),
            "temperature",
            0,
            "stream",
            false,
            "cache_prompt",
            false,
            "max_tokens",
            512,
            "response_format",
            Map.of(
                "type",
                "json_schema",
                "json_schema",
                Map.of("name", "Decision", "strict", true, "schema", schema)));
    // The server is deployed with --no-context-shift. No clipping, transcript substitution,
    // retries or context shrinking is permitted when multimodal embeddings exceed context.
    var response =
        http.send(
            HttpRequest.newBuilder(base.resolve("/v1/chat/completions"))
                .timeout(remaining(deadline))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(body)))
                .build(),
            64 * 1024,
            remaining(deadline));
    if (response.statusCode() == 413)
      throw new ApiException(
          422,
          "MODEL_CONTEXT_UNSUPPORTED",
          "Complete instructions and media do not fit the model context. Select manually.");
    if (response.statusCode() == 400)
      throw new ApiException(
          422,
          "MODEL_REQUEST_UNSUPPORTED",
          "Model rejected the complete task format or context. Select manually.");
    if (response.statusCode() / 100 != 2)
      throw new ApiException(503, "MODEL_UNAVAILABLE", "Model is unavailable. Select manually.");
    try {
      var node = json.readTree(response.body());
      var choice = node.path("choices").get(0);
      if (choice == null || !choice.path("finish_reason").asString().equals("stop"))
        throw new IllegalArgumentException();
      var decision =
          SnapshotValidation.decision(
              choice.path("message").path("content").asString(), options, json);
      return decision.decision().equals("ABSTAIN")
          ? decision
          : new Contracts.Decision("ANSWER", actualIds.get(decision.optionId()));
    } catch (ApiException e) {
      throw e;
    } catch (Exception e) {
      throw new ApiException(
          502, "INVALID_MODEL_RESPONSE", "Model returned an unsupported answer. Select manually.");
    }
  }

  private Duration remaining(long deadline) {
    long nanos = deadline - System.nanoTime();
    if (nanos <= 0)
      throw new ApiException(503, "MODEL_TIMEOUT", "Analysis deadline exceeded. Select manually.");
    return Duration.ofNanos(nanos);
  }
}
