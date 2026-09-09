package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class QualityGatesTest {
  @TempDir Path temp;

  @Test
  void missingEvidenceNeverAuthorizesAnAutomaticAnswer() {
    var gates = new QualityGates(Json.mapper(), "", "a".repeat(64));
    assertFalse(gates.allowed("TEXT"));
    assertThrows(ApiException.class, () -> gates.require(Set.of("TEXT")));
  }

  @Test
  void evidenceRequiresWholeSetsMatchingModelAndNinetyPercent() throws Exception {
    Path file = temp.resolve("evidence.json");
    Files.writeString(
        file,
        Json.mapper()
            .writeValueAsString(
                Map.of(
                    "modelSha256",
                    "a".repeat(64),
                    "categories",
                    List.of(
                        evidence("TEXT", 25, 23, true), evidence("IMAGE", 25, 22, true),
                        evidence("SPEECH", 24, 24, true),
                            evidence("SOUND_PROSODY", 25, 25, false)))));
    var gates = new QualityGates(Json.mapper(), file.toString(), "a".repeat(64));
    assertTrue(gates.allowed("TEXT"));
    assertFalse(gates.allowed("IMAGE"));
    assertFalse(gates.allowed("SPEECH"));
    assertFalse(gates.allowed("SOUND_PROSODY"));
    assertFalse(new QualityGates(Json.mapper(), file.toString(), "b".repeat(64)).allowed("TEXT"));
  }

  private Map<String, Object> evidence(String category, int total, int correct, boolean whole) {
    return Map.of(
        "category",
        category,
        "total",
        total,
        "correct",
        correct,
        "wholeSets",
        whole,
        "corpusSha256",
        "c".repeat(64),
        "evaluatedAt",
        Instant.now().toString());
  }
}
