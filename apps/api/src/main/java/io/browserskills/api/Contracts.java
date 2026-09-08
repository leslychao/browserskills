package io.browserskills.api;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public final class Contracts {
  private Contracts() {}

  public record LoginRequest(String login, String password) {}

  public record UserView(UUID id, String login) {}

  public record Quota(int limit, int used, int remaining, Instant resetsAt) {}

  public record Me(UUID id, String login, Quota quota) {}

  public record Option(String id, String label) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record MediaAsset(
      String id, String kind, String mimeType, long byteLength, String sha256, Long durationMs) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record InstructionBlock(String type, String text, MediaAsset asset, String caption) {}

  public record InstructionBundle(String sourceKey, String hash, List<InstructionBlock> blocks) {}

  public record TaskSnapshot(
      String projectId,
      String taskId,
      String question,
      InstructionBundle instruction,
      MediaAsset image,
      MediaAsset audio,
      List<Option> options,
      String snapshotHash,
      Instant expiresAt,
      String adapterVersion) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record Decision(String decision, String optionId) {}

  public record ReviewTask(
      String projectId,
      String taskId,
      String question,
      InstructionBundle instruction,
      MediaAsset image,
      MediaAsset audio,
      List<Option> options,
      String snapshotHash,
      Instant expiresAt,
      String adapterVersion,
      Decision proposal,
      ApiError aiError,
      String confirmationNonce) {
    public static ReviewTask of(TaskSnapshot s, Decision p, ApiError e, String nonce) {
      return new ReviewTask(
          s.projectId(),
          s.taskId(),
          s.question(),
          s.instruction(),
          s.image(),
          s.audio(),
          s.options(),
          s.snapshotHash(),
          s.expiresAt(),
          s.adapterVersion(),
          p,
          e,
          nonce);
    }
  }

  public record RunItemResult(
      String taskId, int ordinal, String status, String optionId, String code, Instant createdAt) {}

  public record RunSummary(
      UUID id,
      String status,
      int maxTasks,
      int processed,
      Instant createdAt,
      Instant updatedAt,
      ApiError error) {}

  public record RunView(
      UUID id,
      String status,
      int maxTasks,
      int processed,
      Instant createdAt,
      Instant updatedAt,
      ApiError error,
      ReviewTask current,
      List<RunItemResult> results) {}

  public record BrowserStatus(
      String workerId, String generation, String mode, String url, String runId) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record WorkerCommand(
      UUID id, String type, String generation, String runId, SubmitPayload payload) {}

  public record SubmitPayload(
      String taskId, String snapshotHash, String instructionHash, String optionId) {}

  public record SubmitResult(String outcome, String nextTaskId, String code) {}

  public record StartRun(UUID requestId, int maxTasks) {}

  public record Confirm(
      UUID requestId,
      String taskId,
      String snapshotHash,
      String instructionHash,
      String optionId,
      String confirmationNonce) {}

  public record ApiError(String code, String message) {}
}
