// Agent permissions (packages/types/src/den/agent-permissions.ts) as OpenCode
// v2 applies them; OpenCode v1 does not enforce them. Den delivers a member's
// permissions as ordered rules; this module maps them onto v2's own permission
// rules and says which tool calls, local skills and local MCP servers they
// block. It has no engine SDK or server dependency so the v2 plugin can bundle it.
import {
  agentPermissionDenialMessage,
  agentPermissionRuleSchema,
  decideAgentPermission,
  websitePatternEngineResources,
  type AgentPermissionAction,
  type AgentPermissionDecision,
  type AgentPermissionRule,
} from "@openwork/types/den/agent-permissions-runtime";
import { mcpServerUrl, type OrganizationMcpServers } from "./organization-mcp-names.js";

export type { AgentPermissionRule };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rules in a verified desktop policy (Den sends them in its desktop config). */
export function agentPermissionRulesOf(policy: { agentPermissions?: { rules: unknown } } | undefined): AgentPermissionRule[] {
  return parseAgentPermissionRules(policy?.agentPermissions?.rules);
}

/** Rules from plugin options or a stored policy; anything malformed is dropped. */
export function parseAgentPermissionRules(value: unknown): AgentPermissionRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = agentPermissionRuleSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Why the rules block this action on these resources, or null. */
export function agentPermissionDenial(rules: readonly AgentPermissionRule[], action: AgentPermissionAction, resources: readonly string[]): string | null {
  const decision = decideAgentPermission(rules, action, resources);
  return decision.effect === "deny" && decision.rule ? agentPermissionDenialMessage(decision.rule, decision.resource) : null;
}

/**
 * Why the rules block an MCP server an engine has from any config source, or
 * null. A server with an organization name stays on only when it is the one
 * OpenWork registered under that name, at the same address
 * (registeredOrganizationMcpServers); Den applies the rules to the
 * organization's connections behind it.
 */
export function agentPermissionEngineMcpDenial(
  rules: readonly AgentPermissionRule[],
  name: string,
  server: unknown,
  organizationMcp: OrganizationMcpServers,
): string | null {
  const url = mcpServerUrl(server);
  if (url !== null && Object.hasOwn(organizationMcp, name) && organizationMcp[name]?.includes(url)) return null;
  return agentPermissionDenial(rules, "mcp", [name]);
}

// ---------------------------------------------------------------------------
// OpenCode v2: native permission rules, refined by the agent permissions plugin
// ---------------------------------------------------------------------------

export type EngineV2PermissionRule = { action: string; resource: string; effect: AgentPermissionDecision };

const V2_ACTIONS: readonly AgentPermissionAction[] = ["shell", "edit", "webfetch", "websearch", "skill"];

function v2Action(action: string): AgentPermissionAction | null {
  return V2_ACTIONS.find((entry) => entry === action) ?? null;
}

/**
 * The rules v2 evaluates natively, in order. A native denial skips the
 * permission hook and reaches the agent as a bare "Permission denied", even
 * through tools OpenWork wraps, so the plugin decides denials instead: they
 * ask natively, which still stops a call if the plugin is missing. Local
 * skills keep native denials so the engine leaves blocked skills out of the
 * catalog it offers. Website patterns become URL wildcards that never block a
 * URL the pattern allows; the plugin then decides with the exact pattern.
 */
export function agentPermissionEngineV2Rules(rules: readonly AgentPermissionRule[]): EngineV2PermissionRule[] {
  return rules.flatMap((rule) => {
    if (!V2_ACTIONS.includes(rule.action)) return [];
    const effect = rule.effect === "deny" && rule.action !== "skill" ? "ask" : rule.effect;
    if (rule.action !== "webfetch") return [{ action: rule.action, resource: rule.resource, effect }];
    return websitePatternEngineResources(rule.resource, rule.effect).map((resource) => ({ action: "webfetch", resource, effect }));
  });
}

/**
 * The decision a v2 permission evaluation ends with: the engine's, made at
 * least as strict as the organization's, with the rule that blocks a call
 * named in its message.
 */
export function agentPermissionEngineV2Decision(
  rules: readonly AgentPermissionRule[],
  action: string,
  resources: readonly string[],
  engineEffect: "allow" | "ask" | "deny",
): { effect: "allow" | "ask" | "deny"; message?: string } {
  const ourAction = v2Action(action);
  if (!ourAction) return { effect: engineEffect };
  const commands = ourAction === "shell" ? resources.flatMap(shellCommands) : resources;
  const ours = decideAgentPermission(rules, ourAction, commands);
  if (ours.effect === "deny" && ours.rule) return { effect: "deny", message: agentPermissionDenialMessage(ours.rule, ours.resource) };
  if (ours.effect === "ask" && engineEffect === "allow") return { effect: "ask" };
  return { effect: engineEffect };
}

// ---------------------------------------------------------------------------
// Shell commands: the commands a command line runs, for command rules
// ---------------------------------------------------------------------------

/** The text inside each `$(…)`, `<(…)`, `>(…)` and backtick substitution of a command line. */
function shellSubstitutions(line: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "`") {
      const end = line.indexOf("`", index + 1);
      if (end === -1) break;
      found.push(line.slice(index + 1, end));
      index = end;
    } else if ((char === "$" || char === "<" || char === ">") && line[index + 1] === "(") {
      let depth = 0;
      let end = index + 1;
      for (; end < line.length; end++) {
        if (line[end] === "(") depth++;
        else if (line[end] === ")" && --depth === 0) break;
      }
      found.push(line.slice(index + 2, end));
      index = end;
    }
  }
  return found;
}

/** The command without the variable assignments in front of it (`A=1 rm x` runs `rm x`). */
function withoutAssignments(command: string): string {
  const words = command.split(/\s+/);
  let first = 0;
  while (first < words.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first] ?? "")) first++;
  return words.slice(first).join(" ");
}

/** Reserved words and grouping a command can follow: `then rm x`, `do rm x`, `! rm x` and `{ rm x` run `rm x`. */
const SHELL_KEYWORDS = new Set(["!", "{", "}", "if", "then", "elif", "else", "fi", "while", "until", "do", "done", "time"]);

/**
 * The command without the shell keywords, subshell parentheses and case
 * pattern in front of it, and without a closing parenthesis after it:
 * `if true; then rm x; fi`, `(rm x)` and `case $a in b) rm x;; esac` run `rm x`.
 */
function withoutShellKeywords(command: string): string {
  let rest = command.trim();
  for (let previous = ""; previous !== rest;) {
    previous = rest;
    rest = rest.replace(/^\(+\s*/, "").replace(/^case\s+\S+\s+in\s+/, "").replace(/^[^\s()]*\)\s*/, "");
    const word = /^\S+/.exec(rest)?.[0];
    if (word && SHELL_KEYWORDS.has(word)) rest = rest.slice(word.length).trimStart();
  }
  let end = rest.length;
  while (rest[end - 1] === ")") end--;
  return rest.slice(0, end).trimEnd();
}

/** The words of a command, with quotes and backslash escapes removed. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < command.length) word += command[++index]!;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\\" && index + 1 < command.length) {
      word = (word ?? "") + command[++index]!;
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);

/**
 * The scripts a command hands to another shell (`bash -c '…'`,
 * `sudo -u x sh -lc '…'`, `eval '…'`), so a rule for the commands inside
 * applies to them too. Any word may start one, so a wrapper in front never
 * hides it.
 */
function interpreterPayloads(command: string): string[] {
  const words = shellWords(command);
  const found: string[] = [];
  words.forEach((word, index) => {
    const program = word.slice(word.lastIndexOf("/") + 1);
    if (program === "eval") {
      found.push(words.slice(index + 1).join(" "));
      return;
    }
    if (!SHELL_INTERPRETERS.has(program)) return;
    for (let flag = index + 1; flag < words.length && /^-[A-Za-z]+$/.test(words[flag]!); flag++) {
      if (words[flag]!.includes("c")) {
        found.push(words[flag + 1] ?? "");
        return;
      }
    }
  });
  return found;
}

/**
 * Known limitation: a program named through a variable or expansion
 * (`x=rm; $x -rf dir`) is checked as written, so a rule for the program it
 * expands to does not match it.
 *
 * The commands a shell command line runs, roughly as the engine's parser finds
 * them: the line, each part between separators (also without the keywords in
 * front, as in `then rm x`), each command substitution and each script handed
 * to another shell, searched again in turn. A rough split only adds
 * candidates, so a pattern can block more than the line runs, never less.
 */
export function shellCommands(command: string): string[] {
  const found = new Set<string>();
  const visit = (text: string, depth: number) => {
    const line = text.trim();
    if (!line || found.has(line) || depth > 8) return;
    // Keywords in front do not change what runs: `then rm x` runs rm.
    const add = (candidate: string) => {
      const stripped = withoutShellKeywords(candidate);
      for (const entry of [candidate, withoutAssignments(candidate), stripped, withoutAssignments(stripped)]) found.add(entry);
    };
    add(line);
    // Quotes do not change what runs: `"rm" -rf x` runs rm.
    const unquoted = shellWords(line).join(" ");
    if (unquoted) add(unquoted);
    for (const payload of interpreterPayloads(line)) visit(payload, depth + 1);
    for (const inner of shellSubstitutions(line)) visit(inner, depth + 1);
    for (const part of line.split(/&&|\|\||[;|&\n]/)) visit(part, depth + 1);
  };
  visit(command, 0);
  return [...found].filter(Boolean);
}
