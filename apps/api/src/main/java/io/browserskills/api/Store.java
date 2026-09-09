package io.browserskills.api;

import java.sql.*;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

@Repository
public class Store {
  public static final Set<String> ACTIVE =
      Set.of(
          "SELECTING",
          "PREPARING",
          "ANALYZING",
          "FILLING",
          "WAITING_FOR_AUTH",
          "WAITING_FOR_USER",
          "SUBMITTING");
  private static final String ACTIVE_SQL =
      "'SELECTING','PREPARING','ANALYZING','FILLING','WAITING_FOR_AUTH','WAITING_FOR_USER','SUBMITTING'";

  public record User(UUID id, String login, String passwordHash, boolean enabled, int workerId) {}

  public record Run(
      UUID id,
      UUID userId,
      String status,
      int maxTasks,
      int processed,
      String generation,
      String errorCode,
      Instant createdAt,
      Instant updatedAt,
      Contracts.SelectionSettings selection,
      Contracts.CatalogueItem selectedProject,
      String selectionReason,
      Contracts.InstructionProgress instructionProgress) {}

  public record Item(
      UUID id,
      UUID runId,
      int ordinal,
      String poolId,
      String suiteId,
      String snapshotHash,
      String instructionHash,
      String status,
      Contracts.AnswerSet answer,
      String code,
      Instant createdAt) {}

  public record Created(Run run, boolean fresh) {}

  private final JdbcTemplate db;
  private final TransactionTemplate tx;
  private final Clock clock;
  private final int quota;

  public Store(
      JdbcTemplate db,
      TransactionTemplate tx,
      Clock clock,
      @Value("${api.daily-quota:100}") int quota) {
    this.db = db;
    this.tx = tx;
    this.clock = clock;
    this.quota = quota;
  }

  private static <T> T first(List<T> rows) {
    return rows.isEmpty() ? null : rows.getFirst();
  }

  private static String json(Object o) {
    return Json.mapper().writeValueAsString(o);
  }

  private static <T> T read(String s, Class<T> c) {
    return s == null ? null : Json.mapper().readValue(s, c);
  }

  private Timestamp now() {
    return Timestamp.from(clock.instant());
  }

  private User mapUser(ResultSet r, int n) throws SQLException {
    return new User(
        r.getObject("id", UUID.class),
        r.getString("login"),
        r.getString("password_hash"),
        r.getBoolean("enabled"),
        r.getInt("worker_id"));
  }

  private Run run(ResultSet r, int n) throws SQLException {
    return new Run(
        r.getObject("id", UUID.class),
        r.getObject("user_id", UUID.class),
        r.getString("status"),
        r.getInt("max_tasks"),
        r.getInt("processed"),
        r.getString("generation"),
        r.getString("error_code"),
        r.getTimestamp("created_at").toInstant(),
        r.getTimestamp("updated_at").toInstant(),
        read(r.getString("selection_json"), Contracts.SelectionSettings.class),
        read(r.getString("selected_project_json"), Contracts.CatalogueItem.class),
        r.getString("selection_reason"),
        read(r.getString("instruction_progress_json"), Contracts.InstructionProgress.class));
  }

  private Item item(ResultSet r, int n) throws SQLException {
    return new Item(
        r.getObject("id", UUID.class),
        r.getObject("run_id", UUID.class),
        r.getInt("ordinal"),
        r.getString("pool_id"),
        r.getString("suite_id"),
        r.getString("snapshot_hash"),
        r.getString("instruction_hash"),
        r.getString("status"),
        read(r.getString("answer_json"), Contracts.AnswerSet.class),
        r.getString("code"),
        r.getTimestamp("created_at").toInstant());
  }

  public User findLogin(String login) {
    return first(
        db.query(
            "SELECT u.*,a.worker_id FROM users u JOIN browser_assignments a ON a.user_id=u.id WHERE"
                + " login=?",
            this::mapUser,
            login));
  }

  public User user(UUID id) {
    var u =
        first(
            db.query(
                "SELECT u.*,a.worker_id FROM users u JOIN browser_assignments a ON a.user_id=u.id"
                    + " WHERE u.id=?",
                this::mapUser,
                id));
    if (u == null || !u.enabled()) throw ApiException.unauthorized();
    return u;
  }

  public UUID provision(String login, String passwordHash) {
    if (login == null || !login.matches("[a-zA-Z0-9_.@-]{1,128}")) throw ApiException.invalid();
    return tx.execute(
        s -> {
          db.execute("LOCK TABLE browser_assignments IN EXCLUSIVE MODE");
          var used = db.queryForList("SELECT worker_id FROM browser_assignments", Integer.class);
          int slot =
              java.util.stream.IntStream.rangeClosed(1, 5)
                  .filter(i -> !used.contains(i))
                  .findFirst()
                  .orElseThrow(
                      () ->
                          new ApiException(
                              409, "USER_LIMIT", "Five browser assignments already exist."));
          UUID id = UUID.randomUUID();
          db.update(
              "INSERT INTO users(id,login,password_hash) VALUES(?,?,?)", id, login, passwordHash);
          db.update("INSERT INTO browser_assignments(worker_id,user_id) VALUES(?,?)", slot, id);
          return id;
        });
  }

  public boolean disable(String login) {
    return db.update("UPDATE users SET enabled=false WHERE login=?", login) == 1;
  }

  private void lockUser(UUID id) {
    if (db.queryForList(
            "SELECT id FROM users WHERE id=? AND enabled=true FOR UPDATE", UUID.class, id)
        .isEmpty()) throw ApiException.unauthorized();
  }

  public Run owned(UUID user, UUID id) {
    var r = first(db.query("SELECT * FROM runs WHERE user_id=? AND id=?", this::run, user, id));
    if (r == null) throw new ApiException(404, "NOT_FOUND", "Resource not found.");
    return r;
  }

  private Run locked(UUID user, UUID id) {
    var r =
        first(
            db.query(
                "SELECT * FROM runs WHERE user_id=? AND id=? FOR UPDATE", this::run, user, id));
    if (r == null) throw new ApiException(404, "NOT_FOUND", "Resource not found.");
    return r;
  }

  public List<Run> runs(UUID user) {
    return db.query(
        "SELECT * FROM runs WHERE user_id=? ORDER BY created_at DESC LIMIT 100", this::run, user);
  }

  public List<Run> activeRuns() {
    return db.query("SELECT * FROM runs WHERE status IN (" + ACTIVE_SQL + ")", this::run);
  }

  public boolean active(UUID user) {
    return db.queryForObject(
            "SELECT count(*) FROM runs WHERE user_id=? AND status IN (" + ACTIVE_SQL + ")",
            Integer.class,
            user)
        > 0;
  }

  public boolean manualAllowed(UUID user) {
    return db.queryForObject(
            "SELECT count(*) FROM runs WHERE user_id=? AND status IN"
                + " ('SELECTING','PREPARING','ANALYZING','FILLING','SUBMITTING')",
            Integer.class,
            user)
        == 0;
  }

  public Contracts.SelectionSettings selection(UUID user) {
    user(user);
    String s =
        first(
            db.queryForList(
                "SELECT settings_json::text FROM selection_settings WHERE user_id=?",
                String.class,
                user));
    return s == null
        ? Contracts.SelectionSettings.defaults()
        : read(s, Contracts.SelectionSettings.class);
  }

  public Contracts.SelectionSettings selection(UUID user, Contracts.SelectionSettings settings) {
    user(user);
    var value = SnapshotValidation.selection(settings);
    db.update(
        "INSERT INTO selection_settings(user_id,settings_json) VALUES(?,?::jsonb) ON"
            + " CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json",
        user,
        json(value));
    return value;
  }

  public Created create(UUID user, Contracts.StartRun request) {
    if (request == null
        || request.requestId() == null
        || request.maxTasks() < 1
        || request.maxTasks() > 50) throw ApiException.invalid();
    var selection = SnapshotValidation.selection(request.selection());
    return tx.execute(
        s -> {
          lockUser(user);
          var old =
              first(
                  db.query(
                      "SELECT * FROM runs WHERE user_id=? AND request_id=?",
                      this::run,
                      user,
                      request.requestId()));
          if (old != null) {
            if (old.maxTasks() != request.maxTasks() || !old.selection().equals(selection))
              throw new ApiException(
                  409, "IDEMPOTENCY_CONFLICT", "Request id belongs to different parameters.");
            return new Created(old, false);
          }
          if (active(user)) throw new ApiException(409, "RUN_ACTIVE", "A run is already active.");
          UUID id = UUID.randomUUID();
          db.update(
              "INSERT INTO"
                  + " runs(id,user_id,request_id,max_tasks,status,created_at,updated_at,selection_json)"
                  + " VALUES(?,?,?,?,'SELECTING',?,?,?::jsonb)",
              id,
              user,
              request.requestId(),
              request.maxTasks(),
              now(),
              now(),
              json(selection));
          return new Created(owned(user, id), true);
        });
  }

  public void generation(UUID user, UUID run, String generation) {
    db.update(
        "UPDATE runs SET generation=?,updated_at=? WHERE id=? AND user_id=? AND status IN"
            + " ('SELECTING','WAITING_FOR_AUTH','WAITING_FOR_USER')",
        generation,
        now(),
        run,
        user);
  }

  public boolean state(UUID user, UUID run, String expected, String state, String code) {
    if (!ACTIVE.contains(state) && !Set.of("COMPLETED", "FAILED").contains(state))
      throw new IllegalArgumentException();
    return db.update(
            "UPDATE runs SET status=?,error_code=?,updated_at=? WHERE id=? AND user_id=? AND"
                + " status=?",
            state,
            code,
            now(),
            run,
            user,
            expected)
        == 1;
  }

  public void selected(UUID user, UUID run, Contracts.CatalogueItem item, String reason) {
    db.update(
        "UPDATE runs SET selected_project_json=?::jsonb,selection_reason=?,updated_at=? WHERE id=?"
            + " AND user_id=?",
        json(item),
        reason,
        now(),
        run,
        user);
  }

  public void progress(UUID user, UUID run, Contracts.InstructionProgress progress) {
    db.update(
        "UPDATE runs SET instruction_progress_json=?::jsonb,updated_at=? WHERE id=? AND user_id=?",
        json(progress),
        now(),
        run,
        user);
  }

  public Item current(UUID run) {
    return first(
        db.query(
            "SELECT * FROM run_items WHERE run_id=? ORDER BY ordinal DESC LIMIT 1",
            this::item,
            run));
  }

  public List<Item> items(UUID run) {
    return db.query("SELECT * FROM run_items WHERE run_id=? ORDER BY ordinal", this::item, run);
  }

  public Item draft(UUID user, UUID run, Contracts.TaskSet snapshot) {
    return tx.execute(
        s -> {
          var r = locked(user, run);
          if (!Set.of("SELECTING", "PREPARING", "ANALYZING", "FILLING").contains(r.status()))
            return null;
          int unresolved =
              db.queryForObject(
                  "SELECT count(*) FROM run_items i JOIN runs r ON r.id=i.run_id WHERE r.user_id=?"
                      + " AND i.pool_id=? AND i.suite_id=? AND i.status IN"
                      + " ('SUBMIT_INTENT','UNKNOWN','SUBMITTED')",
                  Integer.class,
                  user,
                  snapshot.poolId(),
                  snapshot.suiteId());
          if (unresolved > 0)
            throw new ApiException(
                409,
                "UNRESOLVED_TASK",
                "This suite has already been sent or has an unknown outcome.");
          var old = current(run);
          int ordinal = old == null ? 1 : old.ordinal() + 1;
          UUID id = UUID.randomUUID();
          if (old != null && old.status().equals("DRAFT")) {
            ordinal = old.ordinal();
            db.update("DELETE FROM run_items WHERE id=? AND status='DRAFT'", old.id());
          }
          db.update(
              "INSERT INTO"
                  + " run_items(id,run_id,ordinal,pool_id,suite_id,snapshot_hash,instruction_hash,status,created_at)"
                  + " VALUES(?,?,?,?,?,?,?,'DRAFT',?)",
              id,
              run,
              ordinal,
              snapshot.poolId(),
              snapshot.suiteId(),
              snapshot.snapshotHash(),
              snapshot.instruction().hash(),
              now());
          transition(run, "ANALYZING", null);
          return current(run);
        });
  }

  public boolean intent(
      UUID user, UUID run, UUID item, Contracts.TaskSet snapshot, Contracts.AnswerSet answer) {
    SnapshotValidation.answers(snapshot, answer, true);
    return tx.execute(
        s -> {
          var r = locked(user, run);
          var i = current(run);
          if (i != null && !i.status().equals("DRAFT")) return false;
          if (!r.status().equals("FILLING")
              || i == null
              || !i.id().equals(item)
              || !i.poolId().equals(snapshot.poolId())
              || !i.suiteId().equals(snapshot.suiteId())
              || !i.snapshotHash().equals(snapshot.snapshotHash())
              || !i.instructionHash().equals(snapshot.instruction().hash()))
            throw new ApiException(409, "STALE_TASK", "Task or instruction changed.");
          db.update(
              "UPDATE run_items SET status='SUBMIT_INTENT',answer_json=?::jsonb WHERE id=?",
              json(answer),
              item);
          transition(run, "SUBMITTING", null);
          return true;
        });
  }

  public void updateDraft(UUID user, UUID run, UUID item, Contracts.TaskSet snapshot) {
    db.update(
        "UPDATE run_items SET snapshot_hash=?,instruction_hash=? WHERE id=? AND run_id=? AND"
            + " status='DRAFT' AND EXISTS(SELECT 1 FROM runs WHERE id=? AND user_id=? AND"
            + " status='FILLING')",
        snapshot.snapshotHash(),
        snapshot.instruction().hash(),
        item,
        run,
        run,
        user);
  }

  public boolean finish(UUID user, UUID run, Contracts.SubmitResult result) {
    return tx.execute(
        s -> {
          var r = locked(user, run);
          var i = current(run);
          if (i == null || !i.status().equals("SUBMIT_INTENT")) return false;
          boolean success = Set.of("SUBMITTED", "COMPLETE").contains(result.outcome());
          String itemState =
              success ? "SUBMITTED" : "REJECTED".equals(result.outcome()) ? "FAILED" : "UNKNOWN";
          db.update(
              "UPDATE run_items SET status=?,code=? WHERE id=?", itemState, result.code(), i.id());
          if (success) db.update("UPDATE runs SET processed=processed+1 WHERE id=?", run);
          boolean next =
              success && r.processed() + 1 < r.maxTasks() && r.status().equals("SUBMITTING");
          String state =
              next
                  ? "SELECTING"
                  : success
                      ? ("STOPPED".equals(r.status()) ? "STOPPED" : "COMPLETED")
                      : "UNKNOWN".equals(itemState)
                          ? "UNKNOWN"
                          : "STOPPED".equals(r.status()) ? "STOPPED" : "FAILED";
          transition(run, state, result.code());
          return next;
        });
  }

  public void stop(UUID user, UUID run) {
    tx.executeWithoutResult(
        s -> {
          var r = locked(user, run);
          if (ACTIVE.contains(r.status())) transition(run, "STOPPED", null);
        });
  }

  public void fail(UUID user, UUID run, String code) {
    tx.executeWithoutResult(
        s -> {
          var r = locked(user, run);
          if (ACTIVE.contains(r.status()) && !r.status().equals("SUBMITTING"))
            transition(run, "FAILED", code);
        });
  }

  private void transition(UUID run, String state, String code) {
    db.update(
        "UPDATE runs SET status=?,error_code=?,updated_at=? WHERE id=?", state, code, now(), run);
  }

  public void reconcile() {
    tx.executeWithoutResult(
        s -> {
          db.update(
              "UPDATE run_items SET status='UNKNOWN',code='API_RESTARTED' WHERE"
                  + " status='SUBMIT_INTENT'");
          db.update(
              "UPDATE runs SET status=CASE WHEN EXISTS(SELECT 1 FROM run_items i WHERE"
                  + " i.run_id=runs.id AND i.status='UNKNOWN') THEN 'UNKNOWN' ELSE 'INTERRUPTED'"
                  + " END,error_code='API_RESTARTED',updated_at=? WHERE status IN ("
                  + ACTIVE_SQL
                  + ") OR (status='STOPPED' AND EXISTS(SELECT 1 FROM run_items i WHERE"
                  + " i.run_id=runs.id AND i.status='UNKNOWN'))",
              now());
          db.update(
              "UPDATE ai_usage SET status='UNKNOWN',error_code='API_RESTARTED',completed_at=? WHERE"
                  + " status='RESERVED'",
              now());
        });
  }

  public Contracts.Quota quota(UUID user) {
    Instant start =
        clock
            .instant()
            .atZone(ZoneOffset.UTC)
            .toLocalDate()
            .atStartOfDay(ZoneOffset.UTC)
            .toInstant();
    int used =
        db.queryForObject(
            "SELECT count(*) FROM ai_usage WHERE user_id=? AND created_at>=? AND created_at<?",
            Integer.class,
            user,
            Timestamp.from(start),
            Timestamp.from(start.plus(Duration.ofDays(1))));
    return new Contracts.Quota(
        quota, used, Math.max(0, quota - used), start.plus(Duration.ofDays(1)));
  }

  public boolean reserveAi(UUID user, UUID request, String snapshotHash, String instructionHash) {
    return tx.execute(
        s -> {
          lockUser(user);
          var old =
              db.queryForList(
                  "SELECT snapshot_hash FROM ai_usage WHERE user_id=? AND request_id=?",
                  String.class,
                  user,
                  request);
          if (!old.isEmpty()) {
            if (!old.getFirst().equals(snapshotHash))
              throw new ApiException(409, "IDEMPOTENCY_CONFLICT", "Analysis id already used.");
            return false;
          }
          if (quota(user).remaining() < 1)
            throw new ApiException(429, "AI_QUOTA", "Daily inference quota is exhausted.");
          db.update(
              "INSERT INTO"
                  + " ai_usage(id,user_id,request_id,snapshot_hash,instruction_hash,status,created_at)"
                  + " VALUES(?,?,?,?,?,'RESERVED',?)",
              UUID.randomUUID(),
              user,
              request,
              snapshotHash,
              instructionHash,
              now());
          return true;
        });
  }

  public void completeAi(UUID user, UUID request, String result, String error, String modelHash) {
    db.update(
        "UPDATE ai_usage SET status=?,result_json=?,error_code=?,model_hash=?,completed_at=? WHERE"
            + " user_id=? AND request_id=? AND status='RESERVED'",
        error == null ? "COMPLETED" : "FAILED",
        result,
        error,
        modelHash,
        now(),
        user,
        request);
  }
}
