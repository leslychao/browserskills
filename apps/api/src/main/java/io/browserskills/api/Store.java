package io.browserskills.api;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

@Repository
public class Store {
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
      Instant updatedAt) {}

  public record Item(
      UUID id,
      UUID runId,
      int ordinal,
      String projectId,
      String taskId,
      String snapshotHash,
      String instructionHash,
      UUID nonce,
      String status,
      String optionId,
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

  private User mapUser(ResultSet r, int ignored) throws SQLException {
    return new User(
        r.getObject("id", UUID.class),
        r.getString("login"),
        r.getString("password_hash"),
        r.getBoolean("enabled"),
        r.getInt("worker_id"));
  }

  private Run run(ResultSet r, int ignored) throws SQLException {
    return new Run(
        r.getObject("id", UUID.class),
        r.getObject("user_id", UUID.class),
        r.getString("status"),
        r.getInt("max_tasks"),
        r.getInt("processed"),
        r.getString("generation"),
        r.getString("error_code"),
        r.getTimestamp("created_at").toInstant(),
        r.getTimestamp("updated_at").toInstant());
  }

  private Item item(ResultSet r, int ignored) throws SQLException {
    return new Item(
        r.getObject("id", UUID.class),
        r.getObject("run_id", UUID.class),
        r.getInt("ordinal"),
        r.getString("project_id"),
        r.getString("task_id"),
        r.getString("snapshot_hash"),
        r.getString("instruction_hash"),
        r.getObject("confirmation_nonce", UUID.class),
        r.getString("status"),
        r.getString("option_id"),
        r.getString("code"),
        r.getTimestamp("created_at").toInstant());
  }

  private static <T> T first(List<T> rows) {
    return rows.isEmpty() ? null : rows.getFirst();
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
        status -> {
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
    var rows =
        db.queryForList(
            "SELECT id FROM users WHERE id=? AND enabled=true FOR UPDATE", UUID.class, id);
    if (rows.isEmpty()) throw ApiException.unauthorized();
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
    return db.query(
        "SELECT * FROM runs WHERE status IN"
            + " ('PREPARING','ANALYZING','AWAITING_CONFIRMATION','SUBMITTING')",
        this::run);
  }

  public boolean active(UUID user) {
    return db.queryForObject(
            "SELECT count(*) FROM runs WHERE user_id=? AND status IN"
                + " ('PREPARING','ANALYZING','AWAITING_CONFIRMATION','SUBMITTING')",
            Integer.class,
            user)
        > 0;
  }

  public Created create(UUID user, Contracts.StartRun request) {
    if (request.requestId() == null || request.maxTasks() < 1 || request.maxTasks() > 50)
      throw ApiException.invalid();
    return tx.execute(
        status -> {
          lockUser(user);
          var old =
              first(
                  db.query(
                      "SELECT * FROM runs WHERE user_id=? AND request_id=?",
                      this::run,
                      user,
                      request.requestId()));
          if (old != null) {
            if (old.maxTasks() != request.maxTasks())
              throw new ApiException(
                  409, "IDEMPOTENCY_CONFLICT", "Request id belongs to different parameters.");
            return new Created(old, false);
          }
          if (active(user)) throw new ApiException(409, "RUN_ACTIVE", "A run is already active.");
          UUID id = UUID.randomUUID();
          var now = Timestamp.from(clock.instant());
          db.update(
              "INSERT INTO runs(id,user_id,request_id,max_tasks,status,created_at,updated_at)"
                  + " VALUES(?,?,?,?,'PREPARING',?,?)",
              id,
              user,
              request.requestId(),
              request.maxTasks(),
              now,
              now);
          return new Created(owned(user, id), true);
        });
  }

  public void generation(UUID user, UUID run, String generation) {
    db.update(
        "UPDATE runs SET generation=?,updated_at=? WHERE id=? AND user_id=? AND status='PREPARING'",
        generation,
        Timestamp.from(clock.instant()),
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

  public Item draft(UUID user, UUID run, Contracts.TaskSnapshot snapshot) {
    return tx.execute(
        status -> {
          var r = locked(user, run);
          if (!Set.of("PREPARING", "ANALYZING", "AWAITING_CONFIRMATION", "SUBMITTING")
              .contains(r.status())) return null;
          int unresolved =
              db.queryForObject(
                  "SELECT count(*) FROM run_items i JOIN runs r ON r.id=i.run_id WHERE r.user_id=?"
                      + " AND i.project_id=? AND i.task_id=? AND i.status IN"
                      + " ('SUBMIT_INTENT','UNKNOWN')",
                  Integer.class,
                  user,
                  snapshot.projectId(),
                  snapshot.taskId());
          if (unresolved > 0)
            throw new ApiException(
                409,
                "UNRESOLVED_TASK",
                "Resolve the previous unknown submission in Yandex and open a different task.");
          Item old = current(run);
          if (old != null
              && old.taskId().equals(snapshot.taskId())
              && old.status().equals("SUBMITTED"))
            throw new ApiException(
                409, "TASK_NOT_ADVANCED", "The browser still shows the submitted task.");
          UUID id = UUID.randomUUID(), nonce = UUID.randomUUID();
          int ordinal = old == null ? 1 : old.ordinal() + 1;
          if (old != null && old.status().equals("DRAFT")) {
            ordinal = old.ordinal();
            db.update("DELETE FROM run_items WHERE id=? AND status='DRAFT'", old.id());
          }
          db.update(
              "INSERT INTO"
                  + " run_items(id,run_id,ordinal,project_id,task_id,snapshot_hash,instruction_hash,confirmation_nonce,status,created_at)"
                  + " VALUES(?,?,?,?,?,?,?,?,'DRAFT',?)",
              id,
              run,
              ordinal,
              snapshot.projectId(),
              snapshot.taskId(),
              snapshot.snapshotHash(),
              snapshot.instruction().hash(),
              nonce,
              Timestamp.from(clock.instant()));
          transition(run, "ANALYZING", null);
          return current(run);
        });
  }

  public void awaiting(UUID user, UUID run, UUID item) {
    tx.executeWithoutResult(
        status -> {
          var r = locked(user, run);
          var i = current(run);
          if (r.status().equals("ANALYZING") && i != null && i.id().equals(item))
            transition(run, "AWAITING_CONFIRMATION", null);
        });
  }

  public boolean duplicateConfirm(UUID user, UUID run, Contracts.Confirm c, String hash) {
    owned(user, run);
    var rows =
        db.queryForList(
            "SELECT confirm_hash FROM run_items WHERE run_id=? AND confirm_request_id=?",
            String.class,
            run,
            c.requestId());
    if (rows.isEmpty()) return false;
    if (!rows.getFirst().equals(hash))
      throw new ApiException(
          409, "IDEMPOTENCY_CONFLICT", "Confirmation id belongs to different parameters.");
    return true;
  }

  public boolean intent(UUID user, UUID run, Contracts.Confirm c, String hash) {
    return tx.execute(
        status -> {
          var r = locked(user, run);
          if (duplicateConfirm(user, run, c, hash)) return false;
          Item i = current(run);
          if (!r.status().equals("AWAITING_CONFIRMATION")
              || i == null
              || !i.status().equals("DRAFT")
              || !i.taskId().equals(c.taskId())
              || !i.snapshotHash().equals(c.snapshotHash())
              || !i.instructionHash().equals(c.instructionHash())
              || !i.nonce().toString().equals(c.confirmationNonce()))
            throw new ApiException(
                409,
                "STALE_CONFIRMATION",
                "Task or instructions changed. Review the current task.");
          db.update(
              "UPDATE run_items SET"
                  + " status='SUBMIT_INTENT',option_id=?,confirm_request_id=?,confirm_hash=? WHERE"
                  + " id=?",
              c.optionId(),
              c.requestId(),
              hash,
              i.id());
          transition(run, "SUBMITTING", null);
          return true;
        });
  }

  public boolean finish(UUID user, UUID run, Contracts.SubmitResult result) {
    return tx.execute(
        status -> {
          var r = locked(user, run);
          var i = current(run);
          if (i == null || !i.status().equals("SUBMIT_INTENT")) return false;
          boolean success = Set.of("SUBMITTED", "COMPLETE").contains(result.outcome());
          String itemState =
              success ? "SUBMITTED" : result.outcome().equals("REJECTED") ? "FAILED" : "UNKNOWN";
          db.update(
              "UPDATE run_items SET status=?,code=? WHERE id=?", itemState, result.code(), i.id());
          if (success) db.update("UPDATE runs SET processed=processed+1 WHERE id=?", run);
          boolean next =
              success
                  && !result.outcome().equals("COMPLETE")
                  && r.processed() + 1 < r.maxTasks()
                  && r.status().equals("SUBMITTING");
          String state =
              next
                  ? "PREPARING"
                  : success
                      ? (r.status().equals("STOPPED") ? "STOPPED" : "COMPLETED")
                      : itemState.equals("UNKNOWN") ? "UNKNOWN" : r.status().equals("STOPPED") ? "STOPPED" : "FAILED";
          transition(run, state, result.code());
          return next;
        });
  }

  public void stop(UUID user, UUID run) {
    tx.executeWithoutResult(
        status -> {
          var r = locked(user, run);
          if (Set.of("PREPARING", "ANALYZING", "AWAITING_CONFIRMATION", "SUBMITTING")
              .contains(r.status())) transition(run, "STOPPED", null);
        });
  }

  public void fail(UUID user, UUID run, String code) {
    tx.executeWithoutResult(
        status -> {
          var r = locked(user, run);
          if (Set.of("PREPARING", "ANALYZING", "AWAITING_CONFIRMATION").contains(r.status()))
            transition(run, "FAILED", code);
        });
  }

  private void transition(UUID run, String state, String code) {
    db.update(
        "UPDATE runs SET status=?,error_code=?,updated_at=? WHERE id=?",
        state,
        code,
        Timestamp.from(clock.instant()),
        run);
  }

  public void reconcile() {
    tx.executeWithoutResult(
        status -> {
          db.update(
              "UPDATE run_items SET status='UNKNOWN',code='API_RESTARTED' WHERE"
                  + " status='SUBMIT_INTENT'");
          db.update(
              "UPDATE runs SET status=CASE WHEN EXISTS(SELECT 1 FROM run_items i WHERE"
                  + " i.run_id=runs.id AND i.status='UNKNOWN') THEN 'UNKNOWN' ELSE 'INTERRUPTED'"
                  + " END,error_code='API_RESTARTED',updated_at=? WHERE status IN"
                  + " ('PREPARING','ANALYZING','AWAITING_CONFIRMATION','SUBMITTING') OR (status='STOPPED' AND EXISTS (SELECT 1 FROM run_items i WHERE i.run_id=runs.id AND i.status='UNKNOWN'))",
              Timestamp.from(clock.instant()));
          db.update(
              "UPDATE ai_usage SET status='UNKNOWN',error_code='API_RESTARTED',completed_at=? WHERE"
                  + " status='RESERVED'",
              Timestamp.from(clock.instant()));
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

  public boolean reserveAi(UUID user, UUID request, Contracts.TaskSnapshot snapshot) {
    return tx.execute(
        status -> {
          lockUser(user);
          var old =
              db.queryForList(
                  "SELECT snapshot_hash FROM ai_usage WHERE user_id=? AND request_id=?",
                  String.class,
                  user,
                  request);
          if (!old.isEmpty()) {
            if (!old.getFirst().equals(snapshot.snapshotHash()))
              throw new ApiException(409, "IDEMPOTENCY_CONFLICT", "Analysis id already used.");
            return false;
          }
          if (quota(user).remaining() < 1)
            throw new ApiException(
                429, "AI_QUOTA", "Daily analysis quota is exhausted. Select manually.");
          db.update(
              "INSERT INTO"
                  + " ai_usage(id,user_id,request_id,snapshot_hash,instruction_hash,status,created_at)"
                  + " VALUES(?,?,?,?,?,'RESERVED',?)",
              UUID.randomUUID(),
              user,
              request,
              snapshot.snapshotHash(),
              snapshot.instruction().hash(),
              Timestamp.from(clock.instant()));
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
        Timestamp.from(clock.instant()),
        user,
        request);
  }
}
