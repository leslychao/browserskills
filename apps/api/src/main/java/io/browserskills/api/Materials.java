package io.browserskills.api;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

@Component
public class Materials {
  public record Current(
      UUID itemId,
      Contracts.TaskSnapshot snapshot,
      String nonce,
      Map<String, byte[]> media,
      Contracts.Decision proposal,
      Contracts.ApiError aiError) {
    public Current {
      media = Map.copyOf(media);
    }

    public Contracts.ReviewTask view() {
      return Contracts.ReviewTask.of(snapshot, proposal, aiError, nonce);
    }
  }

  private final Map<UUID, Current> runs = new ConcurrentHashMap<>();

  public Current get(UUID run) {
    return runs.get(run);
  }

  public void put(UUID run, Current current) {
    if (runs.size() >= 5 && !runs.containsKey(run))
      throw new ApiException(503, "MATERIAL_CAPACITY", "Active task capacity is exhausted.");
    runs.put(run, current);
  }

  public void result(UUID run, UUID item, Contracts.Decision decision, Contracts.ApiError error) {
    runs.computeIfPresent(
        run,
        (key, old) ->
            old.itemId().equals(item)
                ? new Current(
                    old.itemId(), old.snapshot(), old.nonce(), old.media(), decision, error)
                : old);
  }

  public void remove(UUID run) {
    runs.remove(run);
  }

  public record AssetBytes(Contracts.MediaAsset asset, byte[] bytes) {}

  public AssetBytes asset(UUID run, String asset) {
    var current = runs.get(run);
    if (current == null || !current.media().containsKey(asset))
      throw new ApiException(404, "NOT_FOUND", "Resource not found.");
    var metadata = SnapshotValidation.assets(current.snapshot()).stream().filter(a -> a.id().equals(asset)).findFirst().orElseThrow(() -> new ApiException(404,"NOT_FOUND","Resource not found."));
    return new AssetBytes(metadata,current.media().get(asset));
  }
}
