package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import java.util.List;
import org.junit.jupiter.api.Test;

class SnapshotValidationTest {
  static Contracts.TaskSnapshot snapshot(String task) {
    return new Contracts.TaskSnapshot(
        "project",
        task,
        "Question",
        new Contracts.InstructionBundle(
            "rules",
            "a".repeat(64),
            List.of(new Contracts.InstructionBlock("text", "Read all instructions", null, null))),
        null,
        null,
        List.of(new Contracts.Option("a", "A"), new Contracts.Option("b", "B")),
        "b".repeat(64),
        null,
        "v1");
  }

  @Test
  void validatesCompleteInstructionsAndStrictModelOutput() {
    assertDoesNotThrow(() -> SnapshotValidation.validate(snapshot("1")));
    assertEquals(
        "a",
        SnapshotValidation.decision(
                "{\"decision\":\"ANSWER\",\"optionId\":\"a\"}", snapshot("1"), Json.mapper())
            .optionId());
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.decision(
                "{\"decision\":\"ANSWER\",\"optionId\":\"x\"}", snapshot("1"), Json.mapper()));
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.decision(
                "{\"decision\":\"ABSTAIN\",\"tool\":\"click\"}", snapshot("1"), Json.mapper()));
  }

  @Test
  void rejectsMissingInstructionsOversizedTextAudioAndDuplicateOptions() {
    var s = snapshot("t");
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.validate(
                new Contracts.TaskSnapshot(
                    s.projectId(),
                    s.taskId(),
                    s.question(),
                    null,
                    null,
                    null,
                    s.options(),
                    s.snapshotHash(),
                    null,
                    "v1")));
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.validate(
                new Contracts.TaskSnapshot(
                    s.projectId(),
                    s.taskId(),
                    "x".repeat(600000),
                    s.instruction(),
                    null,
                    null,
                    s.options(),
                    s.snapshotHash(),
                    null,
                    "v1")));
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.validate(
                new Contracts.TaskSnapshot(
                    s.projectId(),
                    s.taskId(),
                    s.question(),
                    s.instruction(),
                    null,
                    null,
                    List.of(new Contracts.Option("a", "A"), new Contracts.Option("a", "Again")),
                    s.snapshotHash(),
                    null,
                    "v1")));
    var a = new Contracts.MediaAsset("a", "audio", "audio/wav", 44, "c".repeat(64), 60001L);
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.validate(
                new Contracts.TaskSnapshot(
                    s.projectId(),
                    s.taskId(),
                    s.question(),
                    s.instruction(),
                    null,
                    a,
                    s.options(),
                    s.snapshotHash(),
                    null,
                    "v1")));
    var valid = new Contracts.MediaAsset("a", "audio", "audio/wav", 44, "c".repeat(64), 1000L);
    var image = new Contracts.MediaAsset("im", "image", "image/png", 8, "d".repeat(64), null);
    var instructions =
        new Contracts.InstructionBundle(
            "rules",
            "a".repeat(64),
            List.of(
                new Contracts.InstructionBlock("audio", null, valid, "Hear tone"),
                new Contracts.InstructionBlock("image", null, image, null)));
    var combined =
        new Contracts.TaskSnapshot(
            s.projectId(),
            s.taskId(),
            s.question(),
            instructions,
            image,
            valid,
            s.options(),
            s.snapshotHash(),
            null,
            "v1");
    assertDoesNotThrow(() -> SnapshotValidation.validate(combined));
    assertEquals(2, SnapshotValidation.assets(combined).size());
    assertNull(
        SnapshotValidation.decision("{\"decision\":\"ABSTAIN\"}", s, Json.mapper()).optionId());
    assertThrows(
        ApiException.class, () -> SnapshotValidation.decision("not-json", s, Json.mapper()));
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.decision(
                "{\"decision\":\"ANSWER\",\"decision\":\"ABSTAIN\"}", s, Json.mapper()));
  }
}
