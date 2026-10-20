import type { Seed } from "@openwork/env";
import { bootWorkbot, enableWorkbot, signInWorkbot } from "../../worlds/lib/workbot.ts";
import { ACME_MODEL } from "../../worlds/lib/acme-gateway.ts";
import { denFetch } from "../packages/behaviors/src/den.ts";

/** The real signed-in Workbot and Den; no paid VM is created by this rollout/recovery journey. */
export async function workbotComputerWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const workbot = await bootWorkbot(stack, undefined, { live: false, features: { workbotDocuments: true } });
    // Workbot verifies the organization's model against the runner before a turn; choose the one this runner serves.
    const model = await denFetch(workbot.den.admin, "/v1/org/workbot-settings", { method: "PUT", headers: { authorization: `Bearer ${workbot.den.admin.token}` }, body: JSON.stringify({ model: ACME_MODEL }) });
    if (!model.response.ok) throw new Error(`Could not choose Workbot's model: HTTP ${model.response.status} ${model.text.slice(0, 200)}`);
    const signed = await signInWorkbot(workbot);
    // A conversation must exist, or Workbot opens on its first-run welcome instead of Home.
    const sent = await signed.call("/v1/workbot/messages", { method: "POST", body: JSON.stringify({ id: "desktop_proof_hello", text: "Hello" }) });
    if (sent.status !== 202) throw new Error(`Workbot refused the seed message: HTTP ${sent.status} ${(await sent.text()).slice(0, 200)}`);
    const web = await seed.web({ den: workbot.den, headless: true, viewport: { width: 1440, height: 960 } });
    for (const pair of signed.cookie.split("; ")) {
      const equal = pair.indexOf("=");
      await web.client.send("Network.setCookie", { name: pair.slice(0, equal), value: pair.slice(equal + 1), url: workbot.workbotUrl, httpOnly: true, sameSite: "Lax" });
    }
    await web.client.send("Page.navigate", { url: `${workbot.workbotUrl}/computer` });
    return {
      web,
      setEnabled: (value: boolean, workspaceAssistant = false) => enableWorkbot(workbot.den, { computerUse: value, remoteComputers: value, workbotDocuments: true, workbotWorkspaceAssistant: workspaceAssistant }),
      call: signed.call,
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
