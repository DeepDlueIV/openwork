import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { engineV1HistoryUpgrade, engineV1HistoryWithChatsThatFail } from "../worlds/engine-v1-history.ts";

// OPENWORK_EVAL_V1_HISTORY_LIMIT=all (local only) migrates a whole real history, which can take hours.
const whole = Boolean(process.env.OPENWORK_EVAL_V1_HISTORY_SOURCE?.trim()) && process.env.OPENWORK_EVAL_V1_HISTORY_LIMIT?.trim() === "all";
const MIGRATION_WITHIN_MS = whole ? 6 * 3_600_000 : 300_000;

const test = spec.world(engineV1HistoryUpgrade, {
  timeout: whole ? 7 * 3_600_000 : 900_000,
  resources: {
    surfaces: ["desktop"], services: ["den"],
    nativeReason: "The upgrade copies chats from the v1 database file the desktop's engine owns into its v2 sidecar, and only the desktop offers it.",
  },
});
const testWithChatsThatFail = spec.world(engineV1HistoryWithChatsThatFail, {
  timeout: 900_000,
  resources: {
    surfaces: ["desktop"], services: ["den"],
    nativeReason: "The upgrade copies chats from the v1 database file the desktop's engine owns into its v2 sidecar, and only the desktop offers it.",
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intersects(a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function migrationOf(status: Record<string, unknown>) {
  const migration = isRecord(status.migration) ? status.migration : {};
  return {
    state: migration.state,
    imported: typeof migration.imported === "number" ? migration.imported : -1,
    skipped: typeof migration.skipped === "number" ? migration.skipped : -1,
    total: typeof migration.total === "number" ? migration.total : -1,
    backupPath: typeof migration.backupPath === "string" ? migration.backupPath : null,
    notCopied: (Array.isArray(migration.notCopied) ? migration.notCopied : []).filter(isRecord)
      .map(chat => ({ id: String(chat.id), reason: String(chat.reason) })),
  };
}

test("a member chooses a chat upgrade: chats are copied with a backup and OpenWork switches to v2", async ({ world, user, probe, step, evidence }) => {
  const workspaceId = world.workspace.workspaceId;
  const status = async () => {
    const response = await probe.desktopApi("/experimental/engine-v2-preview/status");
    expect(response.status).toBe(200);
    if (!isRecord(response.body)) throw new Error("Engine status missing");
    return response.body;
  };
  const v2SessionIds = async () => {
    const response = await probe.desktopApi(`/workspace/${workspaceId}/opencode2/api/session`);
    expect(response.status).toBe(200);
    const items = isRecord(response.body) ? response.body.data : response.body;
    return (Array.isArray(items) ? items : []).filter(isRecord).map(item => String(item.id)).sort();
  };
  const fixtureIds = world.chats.map(chat => chat.id).sort();
  const draft = "Keep this unsent budget draft while my chats are copied.";
  const viewports = [{ width: 1280, height: 800 }, { width: 800, height: 600 }];
  const floatingLayout = async (testId: "engine-upgrade-notice" | "engine-migration-banner", viewport: { width: number; height: number }) => {
    await user.resizeViewport({ ...viewport, deviceScaleFactor: 1 });
    await user.see({ testId });
    const title = (await probe.dom("[data-session-header-title]")).elements[0];
    expect(title).toBeDefined();
    if (!title) throw new Error("The conversation header is missing");
    expect(title.rect.width).toBeGreaterThan(0);
    expect(title.rect.height).toBeGreaterThan(0);
    await user.hover({ role: "heading", text: title.text });
    await user.hover({ role: "button", label: viewport.width < 1024 ? "More actions" : /^(Open|Close) side panel$/ });
    const labels = testId === "engine-upgrade-notice" ? ["Later", "Upgrade"] : ["Show progress"];
    for (const label of labels) await user.hover({ role: "button", text: label });
    const selector = `[data-testid="${testId}"]`;
    const [floating, controls, chrome] = await Promise.all([
      probe.dom(selector), probe.dom(`${selector} button`),
      probe.dom("[data-session-header], [data-session-header] button, [data-session-header-title], [data-sidebar-titlebar], [data-sidebar-titlebar] button"),
    ]);
    expect(floating.viewportWidth).toBe(viewport.width);
    expect(floating.documentWidth).toBeLessThanOrEqual(viewport.width);
    expect(floating.elements).toHaveLength(1);
    expect(controls.elements.map(control => control.text)).toEqual(labels);
    const bounds = floating.elements[0]!.rect;
    for (const element of [...floating.elements, ...controls.elements]) {
      expect(element.rect.width).toBeGreaterThan(0);
      expect(element.rect.height).toBeGreaterThan(0);
      expect(element.rect.left).toBeGreaterThanOrEqual(0);
      expect(element.rect.right).toBeLessThanOrEqual(viewport.width);
      expect(element.rect.top).toBeGreaterThanOrEqual(0);
      expect(element.rect.bottom).toBeLessThanOrEqual(viewport.height);
    }
    for (const control of controls.elements) {
      expect(control.rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(control.rect.right).toBeLessThanOrEqual(bounds.right);
      expect(control.rect.top).toBeGreaterThanOrEqual(bounds.top);
      expect(control.rect.bottom).toBeLessThanOrEqual(bounds.bottom);
    }
    const visibleChrome = chrome.elements.filter(element => element.rect.width > 0 && element.rect.height > 0);
    expect(visibleChrome.length).toBeGreaterThan(0);
    const overlaps = visibleChrome.filter(element => intersects(bounds, element.rect));
    evidence.recordJsonArtifact(`${testId} header clearance at ${viewport.width}×${viewport.height}`, {
      viewport, floating: bounds, controls: controls.elements, chrome: visibleChrome, overlaps,
    });
    expect(overlaps).toEqual([]);
    expect(bounds.top).toBeGreaterThanOrEqual(Math.max(...visibleChrome.map(element => element.rect.bottom)));
    return `${viewport.width}×${viewport.height}; floating y=${Math.round(bounds.top)}..${Math.round(bounds.bottom)}; header bottom=${Math.round(Math.max(...visibleChrome.map(element => element.rect.bottom)))}; zero intersections; title, header action and ${labels.join(" / ")} accepted real pointer hit tests`;
  };

  await step("before: the member's existing chats have an optional upgrade, not a warning", async () => {
    await user.resizeViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const before = await probe.eventually(status, {
      within: 60_000, label: "v1 engine with v1 history",
      until: value => value.chatRouting !== true && value.v1HistoryAvailable === true,
    });
    await user.see({ testId: "engine-upgrade-notice" }, { timeoutMs: 60_000 });
    await user.see({ text: "A chat upgrade is available in OpenWork." });
    await user.see({ role: "button", text: /^Later$/ });
    await user.notSee({ text: /OpenWork needs to upgrade its chat engine/ });
    if (world.fixture) await user.see({ text: world.chats[0]!.title }, { timeoutMs: 60_000 });
    const layout = await floatingLayout("engine-upgrade-notice", viewports[0]!);
    const mark = await probe.dom('[data-testid="engine-upgrade-notice"] img[src$="/openwork-mark.svg"]');
    const warnings = await probe.dom('[data-testid="engine-upgrade-notice"] .lucide-triangle-alert, [data-testid="engine-upgrade-notice"] [class*="amber"]');
    expect(mark.elements).toHaveLength(1);
    expect(warnings.elements).toHaveLength(0);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "the upgrade is offered without a warning or a mandatory instruction",
      `neutral OpenWork mark ${mark.elements.length}, warning marks ${warnings.elements.length}; engine v1 (chatRouting ${String(before.chatRouting)}), ${world.before.sessions} v1 chats unchanged; ${layout}`,
      mark.elements.length === 1 && warnings.elements.length === 0 && before.chatRouting !== true && world.before.sessions === world.expectedChats,
    );
  });

  await step("before: the small-window upgrade notice leaves the conversation header usable", async () => {
    const layout = await floatingLayout("engine-upgrade-notice", viewports[1]!);
    evidence.recordAssertionEvidence("the notice clears the real header without hiding it", layout, true);
    await user.screenshot();
  });

  await step("before: the member can still read an existing chat and keep an unsent draft", async () => {
    // The previous step leaves the small window, where the sidebar collapses; return to the normal desktop size.
    await user.resizeViewport({ ...viewports[0]!, deviceScaleFactor: 1 });
    if (world.fixture) {
      const first = world.chats[0]!;
      await user.click({ testId: `sidebar-session-${first.id}` });
      await user.see({ text: first.reply }, { timeoutMs: 60_000 });
    }
    await user.see("composer", { editable: true, text: "" });
    await user.type("composer", draft);
    await user.see("composer", { editable: true, text: draft });
    evidence.recordAssertionEvidence("the chat and its unsent draft remain available before upgrade consent", `v1 remains selected; the real composer holds "${draft}" without sending`, (await probe.composer()).draftText === draft);
    await user.screenshot();
  });

  await step("the upgrade says what changes before anything is copied", async () => {
    await user.click({ role: "button", text: /^Upgrade$/ });
    await user.see({ text: "Upgrade chats?" });
    await user.see({ text: /backing up its existing chats first, then switches OpenWork to v2/ });
    await user.see({ text: /Your v1 chats stay as they are/ });
    await user.click({ text: "What changes in migrated chats" });
    await user.see({ text: /Chat permissions and undo history reset/ });
    await user.screenshot();
    const migration = migrationOf(await status());
    evidence.recordAssertionEvidence("nothing is copied until the member confirms", `migration ${String(migration.state)}; consent names the local copy, existing v2 backup and unchanged v1 chats`, migration.state === "idle");
    expect(migration.state).toBe("idle");
  });

  await step("the member can cancel without copying chats or switching OpenWork", async () => {
    await user.click({ role: "button", text: /^Cancel$/ });
    await user.notSee({ testId: "engine-migration-consent" });
    await user.see({ testId: "engine-upgrade-notice" });
    const cancelled = await status();
    const migration = migrationOf(cancelled);
    const history = world.readV1History();
    expect(migration.state).toBe("idle");
    expect(cancelled.chatRouting).not.toBe(true);
    expect(history).toEqual(world.before);
    evidence.recordAssertionEvidence(
      "declining consent leaves the member's chats and current version unchanged",
      `migration ${String(migration.state)}, chatRouting ${String(cancelled.chatRouting)}, v1 sha256 ${history.sha256.slice(0, 12)} unchanged`,
      migration.state === "idle" && cancelled.chatRouting !== true && history.sha256 === world.before.sha256,
    );
    await user.screenshot();
    await user.click({ role: "button", text: /^Upgrade$/ });
    await user.see({ testId: "engine-migration-consent" });
  });

  const beforeCopy = await probe.composer();
  const panesBefore = (await probe.dom('[data-slot="resizable-panel"]')).elements.length;
  expect(beforeCopy.draftText).toBe(draft);
  expect(panesBefore).toBeGreaterThan(0);
  let retainedDraft = draft;

  // Every phase change with its time and counts: the recorded process.
  const timeline: { at: string; elapsedS: number; state: unknown; phase: unknown; imported: number; skipped: number; total: number; chatRouting: unknown }[] = [];
  const startedAt = Date.now();
  const track = (value: Record<string, unknown>) => {
    const migration = migrationOf(value);
    const phase = isRecord(value.migration) ? value.migration.phase : undefined;
    const last = timeline.at(-1);
    const copiedStep = Math.max(1, Math.floor(migration.total / 20));
    if (!last || last.state !== migration.state || last.phase !== phase || last.chatRouting !== value.chatRouting
      || Math.floor((migration.imported + migration.skipped) / copiedStep) !== Math.floor((last.imported + last.skipped) / copiedStep)) {
      timeline.push({
        at: new Date().toISOString(), elapsedS: Math.round((Date.now() - startedAt) / 1000),
        state: migration.state, phase, imported: migration.imported, skipped: migration.skipped, total: migration.total,
        chatRouting: value.chatRouting,
      });
    }
    return value;
  };

  await step("while it runs: a real held copy leaves the member's draft editable without a modal", async () => {
    await user.click({ role: "button", text: /^Upgrade$/ });
    await probe.eventually(async () => track(await status()), {
      within: 120_000, intervalMs: 1_000, label: "migration started",
      until: value => migrationOf(value).state !== "idle",
    });
    const witness = await probe.eventually(world.readHeldCopy, {
      within: MIGRATION_WITHIN_MS, intervalMs: 100, label: "the first real history import is held",
      until: value => value.held && value.arrived === 1,
    });
    const copying = track(await status());
    expect(migrationOf(copying).state).toBe("running");
    expect(isRecord(copying.migration) && copying.migration.phase).toBe("copying");
    expect(migrationOf(copying).backupPath).not.toBeNull();
    expect(copying.chatRouting).not.toBe(true);
    expect(witness.expired).toBe(false);
    await user.see({ testId: "engine-migration-banner" }, { timeoutMs: 10_000 });
    await user.notSee({ testId: "engine-migration-progress" }, { timeoutMs: 500 });
    await user.notSee({ testId: "engine-switch-prompt" }, { timeoutMs: 500 });
    await user.see("composer", { editable: true, text: retainedDraft });
    await user.click("composer");
    await user.press("End");
    const addition = " Add the travel total.";
    await user.type("composer", addition);
    retainedDraft += addition;
    await user.see("composer", { editable: true, text: retainedDraft });
    const composer = await probe.composer();
    expect(composer.route).toBe(beforeCopy.route);
    expect(composer.userMessageCount).toBe(beforeCopy.userMessageCount);
    expect((await probe.dom('[data-slot="resizable-panel"]')).elements).toHaveLength(panesBefore);
    expect(world.readHeldCopy()).toMatchObject({ held: true, arrived: 1, released: 0, expired: false });
    evidence.recordAssertionEvidence(
      "the person can edit the same unsent draft while copying is genuinely unfinished",
      `real import held ${witness.arrived}; running/copying with a v2 backup and v1 routing; composer editable with ${composer.draftText.length} draft characters; same route, ${composer.userMessageCount} sent messages and ${panesBefore} panes; no progress dialog or switch prompt`,
      composer.composerEditable && composer.draftText === retainedDraft,
    );
    await user.screenshot();
  });

  await step("while it runs: chats are copied by a separate process, so running out of memory cannot quit OpenWork", async () => {
    const copy = world.readHeldCopy();
    expect(copy).toMatchObject({ held: true, heldBy: { process: "migration" } });
    expect(copy.mainPid).toBeGreaterThan(0);
    expect(copy.heldBy?.pid).not.toBe(copy.mainPid);
    evidence.recordAssertionEvidence(
      "the held import was sent by the migration process, not the desktop's main process",
      `held import from the ${copy.heldBy?.process ?? "unknown"} process; desktop main and migration are different processes: ${String(copy.heldBy?.pid !== copy.mainPid)}`,
      copy.heldBy?.process === "migration" && copy.heldBy.pid !== copy.mainPid,
    );
  });

  for (const viewport of viewports) {
    await step(`while it runs: progress clears the usable conversation header at ${viewport.width}×${viewport.height}`, async () => {
      const layout = await floatingLayout("engine-migration-banner", viewport);
      await user.notSee({ testId: "engine-migration-progress" }, { timeoutMs: 500 });
      await user.see("composer", { editable: true, text: retainedDraft });
      expect(world.readHeldCopy()).toMatchObject({ held: true, arrived: 1, released: 0, expired: false });
      const copying = track(await status());
      expect(migrationOf(copying).state).toBe("running");
      expect(copying.chatRouting).not.toBe(true);
      expect((await probe.composer()).route).toBe(beforeCopy.route);
      expect((await probe.dom('[data-slot="resizable-panel"]')).elements).toHaveLength(panesBefore);
      evidence.recordAssertionEvidence("background progress overlaps no header or control while the draft is retained", `${layout}; actual import still held; ${retainedDraft.length} draft characters remain editable; no extra pane`, true);
      await user.screenshot();
    });
  }
  // The small window collapses the sidebar; later steps open chats from it at the normal desktop size.
  await user.resizeViewport({ ...viewports[0]!, deviceScaleFactor: 1 });

  if (world.fixture) {
    await step("a failed background copy brings back a recovery decision without changing the original chats", async () => {
      world.releaseHeldCopy("fail");
      await user.see({ testId: "engine-migration-progress" }, { timeoutMs: 10_000 });
      await user.see({ text: "Migration didn't finish" });
      await user.see({ role: "button", text: /^Try again$/ });
      await user.see({ text: /Chats already copied are kept, and trying again skips them/ });
      await user.notSee({ testId: "engine-migration-banner" });
      const failed = track(await status());
      expect(migrationOf(failed).state).toBe("error");
      expect(failed.chatRouting).not.toBe(true);
      expect(world.readV1History()).toEqual(world.before);
      expect((await probe.composer()).draftText).toBe(retainedDraft);
      evidence.recordAssertionEvidence("an interrupted copy returns to Try again rather than silently switching or losing data", `real held import interrupted; migration error; v1 still selected and unchanged; ${retainedDraft.length} draft characters retained; recovery dialog visible`, true);
      await user.screenshot();
    });

    await step("the member retries in the existing dialog and chooses to continue working", async () => {
      await user.click({ role: "button", text: /^Try again$/ });
      await probe.eventually(world.readHeldCopy, {
        within: MIGRATION_WITHIN_MS, intervalMs: 100, label: "the real retry import is held",
        until: value => value.held && value.arrived === 2,
      });
      const retrying = track(await status());
      expect(migrationOf(retrying).state).toBe("running");
      await user.see({ testId: "engine-migration-progress" });
      await user.notSee({ testId: "engine-migration-banner" });
      await user.click({ role: "button", text: "Continue using OpenWork" });
      await user.see({ testId: "engine-migration-banner" });
      await user.notSee({ testId: "engine-migration-progress" }, { timeoutMs: 500 });
      await user.see("composer", { editable: true, text: retainedDraft });
      expect(world.readHeldCopy()).toMatchObject({ held: true, arrived: 2, released: 1, failed: 1, expired: false });
      evidence.recordAssertionEvidence("retry and the existing background control preserve the person's draft", `second real import held; ${retainedDraft.length} draft characters editable after Continue using OpenWork; retry remained a dialog until the person's choice`, true);
      await user.screenshot();
      world.releaseHeldCopy("continue");
    });
  } else {
    world.releaseHeldCopy("continue");
  }

  await step("after: the chats are copied with a backup and OpenWork switches to v2 by itself", async () => {
    // The toast is short-lived: watch for it while the status is polled.
    const toast = user.see({ text: "Upgraded to OpenCode v2" }, { timeoutMs: MIGRATION_WITHIN_MS }).then(() => true, () => false);
    // Poll by hand so a long run is recorded: a screenshot at every phase change, and every 5 minutes.
    const deadline = Date.now() + MIGRATION_WITHIN_MS;
    let lastShotAt = Date.now();
    let seenEntries = timeline.length;
    let after: Record<string, unknown>;
    while (true) {
      after = track(await status());
      const state = migrationOf(after).state;
      if (state === "error" || (state === "completed" && after.chatRouting === true && after.running === true)) break;
      const phaseChanged = timeline.length > seenEntries && timeline.at(-1)?.phase !== timeline[seenEntries - 1]?.phase;
      seenEntries = timeline.length;
      if (whole && (phaseChanged || Date.now() - lastShotAt > 5 * 60_000)) {
        await user.screenshot();
        lastShotAt = Date.now();
      }
      if (Date.now() > deadline) throw new Error(`Migration did not finish within ${MIGRATION_WITHIN_MS / 60_000} minutes; last ${JSON.stringify(timeline.at(-1))}`);
      await new Promise(resolve => setTimeout(resolve, whole ? 5_000 : 1_000));
    }
    const migration = migrationOf(after);
    evidence.recordJsonArtifact("Migration timeline", { chats: world.expectedChats, whole: world.whole, timeline });
    const phaseStart = (phase: string) => timeline.find(entry => entry.phase === phase)?.elapsedS;
    evidence.recordAssertionEvidence(
      "how long each phase took",
      `snapshot+count ${phaseStart("converting") ?? "?"}s, conversion until ${phaseStart("copying") ?? "?"}s, done at ${timeline.at(-1)?.elapsedS ?? "?"}s; ${migration.state}${isRecord(after.migration) && typeof after.migration.error === "string" ? `: ${after.migration.error}` : ""}`,
      migration.state === "completed",
    );
    expect(migration.state).toBe("completed");
    expect(await toast).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "every v1 chat is copied once, after a backup of v2",
      `imported ${migration.imported} of ${migration.total}, skipped ${migration.skipped}; backup ${migration.backupPath ? migration.backupPath.split("/").slice(-2).join("/") : "missing"}`,
      migration.imported === world.expectedChats && migration.skipped === 0 && migration.backupPath !== null,
    );
    expect(migration).toMatchObject({ imported: world.expectedChats, skipped: 0, total: world.expectedChats });
    expect(migration.backupPath).toMatch(/opencode-v2\/backups\/opencode-v2-.+\.db$/);
  });

  await step("after: the migrated chats open on OpenCode v2 and the notice is gone", async () => {
    await user.notSee({ testId: "engine-upgrade-notice" });
    if (world.fixture) {
      const ids = await probe.eventually(v2SessionIds, {
        within: 60_000, label: "fixture chats listed by v2",
        until: value => fixtureIds.every(id => value.includes(id)),
      });
      const first = world.chats[0]!;
      await user.click({ testId: `sidebar-session-${first.id}` });
      await user.see({ text: first.reply }, { timeoutMs: 60_000 });
      await user.screenshot();
      evidence.recordAssertionEvidence(
        "the chats, sub-chat included, are on v2 with their messages",
        `v2 lists ${fixtureIds.filter(id => ids.includes(id)).length} of ${fixtureIds.length} chats; "${first.title}" shows its reply`,
        fixtureIds.every(id => ids.includes(id)),
      );
    } else {
      const ids = await v2SessionIds();
      await user.screenshot();
      evidence.recordAssertionEvidence("copied history is on v2", `${ids.length} chats in this workspace on v2 (others keep their own folders)`, true);
    }
  });

  await step("then every v1 chat with messages has its messages on v2, not just its title", async () => {
    await user.notSee({ testId: "engine-upgrade-notice" });
    const coverage = await world.readCoverage();
    evidence.recordAssertionEvidence(
      "no chat arrives empty",
      `${coverage.withMessages} v1 chats with messages; ${coverage.emptyInV2} of them have no messages on v2; ${coverage.v2Messages} v2 messages`,
      coverage.emptyInV2 === 0,
    );
    expect(coverage.emptyInV2).toBe(0);
  });

  await step("then the v1 history itself was not changed", async () => {
    const now = world.readV1History();
    evidence.recordAssertionEvidence(
      "v1 chats are only read",
      `${now.sessions} chats, ${now.messages} messages, ${now.parts} parts; sha256 ${now.sha256.slice(0, 12)} before and ${world.before.sha256.slice(0, 12)} after`,
      now.sha256 === world.before.sha256,
    );
    expect(now).toEqual(world.before);
  });

  const idsBeforeManual = world.fixture ? await v2SessionIds() : [];
  if (!world.whole) {
    await step("the member can return to the original version and still read the same chats", async () => {
      await user.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
      await user.type({ role: "combobox" }, "Switch to OpenCode v1");
      await user.click({ text: "Switch to OpenCode v1" });
      const original = await probe.eventually(status, {
        within: 60_000, label: "the original version is selected again",
        until: value => value.chatRouting !== true,
      });
      if (world.fixture) {
        const first = world.chats[0]!;
        await user.click({ testId: `sidebar-session-${first.id}` });
        await user.see({ text: first.reply }, { timeoutMs: 60_000 });
      } else {
        await user.see("composer", { editable: true });
      }
      expect(world.readV1History()).toEqual(world.before);
      evidence.recordAssertionEvidence("returning to the original version keeps the untouched history readable", `chatRouting ${String(original.chatRouting)}; original history digest unchanged; ${world.fixture ? "the original chat still shows its reply" : "the original composer remains editable"}`, original.chatRouting !== true);
      await user.screenshot();
    });
  }

  await step("after: a manual migration copies nothing twice and still leaves switching to the member", async () => {
    if (world.whole) {
      // A second full pass repeats hours of snapshot and conversion; the fixture and slice runs prove reruns skip.
      evidence.recordAssertionEvidence("a rerun skips chats already on v2", "not repeated for a whole history; covered by the fixture run", true);
      await world.stopFilm();
      return;
    }
    const idsBefore = idsBeforeManual;
    const seenBefore = world.readHeldCopy();
    // The command palette is one of the two homes of "Migrate chats" (Advanced settings is the other).
    await user.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await user.type({ role: "combobox" }, "Migrate chats");
    await user.click({ text: "Migrate chats to OpenCode v2" });
    await user.see({ testId: "engine-migration-consent" });
    expect((await probe.dom('[data-testid="engine-migration-consent"][data-mode="migrate"]')).elements).toHaveLength(1);
    await user.click({ role: "button", text: /^Migrate chats$/ });
    const again = await probe.eventually(status, {
      within: 300_000, label: "second migration completed",
      until: value => {
        const migration = migrationOf(value);
        return migration.state === "completed" && migration.skipped === world.expectedChats;
      },
    });
    const migration = migrationOf(again);
    await user.see({ text: `Migrated 0 chats; ${world.expectedChats} already in v2.` }, { timeoutMs: 30_000 });
    await user.see({ testId: "engine-migration-progress" });
    await user.see({ role: "button", text: "Switch to OpenCode v2" });
    await user.see({ role: "button", text: "Not now" });
    await user.notSee({ testId: "engine-migration-banner" });
    expect((await probe.dom('[data-testid="engine-migration-progress"][data-state-kind="completed"]')).elements).toHaveLength(1);
    expect(again.chatRouting).not.toBe(true);
    await user.screenshot();
    const idsAfter = world.fixture ? await v2SessionIds() : [];
    const seen = world.readHeldCopy();
    const exported = seen.exports - seenBefore.exports;
    const sent = seen.imports - seenBefore.imports;
    evidence.recordAssertionEvidence(
      "a rerun skips chats already on v2 without exporting or sending them again",
      `imported ${migration.imported}, skipped ${migration.skipped} of ${migration.total}; ${exported} chats exported and ${sent} sent for import; v2 chats ${idsBefore.length} → ${idsAfter.length}; manual completed dialog keeps Switch to OpenCode v2 / Not now and v1 routing`,
      migration.imported === 0 && migration.skipped === world.expectedChats && exported === 0 && sent === 0 && idsAfter.length === idsBefore.length,
    );
    expect(migration).toMatchObject({ imported: 0, skipped: world.expectedChats });
    expect({ exported, sent }).toEqual({ exported: 0, sent: 0 });
    expect(idsAfter).toEqual(idsBefore);
  });
});

testWithChatsThatFail("a chat that cannot be copied stays in v1 and the other chats are still copied", async ({ world, user, probe, step, evidence }) => {
  const workspaceId = world.workspace.workspaceId;
  const status = async () => {
    const response = await probe.desktopApi("/experimental/engine-v2-preview/status");
    expect(response.status).toBe(200);
    if (!isRecord(response.body)) throw new Error("Engine status missing");
    return response.body;
  };
  const v2SessionIds = async () => {
    const response = await probe.desktopApi(`/workspace/${workspaceId}/opencode2/api/session`);
    expect(response.status).toBe(200);
    const items = isRecord(response.body) ? response.body.data : response.body;
    return (Array.isArray(items) ? items : []).filter(isRecord).map(item => String(item.id)).sort();
  };
  const titleOf = (id: string) => world.chats.find(chat => chat.id === id)!.title;
  const tooLarge = { id: world.failing.tooLarge, title: titleOf(world.failing.tooLarge) };
  const crashing = { id: world.failing.crash, title: titleOf(world.failing.crash) };
  const copied = world.chats.map(chat => chat.id).filter(id => id !== tooLarge.id && id !== crashing.id).sort();

  await step("before: the member starts the upgrade with one chat too large to copy and one that stops the copy", async () => {
    await user.resizeViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await probe.eventually(status, {
      within: 60_000, label: "v1 engine with v1 history",
      until: value => value.chatRouting !== true && value.v1HistoryAvailable === true,
    });
    await user.see({ testId: "engine-upgrade-notice" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", text: /^Upgrade$/ });
    await user.see({ testId: "engine-migration-consent" });
    await user.click({ role: "button", text: /^Upgrade$/ });
    await probe.eventually(status, { within: 120_000, label: "migration started", until: value => migrationOf(value).state !== "idle" });
    await user.screenshot();
  });

  await step("a chat that stops the copy ends the run and is named; the chat too large to copy did not stop it", async () => {
    const stopped = await probe.eventually(status, {
      within: 300_000, intervalMs: 1_000, label: "the migration process stopped on a chat",
      until: value => migrationOf(value).state === "error",
    });
    await user.see({ testId: "engine-migration-progress" }, { timeoutMs: 10_000 });
    await user.see({ text: "Migration didn't finish" });
    await user.see({ text: `Chat migration stopped while copying "${crashing.title}"` });
    await user.see({ role: "button", text: /^Try again$/ });
    const migration = migrationOf(stopped);
    const copy = world.readHeldCopy();
    expect(copy.crashes).toHaveLength(1);
    expect(copy.crashes[0]).toMatchObject({ process: "migration" });
    expect(copy.crashes[0]!.pid).not.toBe(copy.mainPid);
    expect(copy.tooLargeExports).toBe(1);
    expect(migration).toMatchObject({ imported: copied.length, notCopied: [{ id: tooLarge.id, reason: "too_large" }] });
    expect(stopped.chatRouting).not.toBe(true);
    expect(world.readV1History()).toEqual(world.before);
    evidence.recordAssertionEvidence(
      "the copy goes past a chat that is too large and names the chat the migration process died on",
      `migration process (not the desktop) killed while exporting "${crashing.title}"; "${tooLarge.title}" streamed over the size limit and was left in v1 (${migration.notCopied.map(chat => chat.reason).join(", ")}); ${migration.imported} chats copied before the stop; v1 still selected and unchanged`,
      copy.crashes.length === 1 && migration.imported === copied.length && stopped.chatRouting !== true,
    );
    await user.screenshot();
  });

  await step("after: Try again copies the rest and lists the chats left in v1 before switching", async () => {
    await user.click({ role: "button", text: /^Try again$/ });
    const done = await probe.eventually(status, {
      within: 300_000, intervalMs: 1_000, label: "the retry completed",
      until: value => migrationOf(value).state === "completed",
    });
    await user.see({ text: "Chats migrated to OpenCode v2" }, { timeoutMs: 30_000 });
    await user.see({ text: /2 chats couldn't be copied and stay in OpenCode v1\./ });
    await user.see({ role: "button", text: "Switch to OpenCode v2" });
    await user.see({ role: "button", text: "Not now" });
    const listed = (await probe.dom('[data-testid="engine-migration-not-copied"] li')).elements.map(element => element.text);
    const migration = migrationOf(done);
    const copy = world.readHeldCopy();
    expect(listed).toEqual([tooLarge.title, crashing.title]);
    expect(migration).toMatchObject({
      imported: 0, skipped: copied.length, total: world.expectedChats,
      notCopied: [{ id: tooLarge.id, reason: "too_large" }, { id: crashing.id, reason: "stopped" }],
    });
    expect(copy.crashes).toHaveLength(1);
    expect(copy.tooLargeExports).toBe(2);
    expect(done.chatRouting).not.toBe(true);
    evidence.recordAssertionEvidence(
      "the retry finishes instead of stopping at the same chat, and says which chats stay in v1",
      `completed: ${migration.skipped} already copied, ${migration.notCopied.length} left in v1 (${listed.join("; ")}); the chat that stopped the first run was not exported again (${copy.crashes.length} crash in total); OpenWork waits for the member's choice instead of switching`,
      migration.state === "completed" && copy.crashes.length === 1 && done.chatRouting !== true,
    );
    await user.screenshot();
  });

  await step("after: switching opens the copied chats on v2 and the chats left in v1 are unchanged", async () => {
    await user.click({ role: "button", text: "Switch to OpenCode v2" });
    await probe.eventually(status, {
      within: 60_000, label: "OpenWork switched to v2",
      until: value => value.chatRouting === true && value.running === true,
    });
    const ids = await probe.eventually(v2SessionIds, {
      within: 60_000, label: "copied chats listed by v2",
      until: value => copied.every(id => value.includes(id)),
    });
    expect(ids).not.toContain(tooLarge.id);
    expect(ids).not.toContain(crashing.id);
    const first = world.chats[0]!;
    await user.click({ testId: `sidebar-session-${first.id}` });
    await user.see({ text: first.reply }, { timeoutMs: 60_000 });
    expect(world.readV1History()).toEqual(world.before);
    evidence.recordAssertionEvidence(
      "the copied chats work on v2; the others are only in v1, which was not changed",
      `v2 lists ${copied.filter(id => ids.includes(id)).length} of ${copied.length} copied chats and neither chat left behind; "${first.title}" shows its reply; v1 digest unchanged`,
      copied.every(id => ids.includes(id)) && !ids.includes(tooLarge.id) && !ids.includes(crashing.id),
    );
    await user.screenshot();
  });
});
