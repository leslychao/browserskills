package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import java.util.*;
import org.junit.jupiter.api.Test;

class SnapshotValidationTest {
  static Contracts.TaskSet snapshot(String suite) {
    return new Contracts.TaskSet(
        "pool",
        suite,
        List.of(
            new Contracts.TaskPart(
                "part",
                "Example",
                "Choose A",
                List.of(),
                List.of(
                    new Contracts.TaskField(
                        "field",
                        "Answer",
                        "SINGLE_CHOICE",
                        true,
                        List.of(new Contracts.Option("a", "A"), new Contracts.Option("b", "B")),
                        null,
                        0,
                        null,
                        null,
                        null)),
                List.of())),
        new Contracts.InstructionBundle(
            "rules",
            "a".repeat(64),
            List.of(
                new Contracts.InstructionBlock(
                    "rule", "text", "Choose the correct letter", null, null))),
        "b".repeat(64),
        null,
        "yang-v2");
  }

  static Contracts.AnswerSet answer() {
    return new Contracts.AnswerSet(
        "ANSWER", List.of(new Contracts.FieldAnswer("part", "field", "a")), null);
  }

  static Contracts.StartRun start(int limit) {
    return new Contracts.StartRun(UUID.randomUUID(), limit, Contracts.SelectionSettings.defaults());
  }

  @Test
  void entireSetMustHaveUniqueFieldsAndWellFormedInstructions() {
    var s = snapshot("suite");
    SnapshotValidation.validate(s);
    var duplicated =
        new Contracts.TaskSet(
            s.poolId(),
            s.suiteId(),
            List.of(s.parts().getFirst(), s.parts().getFirst()),
            s.instruction(),
            s.snapshotHash(),
            null,
            s.adapterVersion());
    assertThrows(ApiException.class, () -> SnapshotValidation.validate(duplicated));
  }

  @Test
  void modelCannotInventReferencesOrIncompleteFinalAnswers() {
    var s = snapshot("suite");
    SnapshotValidation.answers(s, answer(), true);
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.answers(
                s, new Contracts.AnswerSet("ANSWER", List.of(), null), true));
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.answers(
                s,
                new Contracts.AnswerSet(
                    "ANSWER", List.of(new Contracts.FieldAnswer("part", "field", "evil")), null),
                true));
  }

  @Test
  void mediaMetadataAndHashAreBounded() {
    assertEquals(64, SnapshotValidation.sha256(new byte[] {1}).length());
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.validateAsset(
                new Contracts.MediaAsset("x", "audio", "audio/wav", 1, "a".repeat(64), 120001L),
                "audio"));
  }
}
