package io.browserskills.api;

import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Component;

@Component
@org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
public class InstructionCompiler {
  public record Section(
      String id, Contracts.InstructionBlock source, String rules, boolean contentOnlySpeech) {}

  public record Compiled(String hash, List<Section> sections, boolean contentOnlySpeech) {}

  public record Interpretation(
      String sourceId, String rules, boolean complete, boolean contentOnlySpeech) {}

  private final InferenceClient model;
  private final AnalysisQueue queue;
  private final Store store;

  public InstructionCompiler(InferenceClient model, AnalysisQueue queue, Store store) {
    this.model = model;
    this.queue = queue;
    this.store = store;
  }

  static List<Contracts.InstructionBlock> chunks(Contracts.InstructionBundle bundle) {
    SnapshotValidation.instruction(bundle);
    var result = new ArrayList<Contracts.InstructionBlock>();
    for (var b : bundle.blocks()) {
      if (!b.type().equals("text") || b.text().length() <= 6000) {
        result.add(b);
        continue;
      }
      int ordinal = 0;
      for (int start = 0; start < b.text().length(); ) {
        int end = Math.min(start + 6000, b.text().length());
        if (end < b.text().length()) {
          int boundary = b.text().lastIndexOf("\n\n", end);
          if (boundary > start + 3000) end = boundary + 2;
          else {
            boundary = b.text().lastIndexOf(". ", end);
            if (boundary > start + 3000) end = boundary + 2;
            else {
              boundary = b.text().lastIndexOf(' ', end);
              if (boundary > start + 3000) end = boundary + 1;
            }
          }
          end = Math.min(end, start + 6000);
        }
        if (end < b.text().length() && Character.isHighSurrogate(b.text().charAt(end - 1))) end--;
        result.add(
            new Contracts.InstructionBlock(
                b.id() + "#" + ordinal++, "text", b.text().substring(start, end), null, null));
        start = end;
      }
    }
    return List.copyOf(result);
  }

  /**
   * Neighbour fragments are additional context; every original character has its own source chunk.
   */
  static String context(List<Contracts.InstructionBlock> chunks, int index) {
    var context = new StringBuilder();
    for (int i = index - 1; i >= 0; i--)
      if (chunks.get(i).type().equals("text")) {
        var b = chunks.get(i);
        context
            .append("PRECEDING SOURCE ")
            .append(b.id())
            .append(" (overlap tail; full source is processed separately):\n")
            .append(b.text().substring(Math.max(0, b.text().length() - 2000)))
            .append('\n');
        break;
      }
    var current = chunks.get(index);
    if (current.caption() != null)
      context.append("THIS EXAMPLE CAPTION:\n").append(current.caption()).append('\n');
    for (int i = index + 1; i < chunks.size(); i++)
      if (chunks.get(i).type().equals("text")) {
        var b = chunks.get(i);
        context
            .append("FOLLOWING SOURCE ")
            .append(b.id())
            .append(" (overlap beginning; full source is processed separately):\n")
            .append(b.text(), 0, Math.min(2000, b.text().length()))
            .append('\n');
        break;
      }
    if (context.length() > 12000)
      throw new ApiException(
          422,
          "INSTRUCTION_CONTEXT_UNSUPPORTED",
          "Associated example context exceeds the bounded request.");
    return context.toString();
  }

  public Compiled compile(
      UUID user, UUID run, Contracts.InstructionBundle bundle, Instant expires) {
    var chunks = chunks(bundle);
    var sections = new ArrayList<Section>();
    store.progress(user, run, new Contracts.InstructionProgress(0, chunks.size(), 0));
    boolean contentOnly = true;
    int count = 0;
    for (var source : chunks) {
      String associatedContext = context(chunks, count);
      var result =
          queue.call(
              user,
              run,
              bundle.hash(),
              bundle.hash(),
              expires,
              t -> model.interpret(run, source, associatedContext, t));
      if (result == null
          || !source.id().equals(result.sourceId())
          || !result.complete()
          || result.rules() == null
          || result.rules().isBlank()
          || result.rules().length() > 4000)
        throw new ApiException(
            422,
            "INSTRUCTION_INCOMPLETE",
            "An instruction section or example could not be interpreted completely.");
      sections.add(new Section(source.id(), source, result.rules(), result.contentOnlySpeech()));
      contentOnly &= result.contentOnlySpeech();
      count++;
      store.progress(user, run, new Contracts.InstructionProgress(count, chunks.size(), count));
    }
    // Never hide an omitted section behind a truncated summary.
    if (sections.stream().mapToInt(s -> s.rules().length() + s.id().length()).sum() > 18000)
      throw new ApiException(
          422,
          "INSTRUCTION_CONTEXT_UNSUPPORTED",
          "Compiled instruction rules exceed the bounded selection context.");
    return new Compiled(bundle.hash(), List.copyOf(sections), contentOnly);
  }
}
