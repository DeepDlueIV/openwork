import { renderMarkdownHtml } from "./markdown-primitive";

/**
 * One clipboard document for chat Markdown, whichever way a person copies it.
 *
 * The chat dresses Markdown for reading: a grey italic quote, link favicons,
 * code blocks with buttons. A mail or document editor pastes that dressing as
 * text formatting, and the buttons' hidden labels as words. Both copy paths,
 * the Copy button and a selection, go through here, so they paste the same
 * document: the structure the reply was written with, not how the chat shows it.
 */

const KEPT_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
  "input", "li", "ol", "p", "pre", "s", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
const INLINE_TAGS = new Set(["a", "b", "code", "del", "em", "i", "s", "strong", "sub", "sup"]);
const KEPT_ATTRIBUTES: Record<string, string[]> = {
  a: ["href"],
  img: ["src", "alt"],
  input: ["type", "checked", "disabled"],
  ol: ["start"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
};
/** Controls and decorations the chat adds around the content. */
const CHROME = ["button", "svg", "video", "[hidden]", ".sr-only", "[aria-hidden='true']"].join(", ");

export type ClipboardContent = { plain: string; html: string };

function unwrap(element: Element) {
  element.replaceWith(...element.childNodes);
}

function cleanClipboardTree(root: HTMLElement) {
  // Rendered stand-ins go back to what the reply wrote.
  for (const video of root.querySelectorAll("[data-openwork-video]")) {
    const fallback = video.querySelector(":scope > [data-openwork-video-fallback]");
    video.replaceWith(...(fallback ? Array.from(fallback.childNodes) : []));
  }
  for (const diagram of root.querySelectorAll("[data-openwork-mermaid]")) {
    const source = diagram.querySelector("pre[data-openwork-mermaid-source]");
    if (source) diagram.replaceWith(source);
    else diagram.remove();
  }
  for (const math of root.querySelectorAll(".katex")) {
    const tex = math.querySelector("annotation[encoding='application/x-tex']")?.textContent ?? math.textContent ?? "";
    math.replaceWith(root.ownerDocument.createTextNode(tex));
  }
  for (const preview of root.querySelectorAll("[data-openwork-image-preview]")) unwrap(preview);
  for (const chrome of root.querySelectorAll(CHROME)) chrome.remove();

  for (const element of root.querySelectorAll("*")) {
    const tag = element.tagName.toLowerCase();
    // Local paths and in-app references mean nothing outside OpenWork.
    if (tag === "a" && !/^(?:https?:|mailto:)/i.test(element.getAttribute("href") ?? "")) {
      unwrap(element);
      continue;
    }
    if (tag === "img" && !/^https?:/i.test(element.getAttribute("src") ?? "")) {
      element.replaceWith(root.ownerDocument.createTextNode(element.getAttribute("alt") ?? ""));
      continue;
    }
    if (!KEPT_TAGS.has(tag)) {
      unwrap(element);
      continue;
    }
    const kept = KEPT_ATTRIBUTES[tag] ?? [];
    for (const name of element.getAttributeNames()) {
      if (!kept.includes(name)) element.removeAttribute(name);
    }
  }
  // Highlighted code is one span per token; the paste only needs its text.
  for (const pre of root.querySelectorAll("pre")) {
    const code = root.ownerDocument.createElement("code");
    code.textContent = pre.textContent ?? "";
    pre.replaceChildren(code);
  }
}

/** Plain text as the browser lays it out, read from an offscreen copy of the cleaned tree. */
function plainTextOf(root: HTMLElement) {
  const doc = root.ownerDocument;
  const holder = doc.createElement("div");
  holder.style.cssText = "position:fixed;left:-100000px;top:0;width:800px;white-space:normal;pointer-events:none;";
  holder.setAttribute("aria-hidden", "true");
  holder.append(root.cloneNode(true));
  for (const image of holder.querySelectorAll("img")) image.replaceWith(doc.createTextNode(image.getAttribute("alt") ?? ""));
  doc.body.append(holder);
  try {
    return holder.innerText.replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    holder.remove();
  }
}

/** Rich text for the Copy button, rendered from the Markdown the reply was written in. */
export function clipboardHtmlFromMarkdown(markdown: string, doc: Document = document) {
  const root = doc.createElement("div");
  // renderMarkdownHtml sanitizes its output.
  root.innerHTML = renderMarkdownHtml(markdown, "chat");
  cleanClipboardTree(root);
  return root.innerHTML.trim();
}

/**
 * Write a reply as Markdown for plain-text editors (and the composer) and as
 * clean rich text for mail and document editors.
 */
export async function copyMarkdownToClipboard(markdown: string) {
  const html = clipboardHtmlFromMarkdown(markdown);
  if (!html || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
    await navigator.clipboard.writeText(markdown);
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({
    "text/plain": new Blob([markdown], { type: "text/plain" }),
    "text/html": new Blob([html], { type: "text/html" }),
  })]);
}

/**
 * The selected part of a rendered Markdown root as clipboard content, or null
 * when the selection reaches outside it. A selection inside a quote, list or
 * table keeps that container, as the person sees it around their selection.
 */
export function clipboardContentFromSelection(markdownRoot: Element, selection: Selection | null): ClipboardContent | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  if (!ranges.every((range) => markdownRoot.contains(range.commonAncestorContainer))) return null;

  const root = markdownRoot.ownerDocument.createElement("div");
  for (const range of ranges) {
    let content: Node = range.cloneContents();
    const common = range.commonAncestorContainer;
    // Within one text node only inline formatting applies (part of a link or
    // of bold text); across nodes the surrounding blocks apply too.
    const withinText = common.nodeType === Node.TEXT_NODE;
    for (let ancestor = common instanceof Element ? common : common.parentElement; ancestor && ancestor !== markdownRoot; ancestor = ancestor.parentElement) {
      const tag = ancestor.tagName.toLowerCase();
      if (!KEPT_TAGS.has(tag) || (withinText && !INLINE_TAGS.has(tag))) continue;
      const shell = ancestor.cloneNode(false);
      shell.appendChild(content);
      content = shell;
    }
    root.append(content);
  }
  cleanClipboardTree(root);
  const copied = { html: root.innerHTML.trim(), plain: plainTextOf(root) };
  return copied.plain || copied.html ? copied : null;
}
