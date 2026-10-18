import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import type { AutomationList, AutomationRun } from "@openwork/types/automations";

/** Real Workbot client, deterministic owner-scoped Den responses. No production providers or model. */
export async function calendarInventory(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const requests: string[] = [];
  const messages: unknown[] = [];
  let receiptFails = true;
  let rangeFails = false;
  const now = Date.now();
  const item = (index: number): AutomationList["items"][number] => {
    const id = `automation_${index}`;
    return {
      automation: { id, organizationId: "org_example", ownerMemberId: "member_example", name: index === 119 ? "Weekly summary" : `Brief ${String(index).padStart(3, "0")}`, state: index === 0 ? "active" : "inactive", currentRevisionId: `revision_${index}`, nextDueAt: index === 0 ? now + 60000 : null, latestRunAt: null, needsAttentionReason: null, createdAt: now - 86400000, updatedAt: now, archivedAt: null },
      revision: { id: `revision_${index}`, automationId: id, version: 1, instructions: "Summarize the project", schedule: { kind: "once", timezone: "UTC", at: now + 60000 }, model: { providerId: "openwork-cloud", modelId: "default", variant: null }, executionTarget: "cloud", workspaceId: null, maximumRuntimeMs: 900000, digest: "0123456789abcdef0123", createdAt: now - 86400000 },
      latestRun: null,
    };
  };
  const run = (index: number, automationId = "automation_119"): AutomationRun => ({ id: `run_${index}`, automationId, revisionId: `revision_${automationId.split("_").at(-1)}`, trigger: "scheduled", idempotencyKey: `key_${index}`, status: "succeeded", leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, attemptCount: 1, executionTarget: "cloud", executionThread: null, providerId: "openwork-cloud", modelId: "default", modelVariant: null, scheduledFor: now - (index + 1) * 86400000, startedAt: now - (index + 1) * 86400000, finishedAt: now - (index + 1) * 86400000 + 1000, error: null, resultSummary: index === 1 ? null : `Recorded result ${index}`, usage: { inputTokens: null, outputTokens: null, costMicros: null }, createdAt: now - (index + 1) * 86400000, updatedAt: now });
  try {
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "calendar-inventory-fixture", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          requests.push(`${url.pathname}${url.search}`);
          const referring = new URL(req.headers.referer ?? "http://fixture");
          const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (url.pathname === "/v1/workbot/me") return json({ name: "Alex", email: "alex@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Example", enabled: true, calendar: true, documents: false, workspaceAssistant: true, canSchedule: false, sideChats: false, denUrl: "https://workspace.example.test" });
          if (url.pathname === "/v1/workbot") return json({ available: true, name: "Workbot", organizationName: "Example", status: "idle", turns: [], hasEarlier: false, filesEnabled: false });
          if (url.pathname === "/v1/workbot/events") { res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
          if (url.pathname === "/v1/workbot/messages" && req.method === "POST") { let body = ""; for await (const chunk of req) body += chunk; messages.push(JSON.parse(body)); return json({ ok: true }, 202); }
          if (url.pathname.endsWith("/calendar/v1/automations")) {
            const offset = Number(url.searchParams.get("cursor") ?? 0);
            const count = Number(referring.searchParams.get("count") ?? 120);
            const limit = Number(url.searchParams.get("limit") ?? 100);
            return json({ items: Array.from({ length: Math.min(limit, Math.max(0, count - offset)) }, (_, i) => item(offset + i)), nextCursor: offset + limit < count ? String(offset + limit) : null });
          }
          if (url.pathname.endsWith("/calendar/v1/automation-runs")) {
            if (rangeFails) return json({ error: "unavailable" }, 503);
            if (referring.searchParams.get("dense") === "1") {
              const offset = Number(url.searchParams.get("cursor") ?? 0);
              return json({ items: Array.from({ length: 200 }, (_, i) => ({ ...run(offset + i, "automation_0"), scheduledFor: now - 1000 })), nextCursor: String(offset + 200) });
            }
            return json({ items: [], nextCursor: null });
          }
          const history = /\/calendar\/v1\/automations\/(automation_\d+)\/runs$/.exec(url.pathname);
          if (history) {
            const offset = Number(url.searchParams.get("cursor") ?? 0);
            const limit = Number(url.searchParams.get("limit") ?? 20);
            return json({ items: Array.from({ length: Math.min(limit, 45 - offset) }, (_, i) => run(offset + i, history[1])), nextCursor: offset + limit < 45 ? String(offset + limit) : null });
          }
          const detail = /\/calendar\/v1\/automations\/automation_(\d+)$/.exec(url.pathname);
          if (detail) return json(item(Number(detail[1])));
          const receipt = /\/calendar\/v1\/automation-runs\/run_(\d+)$/.exec(url.pathname);
          if (receipt) {
            if (receiptFails) return json({ error: "unavailable" }, 503);
            return json({ run: run(Number(receipt[1])), ...item(119), events: [] });
          }
          if (url.pathname.endsWith("/google-workspace/calendar-events")) {
            const start = Date.parse(url.searchParams.get("timeMin") ?? "");
            return json({ ok: true, events: Array.from({ length: referring.searchParams.get("dense") === "1" ? 100 : 1 }, (_, i) => ({ id: `event_${i}`, summary: i === 0 ? "Team review" : `Meeting ${i}`, description: "", location: "", start: new Date(start + 3600000).toISOString(), end: new Date(start + 7200000).toISOString(), status: "confirmed", htmlLink: "https://calendar.google.com/", attendees: [], meetLink: null })) });
          }
          if (url.pathname.includes("microsoft-365/calendar-events")) return json({ error: "needs_connection" }, 409);
          if (url.pathname.endsWith("/llm-providers")) return json({ llmProviders: [] });
          return json({ error: "not_found" }, 404);
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Calendar fixture did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "calendar-inventory", startUrl: `${url}calendar`, headless: true }));
    return { web, url, requests: () => [...requests], messages: () => [...messages], restoreReceipts: () => { receiptFails = false; }, failRange: () => { rangeFails = true; }, restoreRange: () => { rangeFails = false; }, async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
