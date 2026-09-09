package io.browserskills.api;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

public final class SnapshotValidation {
  private SnapshotValidation() {}

  static void require(boolean condition) {
    if (!condition) throw ApiException.invalid();
  }

  static boolean id(String s) {
    return s != null && !s.isBlank() && s.length() <= 256;
  }

  static boolean hash(String s) {
    return s != null && s.matches("[a-f0-9]{64}");
  }

  public static void instruction(Contracts.InstructionBundle b) {
    require(
        b != null
            && id(b.sourceKey())
            && hash(b.hash())
            && b.blocks() != null
            && !b.blocks().isEmpty()
            && b.blocks().size() <= 2048);
    var ids = new HashSet<String>();
    long text = 0;
    for (var block : b.blocks()) {
      require(block != null && id(block.id()) && ids.add(block.id()));
      if ("text".equals(block.type())) {
        require(block.text() != null && !block.text().isBlank() && block.asset() == null);
        text += block.text().getBytes(StandardCharsets.UTF_8).length;
      } else {
        require(Set.of("audio", "image").contains(block.type()) && block.text() == null);
        validateAsset(block.asset(), block.type());
      }
    }
    require(text <= 512 * 1024);
  }

  public static void validate(Contracts.TaskSet s) {
    require(
        s != null
            && id(s.poolId())
            && id(s.suiteId())
            && id(s.adapterVersion())
            && hash(s.snapshotHash()));
    instruction(s.instruction());
    require(s.parts() != null && !s.parts().isEmpty() && s.parts().size() <= 50);
    Set<String> parts = new HashSet<>();
    int count = 0;
    for (var p : s.parts()) {
      require(
          p != null
              && id(p.id())
              && parts.add(p.id())
              && p.text() != null
              && p.text().length() <= 128 * 1024
              && p.fields() != null
              && p.media() != null
              && p.unmappedControls() != null);
      for (var asset : p.media()) {
        validateAsset(asset, asset.kind());
        require(!"audio".equals(asset.kind()) || asset.durationMs() <= 60000);
      }
      var fields = new HashSet<String>();
      for (var f : p.fields()) {
        require(
            f != null
                && id(f.id())
                && fields.add(f.id())
                && f.label() != null
                && f.label().length() <= 8192
                && Set.of("SINGLE_CHOICE", "MULTI_CHOICE", "TEXT", "NUMBER").contains(f.kind())
                && f.stage() >= 0
                && f.stage() <= 100
                && f.options() != null);
        var choices = new HashSet<String>();
        for (var o : f.options())
          require(
              o != null
                  && id(o.id())
                  && choices.add(o.id())
                  && o.label() != null
                  && o.label().length() <= 8192);
        if (f.kind().endsWith("CHOICE"))
          require(!f.options().isEmpty() && f.options().size() <= 100);
        require(f.maxLength() == null || f.maxLength() > 0 && f.maxLength() <= 100000);
        require(f.min() == null || Double.isFinite(f.min()));
        require(f.max() == null || Double.isFinite(f.max()));
        require(f.min() == null || f.max() == null || f.min() <= f.max());
        if (f.value() != null && !empty(f.value())) value(f, f.value());
        count++;
      }
      var controls = new HashSet<String>();
      for (var c : p.unmappedControls())
        require(
            c != null
                && id(c.id())
                && controls.add(c.id())
                && c.label() != null
                && c.context() != null);
    }
    require(
        count <= 500
            && assets(s).stream().mapToLong(Contracts.MediaAsset::byteLength).sum()
                <= 1024L * 1024 * 1024);
  }

  static void validateAsset(Contracts.MediaAsset a, String kind) {
    require(
        a != null
            && id(a.id())
            && Set.of("image", "audio").contains(kind)
            && kind.equals(a.kind())
            && hash(a.sha256())
            && a.byteLength() > 0
            && a.byteLength() <= 20 * 1024 * 1024
            && a.mimeType() != null
            && a.mimeType().startsWith(kind + "/")
            && a.mimeType().matches("[a-z0-9.+-]+/[a-z0-9.+-]+"));
    require(
        !kind.equals("audio")
            || a.durationMs() != null && a.durationMs() > 0 && a.durationMs() <= 120000);
  }

  public static List<Contracts.MediaAsset> assets(Contracts.TaskSet s) {
    var result = new LinkedHashMap<String, Contracts.MediaAsset>();
    for (var b : s.instruction().blocks()) if (b.asset() != null) add(result, b.asset());
    for (var p : s.parts()) for (var a : p.media()) add(result, a);
    return List.copyOf(result.values());
  }

  static void add(Map<String, Contracts.MediaAsset> assets, Contracts.MediaAsset a) {
    var old = assets.putIfAbsent(a.id(), a);
    require(old == null || old.equals(a));
  }

  public static boolean empty(Object value) {
    return value == null
        || value instanceof String s && s.isBlank()
        || value instanceof List<?> l && l.isEmpty();
  }

  public static void value(Contracts.TaskField f, Object value) {
    switch (f.kind()) {
      case "SINGLE_CHOICE" ->
          require(
              value instanceof String s && f.options().stream().anyMatch(o -> o.id().equals(s)));
      case "MULTI_CHOICE" -> {
        require(value instanceof List<?>);
        var l = (List<?>) value;
        require(
            l.size() == new HashSet<>(l).size()
                && l.stream()
                    .allMatch(
                        v ->
                            v instanceof String
                                && f.options().stream().anyMatch(o -> o.id().equals(v))));
      }
      case "TEXT" ->
          require(
              value instanceof String s
                  && s.length() <= (f.maxLength() == null ? 10000 : f.maxLength()));
      case "NUMBER" -> {
        require(value instanceof Number);
        double n = ((Number) value).doubleValue();
        require(
            Double.isFinite(n)
                && (f.min() == null || n >= f.min())
                && (f.max() == null || n <= f.max()));
      }
      default -> throw ApiException.invalid();
    }
  }

  public static void answers(Contracts.TaskSet s, Contracts.AnswerSet a, boolean complete) {
    require(a != null && Set.of("ANSWER", "ABSTAIN").contains(a.decision()) && a.answers() != null);
    if (a.decision().equals("ABSTAIN")) {
      require(a.answers().isEmpty());
      return;
    }
    require(!a.answers().isEmpty());
    var seen = new HashSet<String>();
    for (var answer : a.answers()) {
      require(
          answer != null
              && id(answer.partId())
              && id(answer.fieldId())
              && seen.add(answer.partId() + "/" + answer.fieldId()));
      var p =
          s.parts().stream()
              .filter(x -> x.id().equals(answer.partId()))
              .findFirst()
              .orElseThrow(ApiException::invalid);
      var f =
          p.fields().stream()
              .filter(x -> x.id().equals(answer.fieldId()))
              .findFirst()
              .orElseThrow(ApiException::invalid);
      value(f, answer.value());
      require(!f.required() || !empty(answer.value()));
    }
    if (complete)
      for (var p : s.parts()) {
        require(p.unmappedControls().isEmpty());
        for (var f : p.fields()) if (f.required()) require(seen.contains(p.id() + "/" + f.id()));
      }
  }

  public static void mapping(Contracts.TaskSet s, Contracts.Mapping mapping) {
    require(
        mapping != null
            && s.suiteId().equals(mapping.suiteId())
            && s.snapshotHash().equals(mapping.snapshotHash())
            && mapping.groups() != null
            && !mapping.groups().isEmpty());
    Set<String> controls = new HashSet<>(), fields = new HashSet<>();
    for (var g : mapping.groups()) {
      var p =
          s.parts().stream()
              .filter(x -> x.id().equals(g.partId()))
              .findFirst()
              .orElseThrow(ApiException::invalid);
      require(
          id(g.fieldId())
              && g.label() != null
              && !g.label().isBlank()
              && Set.of("SINGLE_CHOICE", "MULTI_CHOICE").contains(g.kind())
              && fields.add(g.partId() + "/" + g.fieldId())
              && p.fields().stream().noneMatch(f -> f.id().equals(g.fieldId()))
              && g.controlIds() != null
              && g.controlIds().size() >= 2);
      for (String c : g.controlIds())
        require(
            controls.add(g.partId() + "/" + c)
                && p.unmappedControls().stream()
                    .anyMatch(x -> x.id().equals(c) && x.selected() != null));
    }
    for (var p : s.parts())
      for (var c : p.unmappedControls()) require(controls.contains(p.id() + "/" + c.id()));
  }

  public static Contracts.SelectionSettings selection(Contracts.SelectionSettings s) {
    require(s != null && s.mode() != null);
    require(
        Set.of("MANUAL", "AUTO").contains(s.mode())
            && (s.poolId() == null || id(s.poolId()))
            && s.includePoolIds() != null
            && s.excludePoolIds() != null
            && s.modalities() != null
            && !s.modalities().isEmpty()
            && s.includePoolIds().size() <= 500
            && s.excludePoolIds().size() <= 500
            && s.modalities().size() <= 3
            && new HashSet<>(s.modalities()).size() == s.modalities().size()
            && new HashSet<>(s.includePoolIds()).size() == s.includePoolIds().size()
            && new HashSet<>(s.excludePoolIds()).size() == s.excludePoolIds().size()
            && s.includePoolIds().stream().allMatch(SnapshotValidation::id)
            && s.excludePoolIds().stream().allMatch(SnapshotValidation::id)
            && s.modalities().stream().allMatch(Set.of("text", "image", "audio")::contains));
    require(Collections.disjoint(s.includePoolIds(), s.excludePoolIds()));
    if (s.minReward() != null) {
      try {
        require(s.minReward().matches("(0|[1-9]\\d{0,11})(\\.\\d{1,6})?"));
      } catch (NumberFormatException e) {
        throw ApiException.invalid();
      }
    }
    return s;
  }

  public static String sha256(byte[] b) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}
