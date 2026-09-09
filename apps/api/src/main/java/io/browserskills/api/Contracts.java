package io.browserskills.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class Contracts {
  private Contracts() {}

  public record Quota(int limit, int used, int remaining, Instant resetsAt) {}

  public record Me(UUID id, String login, Quota quota) {}

  public record Option(String id, String label) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record MediaAsset(
      String id, String kind, String mimeType, long byteLength, String sha256, Long durationMs) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record InstructionBlock(
      String id, String type, String text, MediaAsset asset, String caption) {}

  public record InstructionBundle(String sourceKey, String hash, List<InstructionBlock> blocks) {}

  public record TaskField(
      String id,
      String label,
      String kind,
      boolean required,
      List<Option> options,
      Object value,
      int stage,
      Integer maxLength,
      Double min,
      Double max) {}

  public record UnmappedControl(String id, String label, String context, Boolean selected) {}

  public record TaskPart(
      String id,
      String title,
      String text,
      List<MediaAsset> media,
      List<TaskField> fields,
      List<UnmappedControl> unmappedControls) {}

  public record TaskSet(
      String poolId,
      String suiteId,
      List<TaskPart> parts,
      InstructionBundle instruction,
      String snapshotHash,
      Instant expiresAt,
      String adapterVersion) {}

  public record FieldAnswer(String partId, String fieldId, Object value) {}

  public record AnswerSet(String decision, List<FieldAnswer> answers, String reason) {}

  public record FieldGroup(
      String partId, String fieldId, String label, String kind, List<String> controlIds) {}

  public record Mapping(String suiteId, String snapshotHash, List<FieldGroup> groups) {}

  public record YangSession(
      String state, Instant checkedAt, String message, String poolId, String suiteId) {}

  public record BrowserStatus(
      String workerId,
      String generation,
      String mode,
      String url,
      String runId,
      YangSession yang) {}

  public record Reward(String amount, String unit) {}

  public record CatalogueItem(
      String poolId,
      String title,
      Reward reward,
      String availability,
      String kind,
      List<String> modalities,
      String preparation,
      ApiError reason) {}

  public record Catalogue(
      List<CatalogueItem> items, Instant refreshedAt, String activePoolId, String activeSuiteId) {}

  public record SelectionSettings(
      String mode,
      String poolId,
      List<String> includePoolIds,
      List<String> excludePoolIds,
      String minReward,
      List<String> modalities,
      boolean includeTraining,
      boolean includeExams) {
    public static SelectionSettings defaults() {
      return new SelectionSettings(
          "MANUAL",
          null,
          List.of(),
          List.of(),
          null,
          List.of("text", "image", "audio"),
          false,
          false);
    }
  }

  public record InstructionProgress(int processed, int total, int aiRequests) {}

  public record RunItemResult(
      String poolId,
      String suiteId,
      int ordinal,
      String status,
      List<FieldAnswer> answers,
      String code,
      Instant createdAt) {}

  public record RunSummary(
      UUID id,
      String status,
      int maxTasks,
      int processed,
      Instant createdAt,
      Instant updatedAt,
      ApiError error,
      SelectionSettings selection,
      CatalogueItem selectedProject,
      String selectionReason,
      InstructionProgress instructionProgress) {}

  public record RunView(
      UUID id,
      String status,
      int maxTasks,
      int processed,
      Instant createdAt,
      Instant updatedAt,
      ApiError error,
      SelectionSettings selection,
      CatalogueItem selectedProject,
      String selectionReason,
      InstructionProgress instructionProgress,
      TaskSet current,
      List<RunItemResult> results) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record WorkerCommand(
      UUID id, String type, String generation, String runId, Object payload) {}

  public record SubmitPayload(
      String poolId,
      String suiteId,
      String snapshotHash,
      String instructionHash,
      List<FieldAnswer> answers) {}

  public record SubmitResult(String outcome, String nextSuiteId, String code) {}

  public record StartRun(UUID requestId, int maxTasks, SelectionSettings selection) {}

  public record ApiError(String code, String message) {}
}
