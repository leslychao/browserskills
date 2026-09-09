package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.time.*;
import java.util.*;
import org.junit.jupiter.api.Test;

class InstructionCompilerTest {
  @Test
  void conditionAcrossChunkBoundaryAndExampleAssociationRemainVisible() {
    String condition =
        "Если оценки одинаковы, "
            + "переслушайте записи внимательно ".repeat(10)
            + "выберите лучшую.";
    String text = "x".repeat(5900) + " " + condition + " Продолжение. ".repeat(150);
    var audio = new Contracts.MediaAsset("sample", "audio", "audio/wav", 10, "a".repeat(64), 1000L);
    var bundle =
        new Contracts.InstructionBundle(
            "rules",
            "a".repeat(64),
            List.of(
                new Contracts.InstructionBlock("conditional", "text", text, null, null),
                new Contracts.InstructionBlock(
                    "example",
                    "audio",
                    null,
                    audio,
                    "Пример одинаковых оценок: сравнение обязательно."),
                new Contracts.InstructionBlock(
                    "explanation",
                    "text",
                    "В этом примере правильный дополнительный выбор — левый.",
                    null,
                    null)));
    var chunks = InstructionCompiler.chunks(bundle);
    assertTrue(chunks.getFirst().text().contains("Если оценки одинаковы"));
    assertFalse(chunks.getFirst().text().contains("выберите лучшую"));
    assertTrue(InstructionCompiler.context(chunks, 0).contains("выберите лучшую"));
    assertTrue(InstructionCompiler.context(chunks, 1).contains("Если оценки одинаковы"));
    int example =
        java.util.stream.IntStream.range(0, chunks.size())
            .filter(i -> chunks.get(i).id().equals("example"))
            .findFirst()
            .orElseThrow();
    String context = InstructionCompiler.context(chunks, example);
    assertTrue(context.contains("Пример одинаковых оценок"));
    assertTrue(context.contains("правильный дополнительный выбор — левый"));
    assertTrue(context.contains("PRECEDING SOURCE"));
    assertEquals(
        text,
        chunks.stream()
            .filter(b -> b.id().startsWith("conditional"))
            .map(Contracts.InstructionBlock::text)
            .collect(java.util.stream.Collectors.joining()));
  }

  @Test
  void longInstructionsAreCoveredWithoutDroppingHiddenSectionsOrExamples() {
    String text = "Instruction paragraph. ".repeat(1700);
    var audio =
        new Contracts.MediaAsset("example", "audio", "audio/wav", 10, "a".repeat(64), 1000L);
    var source =
        new Contracts.InstructionBundle(
            "rules",
            "a".repeat(64),
            List.of(
                new Contracts.InstructionBlock("long", "text", text, null, null),
                new Contracts.InstructionBlock(
                    "closed-example", "audio", null, audio, "Inside a closed details")));
    var chunks = InstructionCompiler.chunks(source);
    assertEquals(
        text,
        chunks.stream()
            .filter(x -> x.type().equals("text"))
            .map(Contracts.InstructionBlock::text)
            .collect(java.util.stream.Collectors.joining()));
    assertEquals(audio, chunks.getLast().asset());
    assertTrue(
        chunks.stream()
            .filter(x -> x.type().equals("text"))
            .allMatch(x -> x.text().length() <= 6000));
  }

  @Test
  void everySourceMustBeInterpretedAndEachInterpretationIsQuotaCounted() {
    var store = mock(Store.class);
    UUID user = UUID.randomUUID(), run = UUID.randomUUID();
    when(store.owned(user, run)).thenReturn(AnalysisQueueTest.run(user, run, "PREPARING"));
    when(store.reserveAi(any(), any(), any(), any())).thenReturn(true);
    var model = mock(InferenceClient.class);
    var queue = new AnalysisQueue(store, Json.mapper(), Clock.systemUTC(), "hash");
    var source = SnapshotValidationTest.snapshot("suite").instruction();
    when(model.interpret(any(), any(), any(), any()))
        .thenReturn(new InstructionCompiler.Interpretation("rule", "Preserved rule", true, false));
    var compiler = new InstructionCompiler(model, queue, store);
    try {
      assertEquals(1, compiler.compile(user, run, source, null).sections().size());
      verify(store).reserveAi(eq(user), any(), eq(source.hash()), eq(source.hash()));
      when(model.interpret(any(), any(), any(), any()))
          .thenReturn(
              new InstructionCompiler.Interpretation("wrong", "missing source", true, false));
      assertEquals(
          "INSTRUCTION_INCOMPLETE",
          assertThrows(ApiException.class, () -> compiler.compile(user, run, source, null)).code());
    } finally {
      queue.close();
    }
  }
}
