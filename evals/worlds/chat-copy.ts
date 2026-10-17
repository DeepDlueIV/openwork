import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/** What one copy put on the clipboard, plus a style-free outline of its rich text. */
export type CopiedContent = {
  plain: string;
  html: string;
  /** Tags, links and text of the rich text, ignoring attributes and whitespace. */
  outline: string;
  /** Elements in the rich text that carry the chat's display classes or inline styles. */
  styled: string[];
};

export const scheduleFileName = "planting-schedule.md";

/** A drafted email as a Markdown quote, with a two-line sign-off. */
export const draftPrompt = "Draft my reply to Alex about the planting schedule as a quote. COPY_DRAFT_REPLY";
export const draftReply = [
  "> Hi Alex,",
  ">",
  "> Thanks for the update on the garden project.",
  ">",
  "> I'm away on Monday, so Sam will run the 3:30 call and walk you through the planting schedule.",
  ">",
  "> Best regards,",
  "> Jordan",
].join("\n");

export const formattedPrompt = "Summarize the planting plan with the watering command. COPY_FORMATTED_REPLY";
export const formattedReply = [
  "Here is the **planting plan** for the week, from [the seed guide](https://example.com/seed-guide).",
  "",
  "- Tomatoes on Monday",
  "- Basil on Tuesday",
  "",
  "```sh",
  "water --zone garden --minutes 10",
  "```",
  "",
  "Tell me if the schedule changes.",
].join("\n");

/**
 * A person drafts text in a chat and copies it out. The scripted model first
 * reads a workspace file (so the turn shows a "Read <file>" step), then answers
 * with exact Markdown, so every copy can be compared with what was written.
 */
export async function chatCopy(seed: Seed) {
  const engine = resolveEvalEngine();
  const dir = seed.tmpPath("chat-copy");
  await mkdir(dir, { recursive: true });
  const workspacePath = await realpath(dir);
  const schedulePath = join(workspacePath, scheduleFileName);
  await writeFile(schedulePath, "# Planting schedule\n\n- Monday: tomatoes\n- Tuesday: basil\n");

  const providerId = "chat-copy-mock";
  const modelId = "chat-copy-model";
  const app = await seed.appWeb({ name: "chat-copy", workspacePath, mocks: {
    agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
      promptMarker: "COPY_DRAFT_REPLY",
      latestUserTurn: true,
      finalReply: draftReply,
      steps: [{ tool: "read", arguments: { filePath: schedulePath, path: schedulePath } }],
    }, {
      promptMarker: "COPY_FORMATTED_REPLY",
      latestUserTurn: true,
      finalReply: formattedReply,
      steps: [],
    }] }),
  } });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing chat copy model mock");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { read: "allow" },
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Chat copy mock",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-chat-copy-fixture" },
      models: { [modelId]: { name: "Chat copy model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Reply to Alex" });

  // TODO(primitive): seed needs a browser-permission helper. Grant the real
  // permission so copies go through the browser's own clipboard.
  const origin = await seed.evalIn(app, () => location.origin);
  await app.client.send("Browser.grantPermissions", {
    origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });

  return {
    app, workspace, session, engine,
    // TODO(primitive): probe.clipboard should read every clipboard format without
    // per-world evaluation. Rich text is read unsanitized: that is what a mail
    // or document editor receives when the person pastes.
    async clipboard(): Promise<CopiedContent> {
      return seed.evalIn(app, async () => {
        const read = navigator.clipboard.read as (options?: { unsanitized?: string[] }) => Promise<ClipboardItem[]>;
        const items = await read.call(navigator.clipboard, { unsanitized: ["text/html"] });
        const text = async (type: string) => {
          const item = items.find((candidate) => candidate.types.includes(type));
          return item ? (await item.getType(type)).text() : "";
        };
        const plain = await text("text/plain");
        const html = await text("text/html");
        const body = new DOMParser().parseFromString(html, "text/html").body;
        const walk = (node: Node): string => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
          if (!(node instanceof Element)) return "";
          const tag = node.tagName.toLowerCase();
          if (tag === "meta" || tag === "style") return "";
          const href = node.getAttribute("href");
          const inner = [...node.childNodes].map(walk).join("");
          return `<${tag}${href ? ` href="${href}"` : ""}>${inner}</${tag}>`;
        };
        const outline = [...body.childNodes].map(walk).join("").replace(/\s+/g, " ").replace(/> </g, "><").trim();
        const styled = [...body.querySelectorAll("[style], [class]")].map((element) => {
          const style = element.getAttribute("style");
          return `${element.tagName.toLowerCase()} ${style ? `style="${style.slice(0, 80)}"` : `class="${(element.getAttribute("class") ?? "").slice(0, 80)}"`}`;
        });
        return { plain, html, outline, styled };
      }, { awaitPromise: true });
    },
  };
}
