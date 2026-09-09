package io.browserskills.api;

import java.net.URI;
import java.net.http.HttpRequest;
import java.time.Duration;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

@Component
@org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
public class InferenceClient {
  private static final String SYSTEM = systemPrompt();

  private static String systemPrompt() {
    try {
      return new org.springframework.core.io.ClassPathResource("decision-system.txt")
          .getContentAsString(java.nio.charset.StandardCharsets.UTF_8)
          .strip();
    } catch (java.io.IOException e) {
      throw new IllegalStateException("Canonical model prompt is missing", e);
    }
  }

  private final JsonMapper json;
  private final AudioNormalizer audio;
  private final Materials materials;
  private final URI base;
  private final BoundedHttp http = new BoundedHttp();

  public InferenceClient(
      JsonMapper json,
      AudioNormalizer audio,
      Materials materials,
      @Value("${api.inference-url:http://inference:8080}") String url) {
    this.json = json;
    this.audio = audio;
    this.materials = materials;
    this.base = URI.create(url);
  }

  private Map<String, Object> text(String value) {
    return Map.of("type", "text", "text", value);
  }

  private Duration remaining(long deadline) {
    long n = deadline - System.nanoTime();
    if (n <= 0) throw new ApiException(503, "MODEL_TIMEOUT", "Inference deadline exceeded.");
    return Duration.ofNanos(n);
  }

  private Object media(UUID run, Contracts.MediaAsset asset, long deadline) {
    byte[] bytes = materials.asset(run, asset.id()).bytes();
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

  private static Map<String, Object> object(Map<String, Object> properties, List<String> required) {
    return Map.of(
        "type",
        "object",
        "properties",
        properties,
        "required",
        required,
        "additionalProperties",
        false);
  }

  private static Map<String, Object> string() {
    return Map.of("type", "string");
  }

  private static Map<String, Object> array(Object items) {
    return Map.of("type", "array", "items", items);
  }

  private <T> T ask(
      String purpose, List<Object> content, Object schema, Class<T> type, long deadline) {
    var body =
        Map.of(
            "model",
            "Qwen2.5-Omni-7B",
            "messages",
            List.of(
                Map.of("role", "system", "content", SYSTEM + "\n" + purpose),
                Map.of("role", "user", "content", content)),
            "temperature",
            0,
            "stream",
            false,
            "cache_prompt",
            false,
            "max_tokens",
            2048,
            "response_format",
            Map.of(
                "type",
                "json_schema",
                "json_schema",
                Map.of("name", "YangResponse", "strict", true, "schema", schema)));
    var response =
        http.send(
            HttpRequest.newBuilder(base.resolve("/v1/chat/completions"))
                .timeout(remaining(deadline))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(body)))
                .build(),
            128 * 1024,
            remaining(deadline));
    if (response.statusCode() == 413 || response.statusCode() == 400)
      throw new ApiException(
          422,
          "MODEL_CONTEXT_UNSUPPORTED",
          "The complete selected material does not fit or is unsupported by the model.");
    if (response.statusCode() / 100 != 2)
      throw new ApiException(503, "MODEL_UNAVAILABLE", "Local model is unavailable.");
    try {
      var choice = json.readTree(response.body()).path("choices").get(0);
      if (choice == null || !choice.path("finish_reason").asString().equals("stop"))
        throw new IllegalArgumentException();
      String value = choice.path("message").path("content").asString();
      return json.readValue(value, type);
    } catch (Exception e) {
      throw new ApiException(
          502, "INVALID_MODEL_RESPONSE", "Model did not return a complete structured response.");
    }
  }

  public InstructionCompiler.Interpretation interpret(
      UUID run, Contracts.InstructionBlock source, String associatedContext, Duration timeout) {
    long deadline = System.nanoTime() + timeout.toNanos();
    var content = new ArrayList<Object>();
    content.add(text("ASSOCIATED ORIGINAL CONTEXT:\n" + associatedContext));
    content.add(
        text(
            "SOURCE_ID="
                + source.id()
                + "\n"
                + ("text".equals(source.type())
                    ? source.text()
                    : Objects.toString(source.caption(), "Instruction example"))));
    if (source.asset() != null) content.add(media(run, source.asset(), deadline));
    return ask(
        "Interpret EVERY rule, exception and example in this one source section. Keep their"
            + " meaning, ordered dependencies and conditions in rules. complete=false if ambiguous"
            + " or unreadable. contentOnlySpeech=true ONLY if the section positively establishes"
            + " that all audio evaluation is about linguistic content and never"
            + " voice/similarity/prosody/quality; otherwise false.",
        content,
        object(
            Map.of(
                "sourceId",
                Map.of("const", source.id()),
                "rules",
                string(),
                "complete",
                Map.of("type", "boolean"),
                "contentOnlySpeech",
                Map.of("type", "boolean")),
            List.of("sourceId", "rules", "complete", "contentOnlySpeech")),
        InstructionCompiler.Interpretation.class,
        deadline);
  }

  public record SourceSelection(List<String> sourceIds) {}

  public SourceSelection sources(
      Contracts.TaskPart part,
      List<Contracts.TaskField> fields,
      InstructionCompiler.Compiled instruction,
      Duration timeout) {
    var content =
        List.<Object>of(
            text(
                "RULES INDEX="
                    + json.writeValueAsString(
                        instruction.sections().stream()
                            .map(s -> Map.of("id", s.id(), "rules", s.rules()))
                            .toList())),
            text("PART=" + part.text() + "\nFIELDS=" + json.writeValueAsString(fields)));
    var schema =
        object(
            Map.of(
                "sourceIds",
                array(
                    Map.of(
                        "type",
                        "string",
                        "enum",
                        instruction.sections().stream()
                            .map(InstructionCompiler.Section::id)
                            .toList()))),
            List.of("sourceIds"));
    var result =
        ask(
            "Select all original instruction sections and examples needed to answer these fields,"
                + " including general rules and exceptions. Do not omit any relevant source.",
            content,
            schema,
            SourceSelection.class,
            System.nanoTime() + timeout.toNanos());
    if (result == null
        || result.sourceIds() == null
        || result.sourceIds().isEmpty()
        || new HashSet<>(result.sourceIds()).size() != result.sourceIds().size()
        || !instruction.sections().stream()
            .map(InstructionCompiler.Section::id)
            .toList()
            .containsAll(result.sourceIds()))
      throw new ApiException(
          422,
          "INSTRUCTION_INCOMPLETE",
          "Required original instruction sections were not selected.");
    return result;
  }

  public Contracts.AnswerSet answer(
      UUID run,
      Contracts.TaskPart part,
      List<Contracts.TaskField> fields,
      InstructionCompiler.Compiled instruction,
      List<String> sources,
      Duration timeout) {
    long deadline = System.nanoTime() + timeout.toNanos();
    var content = new ArrayList<Object>();
    var assets = new LinkedHashMap<String, Contracts.MediaAsset>();
    for (var section : instruction.sections())
      if (sources.contains(section.id()) && section.source().asset() != null)
        SnapshotValidation.add(assets, section.source().asset());
    for (var asset : part.media()) SnapshotValidation.add(assets, asset);
    checkBatch(assets.values());
    var emitted = new HashSet<String>();
    content.add(
        text(
            "ALL COMPILED RULES="
                + json.writeValueAsString(
                    instruction.sections().stream()
                        .map(s -> Map.of("id", s.id(), "rules", s.rules()))
                        .toList())));
    for (var section : instruction.sections())
      if (sources.contains(section.id())) {
        var source = section.source();
        content.add(
            text(
                "ORIGINAL SOURCE "
                    + source.id()
                    + "\n"
                    + Objects.toString(source.text(), Objects.toString(source.caption(), ""))));
        if (source.asset() != null) {
          content.add(text("SOURCE MEDIA " + source.asset().id()));
          if (emitted.add(source.asset().id())) content.add(media(run, source.asset(), deadline));
        }
      }
    content.add(text("CURRENT PART " + part.id() + "\n" + part.title() + "\n" + part.text()));
    for (var asset : part.media()) {
      content.add(text("TASK MEDIA " + asset.id()));
      if (emitted.add(asset.id())) content.add(media(run, asset, deadline));
    }
    content.add(
        text(
            "EXISTING VALUES (preserve earlier stages): "
                + json.writeValueAsString(
                    part.fields().stream()
                        .filter(f -> !SnapshotValidation.empty(f.value()))
                        .toList())));
    content.add(text("ANSWER EXACTLY THESE FIELDS: " + json.writeValueAsString(fields)));
    var alternatives =
        fields.stream()
            .map(
                field ->
                    object(
                        Map.of(
                            "partId",
                            Map.of("const", part.id()),
                            "fieldId",
                            Map.of("const", field.id()),
                            "value",
                            answerValueSchema(field)),
                        List.of("partId", "fieldId", "value")))
            .toList();
    var schema =
        Map.of(
            "anyOf",
            List.of(
                object(
                    Map.of(
                        "decision",
                        Map.of("const", "ANSWER"),
                        "answers",
                        Map.of(
                            "type",
                            "array",
                            "items",
                            Map.of("anyOf", alternatives),
                            "minItems",
                            fields.size(),
                            "maxItems",
                            fields.size()),
                        "reason",
                        Map.of("type", List.of("string", "null"), "maxLength", 1000)),
                    List.of("decision", "answers", "reason")),
                object(
                    Map.of(
                        "decision",
                        Map.of("const", "ABSTAIN"),
                        "answers",
                        Map.of("type", "array", "items", Map.of("type", "object"), "maxItems", 0),
                        "reason",
                        Map.of("type", "string", "minLength", 1, "maxLength", 1000)),
                    List.of("decision", "answers", "reason"))));
    return ask(
        "Answer only the requested next-stage fields according to all compiled rules and original"
            + " selected sources. Include every requested field exactly once; never change earlier"
            + " stages. Copy partId and fieldId exactly. SINGLE_CHOICE value is one option ID as a"
            + " JSON string; MULTI_CHOICE value is an array of distinct option IDs. Use option IDs,"
            + " never labels, displayed ratings or numeric positions. NUMBER value is a JSON"
            + " number; TEXT value is a JSON string within maxLength. Respect every numeric bound."
            + " If any material or instruction is unclear, return ABSTAIN with an empty answers"
            + " array and explain why.",
        content,
        schema,
        Contracts.AnswerSet.class,
        deadline);
  }

  private static Map<String, Object> answerValueSchema(Contracts.TaskField field) {
    var schema = new LinkedHashMap<String, Object>();
    switch (field.kind()) {
      case "SINGLE_CHOICE" -> {
        schema.put("type", "string");
        schema.put("enum", field.options().stream().map(Contracts.Option::id).toList());
      }
      case "MULTI_CHOICE" -> {
        schema.put("type", "array");
        schema.put(
            "items",
            Map.of(
                "type",
                "string",
                "enum",
                field.options().stream().map(Contracts.Option::id).toList()));
        schema.put("uniqueItems", true);
        schema.put("minItems", field.required() ? 1 : 0);
        schema.put("maxItems", field.options().size());
      }
      case "NUMBER" -> {
        schema.put("type", "number");
        if (field.min() != null) schema.put("minimum", field.min());
        if (field.max() != null) schema.put("maximum", field.max());
      }
      case "TEXT" -> {
        schema.put("type", "string");
        if (field.required()) schema.put("minLength", 1);
        if (field.maxLength() != null) schema.put("maxLength", field.maxLength());
      }
      default -> throw ApiException.invalid();
    }
    return schema;
  }

  public Contracts.Mapping map(Contracts.TaskSet task, Duration timeout) {
    var group =
        object(
            Map.of(
                "partId",
                string(),
                "fieldId",
                string(),
                "label",
                string(),
                "kind",
                Map.of("enum", List.of("SINGLE_CHOICE", "MULTI_CHOICE")),
                "controlIds",
                array(string())),
            List.of("partId", "fieldId", "label", "kind", "controlIds"));
    var schema =
        object(
            Map.of(
                "suiteId",
                Map.of("const", task.suiteId()),
                "snapshotHash",
                Map.of("const", task.snapshotHash()),
                "groups",
                array(group)),
            List.of("suiteId", "snapshotHash", "groups"));
    var result =
        ask(
            "Group every observed unmapped control into one unambiguous question. Use each control"
                + " exactly once and only provided IDs. Do not combine controls from different"
                + " parts. Generate a distinct fieldId. No selectors or actions.",
            List.of(
                text(
                    json.writeValueAsString(
                        Map.of(
                            "parts",
                            task.parts().stream()
                                .map(
                                    p ->
                                        Map.of(
                                            "id",
                                            p.id(),
                                            "text",
                                            p.text(),
                                            "unmappedControls",
                                            p.unmappedControls(),
                                            "existingFields",
                                            p.fields()))
                                .toList())))),
            schema,
            Contracts.Mapping.class,
            System.nanoTime() + timeout.toNanos());
    SnapshotValidation.mapping(task, result);
    return result;
  }

  static void checkBatch(Collection<Contracts.MediaAsset> assets) {
    if (assets.stream().mapToLong(Contracts.MediaAsset::byteLength).sum() > Materials.REQUEST_LIMIT
        || assets.stream()
                .filter(a -> a.kind().equals("audio"))
                .mapToLong(a -> a.durationMs())
                .sum()
            > 120000)
      throw new ApiException(
          422,
          "MODEL_MATERIAL_LIMIT",
          "The complete selected media exceeds one inference request limit.");
  }
}
