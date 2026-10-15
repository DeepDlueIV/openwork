// Lints evals/core and evals/proofs (and rejects anything in the retired
// evals/specs), and checks evals/promises.ts against evals/core. Exits 1 on any error.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promises } from "../../promises.ts";
import { lintSource, type Violation } from "./lint.ts";

const evalsRoot = fileURLToPath(new URL("../..", import.meta.url));

function filesIn(directory: string): string[] {
  const root = join(evalsRoot, directory);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "README.md" && !entry.parentPath.split(sep).includes("node_modules"))
    .map((entry) => relative(evalsRoot, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

const files = ["core", "proofs", "specs"].flatMap(filesIn);
const errors: Violation[] = [];
for (const file of files) {
  const text = readFileSync(join(evalsRoot, file), "utf8");
  errors.push(...lintSource(file, text));
}

const ids = new Set<string>();
const listed = new Set<string>();
for (const promise of promises) {
  if (ids.has(promise.id)) errors.push({ rule: "promise-required", file: "promises.ts", line: 1, message: `Duplicate promise id ${promise.id}.` });
  ids.add(promise.id);
  for (const name of promise.core) {
    const file = `core/${name}.e2e.test.ts`;
    if (listed.has(name)) errors.push({ rule: "promise-required", file: "promises.ts", line: 1, message: `${file} is listed under two promises.` });
    listed.add(name);
    if (!files.includes(file)) errors.push({ rule: "promise-required", file: "promises.ts", line: 1, message: `${promise.id} lists ${file}, which does not exist. Restore the journey or change the promise in review.` });
  }
}

for (const violation of errors) console.error(`evals/${violation.file}:${violation.line} spec/${violation.rule}: ${violation.message}`);
console.log(`spec-lint: ${files.length} files, ${errors.length} errors.`);
if (errors.length > 0) process.exitCode = 1;
