import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { plusMenuWeb } from "../worlds/composer-plus-menu.ts";

const test = spec.world(plusMenuWeb, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const plusButton = { role: "button", label: "Add files, skills, connectors, and more" } as const;
const menuSearch = { placeholder: "Search files, skills, connectors" } as const;
const highlightedRow = "[data-plus-menu-item][data-highlighted]";
const attachShortcut = process.platform === "darwin" ? "Meta+u" : "Control+u";
const pastedTail = "row 42 PASTE_TAIL_7310";
const pasted = [...Array.from({ length: 41 }, (_, index) => `row ${index + 1} of the pasted table`), pastedTail].join("\n");
const hiddenNote = /Attached files were copied into this worker workspace/;
const hiddenConnectorInstruction = /do not assume it is connected/;

type Chips = { file: string; connector: string; pasted: string };

test(`a member (${resolveEvalEngine()}): my sent message shows my files, connector and pasted text the way I composed them`, async ({ world, user, probe, step, evidence }) => {
  const [notes, roster, unpicked] = world.stagedFiles;
  if (!notes || !roster || !unpicked) throw new Error("The world staged too few files.");
  const chips = async (scope: string): Promise<Chips> => {
    const text = async (...selectors: string[]) => (await probe.dom(selectors.map((selector) => `${scope} ${selector}`).join(", "))).elements.map((element) => element.text).join(" | ");
    return {
      file: await text("[data-attachment-file-chip]", "[data-attachment-chip]"),
      connector: await text('[data-composer-badge="connector"]'),
      pasted: await text('[data-composer-badge="pasted"]'),
    };
  };
  let composed: Chips = { file: "", connector: "", pasted: "" };

  await step("before: the composer shows the file chips, the HubSpot pill and one collapsed pasted-text badge", async () => {
    await user.type("composer", `${world.attachPrompt} `);
    await user.click(plusButton);
    await user.click({ role: "option", label: /^Attach a file/ });
    await user.see({ text: notes.name });
    await user.notSee(menuSearch);
    // The attach shortcut adds a second file without opening the menu.
    await user.click("composer");
    await user.press(attachShortcut);
    await user.see({ text: roster.name });
    await user.notSee(menuSearch);
    await user.click(plusButton);
    await user.type(menuSearch, "hbspt");
    await probe.eventually(async () => (await probe.dom(highlightedRow)).elements[0]?.text ?? "", {
      within: 10_000, label: "HubSpot is the first match", until: (text) => text.startsWith("HubSpot"),
    });
    await user.press("Enter");
    await probe.eventually(() => probe.dom("[data-composer-plus-menu]"), {
      within: 5_000, intervalMs: 50, label: "the + menu closes", until: (dom) => dom.elements.length === 0,
    });
    await world.pasteIntoComposer(pasted);
    composed = await probe.eventually(() => chips('[contenteditable="true"]'), {
      within: 10_000, label: "the composer shows all three chips", until: (value) => Boolean(value.file && value.connector && value.pasted),
    });
    await user.notSee({ text: pastedTail });
    evidence.recordAssertionEvidence("The composer shows three chips", `file "${composed.file}"; connector "${composed.connector}"; pasted "${composed.pasted}"`,
      composed.file.includes(notes.name) && composed.connector === "HubSpot" && composed.pasted.includes("42 lines"));
    expect(composed.file).toContain(notes.name);
    expect(composed.file).toContain("TXT");
    expect(composed.connector).toBe("HubSpot");
    expect(composed.pasted).toBe("Pasted text42 lines");
    await user.screenshot();
  });

  await step("after: the sent message shows the same chips, without the attachment path note or the connector instruction", async () => {
    await user.click("Run task");
    await user.see({ text: world.attachReply }, { timeoutMs: 90_000 });
    const sent = await probe.eventually(() => chips('[data-message-role="user"]'), {
      within: 15_000, label: "the sent message shows all three chips", until: (value) => Boolean(value.file && value.connector && value.pasted),
    });
    await user.notSee({ text: hiddenNote });
    await user.notSee({ text: hiddenConnectorInstruction });
    await user.notSee({ text: pastedTail });
    const matches = sent.connector === composed.connector && sent.pasted === composed.pasted
      && sent.file.includes(notes.name) && sent.file.includes("TXT");
    evidence.recordAssertionEvidence("The sent message matches the composer", `file "${sent.file}"; connector "${sent.connector}"; pasted "${sent.pasted}"; no path note or connector instruction shown`, matches);
    expect(sent.connector).toBe(composed.connector);
    expect(sent.pasted).toBe(composed.pasted);
    expect(sent.file).toContain(notes.name);
    expect(sent.file).toContain("TXT");
    await user.screenshot();
  });

  await step("the pasted-text badge opens a preview in place with its counts, Copy and the first lines", async () => {
    await user.click({ role: "button", label: "Show pasted text" });
    await user.see({ text: /^42 lines · [\d,.\s]+ characters$/ });
    await user.see({ role: "button", label: "Copy" });
    await user.see({ text: "row 1 of the pasted table" });
    await user.see({ text: "36 more lines" });
    await user.notSee({ text: pastedTail });
    await user.screenshot();
  });

  await step("then the model received both attached files (not the one left out), the HubSpot instruction and the whole pasted text", async () => {
    await user.see({ text: world.attachReply });
    const bodies = world.providerBodies().filter((body) => body.includes(world.attachPrompt));
    const sent = bodies.join("\n");
    const received = {
      attachmentPath: sent.includes("chat-attachments/") && sent.includes(notes.name),
      attachedContents: sent.includes("NOTES_FILE_5521") && sent.includes("ROSTER_FILE_8830"),
      unpickedContents: sent.includes("UNPICKED_FILE_6604"),
      connectorInstruction: hiddenConnectorInstruction.test(sent),
      pastedTail: sent.includes(pastedTail),
    };
    evidence.recordAssertionEvidence("The model request carries what the message hides", `${bodies.length} model request(s); ${JSON.stringify(received)}`,
      bodies.length > 0 && received.attachmentPath && received.attachedContents && !received.unpickedContents && received.connectorInstruction && received.pastedTail);
    expect(bodies.length).toBeGreaterThan(0);
    expect(received).toEqual({ attachmentPath: true, attachedContents: true, unpickedContents: false, connectorInstruction: true, pastedTail: true });
  });

  await step("after: reopening the conversation shows the same chips from the saved message", async () => {
    await user.reload();
    await user.see({ text: world.attachReply }, { timeoutMs: 60_000 });
    const reloaded = await probe.eventually(() => chips('[data-message-role="user"]'), {
      within: 30_000, label: "the saved message shows all three chips", until: (value) => Boolean(value.file && value.connector && value.pasted),
    });
    await user.notSee({ text: hiddenNote });
    await user.notSee({ text: hiddenConnectorInstruction });
    evidence.recordAssertionEvidence("The saved message keeps its chips", `file "${reloaded.file}"; connector "${reloaded.connector}"; pasted "${reloaded.pasted}"`,
      reloaded.connector === composed.connector && reloaded.pasted === composed.pasted && reloaded.file.includes(notes.name));
    expect(reloaded.connector).toBe(composed.connector);
    expect(reloaded.pasted).toBe(composed.pasted);
    expect(reloaded.file).toContain(notes.name);
    await user.screenshot();
  });
});

const secondLine = "Then list the open questions.";
const video = "pasted-recording.mp4";

test(`a member (${resolveEvalEngine()}): a screenshot and long text I paste between two lines stay there in my message`, async ({ world, user, probe, step, evidence }) => {
  // Reads the draft or the sent message in document order as named pieces.
  const order = async (scope: string) => {
    const selectors = ['[data-lexical-text="true"]', ".whitespace-pre-wrap", '[data-composer-badge="pasted"]', "img"];
    const { elements } = await probe.dom(selectors.map((selector) => `${scope} ${selector}`).join(", "));
    const pieces = elements.map((element) => element.tag === "img" ? "screenshot"
      : element.text.includes("Pasted text") ? "pasted text"
        : element.text.includes(world.attachPrompt) ? "first line"
          : element.text.includes(secondLine) ? "second line" : "");
    return pieces.filter((piece, index) => piece && piece !== pieces[index - 1]).join(" → ");
  };
  const expected = "first line → screenshot → pasted text → second line";

  await step("before: the draft has two lines and the caret sits on the empty line between them", async () => {
    await user.type("composer", world.attachPrompt);
    await user.press("Shift+Enter");
    await user.press("Shift+Enter");
    await user.type("composer", secondLine);
    await user.press("Home");
    await user.press("ArrowLeft");
    const draft = await order('[contenteditable="true"]');
    evidence.recordAssertionEvidence("The draft has two lines", draft, draft === "first line → second line");
    expect(draft).toBe("first line → second line");
    await user.screenshot();
  });

  await step("after: the pasted screenshot and the collapsed pasted text sit on that line, between the two lines", async () => {
    await world.pasteImageIntoComposer("pasted-screenshot.png");
    await probe.eventually(() => order('[contenteditable="true"]'), {
      within: 10_000, label: "the screenshot chip appears", until: (value) => value.includes("screenshot"),
    });
    await world.pasteIntoComposer(pasted);
    const draft = await probe.eventually(() => order('[contenteditable="true"]'), {
      within: 10_000, label: "the pasted-text chip appears", until: (value) => value.includes("pasted text"),
    });
    await user.notSee({ text: pastedTail });
    evidence.recordAssertionEvidence("The pasted items stay where the caret was", draft, draft === expected);
    expect(draft).toBe(expected);
    await user.screenshot();
  });

  await step("after: the sent message keeps the screenshot and pasted text between the two lines", async () => {
    await user.click("Run task");
    await user.see({ text: world.attachReply }, { timeoutMs: 90_000 });
    const sent = await probe.eventually(() => order('[data-message-role="user"]'), {
      within: 15_000, label: "the sent message shows both pasted items", until: (value) => value.includes("screenshot") && value.includes("pasted text"),
    });
    evidence.recordAssertionEvidence("The sent message keeps the composed order", sent, sent === expected);
    expect(sent).toBe(expected);
    await user.screenshot();
  });

  await step("then the model received the pasted text between the two lines", async () => {
    await user.see({ text: world.attachReply });
    const body = world.providerBodies().filter((request) => request.includes(world.attachPrompt)).at(-1) ?? "";
    const positions = [world.attachPrompt, pastedTail, secondLine].map((text) => body.indexOf(text));
    const between = positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1)));
    evidence.recordAssertionEvidence("The model request keeps the composed order", `first line at ${positions[0]}, pasted text ends at ${positions[1]}, second line at ${positions[2]}`, between);
    expect(between).toBe(true);
  });

  await step("a pasted video is sent and stays in the message, also after reopening, without a binary-file model error", async () => {
    const replies = (await probe.dom('[data-message-role="assistant"]')).elements.length;
    await user.type("composer", world.attachPrompt);
    await world.pasteVideoIntoComposer(video);
    await user.see({ text: video });
    await user.click("Run task");
    await probe.eventually(async () => (await probe.dom('[data-message-role="assistant"]')).elements.length, {
      within: 90_000, label: "the video message is answered", until: (count) => count > replies,
    });
    const sentWithVideo = (await probe.dom('[data-message-role="user"]')).elements.filter((element) => element.text.includes(video));
    expect(sentWithVideo).toHaveLength(1);
    await user.notSee({ text: /Cannot read binary file|UnsupportedFunctionalityError/ });
    await user.reload();
    await user.see({ text: video }, { timeoutMs: 60_000 });
    await user.notSee({ text: /Cannot read binary file|UnsupportedFunctionalityError/ });
    await user.screenshot();
  });
});
