package io.browserskills.api;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.sql.*;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

class ReadinessTest {
  @Test
  void localReadinessDistinguishesInferenceFromManualCapabilityWithinBudget() throws Exception {
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/",
        exchange -> {
          exchange.sendResponseHeaders(
              exchange.getRequestURI().getPath().equals("/health") ? 503 : 200, -1);
          exchange.close();
        });
    server.start();
    var db = mock(DataSource.class);
    var connection = mock(Connection.class);
    var statement = mock(Statement.class);
    var rows = mock(ResultSet.class);
    when(db.getConnection()).thenReturn(connection);
    when(connection.createStatement()).thenReturn(statement);
    when(statement.executeQuery("SELECT 1")).thenReturn(rows);
    when(rows.next()).thenReturn(true);
    var workers = mock(WorkerClient.class);
    String base = "http://127.0.0.1:" + server.getAddress().getPort();
    when(workers.uri(anyInt(), anyString()))
        .thenAnswer(c -> URI.create(base + c.getArgument(1, String.class)));
    when(workers.token(anyInt())).thenReturn("fixture-token");
    var health = new ReadinessController(db, workers, base);
    try {
      var request = new MockHttpServletRequest();
      request.setRemoteAddr("203.0.113.10");
      assertThrows(ApiException.class, () -> health.ready(request));
      request.setRemoteAddr("127.0.0.1");
      long start = System.nanoTime();
      var result = health.ready(request);
      assertEquals("DEGRADED", result.get("status"));
      assertEquals(true, result.get("manualBrowserAvailable"));
      assertTrue(System.nanoTime() - start < 3_000_000_000L);
      when(db.getConnection()).thenThrow(new SQLException("offline"));
      assertEquals(false, health.ready(request).get("manualBrowserAvailable"));
    } finally {
      health.close();
      server.stop(0);
    }
  }
}
