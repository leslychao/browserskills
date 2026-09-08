package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;

import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.transaction.support.TransactionTemplate;

class StoreIT {
  private Store store;
  private JdbcTemplate db;
  private UUID user;

  @BeforeEach
  void setup() {
    var p = PostgresFixture.POSTGRES;
    var ds = new DriverManagerDataSource(p.getJdbcUrl(), p.getUsername(), p.getPassword());
    Flyway.configure().dataSource(ds).load().migrate();
    db = new JdbcTemplate(ds);
    db.execute("TRUNCATE users CASCADE");
    store =
        new Store(
            db,
            new TransactionTemplate(new DataSourceTransactionManager(ds)),
            Clock.systemUTC(),
            100);
    user = store.provision("alice", "hash");
  }

  @Test
  void fiftyUniqueConfirmedSendsWithDuplicateConfirmationAndOwnerIsolation() {
    UUID request = UUID.randomUUID();
    var created = store.create(user, new Contracts.StartRun(request, 50));
    UUID run = created.run().id();
    assertFalse(store.create(user, new Contracts.StartRun(request, 50)).fresh());
    assertThrows(ApiException.class, () -> store.create(user, new Contracts.StartRun(request, 49)));
    assertThrows(
        ApiException.class, () -> store.create(user, new Contracts.StartRun(UUID.randomUUID(), 1)));
    UUID other = store.provision("bob", "hash");
    assertEquals(
        "NOT_FOUND", assertThrows(ApiException.class, () -> store.owned(other, run)).code());
    store.generation(user, run, "gen");
    for (int n = 1; n <= 50; n++) {
      var snapshot = SnapshotValidationTest.snapshot("task-" + n);
      var item = store.draft(user, run, snapshot);
      store.awaiting(user, run, item.id());
      var confirm =
          new Contracts.Confirm(
              UUID.randomUUID(),
              snapshot.taskId(),
              snapshot.snapshotHash(),
              snapshot.instruction().hash(),
              "a",
              item.nonce().toString());
      String hash = SnapshotValidation.sha256(Json.mapper().writeValueAsBytes(confirm));
      assertTrue(store.intent(user, run, confirm, hash));
      assertFalse(store.intent(user, run, confirm, hash));
      assertTrue(store.duplicateConfirm(user, run, confirm, hash));
      assertThrows(
          ApiException.class, () -> store.duplicateConfirm(user, run, confirm, "c".repeat(64)));
      boolean next =
          store.finish(user, run, new Contracts.SubmitResult("SUBMITTED", "task-" + (n + 1), null));
      assertEquals(n < 50, next);
    }
    assertEquals(50, store.owned(user, run).processed());
    assertEquals("COMPLETED", store.owned(user, run).status());
    assertEquals(50, store.items(run).size());
    assertFalse(store.active(user));
    assertEquals(1, store.runs(user).size());
  }

  @Test
  void unknownIntentSurvivesRestartAndBlocksSameTaskAcrossRuns() {
    UUID run = store.create(user, new Contracts.StartRun(UUID.randomUUID(), 2)).run().id();
    var snapshot = SnapshotValidationTest.snapshot("ambiguous");
    var item = store.draft(user, run, snapshot);
    store.awaiting(user, run, item.id());
    var confirm =
        new Contracts.Confirm(
            UUID.randomUUID(),
            snapshot.taskId(),
            snapshot.snapshotHash(),
            snapshot.instruction().hash(),
            "a",
            item.nonce().toString());
    assertTrue(store.intent(user, run, confirm, "a".repeat(64)));
    store.reconcile();
    assertEquals("UNKNOWN", store.owned(user, run).status());
    assertEquals("UNKNOWN", store.current(run).status());
    UUID next = store.create(user, new Contracts.StartRun(UUID.randomUUID(), 1)).run().id();
    assertEquals(
        "UNRESOLVED_TASK",
        assertThrows(ApiException.class, () -> store.draft(user, next, snapshot)).code());
    store.draft(user, next, SnapshotValidationTest.snapshot("different"));
    store.reconcile();
    assertEquals("INTERRUPTED", store.owned(user, next).status());
  }

  @Test
  void quotaReservationIsAtomicAndIdempotentUnderConcurrency() throws Exception {
    var snapshot = SnapshotValidationTest.snapshot("quota");
    UUID id = UUID.randomUUID();
    assertTrue(store.reserveAi(user, id, snapshot));
    assertFalse(store.reserveAi(user, id, snapshot));
    store.completeAi(user, id, "{\"decision\":\"ABSTAIN\"}", null, "model-hash");
    try (var threads = Executors.newFixedThreadPool(8)) {
      var jobs = new ArrayList<Future<Boolean>>();
      for (int i = 0; i < 120; i++)
        jobs.add(
            threads.submit(
                () -> {
                  try {
                    return store.reserveAi(user, UUID.randomUUID(), snapshot);
                  } catch (ApiException e) {
                    assertEquals("AI_QUOTA", e.code());
                    return false;
                  }
                }));
      int accepted = 0;
      for (var job : jobs) if (job.get(20, TimeUnit.SECONDS)) accepted++;
      assertEquals(99, accepted);
    }
    assertEquals(100, store.quota(user).used());
    assertEquals(0, store.quota(user).remaining());
    assertEquals(100, db.queryForObject("SELECT count(*) FROM ai_usage", Integer.class));
  }

  @Test
  void staleNonceFailureStopAndRejectedSubmissionAreDurable() {
    UUID run = store.create(user, new Contracts.StartRun(UUID.randomUUID(), 3)).run().id();
    var s = SnapshotValidationTest.snapshot("one");
    var i = store.draft(user, run, s);
    store.awaiting(user, run, i.id());
    var bad =
        new Contracts.Confirm(
            UUID.randomUUID(),
            s.taskId(),
            s.snapshotHash(),
            s.instruction().hash(),
            "a",
            UUID.randomUUID().toString());
    assertThrows(ApiException.class, () -> store.intent(user, run, bad, "a".repeat(64)));
    assertEquals("DRAFT", store.current(run).status());
    store.stop(user, run);
    assertNull(store.draft(user, run, s));
    assertFalse(store.finish(user, run, new Contracts.SubmitResult("REJECTED", null, "ERR")));
    assertEquals("STOPPED", store.owned(user, run).status());
    UUID failed = store.create(user, new Contracts.StartRun(UUID.randomUUID(), 1)).run().id();
    store.fail(user, failed, "BROKEN");
    assertEquals("FAILED", store.owned(user, failed).status());
    UUID rejected = store.create(user, new Contracts.StartRun(UUID.randomUUID(), 1)).run().id();
    var j = store.draft(user, rejected, s);
    store.awaiting(user, rejected, j.id());
    store.intent(
        user,
        rejected,
        new Contracts.Confirm(
            UUID.randomUUID(),
            s.taskId(),
            s.snapshotHash(),
            s.instruction().hash(),
            "a",
            j.nonce().toString()),
        "a".repeat(64));
    assertFalse(
        store.finish(
            user, rejected, new Contracts.SubmitResult("REJECTED", null, "VALIDATION_ERROR")));
    assertEquals("FAILED", store.current(rejected).status());
  }

  @Test
  void provisioningHasFivePermanentAssignmentsAndDisabledUsersCannotAct() {
    for (int i = 2; i <= 5; i++) store.provision("user" + i, "hash");
    assertEquals(
        "USER_LIMIT",
        assertThrows(ApiException.class, () -> store.provision("six", "hash")).code());
    assertEquals(user, store.findLogin("alice").id());
    assertNull(store.findLogin("missing"));
    assertTrue(store.disable("alice"));
    assertThrows(ApiException.class, () -> store.user(user));
    assertFalse(store.disable("missing"));
    assertThrows(ApiException.class, () -> store.provision("six", "hash"));
  }
}
