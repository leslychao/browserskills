package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import java.time.*;
import java.util.*;
import org.junit.jupiter.api.Test;

class ProjectSelectionTest {
  static Contracts.CatalogueItem item(String id, String price, String unit) {
    return new Contracts.CatalogueItem(
        id,
        id,
        price == null ? null : new Contracts.Reward(price, unit),
        "AVAILABLE",
        "WORK",
        List.of("text"),
        "UNPREPARED",
        null);
  }

  @Test
  void autoRanksWholeSuitePriceDeterministicallyAndNeverUnknownPrice() {
    var s =
        new Contracts.SelectionSettings(
            "AUTO", null, List.of(), List.of(), null, List.of("text"), false, false);
    var c =
        new Contracts.Catalogue(
            List.of(
                item("z", "15", "rub"),
                item("a", "15", "rub"),
                item("x", null, "rub"),
                item("b", "6", "rub")),
            Instant.now(),
            null,
            null);
    assertEquals("a", ProjectSelection.choose(c, s).poolId());
    assertThrows(
        ApiException.class,
        () ->
            ProjectSelection.choose(
                new Contracts.Catalogue(
                    List.of(item("a", "20", "usd"), item("b", "20", "rub")),
                    Instant.now(),
                    null,
                    null),
                s));
  }

  @Test
  void reservedSuiteWinsButCannotSilentlySwitchManualProject() {
    var s = Contracts.SelectionSettings.defaults();
    var c =
        new Contracts.Catalogue(
            List.of(item("a", "6", "rub"), item("b", "15", "rub")), Instant.now(), "a", "suite");
    assertEquals("a", ProjectSelection.choose(c, s).poolId());
    var afterLogin = new Contracts.Catalogue(c.items(), Instant.now(), "a", null);
    assertEquals("a", ProjectSelection.choose(afterLogin, s).poolId());
    assertEquals(
        "a",
        ProjectSelection.choose(
                afterLogin,
                new Contracts.SelectionSettings(
                    "AUTO", null, List.of(), List.of(), null, List.of("text"), false, false))
            .poolId());
    assertThrows(
        ApiException.class,
        () ->
            ProjectSelection.choose(
                c,
                new Contracts.SelectionSettings(
                    "MANUAL", "b", List.of(), List.of(), null, List.of("text"), false, false)));
  }

  @Test
  void filtersAndManualSelectionAreApplied() {
    var s =
        new Contracts.SelectionSettings(
            "MANUAL", "b", List.of("b"), List.of("a"), "10", List.of("text"), false, false);
    assertEquals(
        "b",
        ProjectSelection.choose(
                new Contracts.Catalogue(
                    List.of(item("a", "50", "rub"), item("b", "15", "rub")),
                    Instant.now(),
                    null,
                    null),
                s)
            .poolId());
    assertNull(
        ProjectSelection.choose(
            new Contracts.Catalogue(List.of(item("b", "5", "rub")), Instant.now(), null, null), s));
    assertThrows(
        ApiException.class,
        () ->
            SnapshotValidation.selection(
                new Contracts.SelectionSettings(
                    "AUTO",
                    null,
                    List.of("a"),
                    List.of("a"),
                    null,
                    List.of("text"),
                    false,
                    false)));
  }
}
