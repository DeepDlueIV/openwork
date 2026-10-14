import { expect } from "vitest";
import { createAndSelectWorkspace, sendComposerMessage, waitForAssistantReply } from "@openwork/behaviors";
import { app, needs, server, test } from "@openwork/testkit";
import { fileURLToPath } from "node:url";

// Points an isolated desktop at an already deployed Den (for example one
// created with infra/terraform/modules/openwork-aws-ecs), signs in as the
// account in OPENWORK_EVAL_DEMO_EMAIL / OPENWORK_EVAL_DEMO_PASSWORD, and runs
// one chat with the model in OPENWORK_EVAL_MODEL.
const enabled = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL && process.env.OPENWORK_EVAL_DEN_WEB_URL && process.env.OPENWORK_EVAL_DEMO_PASSWORD);
const title = enabled
  ? "desktop signs in to an external self-hosted Den and runs one chat"
  : "self-hosted Den desktop skipped — needs: OPENWORK_EVAL_DEN_API_URL, OPENWORK_EVAL_DEN_WEB_URL, OPENWORK_EVAL_DEMO_EMAIL, OPENWORK_EVAL_DEMO_PASSWORD";
const workspacePath = fileURLToPath(new URL("../..", import.meta.url));

test.skipIf(!enabled)(title, { timeout: 15 * 60_000 }, async ({ evidence, place }) => {
  needs({ env: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEMO_PASSWORD"] });
  await using den = await server({ place });
  expect(den.ref.webUrl).toBe(process.env.OPENWORK_EVAL_DEN_WEB_URL);

  await using desktopApp = await app({ den, as: "admin", place });
  evidence.recordAssertionEvidence("Desktop signed in to the self-hosted Den", `Den auth token and active organization were persisted for ${den.ref.webUrl}.`, true);

  await createAndSelectWorkspace(desktopApp, { path: workspacePath });
  await sendComposerMessage(desktopApp, "Reply with the single word: pong");
  const reply = await waitForAssistantReply(desktopApp, { timeoutMs: 180_000 });
  expect(reply.text.length).toBeGreaterThan(0);
  evidence.recordAssertionEvidence("One chat ran in the signed-in desktop", `Assistant replied: ${JSON.stringify(reply.text.slice(0, 120))}`, true);
});
