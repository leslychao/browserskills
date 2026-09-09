package io.browserskills.api;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import org.springframework.stereotype.Component;

@Component
public class ManualLeases {
  public record Lease(UUID user, int worker, String session, String generation, Instant expires) {}

  public record Status(String state, Instant expiresAt) {}

  // A tab identity is scoped to its HttpOnly application session. It is not a bearer credential.
  public static String controller(String session, UUID controlId) {
    return session + ":" + controlId;
  }

  private final Map<UUID, Lease> leases = new ConcurrentHashMap<>();
  private final List<Consumer<String>> listeners = new CopyOnWriteArrayList<>();
  private final Clock clock;

  public ManualLeases(Clock clock) {
    this.clock = clock;
  }

  public synchronized void acquire(
      UUID user, int worker, String session, String generation, Instant expires, boolean takeOver) {
    var old = leases.get(user);
    if (!takeOver
        && old != null
        && old.expires().isAfter(clock.instant())
        && !old.session().equals(session))
      throw new ApiException(
          409,
          "CONTROL_IN_USE",
          "Браузер управляется из другой вкладки. Нажмите «Перехватить управление», чтобы"
              + " продолжить здесь.");
    revoke(user);
    leases.put(user, new Lease(user, worker, session, generation, expires));
  }

  public Status status(UUID user, String session) {
    var lease = leases.get(user);
    if (lease == null || !lease.expires().isAfter(clock.instant()))
      return new Status("AVAILABLE", null);
    return new Status(lease.session().equals(session) ? "OWNED" : "IN_USE", lease.expires());
  }

  public synchronized void reconcile(UUID user, Contracts.BrowserStatus browser) {
    var lease = leases.get(user);
    if (lease != null
        && (!"MANUAL".equals(browser.mode())
            || !Objects.equals(lease.generation(), browser.generation()))) revoke(user);
  }

  public boolean valid(UUID user, String session) {
    var lease = leases.get(user);
    return lease != null
        && lease.session().equals(session)
        && lease.expires().isAfter(clock.instant());
  }

  public Lease lease(UUID user, String session) {
    if (!valid(user, session))
      throw new ApiException(
          403,
          "CONTROL_REQUIRED",
          "Ручное управление завершено или передано другой вкладке. Подключитесь снова.");
    return leases.get(user);
  }

  public synchronized void revoke(UUID user) {
    var old = leases.remove(user);
    if (old != null) listeners.forEach(listener -> listener.accept(old.session()));
  }

  public void onRevoke(Consumer<String> listener) {
    listeners.add(listener);
  }
}
