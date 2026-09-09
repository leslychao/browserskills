package io.browserskills.api;

import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/** Operator supplied evaluation evidence, never a model confidence or a UI override. */
@Component
public class QualityGates {
  private final Set<String> admitted;

  public QualityGates(
      JsonMapper json,
      @Value("${API_QUALITY_EVIDENCE_PATH:}") String path,
      @Value("${API_MODEL_SHA256:unverified}") String modelHash) {
    admitted = load(json, path, modelHash);
  }

  private static Set<String> load(JsonMapper json, String path, String modelHash) {
    Set<String> passed = new HashSet<>();
    try {
      if (path.isBlank() || !SnapshotValidation.hash(modelHash)) {
        return Set.of();
      }
      Path source = Path.of(path);
      if (Files.size(source) > 1024 * 1024) {
        return Set.of();
      }
      var root = json.readTree(Files.readAllBytes(source));
      if (!modelHash.equals(root.path("modelSha256").asString())) {
        return Set.of();
      }
      Set<String> seen = new HashSet<>();
      for (var evidence : root.path("categories")) {
        String category = evidence.path("category").asString();
        int total = evidence.path("total").asInt(), correct = evidence.path("correct").asInt();
        if (!seen.add(category)) throw new IllegalArgumentException("Duplicate category");
        Instant.parse(evidence.path("evaluatedAt").asString());
        if (evidence.path("wholeSets").asBoolean()
            && SnapshotValidation.hash(evidence.path("corpusSha256").asString())
            && total >= 25
            && correct <= total
            && correct * 100L >= total * 90L) passed.add(category);
      }
    } catch (Exception ignored) {
      passed.clear();
    }
    return Set.copyOf(passed);
  }

  public boolean allowed(String category) {
    return admitted.contains(category);
  }

  public void require(Set<String> categories) {
    if (categories.isEmpty() || !admitted.containsAll(categories))
      throw new ApiException(
          409,
          "QUALITY_NOT_VERIFIED",
          "Automatic answers are not admitted for these capabilities.");
  }
}
