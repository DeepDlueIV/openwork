import { expect } from "vitest";
import { spec, type User } from "@openwork/testkit";
import { auditOperationEvents, auditOperations, auditPage, onlyAuditOperationWith, readLibraryUsageStatus } from "@openwork/behaviors";
import { auditEventTypesResponseSchema, auditUsageResponseSchema } from "@openwork/types/den/audit";
import { auditLogs } from "../worlds/audit-logs.ts";

// Who did what is in audit-logs-actors; this journey is reading and filtering.
const test = spec.world(auditLogs, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

test("an owner reads, filters and pauses audit history, and a teammate cannot read it", { timeout: 1_200_000 }, async ({ world, user, probe, step }) => {
  const owner = user.on(world.web);
  const audit = probe.on(world.web);
  const teammate = user.on(world.memberWeb);
  const ui = auditPage(owner, audit);
  const providerQuery = `&action=provider.credential.updated&resourceId=${encodeURIComponent(world.providerId)}`;
  const groupedRow = { role: "button", label: "View changes for Provider configuration update committed" } satisfies Parameters<User["see"]>[0];
  const idSearches: Array<{ label: string; value: string }> = [];
  let operationId = "";
  let originalEventIds: string[] = [];
  const usage = async () => auditUsageResponseSchema.parse((await probe.api(world.den.admin, "/v1/audit/usage")).body);
  const filterProviderHistory = () => ui.filter("Provider credential updated");
  const seeGroupedOperation = async () => {
    await ui.settled();
    await owner.see(groupedRow, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "audit-empty" });
    expect(await ui.rowCount(operationId)).toBe(1);
  };
  const seeNoMatch = async () => {
    await owner.see({ testId: "audit-empty" }, { text: /No operations match these filters/ });
    await owner.notSee(groupedRow);
  };

  await step("before: the owner is recording by default, the system's setup is the first entry, and no provider changes exist yet", async () => {
    await owner.see({ role: "heading", label: "Audit logs" }, { timeoutMs: 90_000 });
    expect((await audit.dom('[data-testid="audit-compact-list"]')).elements).toHaveLength(1);
    await filterProviderHistory();
    await seeNoMatch();
    expect((await auditOperations(world.den.admin, providerQuery)).operations).toHaveLength(0);
    // Usage totals come from the scheduled refresh, not from each write.
    await world.refreshAuditUsage();
    const current = await usage();
    expect(current).toMatchObject({ entitlement: { enabled: true, source: "self_hosted" }, captureAvailable: true, captureOn: true, captureEnabled: true });
    expect(current.policy).toMatchObject({ revision: 1, enabled: true, source: "operator", allowance: 6_000_000, excessMode: "keep_all" });
    expect(current.retainedOperations).toBeGreaterThan(0);
    await owner.click({ text: "Capture and storage" });
    await owner.see({ text: "Recording" });
    await owner.see({ text: "Totals last refreshed" });
    expect((await audit.dom('[role="switch"][aria-label="Capture audit logs"][aria-checked="true"]')).elements).toHaveLength(1);
    const { events } = await onlyAuditOperationWith(world.den.admin, "audit.policy.initialized");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { type: "system", id: "den-api.audit-defaults" }, changes: { before: null } });
    expect((await auditOperations(world.den.admin, "&action=audit.operations.served")).operations.length, "the owner's own reads are recorded").toBeGreaterThan(0);
    await owner.screenshot();
    await owner.click({ text: "Capture and storage" });
  });

  await step("the Event type filter offers every event type Den records, before any of them happened", async () => {
    const catalog = auditEventTypesResponseSchema.parse((await probe.api(world.den.admin, "/v1/audit/event-types")).body);
    for (const action of ["provider.credential.updated", "provider.created", "audit.policy.enabled"]) expect(catalog.eventTypes).toContain(action);
    await ui.openEventTypes();
    const options = await audit.eventually(() => audit.dom('[role="listbox"] [role="option"]'), {
      within: 30_000, label: "the full event catalog", until: (value) => value.elements.length === catalog.eventTypes.length + 1,
    });
    const labels = options.elements.map((option) => option.text);
    for (const label of ["All event types", "Provider credential updated", "Provider created"]) expect(labels).toContain(label);
    await owner.screenshot();
    await owner.press("Escape");
  });

  await step("the owner replaces the shared key and removes organization-wide access in one save", async () => {
    await owner.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/providers/${encodeURIComponent(world.providerId)}`);
    await owner.see({ testId: "gateway-provider-title" }, { text: "Team models", timeoutMs: 60_000 });
    await owner.click({ testId: "gateway-provider-replace-key" });
    await owner.type({ testId: "gateway-provider-api-key" }, world.replacementCredential, { sensitive: true, verify: true });
    await owner.click({ role: "switch", label: "Everyone in the organization" });
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ testId: "gateway-provider-audience" }, { text: "No one yet", timeoutMs: 60_000 });
    await owner.screenshot();
  });

  await step("after: the several requests of that save appear as one audit operation", async () => {
    await owner.click({ role: "link", label: "Audit logs" });
    await owner.see({ role: "heading", label: "Audit logs" }, { timeoutMs: 30_000 });
    await filterProviderHistory();
    const history = await auditOperations(world.den.admin, providerQuery);
    expect(history.operations).toHaveLength(1);
    const operation = history.operations[0];
    if (!operation) throw new Error("No grouped provider operation returned");
    operationId = operation.id;
    expect(operation.action).toBe("provider.configuration.update.committed");
    const { events } = await auditOperationEvents(world.den.admin, operationId);
    originalEventIds = events.map((event) => event.id);
    expect(new Set(events.map((event) => event.requestId).filter(Boolean)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(events.map((event) => event.operationId))).toEqual(new Set([operationId]));
    const actions = events.map((event) => event.action);
    expect(actions).toContain("provider.credential.updated");
    expect(actions).toContain("provider.access_grant.deleted");
    expect(actions).not.toContain("provider.created");
    const credentialEvent = events.find((event) => event.action === "provider.credential.updated");
    const resource = credentialEvent?.resources.find((entry) => entry.relationship === "target");
    if (!credentialEvent?.requestId || !resource?.id) throw new Error("The credential change must expose its event, request and target resource IDs");
    idSearches.push({ label: "operation", value: operationId }, { label: "event", value: credentialEvent.id }, { label: "request", value: credentialEvent.requestId }, { label: "resource", value: resource.id });
    expect(new Set(idSearches.map((entry) => entry.value)).size).toBe(4);
    await seeGroupedOperation();
    await owner.screenshot();
  });

  await step("after: a child event type finds its whole grouped operation, and an absent one finds nothing", async () => {
    await ui.filter("Provider created");
    await seeNoMatch();
    await filterProviderHistory();
    await owner.see({ role: "button", label: "Event type" }, { text: "Provider credential updated" });
    await seeGroupedOperation();
    await owner.screenshot();
  });

  await step("after: the owner finds the operation by its exact operation, event, request or resource ID, never by a prefix", async () => {
    for (const { label, value } of idSearches) {
      await owner.type({ label: "Search IDs" }, value.slice(0, -1), { replace: true, verify: true });
      await ui.apply();
      await seeNoMatch();
      expect((await auditOperations(world.den.admin, `${providerQuery}&searchId=${encodeURIComponent(value.slice(0, -1))}`)).operations, `${label} prefix`).toHaveLength(0);
      await owner.type({ label: "Search IDs" }, value, { replace: true, verify: true });
      await ui.apply();
      await seeGroupedOperation();
      const found = await auditOperations(world.den.admin, `${providerQuery}&searchId=${encodeURIComponent(value)}`);
      expect(found.operations.map((entry) => entry.id), `${label} ID`).toEqual([operationId]);
      await owner.screenshot();
    }
    await ui.clear();
    await filterProviderHistory();
  });

  await step("a local date range before the save excludes the operation, and Clear filters brings it back", async () => {
    await seeGroupedOperation();
    await ui.enterPastDate("From (local time)", "1");
    await ui.enterPastDate("To (local time)", "2");
    await ui.apply();
    await seeNoMatch();
    expect((await audit.dom('[aria-controls^="audit-operation-"]')).elements).toHaveLength(0);
    await owner.screenshot();
    await ui.clear();
    await owner.see({ label: "From (local time)" }, { value: "" });
    await owner.see({ label: "To (local time)" }, { value: "" });
    await filterProviderHistory();
    await seeGroupedOperation();
  });

  await step("the owner expands the operation to read what changed without any secret value", async () => {
    await owner.click(groupedRow);
    for (const text of ["Provider credential updated", "Before", "After", "Provider access grant deleted", "Changed; values not retained"]) await owner.see({ text }, { timeoutMs: 30_000 });
    await owner.notSee({ text: world.originalCredential });
    await owner.notSee({ text: world.replacementCredential });
    const { events, text } = await auditOperationEvents(world.den.admin, operationId);
    expect(text).not.toContain(world.originalCredential);
    expect(text).not.toContain(world.replacementCredential);
    expect(events.filter((event) => event.changes?.changedFields.length).length).toBeGreaterThanOrEqual(2);
    const provider = await probe.api(world.den.admin, `/v1/inference-providers/${encodeURIComponent(world.providerId)}`);
    expect(provider.text).not.toContain(world.replacementCredential);
    await owner.screenshot();
    await owner.click({ role: "button", label: "Hide changes for Provider configuration update committed" });
  });

  await step("the owner pauses capture without losing entitlement or history, then resumes it", async () => {
    await owner.click({ text: "Capture and storage" });
    await owner.click({ role: "switch", label: "Capture audit logs" });
    await owner.see({ text: "New activity is not recorded. Retained history remains available." });
    const off = await usage();
    expect(off).toMatchObject({ entitlement: { enabled: true, source: "self_hosted" }, captureAvailable: true, captureOn: false, captureEnabled: false });
    expect((await auditOperationEvents(world.den.admin, operationId)).events.map((event) => event.id)).toEqual(originalEventIds);
    await owner.click({ role: "button", label: "Refresh history" });
    await seeGroupedOperation();
    await owner.screenshot();
    await owner.click({ role: "switch", label: "Capture audit logs" });
    await owner.see({ text: "Recording" });
    const on = await usage();
    expect(on).toMatchObject({ captureOn: true, captureEnabled: true });
    expect(on.policy?.revision).toBe((off.policy?.revision ?? 0) + 1);
    expect(on.policy).toMatchObject({ allowance: 6_000_000, source: "operator", excessMode: "keep_all" });
    await owner.reload();
    await filterProviderHistory();
    await seeGroupedOperation();
    await owner.screenshot();
  });

  await step("a teammate sees a locked page, and every audit and usage read is refused", async () => {
    await teammate.reload();
    await teammate.see({ role: "heading", label: "Audit logs" }, { timeoutMs: 90_000 });
    await teammate.see({ testId: "audit-locked" });
    for (const hidden of [{ role: "button", label: "Refresh history" }, { text: "Provider credential updated" }, { label: "Search IDs" }, { role: "switch", label: "Capture audit logs" }] as const) await teammate.notSee(hidden);
    const statuses = [
      (await auditOperations(world.teammate)).status,
      (await auditOperationEvents(world.teammate, operationId)).status,
      (await probe.api(world.teammate, "/v1/audit/event-types")).response.status,
    ];
    for (const { value } of idSearches) {
      const filtered = await auditOperations(world.teammate, `&searchId=${encodeURIComponent(value)}`);
      statuses.push(filtered.status);
      expect(filtered.text).not.toContain(operationId);
    }
    expect(statuses).toEqual(Array.from({ length: 7 }, () => 403));
    // Plugins & connectors usage is the same owner-only history.
    for (const kind of ["plugins", "skills", "connectors"] as const) expect(await readLibraryUsageStatus(world.teammate, kind), `${kind} usage`).toBe(403);
    await teammate.screenshot();
  });
});
