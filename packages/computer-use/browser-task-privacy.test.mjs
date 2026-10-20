import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runComputerProgram } from "@openwork/computer-use/runtime";
import { createBrowserTaskHost } from "./browser-task.mjs";

test("select options keep backing identities private and revalidate before choosing", async () => {
  const options = [
    { value: "private-account-001", label: "Personal", selected: true, disabled: false },
    { value: "private-account-002", label: "Work", selected: false, disabled: false },
    { value: "private-account-003", label: "Unavailable", selected: false, disabled: true },
  ];
  class Element {
    tagName = "SELECT"; parentElement = null; isConnected = true; multiple = false; options = options;
    validity = { valid: false }; validationMessage = "private-account-001";
    get value() { return this.selectedOptions[0]?.value ?? ""; }
    get selectedOptions() { return options.filter(option => option.selected); }
    getAttribute(name) { return name === "aria-label" ? "Account" : null; }
    hasAttribute() { return false; }
    matches() { return false; }
    closest() { return null; }
    getBoundingClientRect() { return { x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 }; }
    focus() { document.activeElement = this; }
    dispatchEvent() {}
    contains(element) { return element === this; }
  }
  const select = new Element();
  const document = { title: "Accounts", body: { innerText: "Choose an account" }, activeElement: select,
    getElementById: () => null, elementFromPoint: () => select,
    querySelectorAll: query => query.startsWith('input[type="password"]') ? [] : [select] };
  const context = vm.createContext({ document, HTMLElement: Element, HTMLSelectElement: Element,
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLLabelElement: class {}, HTMLOptGroupElement: class {},
    getComputedStyle: () => ({ visibility: "visible", display: "block", overflowX: "visible", overflowY: "visible" }),
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, performance, setTimeout, Event });
  const tab = { tabId: "tab", webMcpRevision: 0, view: { webContents: { isDestroyed: () => false,
    getURL: () => "https://example.com/", executeJavaScriptInIsolatedWorld: async (_world, scripts) => vm.runInContext(scripts[0].code, context) } } };
  const host = createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => "tab",
    enabled: () => true, allowed: async () => true, changed: () => {}, isVisible: () => true });
  const observe = () => host.request({ sessionId: "chat", operation: "observe", args: { tabId: "tab" } });
  const act = (seen, value) => host.request({ sessionId: "chat", operation: "act", args: { tabId: "tab", observationId: seen.observationId,
    action: { type: "select", ref: seen.elements[0].ref, values: [value] } } });
  const seen = await observe();
  assert.equal(seen.ok, true, JSON.stringify(seen));
  assert.ok(!JSON.stringify(seen).includes("private-account"));
  const work = seen.elements[0].options.find(option => option.label === "Work").value;
  const chosen = await act(seen, work);
  assert.equal(chosen.ok, true, JSON.stringify(chosen));
  assert.equal(select.value, "private-account-002");
  assert.ok(!JSON.stringify(chosen).includes("private-account"));
  const fresh = await observe();
  const blocked = fresh.elements[0].options.find(option => option.disabled).value;
  assert.equal((await act(fresh, blocked)).code, "option_unavailable");
  const stale = await observe();
  const personal = stale.elements[0].options.find(option => option.label === "Personal").value;
  options[0].value = "different-private-identity";
  assert.equal((await act(stale, personal)).code, "stale_observation");
  assert.equal(select.value, "private-account-002");
  let inputChecks = 0;
  const resizingHost = createBrowserTaskHost({ getTab: () => tab, tabsFor: () => [tab], ownerOf: () => "chat", activeFor: () => "tab",
    enabled: () => true, allowed: async () => true, changed: () => {}, isVisible: () => true,
    beforeInput: async () => { if (++inputChecks === 1) context.innerWidth = 900; } });
  const program = await runComputerProgram({ surface: "browser", code: 'return await tools.ui.select({target:{name:"Account"},option:"Personal"});' }, {
    computer: async () => { throw new Error("Wrong surface"); },
    browser: (operation, args, signal) => resizingHost.request({ sessionId: "chat", operation, args }, { signal }),
  }, new AbortController().signal);
  assert.equal(program.ok, true, JSON.stringify(program));
  assert.equal(select.value, "different-private-identity");
  assert.equal(inputChecks, 2);
  assert.ok(!JSON.stringify(program).includes("private-identity"));
});
