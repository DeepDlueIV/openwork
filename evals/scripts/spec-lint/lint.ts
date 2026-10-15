// Lint for the eval tiers. Every rule is an error with no baseline, and every
// message tells the author (usually an agent) what to do instead.
//
//   evals/core/*.e2e.test.ts      core journeys: every rule
//   evals/proofs/*.proof.test.ts  one-off agent evals: every rule except promise-required
//   evals/specs/                  retired: any file there is rejected
import ts from "typescript";
import { promises, sharedWorlds, type ProductPromise } from "../../promises.ts";

export type Tier = "core" | "proof" | "specs";

export const leakageRules = [
  "e2e-only",
  "no-source-import",
  "no-mocks",
  "no-node-backdoor",
  "no-silent-skip",
  "assert-observable",
] as const;

export const qualityRules = [
  "no-backdoor",
  "no-sleep",
  "no-self-graded-evidence",
  "no-new-world",
  "max-size",
  "promise-required",
] as const;

export type Rule = (typeof leakageRules)[number] | (typeof qualityRules)[number];

export interface Violation {
  rule: Rule;
  file: string;
  line: number;
  message: string;
}

export const MAX_LINES = 250;

const ALLOWED_PACKAGES = new Set(["@openwork/testkit", "@openwork/behaviors", "@openwork/matchers", "vitest", "zod"]);
// Public contract packages: the schemas and SDK a real client of the product uses.
const PUBLIC_CONTRACT = /^@openwork\/(types|sdk)(\/|$)/;
const BANNED_NODE_MODULES = new Set(["fs", "fs/promises", "child_process", "net"]);
const MOCK_CALLS = new Set(["vi.mock", "vi.doMock", "vi.fn", "vi.spyOn", "vi.stubGlobal", "vi.stubEnv", "vi.useFakeTimers"]);
const SKIP_METHODS = new Set(["skip", "skipIf", "runIf", "only", "todo"]);
const SLEEP_CALLS = new Set(["setTimeout", "setInterval", "sleep", "delay", "waitForTimeout"]);
const BACKDOOR_CALLS = new Set(["evalIn", "denFetch", "executeJavaScript", "addInitScript"]);
const BACKDOOR_METHODS = new Set(["evaluate", "evalIn", "eval"]);
const DATABASE_CALL = /queryDenDatabase|denDatabase|createPool|createConnection/;
const OBSERVE_METHODS = new Set(["see", "notSee", "looks", "eventually"]);
const OBSERVE_IMPORT = /^(expect|assert|see|verify)/;

export function tierOf(file: string): Tier | null {
  if (file.startsWith("core/")) return "core";
  if (file.startsWith("proofs/")) return "proof";
  if (file.startsWith("specs/")) return "specs";
  return null;
}

export function rulesFor(tier: Tier): ReadonlySet<Rule> {
  if (tier === "specs") return new Set<Rule>(["e2e-only"]);
  const rules = new Set<Rule>([...leakageRules, ...qualityRules]);
  if (tier === "proof") rules.delete("promise-required");
  return rules;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
}

/** The core journeys an author should extend instead of adding a test. */
export function closestJourneys(text: string, limit = 2): ProductPromise[] {
  const wanted = words(text);
  return promises
    .map((promise) => {
      const vocabulary = words([promise.id, promise.promise, ...promise.core].join(" "));
      let score = 0;
      for (const word of wanted) if (vocabulary.has(word)) score += 1;
      return { promise, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.promise);
}

function journeyHint(text: string): string {
  const closest = closestJourneys(text);
  if (closest.length === 0) return "No core journey matches; propose a promise in evals/promises.ts.";
  return `Extend the closest core journey instead: ${closest.map((promise) => `${promise.id} (core/${promise.core[0]}.e2e.test.ts)`).join(" or ")}.`;
}

const MESSAGES = {
  "e2e-only": (file: string) =>
    `This is a unit or integration test. Put it next to the module it tests (apps/*/test, ee/apps/*/test, packages/*/src/*.test.ts). Evals only prove user-visible behavior through a real build. ${journeyHint(file)}`,
  "no-source-import": (specifier: string) =>
    `Imports "${specifier}". Drive the built app/server. If you need a capability, add a user.* or api.* behavior to @openwork/behaviors.`,
  "no-mocks": (call: string) =>
    `${call}: mocks prove nothing end to end. Use a world seed or a fault server (see the fake-model-faults skill).`,
  "no-node-backdoor": (what: string) =>
    `${what}: observe the result the way a user or client would (UI, public API, MCP). Infrastructure belongs in the world, not the spec.`,
  "no-silent-skip": (call: string) =>
    `${call}: a skip must be reported, not hidden. Declare what the test needs with spec.world(world, { needs }) so a missing requirement shows as Incomplete.`,
  "assert-observable": (title: string) =>
    `"${title}" never asserts what a person or client observes. Assert what the person sees (user.see / user.notSee), or what a client reads (expect on an API response, probe.eventually), not internal state.`,
  "no-backdoor": (what: string) =>
    `${what}: reaches around the product. Use a user.* or api.* behavior from @openwork/behaviors; if none exists, add one.`,
  "no-sleep": (call: string) =>
    `${call}: fixed waits make tests slow and flaky. Wait for an observable state with probe.eventually or user.see({ ... }, { timeoutMs }).`,
  "no-self-graded-evidence": () =>
    `recordAssertionEvidence(..., true) grades itself. Pass the result of a check you made, or replace it with expect/user.see.`,
  "no-new-world": (specifier: string) =>
    `Imports "${specifier}", which is not a shared world. Extend one of the shared worlds in evals/promises.ts (sharedWorlds) with a seed option instead of adding a world.`,
  "max-size": (lines: number) =>
    `${lines} lines (max ${MAX_LINES}). Move repeated steps into @openwork/behaviors so the spec reads as the journey.`,
  "promise-required": (name: string) =>
    `core/${name}.e2e.test.ts is not the core journey of any promise in evals/promises.ts. Add your steps to an existing core journey, write a one-off proof in evals/proofs/, or propose a promise in review.`,
} as const;

function calleeText(node: ts.Expression, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function lastName(text: string): string {
  const parts = text.split(".");
  return parts[parts.length - 1] ?? text;
}

function titleText(node: ts.Node, source: ts.SourceFile): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText(source).slice(1, -1);
  return node.getText(source);
}

function moduleName(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

function isSourceImport(specifier: string): boolean {
  if (specifier.startsWith("@/")) return true;
  if (/^(\.\.\/)+(apps|ee)\//.test(specifier)) return true;
  if (/^(\.\.\/)*(\.\.\/)?packages\/[^/]+\/src(\/|$)/.test(specifier)) return true;
  if (/^(\.\.\/){2,}packages\//.test(specifier)) return true;
  if (/^(\.\.\/){2,}\.github\//.test(specifier)) return true;
  if (specifier.startsWith("/")) return true;
  if (specifier.startsWith("@openwork/") && !ALLOWED_PACKAGES.has(specifier) && !PUBLIC_CONTRACT.test(specifier)) return true;
  return false;
}

function isWorldImport(specifier: string): boolean {
  return /^(\.\.\/)+worlds\//.test(specifier);
}

function worldName(specifier: string): string {
  return specifier.replace(/^(\.\.\/)+worlds\//, "").replace(/\.ts$/, "");
}

export function lintSource(file: string, text: string): Violation[] {
  const tier = tierOf(file);
  if (tier === null) return [];
  const rules = rulesFor(tier);
  const violations: Violation[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const report = (rule: Rule, node: ts.Node | null, message: string) => {
    if (!rules.has(rule)) return;
    const line = node ? source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 : 1;
    violations.push({ rule, file, line, message });
  };

  if (tier === "specs") {
    report("e2e-only", null, `evals/specs is retired. Add a step to a core journey in evals/core (see evals/promises.ts), or write a one-off proof in evals/proofs/*.proof.test.ts. ${journeyHint(`${file} ${text.slice(0, 2000)}`)}`);
    return violations;
  }
  const expectedSuffix = tier === "proof" ? ".proof.test.ts" : ".e2e.test.ts";
  if (!file.endsWith(expectedSuffix)) {
    report("e2e-only", null, MESSAGES["e2e-only"](`${file} ${text.slice(0, 2000)}`));
    return violations;
  }

  const lineCount = text.split("\n").length;
  if (lineCount > MAX_LINES) report("max-size", null, MESSAGES["max-size"](lineCount));

  const testBindings = new Set<string>();
  const observingImports = new Set<string>();
  const localFunctions = new Map<string, ts.Node>();

  const checkSpecifier = (specifier: string, node: ts.Node, typeOnly: boolean) => {
    const name = moduleName(specifier);
    if (BANNED_NODE_MODULES.has(name) || /^mysql/.test(name) || /mysql2/.test(specifier)) {
      report("no-node-backdoor", node, MESSAGES["no-node-backdoor"](`import "${specifier}"`));
      return;
    }
    if (isWorldImport(specifier)) {
      if (!sharedWorlds.includes(worldName(specifier))) report("no-new-world", node, MESSAGES["no-new-world"](specifier));
      return;
    }
    // Type-only imports are erased; they cannot reach around the product.
    if (typeOnly && specifier.startsWith("@openwork/")) return;
    if (isSourceImport(specifier)) report("no-source-import", node, MESSAGES["no-source-import"](specifier));
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      checkSpecifier(specifier, statement, statement.importClause?.isTypeOnly === true);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if ((specifier === "@openwork/testkit" || specifier === "vitest") && (imported === "test" || imported === "it")) testBindings.add(element.name.text);
          if (OBSERVE_IMPORT.test(imported) && specifier.startsWith("@openwork/")) observingImports.add(element.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      checkSpecifier(statement.moduleSpecifier.text, statement, statement.isTypeOnly);
    }
  }

  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) localFunctions.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = node.initializer;
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) localFunctions.set(node.name.text, initializer.body);
      if (ts.isCallExpression(initializer)) {
        const callee = calleeText(initializer.expression, source);
        if (/^spec\.\w+$/.test(callee) || /\.extend$/.test(callee) || testBindings.has(callee.split(".")[0] ?? "")) testBindings.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const tests: { title: string; node: ts.CallExpression; body: ts.Node | undefined }[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = calleeText(node.expression, source);
      const name = lastName(callee);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        checkSpecifier(node.arguments[0].text, node, false);
      }
      if (callee === "require" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) checkSpecifier(node.arguments[0].text, node, false);
      if (MOCK_CALLS.has(callee)) report("no-mocks", node, MESSAGES["no-mocks"](callee));
      if (SKIP_METHODS.has(name) && callee.includes(".") && !callee.startsWith("vi.")) {
        const owner = callee.split(".")[0] ?? "";
        if (testBindings.has(owner) || owner === "describe" || owner === "ctx" || owner === "context") report("no-silent-skip", node, MESSAGES["no-silent-skip"](callee));
      }
      if (SLEEP_CALLS.has(callee) || SLEEP_CALLS.has(name)) report("no-sleep", node, MESSAGES["no-sleep"](callee));
      if (DATABASE_CALL.test(name)) report("no-node-backdoor", node, MESSAGES["no-node-backdoor"](callee));
      if (BACKDOOR_CALLS.has(callee) || BACKDOOR_CALLS.has(name) || (callee.includes(".") && BACKDOOR_METHODS.has(name)) || callee === "client.send" || callee === "probe.eval" || /(^|\.)\w*[pP]robe\.storage$/.test(callee) || /^(window\.)?localStorage\./.test(callee)) {
        report("no-backdoor", node, MESSAGES["no-backdoor"](callee));
      }
      if (name === "recordAssertionEvidence") {
        const last = node.arguments[node.arguments.length - 1];
        if (last && last.kind === ts.SyntaxKind.TrueKeyword) report("no-self-graded-evidence", node, MESSAGES["no-self-graded-evidence"]());
      }
      const first = node.arguments[0];
      if (ts.isIdentifier(node.expression) && testBindings.has(node.expression.text) && first && !ts.isArrowFunction(first) && !ts.isFunctionExpression(first) && !ts.isObjectLiteralExpression(first)) {
        const last = node.arguments[node.arguments.length - 1];
        const body = last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) ? last
          : last && ts.isIdentifier(last) ? localFunctions.get(last.text) : undefined;
        if (body || (last && ts.isIdentifier(last))) tests.push({ title: titleText(first, source), node, body });
      }
    }
    if (ts.isNewExpression(node) && calleeText(node.expression, source) === "URL") {
      const [first, base] = node.arguments ?? [];
      if (first && base && ts.isStringLiteral(first) && base.getText(source) === "import.meta.url" && /^(\.\.\/)+(apps|ee|packages|\.github)\//.test(first.text)) {
        report("no-source-import", node, MESSAGES["no-source-import"](first.text));
      }
    }
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && /__openwork|__OPENWORK/.test(node.text)) {
      report("no-backdoor", node, MESSAGES["no-backdoor"](node.text));
    }
    if (ts.isStringLiteral(node) && /^(window\.)?__openwork/i.test(node.text)) report("no-backdoor", node, MESSAGES["no-backdoor"](node.text));
    ts.forEachChild(node, visit);
  };
  visit(source);

  // A local helper observes if it (transitively) calls an observation.
  const observes = (body: ts.Node, observing: ReadonlySet<string>): boolean => {
    let found = false;
    const walk = (node: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const callee = calleeText(node.expression, source);
        const head = callee.split(/[.(]/)[0] ?? "";
        if (head === "expect" || OBSERVE_METHODS.has(lastName(callee)) || observing.has(callee) || observingImports.has(head)) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
    return found;
  };
  const observingLocals = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of localFunctions) {
      if (!observingLocals.has(name) && observes(body, observingLocals)) {
        observingLocals.add(name);
        changed = true;
      }
    }
  }

  if (tests.length === 0) report("assert-observable", null, MESSAGES["assert-observable"]("(no test found)"));
  for (const test of tests) {
    if (!test.body || !observes(test.body, observingLocals)) report("assert-observable", test.node, MESSAGES["assert-observable"](test.title));
  }
  if (tier === "core") {
    const name = file.replace(/^core\//, "").replace(/\.e2e\.test\.ts$/, "");
    if (!promises.some((promise) => promise.core.some((core) => core === name))) report("promise-required", null, MESSAGES["promise-required"](name));
  }

  return violations;
}
