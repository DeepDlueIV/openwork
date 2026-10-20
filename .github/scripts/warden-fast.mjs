#!/usr/bin/env node
// Fast Warden feedback: re-review only the files whose own changes moved.
//
//   ci     warden-quick.yml, after each push to a same-repository PR. Finds the
//          newest complete Warden review of this PR (the full review or an
//          earlier quick one), fingerprints each file's own change then and
//          now, and runs Warden on the files that moved. Security findings
//          for unchanged files carry over. Advisory only: it never approves,
//          and the full Warden review still decides clearance.
//   local  `pnpm warden:quick` and the optional pre-push hook. The same check
//          on your branch before pushing, against your last local review.
//
// A file's fingerprint covers only the lines its change adds and removes (plus
// mode and binary markers), never line numbers or surrounding context. Merging
// or rebasing dev keeps it unless dev touched the change itself or a conflict
// was resolved inside it.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseWardenJsonl, safe } from "./contributor-screen.mjs";

export const SKILLS = ["diff-security-review", "confidentiality-review"];
// Below this, the full review is already about as fast as a partial one.
export const MIN_PR_FILES = 15;
// Above this share of moved files, wait for the full review instead.
export const MAX_MOVED_SHARE = 0.5;
export const QUICK_ARTIFACT = "warden-quick-baseline";
const FULL_ARTIFACT = "warden-findings";
const SEVERITIES = ["high", "medium", "low"];
const MAX_FINDINGS = 50;

// --- Fingerprints -----------------------------------------------------------------

/** Fingerprint of one file's `git diff -U0` patch: its own added and removed lines. */
export function fingerprintPatch(patch) {
  const hash = createHash("sha256");
  const header = [];
  let body = false;
  for (const line of patch.split("\n")) {
    if (!body) {
      if (line.startsWith("@@")) body = true;
      else header.push(line);
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+") || line.startsWith("-") || line === "\\ No newline at end of file") hash.update(`${line}\n`);
  }
  const binary = header.some((line) => line.startsWith("Binary files "));
  for (const line of header) {
    if (/^(old mode|new mode|deleted file mode|new file mode) /.test(line)) hash.update(`${line}\n`);
    // Binary content is only visible through its blob ids.
    if (binary && line.startsWith("index ")) hash.update(`${line.split(" ")[1]}\n`);
  }
  return hash.digest("hex");
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function mergeBase(cwd, a, b) {
  return git(cwd, ["merge-base", a, b]).trim();
}

/** Fingerprints of every file a branch changes, from its merge base. */
export function fingerprints(cwd, base, head) {
  const files = git(cwd, ["diff", "--name-only", "-z", "--no-renames", base, head]).split("\0").filter(Boolean);
  return Object.fromEntries(files.map((file) => [file, fingerprintPatch(git(cwd,
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0", base, head, "--", file]))]));
}

// --- Planning ---------------------------------------------------------------------

// Warden path patterns treat `*` and `?` as wildcards; anything else matches literally.
const literalPath = (file) => !/[*?\u0000-\u001f\u007f]/.test(file);

/** Which files to review now. `baseline` holds the fingerprints of the last complete review. */
export function planReview(baseline, current, { minFiles = MIN_PR_FILES, maxShare = MAX_MOVED_SHARE } = {}) {
  const total = Object.keys(current).length;
  const moved = Object.keys(current).filter((file) => baseline?.[file] !== current[file]).sort();
  const removed = baseline ? Object.keys(baseline).filter((file) => !(file in current)).sort() : [];
  if (total < minFiles) return { mode: "small", moved, removed };
  if (!baseline) return { mode: "no-baseline", moved, removed };
  if (!moved.length) return { mode: "carry", moved, removed };
  if (moved.length > total * maxShare) return { mode: "too-many", moved, removed };
  if (!moved.every(literalPath)) return { mode: "unsupported-path", moved, removed };
  return { mode: "partial", moved, removed };
}

/** The trusted policy with each skill limited to `files`. Null if the policy isn't the expected shape. */
export function quickConfig(policy, files) {
  const paths = `paths = [${files.map((file) => JSON.stringify(file)).join(", ")}]`;
  const lines = policy.split("\n");
  const out = [];
  let inSkill = false;
  let inserted = 0;
  for (const line of lines) {
    // Local triggers use `minConfidence = "low"`; keep the quick review as strict as CI.
    if (/^\s*minConfidence\s*=/.test(line)) continue;
    out.push(line);
    if (/^\[\[skills\]\]\s*$/.test(line)) inSkill = true;
    else if (/^\[/.test(line)) inSkill = false;
    else if (inSkill && /^name\s*=\s*"[^"]+"\s*$/.test(line)) {
      out.push(paths);
      inserted += 1;
      inSkill = false;
    }
  }
  const skills = lines.filter((line) => /^\[\[skills\]\]\s*$/.test(line)).length;
  if (!skills || inserted !== skills || /^\s*paths\s*=/m.test(policy)) return null;
  return out.join("\n");
}

// --- Findings ---------------------------------------------------------------------

const cleanText = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";

/** Security findings in the shared artifact shape, from a Warden JSONL parse. */
export function securityFrom(parsed) {
  return parsed.findings.filter((finding) => finding.skill === "diff-security-review").map((finding) => ({
    severity: finding.severity,
    title: cleanText(finding.title, 300),
    description: cleanText(finding.description, 2000),
    path: typeof finding.location?.path === "string" ? finding.location.path.slice(0, 240) : null,
    line: Number.isSafeInteger(finding.location?.startLine) && finding.location.startLine > 0 ? finding.location.startLine : null,
  }));
}

/** Fresh findings for moved files plus earlier ones for files that didn't move. */
export function mergeFindings(previous, fresh, { moved, removed }) {
  const stale = new Set([...moved, ...removed]);
  const carried = previous.filter((finding) => !finding.path || !stale.has(finding.path))
    .map((finding) => ({ ...finding, source: "carried" }));
  return [...fresh.map((finding) => ({ ...finding, source: "new" })), ...carried]
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

/** Validates a downloaded baseline artifact against the run it came from. */
export function validBaseline(artifact, run, expected) {
  const findings = artifact?.findings;
  return artifact?.complete === true && artifact.schema_version === 1 && artifact.repository === expected.repository &&
    artifact.pr === expected.pr && artifact.head_sha === run.head_sha && String(artifact.run_id) === String(run.id) &&
    /^[0-9a-f]{40}$/.test(artifact.head_sha) && Number.isSafeInteger(artifact.total) && Array.isArray(findings) &&
    findings.every((finding) => SEVERITIES.includes(finding?.severity) && typeof finding.title === "string" &&
      typeof finding.description === "string" && (finding.path === null || typeof finding.path === "string"));
}

// --- Rendering --------------------------------------------------------------------

// GitHub workflow command escaping for annotation values and properties.
const commandData = (value) => String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const commandProperty = (value) => commandData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** Inline annotations on the PR diff; GitHub shows at most 10 warnings/errors per step. */
export function annotations(findings, limit = 10) {
  return findings.filter((finding) => finding.path).slice(0, limit).map((finding) => {
    const level = finding.severity === "high" ? "error" : "warning";
    const where = `file=${commandProperty(finding.path)}${finding.line ? `,line=${finding.line}` : ""}`;
    const title = commandProperty(`Warden quick review (${finding.severity}${finding.source === "carried" ? ", earlier review" : ""})`);
    return `::${level} ${where},title=${title}::${commandData(`${finding.title}\n\n${finding.description}`.slice(0, 1800))}`;
  });
}

const PLAN_TEXT = {
  small: "This PR is small, so the full Warden review is already quick. No partial review ran.",
  "no-baseline": "No complete Warden review of this PR yet. The full Warden review covers this push.",
  "too-many": "Most of the PR's files changed since the last complete review. The full Warden review covers this push.",
  "unsupported-path": "A changed file name can't be used as a Warden path filter. The full Warden review covers this push.",
  "missing-baseline-commit": "The last reviewed commit is no longer available. The full Warden review covers this push.",
};

export function renderSummary({ plan, total, findings, omitted, baselineUrl, confidentiality, complete, reason }) {
  const lines = ["### Warden quick review (advisory)", ""];
  if (PLAN_TEXT[plan.mode]) {
    lines.push(PLAN_TEXT[plan.mode], "");
    return lines.join("\n");
  }
  const reviewed = plan.mode === "carry"
    ? "Nothing in the PR's own changes moved since the last complete review, so its findings carry over."
    : `Re-reviewed ${plan.moved.length} of ${total} files whose own changes moved since the last complete review.`;
  lines.push(reviewed, baselineUrl ? `Earlier findings come from [that review](${baselineUrl}).` : "", "");
  if (!complete) lines.push(`**Incomplete** (${safe(reason, 80)}): findings below are partial. The full Warden review still runs.`, "");
  if (confidentiality) lines.push(`${confidentiality} confidentiality finding(s) in the re-reviewed files. Details are omitted here; check the added diff for outside identities.`, "");
  if (!findings.length) lines.push(complete ? "No security findings." : "No security findings so far.");
  else {
    lines.push("| Severity | Finding | Where | From |", "| --- | --- | --- | --- |");
    for (const finding of findings.slice(0, MAX_FINDINGS)) {
      lines.push(`| ${finding.severity} | ${safe(finding.title, 200)} | ${finding.path ? `\`${safe(finding.path, 200)}${finding.line ? `:${finding.line}` : ""}\`` : "—"} | ${finding.source === "new" ? "this push" : "earlier review"} |`);
    }
  }
  if (omitted) lines.push("", `${omitted} more finding(s) from the last full review aren't listed; see that run.`);
  lines.push("", "This is fast feedback only. Clearance still comes from the full Warden review of this exact commit.", "");
  return lines.join("\n");
}

// --- Running Warden ---------------------------------------------------------------

/** Runs the Warden CLI on `files` between `base` and `head`; returns the parsed JSONL. */
export function runWarden({ cwd, wardenBin, policy, files, base, head, env, outDir }) {
  const config = quickConfig(policy, files);
  if (!config) return { complete: false, reason: "unexpected-policy", findings: [] };
  const configPath = join(cwd, ".warden-quick.toml");
  const jsonl = join(outDir, "warden-quick.jsonl");
  writeFileSync(configPath, config);
  rmSync(jsonl, { force: true });
  try {
    const command = wardenBin ? ["node", [wardenBin]] : ["pnpm", ["dlx", "@sentry/warden@0.43.0"]];
    const result = spawnSync(command[0], [...command[1], `${base}..${head}`, "-C", cwd, "--config-path", configPath,
      "--runtime", "pi", "--fail-on", "off", "--log", "-o", jsonl], { cwd, env, stdio: ["ignore", "inherit", "inherit"], timeout: 45 * 60 * 1000 });
    if (result.error) return { complete: false, reason: "warden-did-not-start", findings: [] };
  } finally {
    rmSync(configPath, { force: true });
  }
  return parseWardenJsonl(existsSync(jsonl) ? readFileSync(jsonl, "utf8") : "", SKILLS);
}

// --- CI ---------------------------------------------------------------------------

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** Newest complete review of this PR: a full Warden run or an earlier quick review. */
function findBaseline({ repo, pr, headRef, outDir }) {
  const runs = [];
  for (const [workflow, artifact] of [["warden.yml", FULL_ARTIFACT], ["warden-quick.yml", QUICK_ARTIFACT]]) {
    let listed;
    try {
      listed = JSON.parse(gh(["api", `repos/${repo}/actions/workflows/${workflow}/runs?event=pull_request&status=completed&branch=${encodeURIComponent(headRef)}&per_page=30`]));
    } catch {
      // A workflow that hasn't reached the default branch yet has no runs to offer.
      continue;
    }
    for (const run of listed.workflow_runs ?? []) {
      if (run.conclusion !== "success" || run.head_repository?.full_name !== repo) continue;
      if (!(run.pull_requests ?? []).some((item) => item.number === pr)) continue;
      runs.push({ run, artifact });
    }
  }
  runs.sort((a, b) => Date.parse(b.run.updated_at) - Date.parse(a.run.updated_at));
  for (const { run, artifact } of runs.slice(0, 10)) {
    const dir = join(outDir, `baseline-${run.id}`);
    try {
      gh(["run", "download", String(run.id), "--repo", repo, "--name", artifact, "--dir", dir]);
      const file = readdirSync(dir).find((name) => name.endsWith(".json"));
      const data = file ? JSON.parse(readFileSync(join(dir, file), "utf8")) : null;
      if (validBaseline(data, run, { repository: repo, pr })) return { data, url: run.html_url };
    } catch {
      // Missing or expired artifact: try the next older review.
    }
  }
  return null;
}

function hasCommit(cwd, sha) {
  if (spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd }).status === 0) return true;
  spawnSync("git", ["fetch", "--quiet", "--no-tags", "origin", sha], { cwd });
  return spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd }).status === 0;
}

async function ci(env) {
  for (const name of ["REPO", "PR_NUMBER", "HEAD_SHA", "BASE_SHA", "HEAD_REF", "PR_DIR", "OUT_DIR", "RUN_ID", "POLICY_PATH"]) {
    if (!env[name]) throw new Error(`${name} is required`);
  }
  const pr = Number(env.PR_NUMBER);
  const cwd = env.PR_DIR;
  mkdirSync(env.OUT_DIR, { recursive: true });
  const summary = (text) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); console.log(text); };
  const current = fingerprints(cwd, mergeBase(cwd, env.BASE_SHA, env.HEAD_SHA), env.HEAD_SHA);
  const total = Object.keys(current).length;
  if (total < MIN_PR_FILES) return summary(renderSummary({ plan: { mode: "small" } }));

  const baseline = findBaseline({ repo: env.REPO, pr, headRef: env.HEAD_REF, outDir: env.OUT_DIR });
  if (baseline && !hasCommit(cwd, baseline.data.head_sha)) return summary(renderSummary({ plan: { mode: "missing-baseline-commit" } }));
  const before = baseline ? fingerprints(cwd, mergeBase(cwd, env.BASE_SHA, baseline.data.head_sha), baseline.data.head_sha) : null;
  const plan = planReview(before, current);
  if (PLAN_TEXT[plan.mode]) return summary(renderSummary({ plan }));

  let parsed = { complete: true, findings: [] };
  if (plan.mode === "partial") {
    parsed = runWarden({ cwd, wardenBin: env.WARDEN_BIN, policy: readFileSync(env.POLICY_PATH, "utf8"), files: plan.moved,
      base: mergeBase(cwd, env.BASE_SHA, env.HEAD_SHA), head: env.HEAD_SHA, env: process.env, outDir: env.OUT_DIR });
  }
  // If the re-review didn't finish, keep the earlier findings for the files it covered.
  const findings = mergeFindings(baseline.data.findings, securityFrom(parsed), parsed.complete ? plan : { moved: [], removed: plan.removed });
  const omitted = Math.max(0, baseline.data.total - baseline.data.findings.length);
  const confidentiality = parsed.findings.filter((finding) => finding.skill === "confidentiality-review").length;
  summary(renderSummary({ plan, total, findings, omitted, baselineUrl: baseline.url, confidentiality, complete: parsed.complete, reason: parsed.reason }));
  for (const line of annotations(findings)) console.log(line);
  // Only a complete review becomes the next push's baseline.
  if (parsed.complete) {
    writeFileSync(join(env.OUT_DIR, `${QUICK_ARTIFACT}.json`), `${JSON.stringify({
      schema_version: 1, complete: true, repository: env.REPO, pr, head_sha: env.HEAD_SHA, run_id: env.RUN_ID,
      total: findings.length + omitted, findings: findings.slice(0, MAX_FINDINGS).map(({ source, ...finding }) => finding),
    }, null, 2)}\n`);
  }
}

// --- Local ------------------------------------------------------------------------

/** Hash of the review policy, so a policy or skill change starts a fresh local review. */
export function policyHash(root) {
  const hash = createHash("sha256");
  const files = ["warden.toml"];
  const skills = join(root, ".warden", "skills");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(root, path));
    }
  };
  if (existsSync(skills)) walk(skills);
  for (const file of files) hash.update(`${file}\0${readFileSync(join(root, file))}\0`);
  return hash.digest("hex");
}

function localState(root) {
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim().replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = resolve(root, git(root, ["rev-parse", "--git-path", "warden-quick"]).trim());
  return { dir, file: join(dir, `${branch}.json`) };
}

const blocking = (finding) => finding.skill === "confidentiality-review" || finding.severity !== "low";

/** Exit codes: 0 clear, 1 high/medium security or confidentiality findings, 2 couldn't review. */
async function local(args, env) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  // Warden reads WARDEN_-prefixed provider keys; accept a plain OpenAI key too.
  const key = env.WARDEN_OPENAI_API_KEY || env.OPENAI_API_KEY;
  if (!key) {
    console.error("Warden quick review skipped: set WARDEN_OPENAI_API_KEY (see .warden/README.md).");
    return 2;
  }
  const upstream = ["origin/dev", "dev"].find((ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root }).status === 0);
  if (!upstream) { console.error("Warden quick review skipped: no dev branch to compare against."); return 2; }
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const base = mergeBase(root, upstream, head);
  const current = fingerprints(root, base, head);
  if (!Object.keys(current).length) { console.log("Warden quick review: no changes against dev."); return 0; }

  const state = localState(root);
  const policy = policyHash(root);
  let saved = null;
  if (!args.includes("--full") && existsSync(state.file)) {
    try { saved = JSON.parse(readFileSync(state.file, "utf8")); } catch { saved = null; }
    if (saved?.policy !== policy) saved = null;
  }
  // Locally every PR size benefits: there is no full review running in parallel.
  const plan = planReview(saved?.fingerprints ?? null, current, { minFiles: 0, maxShare: 1 });
  const files = plan.mode === "no-baseline" ? Object.keys(current).sort() : plan.moved;
  if (plan.mode === "unsupported-path") { console.error("Warden quick review: a changed file name can't be filtered; run pnpm warden:check."); return 2; }

  let parsed = { complete: true, findings: [] };
  if (files.length) {
    console.log(`Warden quick review: reviewing ${files.length} of ${Object.keys(current).length} changed files${saved ? " that moved since your last review" : ""}.`);
    mkdirSync(state.dir, { recursive: true });
    parsed = runWarden({ cwd: root, wardenBin: env.WARDEN_BIN, policy: readFileSync(join(root, "warden.toml"), "utf8"), files, base, head,
      env: { ...process.env, WARDEN_OPENAI_API_KEY: key, PI_CODING_AGENT_DIR: join(root, ".warden", "pi") }, outDir: state.dir });
  } else console.log("Warden quick review: nothing moved since your last review.");

  // Locally, confidentiality findings stay on your machine, so they carry over too.
  const fresh = parsed.findings.map((finding) => ({
    skill: finding.skill, severity: finding.severity, title: cleanText(finding.title, 300), description: cleanText(finding.description, 2000),
    path: typeof finding.location?.path === "string" ? finding.location.path : null,
    line: Number.isSafeInteger(finding.location?.startLine) ? finding.location.startLine : null,
  }));
  const reviewedPlan = plan.mode === "no-baseline" ? { moved: files, removed: [] } : plan;
  const findings = mergeFindings(saved?.findings ?? [], fresh, parsed.complete ? reviewedPlan : { moved: [], removed: reviewedPlan.removed });
  for (const finding of findings) {
    console.log(`\n[${finding.severity}] ${finding.skill === "confidentiality-review" ? "confidentiality: " : ""}${finding.title}`);
    if (finding.path) console.log(`  ${finding.path}${finding.line ? `:${finding.line}` : ""}${finding.source === "carried" ? " (from your last review)" : ""}`);
    console.log(`  ${finding.description.replace(/\n/g, "\n  ")}`);
  }
  if (!parsed.complete) { console.error(`\nWarden quick review incomplete (${parsed.reason}); nothing saved.`); return 2; }
  writeFileSync(state.file, `${JSON.stringify({ head, policy, fingerprints: current, findings: findings.map(({ source, ...finding }) => finding) }, null, 2)}\n`);
  const serious = findings.filter(blocking).length;
  console.log(serious ? `\nWarden quick review: ${serious} finding(s) CI's Warden would block on.` : "\nWarden quick review: no high or medium security or confidentiality findings.");
  return serious ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2);
  const run = mode === "ci" ? ci(process.env).then(() => 0) : mode === "local" ? local(args, process.env) : Promise.reject(new Error(`Unknown mode: ${mode}`));
  run.then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Warden quick review failed: ${error.message}`);
    process.exitCode = mode === "local" ? 2 : 1;
  });
}
