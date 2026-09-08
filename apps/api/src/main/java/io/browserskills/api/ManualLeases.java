package io.browserskills.api;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import org.springframework.stereotype.Component;

@Component
public class ManualLeases {
  public record Lease(UUID user, int worker, String session, String generation, Instant expires) {}

  private final Map<UUID, Lease> leases = new ConcurrentHashMap<>();
  private final List<Consumer<String>> listeners = new CopyOnWriteArrayList<>();
  private final Clock clock;

  public ManualLeases(Clock clock) {
    this.clock = clock;
  }

  public synchronized void acquire(
      UUID user, int worker, String session, String generation, Instant expires) {
    var old = leases.get(user);
    if (old != null && old.expires().isAfter(clock.instant()) && !old.session().equals(session))
      throw new ApiException(409, "CONTROL_IN_USE", "Browser control belongs to another session.");
    revoke(user);
    leases.put(user, new Lease(user, worker, session, generation, expires));
  }

  public boolean valid(UUID user, String session) {
    var lease = leases.get(user);
    return lease != null
        && lease.session().equals(session)
        && lease.expires().isAfter(clock.instant());
  }

  public Lease lease(UUID user, String session) {
    if (!valid(user, session))
      throw new ApiException(403, "CONTROL_REQUIRED", "Acquire manual browser control first.");
    return leases.get(user);
  }

  public synchronized void revoke(UUID user) {
    var old = leases.remove(user);
    if (old != null) listeners.forEach(listener -> listener.accept(old.session()));
  }

  public void revokeSession(String session) {
    leases.values().stream()
        .filter(l -> l.session().equals(session))
        .map(Lease::user)
        .toList()
        .forEach(this::revoke);
    listeners.forEach(listener -> listener.accept(session));
  }

  public void onRevoke(Consumer<String> listener) {
    listeners.add(listener);
  }
}
