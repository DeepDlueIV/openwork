import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { closestJourneys, leakageRules, lintSource, qualityRules, type Rule } from "./lint.ts";

const fixtures = new URL("./fixtures/", import.meta.url);

function fixture(name: string): { file: string; text: string } {
  const raw = readFileSync(new URL(`${name}.txt`, fixtures), "utf8");
  const [header = "", ...rest] = raw.split("\n");
  const file = /^\/\/ path: (.+)$/.exec(header)?.[1];
  if (!file) throw new Error(`${name}.txt must start with "// path: <tier>/<file>"`);
  return { file, text: rest.join("\n") };
}

function rulesFired(name: string): Rule[] {
  const { file, text } = fixture(name);
  return [...new Set(lintSource(file, text).map((violation) => violation.rule))];
}

const allRules: Rule[] = [...leakageRules, ...qualityRules];

describe("spec-lint", () => {
  test("every rule has a bad fixture", () => {
    const names = readdirSync(fixtures).map((name) => name.replace(/\.txt$/, ""));
    expect(allRules.filter((rule) => !names.includes(rule))).toEqual([]);
  });

  test.each(allRules)("spec/%s fires on its bad fixture", (rule) => {
    expect(rulesFired(rule)).toContain(rule);
  });

  test.each(["clean-core", "clean-proof"])("%s passes every rule", (name) => {
    const { file, text } = fixture(name);
    expect(lintSource(file, text)).toEqual([]);
  });

  test("a rejected unit test is pointed at the closest core journey", () => {
    const { file, text } = fixture("e2e-only");
    const [violation] = lintSource(file, text);
    expect(violation?.message).toMatch(/Extend the closest core journey instead: [A-Z-]+ \(core\/[a-z0-9-]+\.e2e\.test\.ts\)/);
    expect(closestJourneys("member api key isolation connection")[0]?.id).toBeDefined();
  });

  test("evals/specs is retired: any file there is rejected, even a clean journey", () => {
    const { text } = fixture("clean-proof");
    expect(lintSource("specs/composer-draft.e2e.test.ts", text).map((violation) => violation.rule)).toEqual(["e2e-only"]);
  });

  test("a proof must use the proof suffix and a core journey the e2e suffix", () => {
    const { text } = fixture("clean-proof");
    expect(lintSource("proofs/composer-draft.e2e.test.ts", text).map((violation) => violation.rule)).toEqual(["e2e-only"]);
  });
});
