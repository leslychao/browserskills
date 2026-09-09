package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class MaterialsTest {
  @TempDir Path directory;

  @Test
  void originalsAreStoredOnDiskBoundToRunAndDeletedAtCompletion() throws Exception {
    var materials = new Materials(directory.toString());
    UUID user = UUID.randomUUID(), run = UUID.randomUUID();
    byte[] bytes = "original".getBytes();
    var asset =
        new Contracts.MediaAsset(
            "asset", "image", "image/png", bytes.length, SnapshotValidation.sha256(bytes), null);
    materials.putAsset(user, run, asset, bytes);
    assertTrue(materials.has(run, asset));
    assertArrayEquals(bytes, materials.asset(run, "asset").bytes());
    assertThrows(ApiException.class, () -> materials.asset(UUID.randomUUID(), "asset"));
    assertThrows(ApiException.class, () -> materials.begin(UUID.randomUUID(), run));
    materials.source(user, run, SnapshotValidationTest.snapshot("suite").instruction());
    materials.put(
        run,
        new Materials.Current(run, UUID.randomUUID(), SnapshotValidationTest.snapshot("suite")));
    assertNotNull(materials.get(run));
    materials.remove(run);
    assertNull(materials.get(run));
    try (var entries = Files.list(directory)) {
      assertEquals(0, entries.count());
    }
  }

  @Test
  void changedMetadataAndOnDiskTamperingAreRejected() throws Exception {
    var materials = new Materials(directory.toString());
    UUID user = UUID.randomUUID(), run = UUID.randomUUID();
    byte[] bytes = {1, 2};
    var asset =
        new Contracts.MediaAsset(
            "asset", "image", "image/png", 2, SnapshotValidation.sha256(bytes), null);
    materials.putAsset(user, run, asset, bytes);
    assertThrows(ApiException.class, () -> materials.putAsset(user, run, asset, new byte[] {3, 4}));
    try (var entries = Files.list(directory.resolve("run-" + run))) {
      Files.write(entries.findFirst().orElseThrow(), new byte[] {4, 5});
    }
    assertThrows(ApiException.class, () -> materials.asset(run, "asset"));
    materials.close();
  }

  @Test
  void cacheEvictsBeforeSixtyFourMiBAndReloadsValidatedOriginalFromWorker() throws Exception {
    var worker = mock(WorkerClient.class);
    var materials = new Materials(directory.toString(), worker);
    UUID user = UUID.randomUUID(), run = UUID.randomUUID();
    byte[] bytes = new byte[20 * 1024 * 1024];
    String hash = SnapshotValidation.sha256(bytes);
    var assets = new ArrayList<Contracts.MediaAsset>();
    for (int i = 0; i < 4; i++) {
      var asset =
          new Contracts.MediaAsset("image-" + i, "image", "image/png", bytes.length, hash, null);
      assets.add(asset);
      materials.register(user, run, 1, asset);
      when(worker.media(1, asset)).thenReturn(bytes);
      assertEquals(bytes.length, materials.asset(run, asset.id()).bytes().length);
    }
    try (var paths = Files.list(directory.resolve("run-" + run))) {
      assertEquals(3, paths.count());
    }
    assertEquals(bytes.length, materials.asset(run, assets.getFirst().id()).bytes().length);
    verify(worker, times(2)).media(1, assets.getFirst());
    materials.completeSuite(run, SnapshotValidationTest.snapshot("suite").instruction());
    assertThrows(ApiException.class, () -> materials.asset(run, assets.getFirst().id()));
    materials.close();
  }
}
