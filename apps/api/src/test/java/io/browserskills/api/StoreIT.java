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
  Store store;
  JdbcTemplate db;
  UUID user;

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
  void fiftyWholeSuiteSendsAreDurableIdempotentAndOwned() {
    var request = SnapshotValidationTest.start(50);
    var created = store.create(user, request);
    UUID run = created.run().id();
    assertFalse(store.create(user, request).fresh());
    assertThrows(
        ApiException.class,
        () ->
            store.create(
                user, new Contracts.StartRun(request.requestId(), 49, request.selection())));
    assertThrows(ApiException.class, () -> store.create(user, SnapshotValidationTest.start(1)));
    UUID other = store.provision("bob", "hash");
    assertThrows(ApiException.class, () -> store.owned(other, run));
    store.generation(user, run, "gen");
    for (int n = 1; n <= 50; n++) {
      var s = SnapshotValidationTest.snapshot("suite-" + n);
      var item = store.draft(user, run, s);
      store.state(user, run, "ANALYZING", "FILLING", null);
      assertTrue(store.intent(user, run, item.id(), s, SnapshotValidationTest.answer()));
      assertFalse(store.intent(user, run, item.id(), s, SnapshotValidationTest.answer()));
      assertEquals(
          n < 50,
          store.finish(
              user, run, new Contracts.SubmitResult("SUBMITTED", "suite-" + (n + 1), null)));
    }
    assertEquals(50, store.owned(user, run).processed());
    assertEquals("COMPLETED", store.owned(user, run).status());
    assertEquals(50, store.items(run).size());
    assertFalse(store.active(user));
  }

  @Test
  void unknownAndStoppedIntentSurviveRestartAndBlockResendingSuite() {
    UUID run = store.create(user, SnapshotValidationTest.start(2)).run().id();
    var s = SnapshotValidationTest.snapshot("unknown");
    var item = store.draft(user, run, s);
    store.state(user, run, "ANALYZING", "FILLING", null);
    store.intent(user, run, item.id(), s, SnapshotValidationTest.answer());
    store.stop(user, run);
    store.reconcile();
    assertEquals("UNKNOWN", store.owned(user, run).status());
    assertEquals("UNKNOWN", store.current(run).status());
    UUID next = store.create(user, SnapshotValidationTest.start(1)).run().id();
    assertEquals(
        "UNRESOLVED_TASK",
        assertThrows(ApiException.class, () -> store.draft(user, next, s)).code());
    store.draft(user, next, SnapshotValidationTest.snapshot("different"));
    store.reconcile();
    assertEquals("INTERRUPTED", store.owned(user, next).status());
  }

  @Test
  void pausedRunRetainsExclusiveSlotButAllowsManualLoginAndSettingsAreSnapshots() {
    var setting =
        new Contracts.SelectionSettings(
            "AUTO", null, List.of(), List.of("blocked"), "1.50", List.of("text"), false, false);
    store.selection(user, setting);
    var request = new Contracts.StartRun(UUID.randomUUID(), 2, setting);
    UUID run = store.create(user, request).run().id();
    store.state(user, run, "SELECTING", "WAITING_FOR_AUTH", "TWO_FACTOR_REQUIRED");
    assertTrue(store.active(user));
    assertTrue(store.manualAllowed(user));
    assertThrows(ApiException.class, () -> store.create(user, SnapshotValidationTest.start(1)));
    store.selection(user, Contracts.SelectionSettings.defaults());
    assertEquals(setting, store.owned(user, run).selection());
    assertTrue(store.state(user, run, "WAITING_FOR_AUTH", "SELECTING", null));
    assertFalse(store.manualAllowed(user));
  }

  @Test
  void changedSnapshotStopAndRejectedResultCannotCreateExtraIntent() {
    UUID run = store.create(user, SnapshotValidationTest.start(3)).run().id();
    var s = SnapshotValidationTest.snapshot("one");
    var i = store.draft(user, run, s);
    store.state(user, run, "ANALYZING", "FILLING", null);
    assertThrows(
        ApiException.class,
        () -> store.intent(user, run, UUID.randomUUID(), s, SnapshotValidationTest.answer()));
    store.stop(user, run);
    assertNull(store.draft(user, run, s));
    assertFalse(store.finish(user, run, new Contracts.SubmitResult("REJECTED", null, "ERR")));
    UUID next = store.create(user, SnapshotValidationTest.start(1)).run().id();
    var n = store.draft(user, next, s);
    store.state(user, next, "ANALYZING", "FILLING", null);
    store.intent(user, next, n.id(), s, SnapshotValidationTest.answer());
    assertFalse(
        store.finish(user, next, new Contracts.SubmitResult("REJECTED", null, "VALIDATION_ERROR")));
    assertEquals("FAILED", store.current(next).status());
  }

  @Test
  void everyActualModelCallUsesAtomicQuotaAcrossInstructionAndAnswerPhases() throws Exception {
    String hash = "a".repeat(64);
    UUID id = UUID.randomUUID();
    assertTrue(store.reserveAi(user, id, hash, hash));
    assertFalse(store.reserveAi(user, id, hash, hash));
    store.completeAi(user, id, "{}", null, hash);
    try (var pool = Executors.newFixedThreadPool(8)) {
      var jobs = new ArrayList<Future<Boolean>>();
      for (int i = 0; i < 120; i++)
        jobs.add(
            pool.submit(
                () -> {
                  try {
                    return store.reserveAi(user, UUID.randomUUID(), hash, hash);
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
  }

  @Test
  void fiveAssignmentsAndDisabledAccountsRemainEnforced() {
    for (int i = 2; i <= 5; i++) store.provision("user" + i, "hash");
    assertThrows(ApiException.class, () -> store.provision("six", "hash"));
    assertEquals(user, store.findLogin("alice").id());
    assertNull(store.findLogin("missing"));
    assertTrue(store.disable("alice"));
    assertThrows(ApiException.class, () -> store.user(user));
    assertFalse(store.disable("missing"));
  }

  @Test
  void upgradePreservesExistingSingleAnswerHistoryAndRemovesExecutableConfirmationColumns() {
    var p = PostgresFixture.POSTGRES;
    var ds = new DriverManagerDataSource(p.getJdbcUrl(), p.getUsername(), p.getPassword());
    String schema = "migration_" + UUID.randomUUID().toString().replace("-", "");
    db.execute("CREATE SCHEMA " + schema);
    try {
      Flyway.configure()
          .dataSource(ds)
          .schemas(schema)
          .defaultSchema(schema)
          .target("1")
          .load()
          .migrate();
      UUID oldUser = UUID.randomUUID(),
          oldRun = UUID.randomUUID(),
          oldItem = UUID.randomUUID(),
          nonce = UUID.randomUUID();
      db.update(
          "INSERT INTO " + schema + ".users(id,login,password_hash) VALUES(?,?,?)",
          oldUser,
          "old-user",
          "hash");
      db.update(
          "INSERT INTO "
              + schema
              + ".runs(id,user_id,request_id,max_tasks,status,created_at,updated_at)"
              + " VALUES(?,?,?,1,'AWAITING_CONFIRMATION',now(),now())",
          oldRun,
          oldUser,
          UUID.randomUUID());
      db.update(
          "INSERT INTO "
              + schema
              + ".run_items(id,run_id,ordinal,project_id,task_id,snapshot_hash,instruction_hash,confirmation_nonce,status,option_id,created_at)"
              + " VALUES(?,?,1,'old-pool','old-suite',?,?,?,'DRAFT','answer-a',now())",
          oldItem,
          oldRun,
          "a".repeat(64),
          "b".repeat(64),
          nonce);
      Flyway.configure().dataSource(ds).schemas(schema).defaultSchema(schema).load().migrate();
      assertEquals(
          "INTERRUPTED",
          db.queryForObject(
              "SELECT status FROM " + schema + ".runs WHERE id=?", String.class, oldRun));
      assertEquals(
          "answer-a",
          db.queryForObject(
              "SELECT legacy_response->>'optionId' FROM " + schema + ".run_items WHERE id=?",
              String.class,
              oldItem));
      assertEquals(
          nonce.toString(),
          db.queryForObject(
              "SELECT legacy_response->>'confirmationNonce' FROM "
                  + schema
                  + ".run_items WHERE id=?",
              String.class,
              oldItem));
      assertEquals(
          "old-suite",
          db.queryForObject(
              "SELECT suite_id FROM " + schema + ".run_items WHERE id=?", String.class, oldItem));
      assertEquals(
          0,
          db.queryForObject(
              "SELECT count(*) FROM information_schema.columns WHERE table_schema=? AND"
                  + " table_name='run_items' AND column_name IN"
                  + " ('option_id','confirmation_nonce','confirm_request_id','confirm_hash')",
              Integer.class,
              schema));
    } finally {
      db.execute("DROP SCHEMA " + schema + " CASCADE");
    }
  }
}
