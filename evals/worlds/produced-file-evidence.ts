import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export const producedFilePrompt = "Prepare a two-sheet budget workbook.";
export async function producedFileEvidence(seed: Seed) {
  const engine = resolveEvalEngine();
  const workspacePath = seed.tmpPath("produced-file-evidence");
  await mkdir(workspacePath, { recursive: true });
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: producedFilePrompt, latestUserTurn: true,
    // Deliberately no English trigger words or filename in the reply.
    finalReply: "Voilà. La feuille est prête.",
    steps: [
      { tool: "spreadsheet_write", arguments: { path: "budget.xlsx", sheets: [
        { name: "Summary", rows: [["Total", 30]] }, { name: "Inputs", rows: [["North", 10], ["South", 20]] },
      ] } },
      // Merely printing a plausible path must not promote another artifact.
      { tool: engine === "v2" ? "shell" : "bash", arguments: { command: "printf 'not-produced.pdf\\n'", description: "Read a reference" } },
    ],
  }] });
  const app = await seed.appWeb({ name: "produced-file-evidence", workspacePath, headless: true, mocks: { agent: mock } });
  const workspace = await seed.workspace(app, workspacePath);
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Export model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, "export-proof", "workbook", {
    permission: { "*": "allow" }, provider: { "export-proof": { npm: "@ai-sdk/openai-compatible", name: "Workbook model",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-export-fixture" }, models: { workbook: { name: "Workbook model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Budget export" });
  return { app, workspace, session,
    workbookSignature: async () => (await readFile(join(workspacePath, "budget.xlsx"))).subarray(0, 2).toString(),
  };
}
