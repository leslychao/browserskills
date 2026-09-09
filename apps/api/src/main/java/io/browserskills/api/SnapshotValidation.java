package io.browserskills.api;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import tools.jackson.databind.json.JsonMapper;

public final class SnapshotValidation {
  private SnapshotValidation() {}

  static void require(boolean condition) {
    if (!condition) throw ApiException.invalid();
  }

  static boolean id(String value) {
    return value != null && !value.isBlank() && value.length() <= 256;
  }

  static boolean hash(String value) {
    return value != null && value.matches("[a-f0-9]{64}");
  }

  public static void validate(Contracts.TaskSnapshot s) {
    require(
        s != null
            && id(s.projectId())
            && id(s.taskId())
            && id(s.adapterVersion())
            && hash(s.snapshotHash())
            && s.question() != null);
    var instructions = s.instruction();
    require(
        instructions != null
            && id(instructions.sourceKey())
            && hash(instructions.hash())
            && instructions.blocks() != null
            && !instructions.blocks().isEmpty()
            && instructions.blocks().size() <= 256);
    long audio = 0, bytes = s.question().getBytes(StandardCharsets.UTF_8).length;
    for (var b : instructions.blocks()) {
      require(b != null);
      if ("text".equals(b.type())) {
        require(b.text() != null && !b.text().isBlank() && b.asset() == null);
        bytes += b.text().getBytes(StandardCharsets.UTF_8).length;
      } else {
        require(Set.of("image", "audio").contains(b.type()) && b.text() == null);
        validateAsset(b.asset(), b.type());
        if (b.type().equals("audio")) audio += b.asset().durationMs();
      }
      if (b.caption() != null) bytes += b.caption().getBytes(StandardCharsets.UTF_8).length;
    }
    require(s.options() != null && s.options().size() >= 2 && s.options().size() <= 10);
    var ids = new HashSet<String>();
    for (var o : s.options()) {
      require(
          o != null
              && id(o.id())
              && ids.add(o.id())
              && o.label() != null
              && !o.label().isBlank()
              && o.label().length() <= 2048);
      bytes += o.label().getBytes(StandardCharsets.UTF_8).length;
    }
    if (s.image() != null) validateAsset(s.image(), "image");
    if (s.audio() != null) {
      validateAsset(s.audio(), "audio");
      require(s.audio().durationMs() <= 60_000);
      audio += s.audio().durationMs();
    }
    require(
        audio <= 120_000
            && bytes <= 512 * 1024
            && (!s.question().isBlank() || s.image() != null || s.audio() != null));
    long allBytes = assets(s).stream().mapToLong(Contracts.MediaAsset::byteLength).sum();
    require(allBytes <= 64 * 1024 * 1024);
  }

  static void validateAsset(Contracts.MediaAsset a, String kind) {
    require(
        a != null
            && id(a.id())
            && kind.equals(a.kind())
            && hash(a.sha256())
            && a.byteLength() > 0
            && a.byteLength() <= 20 * 1024 * 1024);
    require(
        a.mimeType() != null
            && a.mimeType().startsWith(kind + "/")
            && a.mimeType().matches("[a-z0-9.+-]+/[a-z0-9.+-]+"));
    require(
        !kind.equals("audio")
            || a.durationMs() != null && a.durationMs() > 0 && a.durationMs() <= 120_000);
  }

  public static List<Contracts.MediaAsset> assets(Contracts.TaskSnapshot s) {
    var result = new LinkedHashMap<String, Contracts.MediaAsset>();
    for (var b : s.instruction().blocks()) if (b.asset() != null) add(result, b.asset());
    if (s.image() != null) add(result, s.image());
    if (s.audio() != null) add(result, s.audio());
    return List.copyOf(result.values());
  }

  private static void add(Map<String, Contracts.MediaAsset> assets, Contracts.MediaAsset asset) {
    var previous = assets.putIfAbsent(asset.id(), asset);
    require(previous == null || previous.equals(asset));
  }

  public static String sha256(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  public static Contracts.Decision decision(
      String content, List<Contracts.Option> options, JsonMapper mapper) {
    try {
      var node = mapper.readTree(content);
      require(node.isObject() && node.path("decision").isString());
      for (String key : node.propertyNames()) require(Set.of("decision", "optionId").contains(key));
      String decision = node.path("decision").asString();
      if (decision.equals("ABSTAIN") && !node.has("optionId"))
        return new Contracts.Decision("ABSTAIN", null);
      require(decision.equals("ANSWER") && node.path("optionId").isString());
      String option = node.path("optionId").asString();
      require(options.stream().anyMatch(o -> o.id().equals(option)));
      return new Contracts.Decision("ANSWER", option);
    } catch (Exception e) {
      throw new ApiException(
          502,
          "INVALID_MODEL_RESPONSE",
          "Model did not produce a supported answer. Select manually.");
    }
  }
}
