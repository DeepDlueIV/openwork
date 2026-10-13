import { expect } from "vitest";
import { z } from "zod";
import { spec } from "@openwork/testkit";
import { libraryUsage } from "../worlds/library-usage.ts";
import { isEmulatedClientWidth } from "../worlds/library.ts";

const test = spec.world(libraryUsage, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

const row = (name: string) => `[data-testid="library-usage-row"][data-item="${name}"]`;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const breakdownSchema = z.object({
  timezone: z.string(),
  rows: z.array(z.object({ itemId: z.string().nullable(), memberId: z.string().nullable(), uses: z.number(), people: z.number(), failures: z.number().nullable(), sources: z.record(z.string(), z.number()) })),
});

test("an owner sees which plugins, skills and connectors the team uses, which fail, and which nobody uses, while a teammate cannot see usage", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const teammate = user.on(world.memberWeb);
  const memberPage = probe.on(world.memberWeb);
  const { draftReply, summarizeTicket, quoteBuilder } = world.skills;
  const rowText = async (name: string) => oneLine((await page.dom(row(name))).elements[0]?.text ?? "");
  const openView = async (label: string, expected: string) => {
    await owner.click({ role: "radio", label });
    await page.eventually(async () => {
      if ((await page.dom(row(expected))).elements.length === 0) throw new Error(`${label} has not shown ${expected} yet.`);
      return true;
    }, { within: 30_000, intervalMs: 500, label: `${label} view` });
  };

  await step("before: the owner opens Plugins & connectors in Analytics and sees that nothing has been used yet", async () => {
    await owner.see({ role: "link", label: "Plugins & connectors" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Plugins & connectors" });
    await owner.see({ role: "heading", label: "Plugins & connectors" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "library-usage-no-usage" }, { timeoutMs: 60_000 });
    await owner.see({ text: "No usage yet" });
    const emptyState = oneLine((await page.dom('[data-testid="library-usage-no-usage"]')).elements[0]?.text ?? "");
    const unused = (await page.dom("[data-item-unused]")).elements.length;
    const unusedRows = await Promise.all([rowText("Support kit"), rowText("GitHub")]);
    const plainState = emptyState === "No usage yet" && unused === 2 && unusedRows.every((text) => text.includes("Not used"));
    evidence.recordAssertionEvidence("a fresh workspace shows an empty state, not a page of zeros", `${emptyState}; ${unused} of 2 plugins still read Not used; no Counts start explainer or summary cards are drawn`, plainState);
    expect(emptyState).not.toContain("Counts start");
    expect(plainState).toBe(true);
    expect(unused).toBe(2);
    expect((await page.dom('[data-testid="library-usage-summary"]')).elements).toHaveLength(0);
    await owner.screenshot();
  });

  await step("after: a reload keeps one neutral empty state", async () => {
    await owner.reload();
    await owner.see({ testId: "library-usage-no-usage" }, { timeoutMs: 60_000 });
    expect((await page.dom('[data-testid="library-usage-no-usage"] svg')).elements).toHaveLength(0);
    expect((await page.dom("[data-item-unused]")).elements).toHaveLength(2);
    evidence.recordAssertionEvidence("no recorded usage stays an empty state, not a fabricated zero report", "No usage yet; both real plugins remain Not used, with no decorative icon tile.", true);
    await owner.screenshot();
  });

  await step("when teammates' agents load skills and make two successful connector calls through OpenWork", async () => {
    const loads = [
      await world.loadSkill("alice", "draftReply", "get_skill"),
      // The same teammate loading the same skill again a moment later is another use.
      await world.loadSkill("alice", "draftReply", "get_skill"),
      await world.loadSkill("blair", "draftReply", "execute_capability"),
      await world.loadSkill("blair", "summarizeTicket", "get_skill"),
    ];
    const calls = [
      await world.callConnector("alice", "tracker", "search_issues"),
      await world.callConnector("blair", "tracker", "search_issues"),
    ];
    const served = loads.filter((load) => load.status === 200 && !load.isError && load.servedSkill).length;
    const succeeded = calls.filter((call) => call.status === 200 && !call.isError).length;
    evidence.recordAssertionEvidence("the agents really used them without failures", `${served} of 4 skill loads returned the SKILL.md; ${succeeded} of 2 connector calls succeeded through the gateway`, served === 4 && succeeded === 2);
    expect(served).toBe(4);
    expect(succeeded).toBe(2);
  });

  await step("after: two successful connector calls show Failed 0 without an attention color", async () => {
    await openView("Connectors", world.connectors.tracker);
    await page.eventually(async () => {
      await owner.reload();
      await owner.see({ testId: "library-usage-row" }, { timeoutMs: 30_000 });
      const uses = (await page.dom(`${row(world.connectors.tracker)} [data-item-uses]`)).elements[0]?.text;
      const failed = (await page.dom(`${row(world.connectors.tracker)} [data-item-failures]`)).elements[0]?.text;
      if (uses !== "2" || failed !== "0") throw new Error(`Team tracker shows ${uses ?? "no"} uses and ${failed ?? "no"} failures so far.`);
      return true;
    }, { within: 60_000, intervalMs: 1_000, label: "two successful calls are recorded with zero failures" });
    await owner.see({ testId: "library-usage-failed" });
    const neutral = (await page.dom('[data-testid="library-usage-failed"][data-state="neutral"]')).elements;
    // Analytics stat cards carry attention as data, not a colored icon.
    const calm = (await page.dom('[data-testid="library-usage-failed"] [data-analytics-stat][data-attention="false"]')).elements;
    const flagged = (await page.dom('[data-testid="library-usage-failed"] [data-attention="true"], [data-testid="library-usage-failed"] [class~="text-[var(--ow-danger)]"]')).elements;
    const card = (await page.dom('[data-testid="library-usage-failed"] > div > div')).elements.map((entry) => oneLine(entry.text)).join(" ");
    const ok = neutral.length === 1 && calm.length === 1 && flagged.length === 0 && card === "Failed 0 0% of uses";
    evidence.recordAssertionEvidence("zero failures is a neutral measured state", `Team tracker has 2 real uses and 0 failures; card reads ${card}; ${neutral.length} neutral card, ${calm.length} calm stat and ${flagged.length} attention markers`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("the compact name filter leaves only the connector the owner searches for", async () => {
    await owner.type({ placeholder: "Filter by name" }, world.connectors.tracker, { replace: true });
    await owner.see({ text: world.connectors.tracker });
    await owner.notSee({ text: world.connectors.wiki });
    const filter = (await page.dom('[data-testid="library-usage-filters"] > label')).elements[0];
    const visible = (await page.dom('[data-testid="library-usage-row"]')).elements;
    const ok = filter !== undefined && filter.rect.height === 32 && filter.rect.width === 240 && visible.length === 1;
    evidence.recordAssertionEvidence("the shared compact filter works without becoming a full-width search bar", `Filter is ${filter?.rect.width ?? 0}×${filter?.rect.height ?? 0}px; ${visible.length} row remains for ${world.connectors.tracker}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
    await owner.type({ placeholder: "Filter by name" }, "", { replace: true });
    await owner.press("Backspace");
    await owner.see({ text: world.connectors.wiki });
  });

  await step("when a teammate's agent tries to create an issue, the connector really refuses the archived project", async () => {
    const failed = await world.callConnector("blair", "tracker", "create_issue");
    // The gateway deliberately replaces provider tool text with a sanitized provider_error and a diagnostic reference.
    const refused = failed.status === 200 && failed.isError && failed.text.includes('"error":"provider_error"') && failed.text.includes("requested provider operation failed");
    evidence.recordAssertionEvidence("the third connector call really fails through the gateway", `HTTP ${failed.status}; tool failure ${failed.isError}; ${failed.text}`, refused);
    expect(refused).toBe(true);
  });

  await step("after: Support kit shows 4 uses by 2 people today and GitHub still reads Not used", async () => {
    await openView("Plugins", "Support kit");
    await page.eventually(async () => {
      await owner.reload();
      await owner.see({ testId: "library-usage-row" }, { timeoutMs: 30_000 });
      const uses = (await page.dom(`${row("Support kit")} [data-item-uses]`)).elements.map((entry) => entry.text);
      if (uses[0] !== "4") throw new Error(`Support kit shows ${uses.join() || "nothing"} uses so far.`);
      return uses;
    }, { within: 60_000, intervalMs: 2_000, label: "Support kit counts four uses" });
    const support = await rowText("Support kit");
    const sales = await rowText("GitHub");
    evidence.recordAssertionEvidence("plugins add up their skills' uses", `Support kit: ${support}; GitHub: ${sales}`, support.includes("Today") && sales.includes("Not used"));
    expect(support).toContain("Today");
    expect(sales).toContain("Not used");
    await owner.see({ testId: "library-usage-summary" });
    await owner.screenshot();
  });

  await step("the Skills view counts every load, including the repeated one, and the Not used filter leaves only the skill nobody used", async () => {
    await openView("Skills", draftReply.title);
    const draft = await rowText(draftReply.title);
    const draftUses = (await page.dom(`${row(draftReply.title)} [data-item-uses]`)).elements[0]?.text ?? "";
    const summary = await rowText(summarizeTicket.title);
    await owner.click({ role: "radio", label: "Not used" });
    await owner.see({ text: quoteBuilder.title });
    const visible = (await page.dom('[data-testid="library-usage-row"]')).elements.map((entry) => oneLine(entry.text));
    evidence.recordAssertionEvidence("skill counts and the Not used filter", `${draftReply.title}: ${draftUses} uses (${draft}); ${summarizeTicket.title}: ${summary}; Not used shows ${visible.length} row: ${visible.join(", ")}`, visible.length === 1 && draftUses === "3");
    expect(draftUses).toBe("3");
    expect(visible).toHaveLength(1);
    await owner.screenshot();
  });

  await step("the usage breakdown shows who loaded each skill, how often, and that their agents started every load", async () => {
    const draftId = draftReply.capability.split(":")[2] ?? "";
    const { alice, blair } = world.memberIds;
    const result = await probe.api(world.den.admin, `/v1/library-usage?kind=skills&groupBy=item,member&itemId=${encodeURIComponent(draftId)}`);
    const body = breakdownSchema.parse(result.body);
    const rows = body.rows;
    const perMember = rows.map((entry) => `${entry.memberId === alice ? "Alice" : entry.memberId === blair ? "Blair" : entry.memberId}: ${entry.uses} (${Object.entries(entry.sources).map(([source, count]) => `${source} ${count}`).join(", ")})`);
    const ok = result.response.status === 200 && body.timezone === "UTC" && rows.length === 2
      && rows.every((entry) => entry.itemId === draftId && entry.people === 1 && entry.sources.agent === entry.uses)
      && rows.find((entry) => entry.memberId === alice)?.uses === 2
      && rows.find((entry) => entry.memberId === blair)?.uses === 1;
    evidence.recordAssertionEvidence("one skill broken down by member and source", `HTTP ${result.response.status}; ${draftReply.title}: ${perMember.join("; ")}`, ok);
    expect(ok).toBe(true);
  });

  await step("the Connectors view shows 1 of 3 calls failed on Team tracker and Old wiki was never used", async () => {
    await openView("Connectors", world.connectors.tracker);
    await page.eventually(async () => {
      // The earlier zero-failure report is still cached. A real reload reads
      // the updated report without injecting counts or touching query state.
      await owner.reload();
      await owner.see({ testId: "library-usage-row" }, { timeoutMs: 30_000 });
      const failed = (await page.dom(`${row(world.connectors.tracker)} [data-item-failures]`)).elements.map((entry) => entry.text);
      if (failed[0] !== "1 of 3") throw new Error(`Team tracker shows ${failed.join() || "nothing"} failed so far.`);
      return failed;
    }, { within: 30_000, intervalMs: 1_000, label: "Team tracker shows one failed call" });
    const tracker = await rowText(world.connectors.tracker);
    const wiki = await rowText(world.connectors.wiki);
    const attention = (await page.dom('[data-testid="library-usage-failed"][data-state="attention"]')).elements;
    const flagged = (await page.dom('[data-testid="library-usage-failed"] [data-analytics-stat][data-attention="true"]')).elements;
    const dangerValue = (await page.dom('[data-testid="library-usage-failed"] [data-analytics-stat] > div[class~="text-[var(--ow-danger)]"]')).elements;
    const card = (await page.dom('[data-testid="library-usage-failed"] > div > div')).elements.map((entry) => oneLine(entry.text)).join(" ");
    // Both fixtures are custom MCP names, not named services. A generic
    // tracker must not acquire a made-up Linear, Slack or other brand logo.
    const inventedLogos = (await page.dom(`${row(world.connectors.tracker)} img, ${row(world.connectors.wiki)} img`)).elements;
    await owner.click({ role: "radio", label: "Failing" });
    const failing = (await page.dom('[data-testid="library-usage-row"]')).elements.map((entry) => oneLine(entry.text));
    const ok = wiki.includes("Not used") && failing.length === 1 && attention.length === 1
      && flagged.length === 1 && dangerValue.length === 1 && card === "Failed 1 33% of uses" && inventedLogos.length === 0;
    evidence.recordAssertionEvidence("only a real failed call gets the attention state", `Team tracker: ${tracker}; Old wiki: ${wiki}; Failing shows ${failing.length} row; card ${card}, ${flagged.length} attention stat, ${dangerValue.length} danger value; ${inventedLogos.length} fabricated service logos`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("when the gateway's nightly rollup folds today's uses into daily rows, the breakdown and the Plugins view count exactly the same", async () => {
    const draftId = draftReply.capability.split(":")[2] ?? "";
    const trackerId = world.connectionIds.tracker;
    const read = async (path: string) => breakdownSchema.parse((await probe.api(world.den.admin, path)).body).rows;
    const skillsBefore = await read(`/v1/library-usage?kind=skills&groupBy=item,member&itemId=${encodeURIComponent(draftId)}`);
    const trackerBefore = await read(`/v1/library-usage?kind=connectors&groupBy=item&itemId=${encodeURIComponent(trackerId)}`);
    const folded = await world.foldUsage();
    // 4 skill loads and 3 connector calls were recorded today; the job moves every one into a daily row.
    const foldedAll = folded.status === 200 && folded.dayBuckets >= 1 && folded.rowsDeleted === 7;
    evidence.recordAssertionEvidence("the real rollup job consumed today's raw uses", `POST /internal/rollups/run as of ${folded.now}: HTTP ${folded.status}; ${folded.dayBuckets} day folded; ${folded.rowsDeleted} raw rows moved into daily rollups`, foldedAll);
    expect(foldedAll).toBe(true);
    const skillsAfter = await read(`/v1/library-usage?kind=skills&groupBy=item,member&itemId=${encodeURIComponent(draftId)}`);
    const trackerAfter = await read(`/v1/library-usage?kind=connectors&groupBy=item&itemId=${encodeURIComponent(trackerId)}`);
    const sortByMember = (rows: typeof skillsBefore) => [...rows].sort((a, b) => (a.memberId ?? "").localeCompare(b.memberId ?? "")).map((entry) => ({ memberId: entry.memberId, uses: entry.uses, sources: entry.sources }));
    const tracker = (rows: typeof trackerBefore) => rows.map((entry) => ({ uses: entry.uses, people: entry.people, failures: entry.failures, sources: entry.sources }));
    const sameSkills = JSON.stringify(sortByMember(skillsAfter)) === JSON.stringify(sortByMember(skillsBefore));
    const sameTracker = JSON.stringify(tracker(trackerAfter)) === JSON.stringify(tracker(trackerBefore)) && trackerAfter[0]?.uses === 3 && trackerAfter[0]?.failures === 1;
    evidence.recordAssertionEvidence("daily rollups answer exactly what the raw uses did", `${draftReply.title} per member before ${JSON.stringify(sortByMember(skillsBefore))}, after ${JSON.stringify(sortByMember(skillsAfter))}; ${world.connectors.tracker} before ${JSON.stringify(tracker(trackerBefore))}, after ${JSON.stringify(tracker(trackerAfter))}`, sameSkills && sameTracker);
    expect(sameSkills).toBe(true);
    expect(sameTracker).toBe(true);
    await openView("Plugins", "Support kit");
    await owner.reload();
    await owner.see({ testId: "library-usage-row" }, { timeoutMs: 30_000 });
    const support = await rowText("Support kit");
    const supportUses = (await page.dom(`${row("Support kit")} [data-item-uses]`)).elements[0]?.text;
    evidence.recordAssertionEvidence("the Plugins view reads the daily rollups", `Support kit after the fold: ${support}`, supportUses === "4" && support.includes("Today"));
    expect(supportUses).toBe("4");
    expect(support).toContain("Today");
    await owner.screenshot();
    // The next steps compare connectors, where this journey was before the fold.
    await openView("Connectors", world.connectors.tracker);
  });

  await step("after: at phone width the owner's comparison table scrolls sideways without widening the page", async () => {
    await owner.click({ role: "radio", label: "All" });
    await owner.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await owner.see({ role: "heading", label: "Plugins & connectors" });
    await owner.see({ testId: "library-usage-table" });
    const layout = await world.usageLayout();
    const visible = (await page.dom('[data-testid="library-usage-row"]')).elements;
    const headers = (await page.dom('[data-testid="library-usage-columns"] > span')).elements.map((entry) => entry.text);
    const frames = (await page.dom('body, [data-testid="library-usage"], [data-testid="library-usage-toolbar"], [data-testid="library-usage-filters"], [data-testid="library-usage-table"]')).elements;
    const fits = frames.every((entry) => entry.rect.left >= 0 && entry.rect.right <= layout.viewportWidth);
    const ok = isEmulatedClientWidth(layout.viewportWidth, 390) && layout.documentWidth <= layout.viewportWidth && layout.bodyScrollWidth <= layout.bodyWidth
      && layout.table !== null && layout.table.width > 0 && layout.table.scrollWidth > layout.table.width
      && layout.table.overflowX === "auto" && fits && visible.length === 3;
    evidence.recordAssertionEvidence("phone-width scrolling stays inside the comparison table", `Viewport ${layout.viewportWidth}px; document ${layout.documentWidth}px; body ${layout.bodyScrollWidth}/${layout.bodyWidth}px; table ${layout.table?.scrollWidth ?? 0}/${layout.table?.width ?? 0}px (${layout.table?.overflowX ?? "missing"}); ${visible.length} real connector rows; columns ${headers.join(", ")}; page frames fit: ${fits}`, ok);
    expect(headers).toEqual(["Connector", "Uses", "People", "Failed", "Last used"]);
    expect(ok).toBe(true);
    await owner.screenshot();
    await owner.resizeViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
  });

  await step("before: Members and Connectors use Den rows", async () => {
    await owner.navigate(`${world.baseUrl}/dashboard/members`);
    await owner.see({ role: "heading", label: "Members" }, { timeoutMs: 60_000 });
    await owner.screenshot();
    await owner.navigate(`${world.baseUrl}/dashboard/mcp-connections`);
    await owner.see({ text: world.connectors.tracker }, { timeoutMs: 60_000 });
    await owner.screenshot();
    evidence.recordAssertionEvidence("Den's management pages are the comparison", "Members and Connectors are shown before Analytics.", true);
  });

  await step("after: Analytics uses neutral stats and the same Den rows without changing counts", async () => {
    await owner.navigate(`${world.baseUrl}/dashboard/analytics/library`);
    await owner.see({ testId: "library-usage-row" }, { timeoutMs: 60_000 });
    const previous = await rowText("Support kit");
    await owner.reload();
    await owner.see({ testId: "library-usage-row" }, { timeoutMs: 60_000 });
    const current = await rowText("Support kit");
    const marks = (await page.dom(`${row("GitHub")} img`)).elements;
    const rows = (await page.dom("[data-analytics-row]")).elements;
    const stats = (await page.dom("[data-analytics-stat]")).elements;
    expect(current).toBe(previous);
    expect(rows).toHaveLength(2);
    expect(stats).toHaveLength(4);
    expect(marks).toHaveLength(1);
    expect((await page.dom('[data-analytics-stat] svg')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("the same counts share management rows and known brand marks", `Support kit before/after: ${current}; ${rows.length} Den rows, ${stats.length} neutral stats, ${marks.length} GitHub logo; no decorative stat icons.`, current === previous && marks.length === 1);
    await owner.screenshot();
  });

  await step("a slow usage read shows Den row skeletons rather than loading prose", async () => {
    await world.faults.delay();
    await owner.reload();
    await owner.see({ testId: "item-rows-skeleton" }, { timeoutMs: 5_000 });
    await owner.notSee({ text: "Loading usage…" });
    await owner.screenshot();
    await world.faults.recover();
    await owner.see({ testId: "library-usage-row" }, { timeoutMs: 30_000 });
    const delayed = (await world.faults.requests()).filter((request) => request.faulted && request.status === 200);
    expect(delayed.length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("loading preserves the destination rows", `${delayed.length} actual usage response was delayed; Den row skeletons fill the same list, then real counts return.`, delayed.length > 0);
  });

  await step("a usage outage gives one retry and never invents empty counts", async () => {
    await world.faults.fail();
    await owner.reload();
    await owner.see({ text: "Couldn't load plugins usage" }, { timeoutMs: 30_000 });
    await owner.notSee({ text: "No usage yet" });
    await owner.notSee({ text: "Your data is safe. This is usually a short connection problem." });
    const failed = (await world.faults.requests()).filter((request) => request.status === 503);
    expect(failed.length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("failure and empty usage remain distinct", `${failed.length} intercepted usage read returned 503; no empty or zero report replaces the error.`, failed.length > 0);
    await owner.screenshot();
  });

  await step("after: one retry restores the recorded plugin counts", async () => {
    await world.faults.recover();
    await owner.click({ role: "button", label: "Try again" });
    await owner.see({ testId: "library-usage-row" }, { timeoutMs: 30_000 });
    expect((await page.dom(`${row("Support kit")} [data-item-uses]`)).elements[0]?.text).toBe("4");
    evidence.recordAssertionEvidence("retry restores real usage", "Support kit again shows its 4 recorded uses after the transport recovers.", true);
    await owner.screenshot();
  });

  await step("the owner opens Support kit's usage and sees who uses it, how often, and what started it", async () => {
    await owner.click({ role: "link", label: /Support kit/ });
    await owner.see({ testId: "library-usage-item" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "library-usage-person" }, { timeoutMs: 60_000 });
    const heading = oneLine((await page.dom('[data-testid="library-usage-item-heading"] h2')).elements[0]?.text ?? "");
    const people = (await page.dom('[data-testid="library-usage-person"]')).elements.map((entry) => oneLine(entry.text));
    const aliceUses = (await page.dom('[data-testid="library-usage-person"][data-person="Alice Teammate"] [data-item-uses]')).elements[0]?.text;
    const blairUses = (await page.dom('[data-testid="library-usage-person"][data-person="Blair Teammate"] [data-item-uses]')).elements[0]?.text;
    const sources = (await page.dom('[data-testid="library-usage-sources"] li')).elements.map((entry) => oneLine(entry.text));
    const agentUses = oneLine((await page.dom('[data-testid="library-usage-sources"] li[data-source="agent"] span:last-child')).elements[0]?.text ?? "");
    const daily = (await page.dom('[data-testid="library-usage-daily"] figure')).elements.length;
    const ok = heading === "Support kit" && people.length === 2 && aliceUses === "2" && blairUses === "2" && sources.length === 1 && agentUses === "4" && daily === 1;
    evidence.recordAssertionEvidence("one plugin's people, days and sources", `${heading}: ${people.join("; ")}; started by ${sources.join(", ")}; ${daily} uses-per-day chart`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("from there the owner opens Alice and sees which plugins and skills she used", async () => {
    await owner.click({ role: "link", label: /Alice Teammate/ });
    await owner.see({ testId: "library-usage-member" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "library-usage-member-item" }, { timeoutMs: 60_000 });
    const plugins = (await page.dom('[data-testid="library-usage-member-item"]')).elements.map((entry) => oneLine(entry.text));
    const supportUses = (await page.dom('[data-testid="library-usage-member-item"][data-item="Support kit"] [data-item-uses]')).elements[0]?.text;
    await owner.screenshot();
    await owner.click({ role: "radio", label: "Skills" });
    await page.eventually(async () => {
      if ((await page.dom(`[data-testid="library-usage-member-item"][data-item="${draftReply.title}"]`)).elements.length === 0) throw new Error("Alice's skills have not loaded yet.");
      return true;
    }, { within: 30_000, intervalMs: 500, label: "Alice's skills" });
    const skillRows = (await page.dom('[data-testid="library-usage-member-item"]')).elements.map((entry) => oneLine(entry.text));
    const draftUses = (await page.dom(`[data-testid="library-usage-member-item"][data-item="${draftReply.title}"] [data-item-uses]`)).elements[0]?.text;
    const ok = plugins.length === 1 && supportUses === "2" && skillRows.length === 1 && draftUses === "2";
    evidence.recordAssertionEvidence("one person's plugins and skills", `Alice's plugins: ${plugins.join("; ")}; her skills: ${skillRows.join("; ")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("usage pages still lead to where each plugin and connector is managed", async () => {
    await owner.click({ role: "link", label: new RegExp(draftReply.title) });
    await owner.see({ testId: "library-usage-item" }, { timeoutMs: 60_000 });
    await owner.navigate(`${world.baseUrl}/dashboard/analytics/library?view=plugins`);
    await owner.see({ testId: "library-usage-row" }, { timeoutMs: 60_000 });
    await owner.click({ role: "link", label: /Support kit/ });
    await owner.see({ testId: "library-usage-item" }, { timeoutMs: 60_000 });
    await owner.click({ role: "link", label: "Open in Library" });
    // The Library header reads its logo letter before the name.
    await owner.see({ role: "heading", label: /Support kit$/ }, { timeoutMs: 60_000 });
    await owner.notSee({ testId: "library-usage-item" });
    await owner.screenshot();
    await owner.navigate(`${world.baseUrl}/dashboard/analytics/library?view=connectors`);
    await owner.see({ testId: "library-usage-row" }, { timeoutMs: 60_000 });
    const marks = (await page.dom(`${row("GitHub")} img`)).elements;
    expect(marks).toHaveLength(1);
    expect((await page.dom(`${row(world.connectors.tracker)} img`)).elements).toHaveLength(0);
    await owner.click({ role: "link", label: /Team tracker/ });
    await owner.see({ testId: "library-usage-item" }, { timeoutMs: 60_000 });
    const trackerFailures = (await page.dom('[data-testid="library-usage-person"] [data-item-failures]')).elements.map((entry) => entry.text);
    await owner.screenshot();
    await owner.click({ role: "link", label: "Open connector" });
    await owner.see({ role: "heading", label: new RegExp(`${world.connectors.tracker}$`) }, { timeoutMs: 60_000 });
    await owner.notSee({ testId: "library-usage-item" });
    evidence.recordAssertionEvidence("usage pages link to the management pages", `Support kit's usage opens its Library detail; Team tracker's usage (failures per person: ${trackerFailures.join(", ")}) opens its Connectors detail.`, true);
    await owner.screenshot();
  });

  await step("after: integrated comparisons stay inside the table at phone width", async () => {
    await owner.navigate(`${world.baseUrl}/dashboard/analytics/library?view=connectors`);
    await owner.resizeViewport({ width: 320, height: 844, deviceScaleFactor: 1 });
    await owner.see({ testId: "library-usage-table" }, { timeoutMs: 60_000 });
    const layout = await world.usageLayout();
    expect(isEmulatedClientWidth(layout.viewportWidth, 320)).toBe(true);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.table?.overflowX).toBe("auto");
    evidence.recordAssertionEvidence("narrow integration never widens the page", `Viewport ${layout.viewportWidth}px; document ${layout.documentWidth}px; comparison scrolling stays inside its ${layout.table?.width ?? 0}px table.`, layout.documentWidth <= layout.viewportWidth);
    await owner.screenshot();
    await owner.resizeViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
  });

  await step("a teammate cannot read usage", async () => {
    await teammate.navigate(`${world.baseUrl}/dashboard/analytics/library`);
    await teammate.notSee({ role: "heading", label: "Plugins & connectors" });
    const alice = world.den.members.alice;
    if (!alice) throw new Error("Missing teammate session.");
    const denied = await Promise.all([
      ...["plugins", "skills", "connectors"].map((kind) => probe.api(alice, `/v1/library-usage/${kind}`)),
      probe.api(alice, "/v1/library-usage?kind=skills&groupBy=member"),
    ]);
    const statuses = denied.map((result) => result.response.status);
    const headings = (await memberPage.dom("h1")).elements.map((entry) => entry.text);
    evidence.recordAssertionEvidence("usage is for owners and admins only", `teammate API reads: ${statuses.join(", ")}; teammate page headings: ${headings.join(", ") || "none"}`, statuses.every((status) => status === 403));
    expect(statuses).toEqual([403, 403, 403, 403]);
    await teammate.screenshot();
  });
});

