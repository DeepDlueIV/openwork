#!/usr/bin/env node
// Internal, fictional workplace browser for demo-atlassian.mjs. No build or dependencies.
// HOST=127.0.0.1 PORT=3992 ATLASSIAN_BASE_URL=http://127.0.0.1:3991 node demo-workplace-ui.mjs
// The upstream is operator-configured, never supplied by an HTTP caller. No real tokens are read.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3992);
const upstream = new URL(process.env.ATLASSIAN_BASE_URL || "http://127.0.0.1:3991");
if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== "/") {
  throw new Error("ATLASSIAN_BASE_URL must be an HTTP origin without credentials, path, query, or fragment.");
}
const csrf = randomBytes(24).toString("hex");
const MAX_BODY = 1024 * 1024;

// Native controls intentionally replace framework primitives in this standalone eval fixture.
const css = `
:root{color-scheme:light;--background:#fafbfc;--surface:#f7f8fa;--ink:#172b4d;--muted:#626f86;--border:rgba(9,30,66,.14);--primary:#0c66e4;--accent:#011627;--radius:.45rem;--danger:#ae2e24;--space:16px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--background)}
*{box-sizing:border-box}body{margin:0}a{color:var(--primary);text-decoration:none}a:hover{text-decoration:underline}button,input,select,textarea{font:inherit;color:inherit}button,select,input,textarea{border:1px solid var(--border);border-radius:var(--radius);background:var(--background);padding:7px 10px}button{cursor:pointer;font-weight:500}button:hover{background:#e9edf3}button:disabled{opacity:.55;cursor:wait}.primary{background:var(--primary);color:#f7faff;border-color:transparent}.primary:hover{background:#0055cc}:focus-visible{outline:2px solid var(--primary);outline-offset:3px}header{height:58px;display:flex;align-items:center;gap:26px;padding:0 24px;border-bottom:1px solid var(--border);background:var(--background)}header a{color:var(--ink)}.brand{display:flex;align-items:center;gap:9px;font-size:19px;font-weight:650;letter-spacing:-.6px}.brand svg{width:25px;height:28px}header nav{display:flex;gap:24px;height:100%;align-items:center}header nav a[aria-current]{color:var(--primary);font-weight:600}.spacer{flex:1}.demo,.muted{color:var(--muted)}.demo{font-size:11px}.avatar{display:inline-grid;place-items:center;border-radius:50%;width:29px;height:29px;background:#dce8fc;color:#09326c;font-size:11px;font-weight:600}.layout{display:grid;grid-template-columns:238px minmax(0,1fr);min-height:calc(100vh - 58px)}aside{background:var(--surface);border-right:1px solid var(--border);padding:24px 14px}aside h2{font-size:13px;margin:0 10px 20px}aside a{display:block;padding:8px 10px;border-radius:4px;color:var(--ink);overflow-wrap:anywhere}aside a.selected{background:#e9f2ff;color:var(--primary);font-weight:600}aside details{margin:9px 0}aside summary{cursor:pointer;font-weight:600;padding:7px 8px}aside .tree a{font-size:12px;padding-top:6px;padding-bottom:6px}main{padding:28px 34px;min-width:0}.breadcrumb{color:var(--muted);margin-bottom:14px;font-size:12px}.titlebar,.toolbar{display:flex;gap:12px;align-items:center;margin-bottom:22px}h1{font-size:20px;letter-spacing:-.4px;line-height:1.4;margin:0;font-weight:600}h2{font-size:15px;font-weight:600;margin:24px 0 12px}h3{font-size:14px}label{display:grid;gap:5px;font-weight:500}input[type=search]{width:280px}table{width:100%;border-collapse:collapse;text-align:left}th{color:var(--muted);font-size:12px;font-weight:600}th,td{padding:12px 10px;border-bottom:1px solid var(--border);vertical-align:top}tbody tr:hover{background:var(--surface)}td.summary{min-width:230px}td.nowrap{white-space:nowrap}.status{display:inline-block;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:650;background:#e4e7ec;color:#44546f;white-space:nowrap}.status.indeterminate{background:#e9f2ff;color:#0055cc}.status.done{background:#dcfff1;color:#216e4e}.tag{display:inline-block;background:#edf0f5;border-radius:3px;padding:2px 7px;margin:3px 5px 0 0;font-size:12px}.issue-grid{display:grid;grid-template-columns:minmax(0,1fr) 265px;gap:38px}.properties{padding-left:24px;border-left:1px solid var(--border)}.properties label{margin-bottom:18px}.properties select{width:100%}.copy{white-space:pre-wrap;line-height:1.75}.comment{border-top:1px solid var(--border);padding:16px 0}.comment p{margin:7px 0}.comment time{font-size:11px;color:var(--muted);margin-left:9px}textarea{width:100%;min-height:95px;resize:vertical}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}dialog{width:min(580px,95vw);border:0;border-radius:10px;padding:26px;background:var(--background);box-shadow:0 16px 48px rgba(9,30,66,.25);color:var(--ink)}dialog::backdrop{background:rgba(9,30,66,.42)}dialog h2{margin-top:0;font-size:20px}dialog label{margin-top:15px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:15px}.document{max-width:880px;font-size:14px;line-height:1.8;min-height:180px;overflow-wrap:anywhere}.document h1{font-size:20px;margin:22px 0 12px}.document h2{font-size:18px;margin-top:28px}.document h3{font-size:15px}.document p{margin:12px 0}.document table{margin:20px 0;font-size:13px}.document th,.document td{border:1px solid var(--border);padding:9px 12px}.document th{background:var(--surface);color:var(--ink)}.document blockquote{margin:16px 0;border-left:3px solid var(--border);padding-left:16px;color:var(--muted)}.document pre{background:var(--surface);padding:12px;white-space:pre-wrap}.document[contenteditable=true]{padding:18px;border:1px solid var(--primary);border-radius:var(--radius)}.metadata{color:var(--muted);margin-bottom:28px;font-size:12px}.page-list{max-width:880px}.page-row{display:block;border-bottom:1px solid var(--border);padding:17px 2px;font-weight:500}.page-row small{display:block;font-weight:400;color:var(--muted);margin-top:4px}#notice{position:sticky;top:0;padding:9px 24px;background:#fff3d5;color:#7f5f01;border-bottom:1px solid var(--border)}#notice:empty{display:none}.skeleton{height:15px;background:#e8ecf1;border-radius:3px;margin:15px 0;width:65%}.skeleton:nth-child(2n){width:90%}.empty{padding:30px 0;color:var(--muted)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}#edit-title{font-size:20px;width:100%;margin-bottom:16px}footer{margin-top:28px;color:var(--muted);font-size:11px}@media(max-width:900px){.layout{grid-template-columns:185px minmax(0,1fr)}main{padding:22px 18px}.issue-grid{grid-template-columns:1fr}.properties{border-left:0;padding-left:0}.table-wrap{overflow:auto}.demo{display:none}header{gap:18px;padding:0 16px}}@media(max-width:600px){.layout{display:block}aside{border-right:0;border-bottom:1px solid var(--border)}aside h2{margin-bottom:4px}header nav{gap:12px}.toolbar{flex-wrap:wrap}input[type=search]{width:100%}}
`;

function client() {
  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const options = (items, selected, value = "name", title = "name") => items.map((item) => `<option value="${escape(item[value])}" ${String(item[value]) === String(selected) ? "selected" : ""}>${escape(item[title])}</option>`).join("");
  const date = (value) => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const issuePath = (key) => `/jira/browse/${encodeURIComponent(key)}`;
  const pagePath = (id) => `/confluence/pages/${encodeURIComponent(id)}`;
  const jira = "/jira/rest/api/2";
  const confluence = "/confluence/rest/api";
  let projects = [], people = [], priorities = [], pages = [], spaces = [], issues = [];
  let currentPage, editingVersion, busy = false, refreshing = false, lastVerified = "";
  const isJira = location.pathname.startsWith("/jira");
  const key = isJira ? decodeURIComponent(location.pathname.split("/")[3] || "") : "";
  const pageId = !isJira ? decodeURIComponent(location.pathname.split("/")[3] || "") : "";
  const notice = (message) => {
    $("notice").textContent = message;
    if ($("create-error")) $("create-error").textContent = $("create-dialog").open ? message : "";
  };
  function patch(id, html) {
    const node = $(id);
    if (node && node.innerHTML !== html && !node.contains(document.activeElement)) node.innerHTML = html;
  }
  async function api(path, method = "GET", body) {
    const response = await fetch("/api/atlassian" + path, {
      method, headers: { "Content-Type": "application/json", "X-Demo-CSRF": document.querySelector('meta[name="demo-csrf"]').content },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.message || data?.errorMessages?.join("; ") || `Request failed (${response.status}).`);
    return data;
  }
  async function mutate(action) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button[type="submit"], .properties select').forEach((control) => { control.disabled = true; });
    try { await action(); notice(""); await refresh(); }
    catch (error) { notice(`${error.message} Your changes are kept. Try again.`); }
    finally { busy = false; document.querySelectorAll('button[type="submit"], .properties select').forEach((control) => { control.disabled = false; }); }
  }
  // Rebuild allowed markup, never reuse source nodes/attributes. Scripts, SVG, embeds,
  // styles, event handlers, remote media and non-workplace links cannot enter the live DOM.
  function safeStorage(storage) {
    const source = new DOMParser().parseFromString(String(storage || ""), "text/html");
    const allowed = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "B", "EM", "I", "U", "S", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "BLOCKQUOTE", "PRE", "CODE", "BR", "HR"]);
    const discarded = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE", "IMG", "LINK", "META", "FORM", "INPUT", "BUTTON"]);
    function localLink(href) {
      if (!href) return null;
      try {
        const url = new URL(href, location.origin);
        const issue = /^(?:\/jira)?\/browse\/([A-Z][A-Z0-9_]*-\d+)$/.exec(url.pathname);
        if (issue) return issuePath(issue[1]);
        const page = /^\/confluence\/pages\/(\d+)$/.exec(url.pathname);
        if (page) return pagePath(page[1]);
        if (/\/(?:pages\/)?viewpage\.action$/.test(url.pathname) && /^\d+$/.test(url.searchParams.get("pageId") || "")) return pagePath(url.searchParams.get("pageId"));
      } catch { /* Non-workplace links are plain text. */ }
      return null;
    }
    function copy(node, parent) {
      if (node.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(node.textContent)); return; }
      if (node.nodeType !== Node.ELEMENT_NODE || discarded.has(node.tagName)) return;
      let target = parent;
      const href = node.tagName === "A" ? localLink(node.getAttribute("href")) : null;
      if (allowed.has(node.tagName) || href) {
        target = document.createElement(href ? "a" : node.tagName.toLowerCase());
        if (href) target.setAttribute("href", href);
        parent.append(target);
      }
      for (const child of node.childNodes) copy(child, target);
    }
    const result = document.createElement("div");
    for (const node of source.body.childNodes) copy(node, result);
    return result.innerHTML;
  }
  function status(value) { return `<span class="status ${escape(value?.statusCategory?.key || "")}">${escape(value?.name)}</span>`; }
  function renderIssues() {
    const query = $("search").value.toLowerCase();
    const project = $("project-filter").value;
    const filtered = issues.filter((issue) => (!project || issue.fields.project.key === project) && `${issue.key} ${issue.fields.summary} ${issue.fields.description || ""} ${(issue.fields.labels || []).join(" ")}`.toLowerCase().includes(query));
    patch("issue-count", `${filtered.length} issues`);
    patch("issue-rows", filtered.length ? filtered.map((issue) => {
      const f = issue.fields;
      return `<tr><td class="nowrap"><a href="${issuePath(issue.key)}">${escape(issue.key)}</a></td><td class="summary"><a href="${issuePath(issue.key)}">${escape(f.summary)}</a></td><td>${escape(f.issuetype?.name)}</td><td>${status(f.status)}</td><td>${escape(f.priority?.name)}</td><td class="nowrap">${escape(f.assignee?.displayName || "Unassigned")}</td><td class="nowrap muted">${escape(date(f.updated))}</td></tr>`;
    }).join("") : '<tr><td colspan="7" class="empty">No matching issues. Change your filters or create an issue.</td></tr>');
  }
  function renderTree() {
    function branch(parent, list, depth = 0, visited = new Set()) {
      if (depth > 15 || visited.has(parent)) return "";
      const seen = new Set(visited).add(parent);
      return list.filter((p) => (p.ancestors?.at(-1)?.id || "") === parent).map((p) => `<a style="padding-left:${12 + depth * 14}px" href="${pagePath(p.id)}" class="${p.id === pageId ? "selected" : ""}" ${p.id === pageId ? 'aria-current="page"' : ""}>${escape(p.title)}</a>${branch(p.id, list, depth + 1, seen)}`).join("");
    }
    // Preserve disclosure state across polling, including keyboard-focused summaries.
    const open = new Map([...document.querySelectorAll("#space-tree details")].map((node) => [node.dataset.space, node.open]));
    patch("space-tree", spaces.map((s) => `<details data-space="${escape(s.key)}" ${open.get(s.key) !== false ? "open" : ""}><summary>${escape(s.name)}</summary><div class="tree">${branch("", pages.filter((p) => p.space?.key === s.key))}</div></details>`).join(""));
  }
  function renderPages() {
    const query = $("search").value.toLowerCase();
    const matches = pages.filter((p) => `${p.title} ${p.space?.name} ${p.body?.storage?.value?.replace(/<[^>]*>/g, " ") || ""}`.toLowerCase().includes(query));
    patch("page-results", matches.length ? matches.map((p) => `<a class="page-row" href="${pagePath(p.id)}">${escape(p.title)}<small>${escape(p.space?.name)} · ${escape(p.version?.by?.displayName || "")} · ${escape(date(p.version?.when))}</small></a>`).join("") : '<p class="empty">No matching pages. Try another search.</p>');
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      if (isJira) {
        if (key) {
          const [issue, transitions] = await Promise.all([api(`${jira}/issue/${encodeURIComponent(key)}?fields=*all`), api(`${jira}/issue/${encodeURIComponent(key)}/transitions`)]);
          const f = issue.fields;
          $("issue-title").textContent = f.summary;
          patch("issue-description", escape(f.description || "No description yet."));
          patch("issue-labels", (f.labels || []).map((label) => `<span class="tag">${escape(label)}</span>`).join(""));
          patch("issue-meta", `${escape(f.issuetype?.name)} · Reported by ${escape(f.reporter?.displayName || "Unknown")} · Updated ${escape(date(f.updated))}`);
          patch("issue-status", `<option value="">${escape(f.status.name)}</option>${options(transitions.transitions.filter((t) => t.to.name !== f.status.name), null, "id")}`);
          patch("issue-priority", options(priorities, f.priority?.name));
          patch("issue-assignee", `<option value="">Unassigned</option>${options(people, f.assignee?.name, "name", "displayName")}`);
          patch("issue-comments", (f.comment?.comments || []).map((c) => `<article class="comment"><strong>${escape(c.author?.displayName)}</strong><time>${escape(date(c.created))}</time><p class="copy">${escape(c.body)}</p></article>`).join("") || '<p class="muted">No comments yet.</p>');
        } else {
          const result = await api(`${jira}/search?jql=${encodeURIComponent("ORDER BY updated DESC")}&maxResults=1000&fields=*all`);
          issues = result.issues; renderIssues();
        }
      } else {
        const [spaceResult, pageResult] = await Promise.all([api(`${confluence}/space?limit=500`), api(`${confluence}/content?type=page&limit=500&expand=space,ancestors,body.storage,version,metadata.labels`)]);
        spaces = spaceResult.results; pages = pageResult.results; renderTree();
        if (pageId) {
          currentPage = await api(`${confluence}/content/${encodeURIComponent(pageId)}?expand=space,ancestors,body.storage,version,history,metadata.labels`);
          const p = currentPage;
          patch("page-breadcrumb", [p.space?.name, ...(p.ancestors || []).map((a) => a.title)].map(escape).join(" / "));
          $("page-title").textContent = p.title;
          patch("page-meta", `Edited by ${escape(p.version?.by?.displayName)} · ${escape(date(p.version?.when))} · Version ${escape(p.version?.number)}`);
          patch("page-labels", (p.metadata?.labels?.results || []).map((label) => `<span class="tag">${escape(label.name)}</span>`).join(""));
          if (!editingVersion) patch("document", safeStorage(p.body?.storage?.value));
          else if (p.version.number !== editingVersion) notice("This page changed while you were editing. Copy your draft, cancel, and edit the latest version before saving.");
          $("edit-page").disabled = false;
        } else renderPages();
      }
      lastVerified = new Date().toLocaleTimeString();
      $("sync-state").textContent = `Live · Last synced ${lastVerified}`;
      if ($("notice").textContent.startsWith("Couldn't sync")) notice("");
    } catch (error) { notice(`Couldn't sync: ${error.message} Last verified ${lastVerified || "not yet"}. Retrying automatically.`); }
    finally { refreshing = false; }
  }
  function shell() {
    if (isJira) {
      $("sidebar").innerHTML = `<h2>Acme Robotics</h2><a class="selected" href="/jira">All issues</a><a href="/confluence">Team knowledge</a>`;
      $("main").innerHTML = key ? `<div class="breadcrumb"><a href="/jira">Issues</a> / ${escape(key)}</div><div class="titlebar"><h1 id="issue-title">${escape(key)}</h1></div><div class="issue-grid"><section><div id="issue-meta" class="metadata"></div><h2>Description</h2><div id="issue-description" class="copy"><div class="skeleton"></div></div><div id="issue-labels"></div><h2>Activity</h2><div id="issue-comments"></div><form id="comment-form"><label for="comment-body">Add a comment</label><textarea id="comment-body" required placeholder="Write a comment…"></textarea><div class="actions"><button type="submit" class="primary">Post comment</button></div></form></section><section class="properties" aria-label="Issue details"><h2>Details</h2><label>Status<select id="issue-status"></select></label><label>Priority<select id="issue-priority"></select></label><label>Assignee<select id="issue-assignee"></select></label></section></div>` : `<div class="breadcrumb">Projects / Issues</div><div class="titlebar"><h1>All issues</h1><span class="spacer"></span><button class="primary" id="create-issue">Create issue</button></div><div class="toolbar"><label><span class="sr-only">Search issues</span><input type="search" id="search" placeholder="Search issues"></label><label><span class="sr-only">Project</span><select id="project-filter"><option value="">All projects</option>${options(projects, null, "key")}</select></label><span id="issue-count" class="muted"></span></div><div class="table-wrap"><table><thead><tr><th>Key</th><th>Summary</th><th>Type</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Updated</th></tr></thead><tbody id="issue-rows"><tr><td colspan="7"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></td></tr></tbody></table></div>`;
      if (key) {
        $("issue-status").onchange = (event) => { const value = event.target.value; if (value) mutate(() => api(`${jira}/issue/${encodeURIComponent(key)}/transitions`, "POST", { transition: { id: value } })); };
        for (const field of ["priority", "assignee"]) $("issue-" + field).onchange = (event) => {
          const value = event.target.value;
          mutate(() => api(`${jira}/issue/${encodeURIComponent(key)}`, "PUT", { fields: { [field]: value ? { name: value } : null } }));
        };
        $("comment-form").onsubmit = (event) => { event.preventDefault(); const value = $("comment-body").value; if (!value.trim()) return; mutate(async () => { await api(`${jira}/issue/${encodeURIComponent(key)}/comment`, "POST", { body: value }); $("comment-body").value = ""; }); };
      } else {
        $("search").oninput = renderIssues;
        $("project-filter").onchange = renderIssues;
        $("create-issue").onclick = () => { $("create-error").textContent = ""; $("create-dialog").showModal(); };
      }
    } else {
      $("sidebar").innerHTML = '<h2><a href="/confluence">Acme knowledge</a></h2><div id="space-tree"></div>';
      $("main").innerHTML = pageId ? '<div id="page-breadcrumb" class="breadcrumb">Spaces</div><div class="titlebar"><h1 id="page-title">Page</h1><span class="spacer"></span><button id="edit-page" disabled>Edit page</button></div><div id="page-meta" class="metadata"></div><div id="editor-controls" hidden><label for="edit-title">Page title</label><input id="edit-title" required><div class="toolbar"><button id="save-page" class="primary">Save changes</button><button id="cancel-edit">Cancel</button><span class="muted">Rich text · formatting is preserved</span></div></div><article id="document" class="document"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></article><div id="page-labels"></div>' : '<div class="breadcrumb">Acme Robotics / Knowledge</div><div class="titlebar"><h1>Pages</h1></div><div class="toolbar"><label><span class="sr-only">Search pages</span><input id="search" type="search" placeholder="Search pages and spaces"></label></div><div id="page-results" class="page-list"><div class="skeleton"></div><div class="skeleton"></div></div>';
      if (!pageId) $("search").oninput = renderPages;
      else {
        function endEditing() {
          editingVersion = null; $("document").removeAttribute("contenteditable"); $("document").removeAttribute("role"); $("document").removeAttribute("aria-label");
          $("editor-controls").hidden = true; $("edit-page").hidden = false;
        }
        $("edit-page").onclick = () => {
          editingVersion = currentPage.version.number; $("edit-title").value = currentPage.title;
          $("editor-controls").hidden = false; $("edit-page").hidden = true;
          $("document").contentEditable = "true"; $("document").setAttribute("role", "textbox"); $("document").setAttribute("aria-label", "Page body"); $("document").setAttribute("aria-multiline", "true"); $("document").focus();
        };
        $("document").addEventListener("paste", (event) => {
          if (!editingVersion) return;
          event.preventDefault();
          const selection = window.getSelection();
          if (!selection.rangeCount) return;
          const range = selection.getRangeAt(0); range.deleteContents();
          const fragment = range.createContextualFragment(event.clipboardData.getData("text/html") ? safeStorage(event.clipboardData.getData("text/html")) : escape(event.clipboardData.getData("text/plain")).replace(/\n/g, "<br>"));
          const last = fragment.lastChild; range.insertNode(fragment); if (last) { range.setStartAfter(last); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
        });
        $("document").addEventListener("drop", (event) => { if (editingVersion) event.preventDefault(); });
        $("cancel-edit").onclick = () => { endEditing(); notice(""); patch("document", safeStorage(currentPage.body?.storage?.value)); $("edit-page").focus(); };
        $("save-page").onclick = () => {
          if (!$("edit-title").reportValidity()) return;
          const title = $("edit-title").value.trim(); if (!title) return;
          const body = safeStorage($("document").innerHTML);
          mutate(async () => {
            $("save-page").disabled = true;
            try { await api(`${confluence}/content/${encodeURIComponent(pageId)}`, "PUT", { id: pageId, type: "page", title, version: { number: editingVersion + 1 }, body: { storage: { value: body, representation: "storage" } } }); endEditing(); $("edit-page").focus(); }
            finally { $("save-page").disabled = false; }
          });
        };
      }
    }
  }
  async function start() {
    if (isJira) {
      try { [projects, people, priorities] = await Promise.all([api(`${jira}/project`), api(`${jira}/user/search?username=&maxResults=1000`), api(`${jira}/priority`)]); }
      catch (error) { notice(`Couldn't load issue controls: ${error.message} Reload after starting the demo backend.`); }
    }
    shell();
    $("new-project").innerHTML = options(projects, projects[0]?.key, "key");
    $("new-priority").innerHTML = options(priorities, "Medium");
    $("new-assignee").innerHTML = '<option value="">Unassigned</option>' + options(people, null, "name", "displayName");
    function updateTypes() {
      const project = projects.find((p) => p.key === $("new-project").value);
      const names = project?.projectTypeKey === "service_desk" ? ["IT Help", "Service Request", "Incident", "Task"] : project?.projectTypeKey === "business" ? ["Task"] : ["Task", "Story", "Bug", "Epic"];
      $("new-type").innerHTML = options(names.map((name) => ({ name })), "Task");
    }
    $("new-project").onchange = updateTypes; updateTypes();
    $("cancel-create").onclick = () => $("create-dialog").close();
    $("create-form").onsubmit = (event) => {
      event.preventDefault();
      mutate(async () => {
        const assignee = $("new-assignee").value;
        const created = await api(`${jira}/issue`, "POST", { fields: { project: { key: $("new-project").value }, summary: $("new-summary").value.trim(), description: $("new-description").value, issuetype: { name: $("new-type").value }, priority: { name: $("new-priority").value }, assignee: assignee ? { name: assignee } : null } });
        $("create-dialog").close(); location.assign(issuePath(created.key));
      });
    };
    await refresh();
    setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 2000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  }
  void start();
}

const jiraLogo = '<svg viewBox="0 0 28 28" aria-hidden="true"><path fill="#1868db" d="M14 1 27 14 14 27 1 14z"/><path fill="#f7faff" d="m14 8 6 6-6 6-6-6z"/></svg>';
const confluenceLogo = '<svg viewBox="0 0 28 28" aria-hidden="true"><path fill="#1868db" d="M3 7c6-9 13 10 20 1l4 5C17 27 10 4 6 13zm22 14C19 30 12 11 5 20l-4-5C11 1 18 24 22 15z"/></svg>';
function html(isJira) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="demo-csrf" content="${csrf}"><title>${isJira ? "Jira" : "Confluence"} · Acme Robotics demo</title><link rel="stylesheet" href="/styles.css"><script src="/app.js" defer></script></head><body><header><a class="brand" href="${isJira ? "/jira" : "/confluence"}">${isJira ? jiraLogo + "Jira" : confluenceLogo + "Confluence"}</a><nav aria-label="Workplace"><a href="/jira" ${isJira ? 'aria-current="page"' : ""}>Projects</a><a href="/confluence" ${!isJira ? 'aria-current="page"' : ""}>Spaces</a></nav><span class="spacer"></span><span class="demo">Demo · fictional workspace</span><span class="avatar" title="Alex Chen" aria-label="Alex Chen">AC</span></header><div id="notice" role="status" aria-live="polite"></div><div class="layout"><aside id="sidebar" aria-label="${isJira ? "Projects" : "Spaces and pages"}"></aside><main><div id="main"><div class="skeleton"></div><div class="skeleton"></div></div><footer id="sync-state">Not synced yet</footer></main></div><dialog id="create-dialog" aria-labelledby="create-heading"><form id="create-form"><h2 id="create-heading">Create issue</h2><p id="create-error" role="alert"></p><div class="columns"><label>Project<select id="new-project" required></select></label><label>Issue type<select id="new-type" required></select></label></div><label>Summary<input id="new-summary" required maxlength="255"></label><label>Description<textarea id="new-description"></textarea></label><div class="columns"><label>Priority<select id="new-priority"></select></label><label>Assignee<select id="new-assignee"></select></label></div><div class="actions"><button type="button" id="cancel-create">Cancel</button><button type="submit" class="primary">Create issue</button></div></form></dialog></body></html>`;
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://demo.local");
    if (url.pathname === "/health" && req.method === "GET") return send(res, 200, { ok: true, service: "demo-workplace-ui", fictional: true });
    if (url.pathname.startsWith("/api/atlassian/")) {
      const path = url.pathname.slice("/api/atlassian".length);
      if (!/^\/(jira\/rest\/(api\/2|servicedeskapi)|confluence\/rest\/api)(\/|$)/.test(path) || /%2f|%5c|%2e/i.test(path) || path.includes("\\")) return send(res, 400, { message: "Only demo Jira and Confluence REST paths are allowed." });
      if (!["GET", "POST", "PUT", "DELETE"].includes(req.method)) return send(res, 405, { message: "Method not allowed." });
      if (req.method !== "GET" && req.headers["x-demo-csrf"] !== csrf) return send(res, 403, { message: "Open the demo page before making changes." });
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return send(res, 413, { message: "Request exceeds the demo's 1 MB limit." });
        chunks.push(chunk);
      }
      const destination = new URL(upstream.origin + path + url.search);
      if (destination.origin !== upstream.origin) return send(res, 400, { message: "Invalid demo destination." });
      const response = await fetch(destination, {
        method: req.method, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { Authorization: "Bearer demo-pat", "Content-Type": "application/json", Accept: "application/json" },
        ...(size ? { body: Buffer.concat(chunks) } : {}),
      });
      const body = await response.text();
      if (response.status === 204) { res.writeHead(204, { "Cache-Control": "no-store" }); return res.end(); }
      // Never reflect executable upstream content or forward cookies/auth headers.
      let data;
      try { data = JSON.parse(body); } catch { return send(res, 502, { message: "The demo backend returned an invalid response." }); }
      return send(res, response.status, data);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { message: "Method not allowed." });
    if (url.pathname === "/") { res.writeHead(302, { Location: "/jira" }); return res.end(); }
    // The real Atlassian MCP returns these Data Center browse links. Keep them clickable in the demo.
    if (url.pathname === "/confluence/pages/viewpage.action" && /^\d+$/.test(url.searchParams.get("pageId") || "")) {
      res.writeHead(302, { Location: `/confluence/pages/${url.searchParams.get("pageId")}` }); return res.end();
    }
    if (url.pathname === "/app.js") return send(res, 200, `(${client.toString()})();`, "text/javascript");
    if (url.pathname === "/styles.css") return send(res, 200, css, "text/css");
    if (/^\/jira(?:\/browse\/[A-Z][A-Z0-9_]*-\d+)?\/?$/.test(url.pathname) || /^\/confluence(?:\/pages\/\d+)?\/?$/.test(url.pathname)) return send(res, 200, html(url.pathname.startsWith("/jira")), "text/html");
    return send(res, 404, { message: "Page not found. Open /jira or /confluence." });
  } catch {
    return send(res, 502, { message: "The demo backend is unavailable. Start demo-atlassian.mjs and retry." });
  }
});
server.listen(PORT, HOST, () => console.log(`Demo workplace UI: http://${HOST}:${PORT}/jira (fictional workspace)`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
