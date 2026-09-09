package io.browserskills.api;

import jakarta.servlet.http.*;
import java.time.*;
import java.util.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.http.*;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.*;

@RestController
@ConditionalOnWebApplication
public class ApiController {
  private final Store store;
  private final Orchestrator runs;
  private final Materials materials;
  private final Clock clock;

  public ApiController(Store store, Orchestrator runs, Materials materials, Clock clock) {
    this.store = store;
    this.runs = runs;
    this.materials = materials;
    this.clock = clock;
  }

  private UUID workspace() {
    return store.localWorkspace().id();
  }

  @GetMapping("/health/live")
  Map<String, String> live() {
    return Map.of("status", "UP");
  }

  @GetMapping("/api/csrf")
  Map<String, String> csrf(CsrfToken token) {
    return Map.of("token", token.getToken(), "headerName", token.getHeaderName());
  }

  @GetMapping("/api/me")
  Contracts.Me me() {
    var u = store.user(workspace());
    return new Contracts.Me(u.id(), u.login(), store.quota(u.id()));
  }

  @GetMapping("/api/browser")
  Contracts.BrowserStatus browser() {
    return runs.browser(workspace(), false);
  }

  @PostMapping("/api/browser")
  Contracts.BrowserStatus open() {
    return runs.browser(workspace(), true);
  }

  @GetMapping("/api/browser/manual-control")
  ManualLeases.Status controlStatus(
      HttpServletRequest request, @RequestHeader("X-Browser-Control") UUID controlId) {
    return runs.manualStatus(
        workspace(), ManualLeases.controller(request.getSession(true).getId(), controlId));
  }

  @PostMapping("/api/browser/manual-control")
  Contracts.BrowserStatus control(
      HttpServletRequest request,
      @RequestHeader("X-Browser-Control") UUID controlId,
      @RequestParam(defaultValue = "false") boolean takeOver) {
    var session = request.getSession(true);
    return runs.manual(
        workspace(),
        ManualLeases.controller(session.getId(), controlId),
        clock.instant().plusSeconds(3600),
        true,
        takeOver);
  }

  @DeleteMapping("/api/browser/manual-control")
  Contracts.BrowserStatus release(
      HttpServletRequest request, @RequestHeader("X-Browser-Control") UUID controlId) {
    return runs.manual(
        workspace(),
        ManualLeases.controller(request.getSession(true).getId(), controlId),
        null,
        false,
        false);
  }

  @PostMapping("/api/runs")
  Contracts.RunView start(@RequestBody Contracts.StartRun request) {
    return runs.start(workspace(), request);
  }

  @GetMapping("/api/runs")
  List<Contracts.RunSummary> list() {
    return runs.list(workspace());
  }

  @GetMapping("/api/runs/{id}")
  Contracts.RunView get(@PathVariable UUID id) {
    return runs.view(workspace(), id);
  }

  @PostMapping("/api/runs/{id}/resume")
  Contracts.RunView resume(@PathVariable UUID id) {
    return runs.resume(workspace(), id);
  }

  @GetMapping("/api/yang/session")
  Contracts.YangSession yangSession() {
    return runs.session(workspace());
  }

  @GetMapping("/api/yang/catalogue")
  Contracts.Catalogue catalogue() {
    return runs.catalogue(workspace(), false);
  }

  @PostMapping("/api/yang/catalogue/refresh")
  Contracts.Catalogue refreshCatalogue() {
    return runs.catalogue(workspace(), true);
  }

  @GetMapping("/api/yang/selection")
  Contracts.SelectionSettings selection() {
    return store.selection(workspace());
  }

  @PutMapping("/api/yang/selection")
  Contracts.SelectionSettings selection(@RequestBody Contracts.SelectionSettings settings) {
    return store.selection(workspace(), settings);
  }

  @PostMapping("/api/runs/{id}/stop")
  Contracts.RunView stop(@PathVariable UUID id) {
    return runs.stop(workspace(), id);
  }

  @GetMapping("/api/runs/{id}/media/{assetId}")
  ResponseEntity<byte[]> media(
      @PathVariable UUID id,
      @PathVariable String assetId,
      @RequestHeader(value = "Range", required = false) String range) {
    store.owned(workspace(), id);
    var material = materials.asset(id, assetId);
    return MediaRanges.response(material.bytes(), material.asset().mimeType(), range);
  }
}
