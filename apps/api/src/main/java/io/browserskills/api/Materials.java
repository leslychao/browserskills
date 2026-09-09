package io.browserskills.api;

import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Original assets live in the worker; this bounded LRU cache is disposable. */
@Component
@org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
public class Materials {
  public static final long USER_LIMIT = 64L * 1024 * 1024;
  public static final long REQUEST_LIMIT = 64L * 1024 * 1024;

  public record Current(UUID runId, UUID itemId, Contracts.TaskSet snapshot) {}

  public record AssetBytes(Contracts.MediaAsset asset, byte[] bytes) {}

  private record FileAsset(Contracts.MediaAsset metadata, Path path, long accessed) {}

  private final Path root;
  private final WorkerClient worker;
  private final Map<UUID, UUID> owners = new ConcurrentHashMap<>();
  private final Map<UUID, Integer> workers = new ConcurrentHashMap<>();
  private final Map<UUID, Current> runs = new ConcurrentHashMap<>();
  private final Map<UUID, Map<String, FileAsset>> files = new ConcurrentHashMap<>();

  @Autowired
  public Materials(@Value("${API_MATERIALS_DIR:}") String directory, WorkerClient worker) {
    this.worker = worker;
    try {
      root =
          directory.isBlank()
              ? Files.createTempDirectory("browserskills-materials-")
              : Path.of(directory).toAbsolutePath().normalize();
      if (Files.isSymbolicLink(root)) throw new IOException("Symbolic material root");
      Files.createDirectories(root);
      try (var entries = Files.list(root)) {
        for (Path p : entries.toList())
          if (p.getFileName().toString().matches("run-[0-9a-f-]{36}")) delete(p);
      }
    } catch (IOException e) {
      throw new IllegalStateException("Cannot initialize material storage.", e);
    }
  }

  public Materials(String directory) {
    this(directory, null);
  }

  public Materials() {
    this("", null);
  }

  public synchronized void begin(UUID user, UUID run) {
    UUID old = owners.putIfAbsent(run, user);
    if (old != null && !old.equals(user))
      throw new ApiException(404, "NOT_FOUND", "Resource not found.");
    if (owners.size() > 5) {
      owners.remove(run);
      throw new ApiException(503, "MATERIAL_CAPACITY", "Active material capacity exhausted.");
    }
    files.computeIfAbsent(run, r -> new LinkedHashMap<>());
  }

  public synchronized void register(UUID user, UUID run, int workerId, Contracts.MediaAsset asset) {
    begin(user, run);
    SnapshotValidation.validateAsset(asset, asset.kind());
    if (workerId < 1 || workerId > 5) throw ApiException.invalid();
    workers.put(run, workerId);
    var entry = files.get(run).get(asset.id());
    if (entry != null && !entry.metadata().equals(asset))
      throw new ApiException(409, "MEDIA_CHANGED", "Media identifier was reused.");
    if (entry == null) files.get(run).put(asset.id(), new FileAsset(asset, null, 0));
  }

  public synchronized void putAsset(UUID user, UUID run, Contracts.MediaAsset asset, byte[] bytes) {
    begin(user, run);
    cache(user, run, asset, bytes);
  }

  private void cache(UUID user, UUID run, Contracts.MediaAsset asset, byte[] bytes) {
    SnapshotValidation.validateAsset(asset, asset.kind());
    if (bytes.length != asset.byteLength()
        || !SnapshotValidation.sha256(bytes).equals(asset.sha256()))
      throw new ApiException(502, "MEDIA_CHANGED", "Media changed.");
    var runFiles = files.get(run);
    var old = runFiles.get(asset.id());
    if (old != null && !old.metadata().equals(asset))
      throw new ApiException(409, "MEDIA_CHANGED", "Media identifier was reused.");
    if (old != null && old.path() != null) return;
    while (used(user) + bytes.length > USER_LIMIT) evict(user);
    try {
      Path directory = root.resolve("run-" + run);
      Files.createDirectories(directory);
      Path path =
          directory.resolve(
              asset.sha256()
                  + "-"
                  + SnapshotValidation.sha256(
                      asset.id().getBytes(java.nio.charset.StandardCharsets.UTF_8)));
      Files.write(path, bytes, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
      runFiles.put(asset.id(), new FileAsset(asset, path, System.nanoTime()));
    } catch (IOException e) {
      throw new ApiException(503, "MATERIAL_STORAGE", "Cannot write temporary material.");
    }
  }

  private long used(UUID user) {
    return owners.entrySet().stream()
        .filter(e -> e.getValue().equals(user))
        .mapToLong(
            e ->
                files.get(e.getKey()).values().stream()
                    .filter(f -> f.path() != null)
                    .mapToLong(f -> f.metadata().byteLength())
                    .sum())
        .sum();
  }

  private void evict(UUID user) {
    UUID oldestRun = null;
    String oldestId = null;
    FileAsset oldest = null;
    for (var r : owners.entrySet())
      if (r.getValue().equals(user))
        for (var f : files.get(r.getKey()).entrySet())
          if (f.getValue().path() != null
              && (oldest == null || f.getValue().accessed() < oldest.accessed())) {
            oldestRun = r.getKey();
            oldestId = f.getKey();
            oldest = f.getValue();
          }
    if (oldest == null)
      throw new ApiException(422, "MATERIAL_LIMIT", "The request cannot fit the material cache.");
    try {
      Files.deleteIfExists(oldest.path());
    } catch (IOException e) {
      throw new ApiException(503, "MATERIAL_STORAGE", "Cannot evict cached material.");
    }
    files.get(oldestRun).put(oldestId, new FileAsset(oldest.metadata(), null, 0));
  }

  public synchronized void source(UUID user, UUID run, Contracts.InstructionBundle instruction) {
    begin(user, run);
    SnapshotValidation.instruction(instruction);
    // Complete original text stays in the current compiled instruction; media remain worker-owned.
  }

  public Current get(UUID run) {
    return runs.get(run);
  }

  public void put(UUID run, Current current) {
    if (!owners.containsKey(run)) throw new IllegalStateException("Run material owner missing");
    runs.put(run, current);
  }

  private AssetBytes cached(UUID run, String id) {
    var entries = files.get(run);
    FileAsset entry = entries == null ? null : entries.get(id);
    if (entry == null) throw new ApiException(404, "NOT_FOUND", "Resource not found.");
    if (entry.path() == null) return null;
    try {
      if (Files.isSymbolicLink(entry.path())
          || Files.size(entry.path()) != entry.metadata().byteLength()) throw new IOException();
      byte[] bytes = Files.readAllBytes(entry.path());
      if (!SnapshotValidation.sha256(bytes).equals(entry.metadata().sha256()))
        throw new IOException();
      entries.put(id, new FileAsset(entry.metadata(), entry.path(), System.nanoTime()));
      return new AssetBytes(entry.metadata(), bytes);
    } catch (IOException e) {
      throw new ApiException(502, "MEDIA_CHANGED", "Temporary material changed.");
    }
  }

  public AssetBytes asset(UUID run, String id) {
    UUID user;
    int workerId;
    Contracts.MediaAsset metadata;
    synchronized (this) {
      var found = cached(run, id);
      if (found != null) return found;
      user = owners.get(run);
      workerId = workers.getOrDefault(run, 0);
      metadata = files.get(run).get(id).metadata();
    }
    if (worker == null || workerId == 0)
      throw new ApiException(502, "MEDIA_UNAVAILABLE", "Original media worker is unavailable.");
    byte[] bytes = worker.media(workerId, metadata);
    synchronized (this) {
      if (!Objects.equals(owners.get(run), user) || !has(run, metadata))
        throw new ApiException(404, "NOT_FOUND", "Run material has been released.");
      cache(user, run, metadata, bytes);
      return cached(run, id);
    }
  }

  public synchronized boolean has(UUID run, Contracts.MediaAsset asset) {
    var entry = files.getOrDefault(run, Map.of()).get(asset.id());
    return entry != null && entry.metadata().equals(asset);
  }

  public synchronized void completeSuite(UUID run, Contracts.InstructionBundle instruction) {
    runs.remove(run);
    var entries = files.get(run);
    if (entries == null) return;
    var keep = new HashSet<String>();
    for (var b : instruction.blocks()) if (b.asset() != null) keep.add(b.asset().id());
    for (String id : List.copyOf(entries.keySet()))
      if (!keep.contains(id)) {
        var entry = entries.remove(id);
        try {
          if (entry.path() != null) Files.deleteIfExists(entry.path());
        } catch (IOException e) {
          throw new ApiException(
              503, "MATERIAL_CLEANUP", "Cannot release completed suite material.");
        }
      }
  }

  public synchronized void remove(UUID run) {
    runs.remove(run);
    owners.remove(run);
    workers.remove(run);
    files.remove(run);
    try {
      delete(root.resolve("run-" + run));
    } catch (IOException e) {
      throw new ApiException(503, "MATERIAL_CLEANUP", "Temporary material cleanup failed.");
    }
  }

  private void delete(Path path) throws IOException {
    if (!path.toAbsolutePath().normalize().startsWith(root) || path.equals(root))
      throw new IOException("Invalid cleanup path");
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return;
    try (var tree = Files.walk(path)) {
      for (Path p : tree.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(p);
    }
  }

  @PreDestroy
  void close() {
    for (UUID run : List.copyOf(owners.keySet())) remove(run);
  }
}
