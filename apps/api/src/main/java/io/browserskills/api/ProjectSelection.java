package io.browserskills.api;

import java.math.BigDecimal;
import java.util.*;

public final class ProjectSelection {
  private ProjectSelection() {}

  static boolean eligible(Contracts.CatalogueItem item, Contracts.SelectionSettings s) {
    if (item.availability().equals("UNAVAILABLE") || item.preparation().equals("BLOCKED"))
      return false;
    if (!s.includePoolIds().isEmpty() && !s.includePoolIds().contains(item.poolId())
        || s.excludePoolIds().contains(item.poolId())) return false;
    if (item.kind().equals("TRAINING") && !s.includeTraining()
        || item.kind().equals("EXAM") && !s.includeExams()) return false;
    if (!s.modalities().containsAll(item.modalities())) return false;
    return s.minReward() == null
        || item.reward() != null
            && new BigDecimal(item.reward().amount()).compareTo(new BigDecimal(s.minReward())) >= 0;
  }

  public static Contracts.CatalogueItem choose(
      Contracts.Catalogue catalogue, Contracts.SelectionSettings settings) {
    var s = SnapshotValidation.selection(settings);
    if (catalogue.activePoolId() != null) {
      if (s.mode().equals("MANUAL")
          && s.poolId() != null
          && !s.poolId().equals(catalogue.activePoolId()))
        throw new ApiException(
            409,
            "ACTIVE_SUITE_CONFLICT",
            "Another reserved suite must be completed or closed in Yang first.");
      return catalogue.items().stream()
          .filter(i -> i.poolId().equals(catalogue.activePoolId()) && eligible(i, s))
          .findFirst()
          .orElseThrow(
              () ->
                  new ApiException(
                      409,
                      "ACTIVE_SUITE_UNSUPPORTED",
                      "The reserved suite does not satisfy this run's filters."));
    }
    var candidates = catalogue.items().stream().filter(i -> eligible(i, s)).toList();
    if (s.mode().equals("MANUAL")) {
      if (s.poolId() == null)
        throw new ApiException(
            409, "PROJECT_REQUIRED", "Choose a project or open its active suite.");
      return candidates.stream()
          .filter(i -> i.poolId().equals(s.poolId()))
          .findFirst()
          .orElse(null);
    }
    var priced = candidates.stream().filter(i -> i.reward() != null).toList();
    if (priced.stream().map(i -> i.reward().unit()).distinct().count() > 1)
      throw new ApiException(
          409,
          "REWARD_UNITS_DIFFER",
          "Available prices use incomparable units. Choose a project manually.");
    return priced.stream()
        .sorted(
            Comparator.<Contracts.CatalogueItem, BigDecimal>comparing(
                    i -> new BigDecimal(i.reward().amount()))
                .reversed()
                .thenComparing(Contracts.CatalogueItem::poolId))
        .findFirst()
        .orElse(null);
  }
}
