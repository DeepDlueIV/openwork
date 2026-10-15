// The product promises OpenWork's core e2e journeys protect.
//
// Two kinds of e2e test live in evals/, and they are treated differently:
//
//   core   evals/core/*.e2e.test.ts
//          The journeys listed under each promise below. Maintained by the
//          team. Strict lint (scripts/spec-lint): no backdoors, sleeps, silent
//          skips, mocks, product-source imports or self-graded evidence; shared
//          worlds only; at most 250 lines. A core journey is never deleted or
//          weakened to make a PR green: fix the product, or change the promise
//          here in review.
//
//   proof  evals/proofs/*.proof.test.ts
//          A one-off eval an agent writes to prove one change on one PR. Same
//          lint, minus the promise requirement. Not maintained: if a proof
//          keeps mattering, fold its steps into the promise's core journey.
//
// Unit and integration tests do not belong in evals/: put them next to the
// module they test. `health` lists known issues a promise's journeys still have.

export type Surface = "desktop" | "web" | "den" | "mcp" | "packaged";

export type Area =
  | "app"
  | "desktop"
  | "server"
  | "den-api"
  | "den-web"
  | "gateway"
  | "opencode-plugin";

export interface ProductPromise {
  /** Stable id; a core spec declares it and lint checks it exists here. */
  id: string;
  surface: Surface;
  /** Who keeps the promise's benefit: written as the test title's actor. */
  actor: "a person" | "a member" | "an admin" | "an owner" | "an agent" | "an MCP client";
  /** The promise in user language. Becomes the core test's title. */
  promise: string;
  /** Code areas whose changes make this journey mandatory on a PR. */
  areas: readonly Area[];
  /**
   * The core journey files that protect this promise: evals/core/<name>.e2e.test.ts.
   * Usually one. More only when the journeys need different binaries or
   * platforms (packaged flavors), never to fit one more test.
   */
  core: readonly string[];
  /** Known issues to fix before it passes core lint. Empty means ready. */
  health: readonly string[];
}

export const promises = [
  // ── Chat ──────────────────────────────────────────────────────────────────
  {
    id: "CHAT-ROUNDTRIP",
    surface: "web",
    actor: "a person",
    promise: "a signed-in person sends a message and reads the reply",
    areas: ["app", "server", "gateway"],
    core: ["core-chat"],
    health: [],
  },
  {
    id: "CHAT-STREAMING",
    surface: "web",
    actor: "a person",
    promise: "a person reads the beginning of an answer before the model finishes, and can return to one that is still growing",
    areas: ["app", "server"],
    core: ["engine-parity"],
    health: [],
  },
  {
    id: "CHAT-STOP",
    surface: "web",
    actor: "a person",
    promise: "a person stops a running turn, or replaces it with an edit, and sees what each unfinished tool did",
    areas: ["app", "server"],
    core: ["unfinished-tool-lifecycle"],
    health: [],
  },
  {
    id: "CHAT-WORKING-VISIBLE",
    surface: "web",
    actor: "a person",
    promise: "a person can always tell the agent is still working, including background helpers, and is told when they finish",
    areas: ["app", "server"],
    core: ["agent-visibility-journey"],
    health: [],
  },
  {
    id: "CHAT-SURVIVES-RESTART",
    surface: "desktop",
    actor: "a person",
    promise: "a person restarts the app and finds their conversation, queued follow-ups and unsent draft where they left them",
    areas: ["app", "desktop", "server"],
    core: ["thread-continues-after-restart"],
    health: [],
  },
  {
    id: "CHAT-ATTACHMENTS",
    surface: "web",
    actor: "a member",
    promise: "a member attaches a file and a connector to a message, and the sent message and the answer use them as composed",
    areas: ["app", "server"],
    core: ["sent-message-matches-composer"],
    health: [],
  },
  {
    id: "CHAT-ERRORS",
    surface: "web",
    actor: "a member",
    promise: "a member whose provider refuses a request sees a readable reason and one way to recover, never a blank or raw error",
    areas: ["app", "server", "gateway"],
    core: ["session-error-technical-details"],
    health: [],
  },
  {
    id: "SESSION-ARCHIVE",
    surface: "web",
    actor: "a person",
    promise: "a person archives a conversation, a working one only after confirming Stop, and can undo it",
    areas: ["app", "server"],
    core: ["session-archive-button"],
    health: [],
  },

  // ── Agent capabilities in chat ────────────────────────────────────────────
  {
    id: "AGENT-PERMISSIONS",
    surface: "desktop",
    actor: "a member",
    promise: "a member's agent asks before commands, runs the ones the team allows, and cannot run blocked ones",
    areas: ["app", "server", "den-api"],
    core: ["agent-permissions"],
    health: [],
  },
  {
    id: "CONNECTOR-IN-CHAT",
    surface: "web",
    actor: "a person",
    promise: "a person asks for something from a connected service and sees what was called and what came back",
    areas: ["app", "server", "den-api"],
    core: ["agent-connection-journey"],
    health: [],
  },
  {
    id: "CONNECTOR-SIGN-IN-IN-CHAT",
    surface: "web",
    actor: "a person",
    promise: "a person asks for an unconnected service, connects it from the card in chat, and the original task continues",
    areas: ["app", "server", "den-api"],
    core: ["agent-connection-sign-in-journey"],
    health: [],
  },
  {
    id: "CONNECTOR-CHANGES-LIVE",
    surface: "web",
    actor: "a member",
    promise: "a connector or skill added or removed by an admin reaches a member's ongoing conversation without a restart",
    areas: ["app", "server", "den-api"],
    core: ["opencode-v2-mcp-hot-reload"],
    health: [],
  },
  {
    id: "MODEL-CHOICE",
    surface: "web",
    actor: "a member",
    promise: "a member with only their organization's models gets an answer to their first message, and can switch models",
    areas: ["app", "server", "gateway", "den-api"],
    core: ["composer-first-message-org-model"],
    health: [],
  },
  {
    id: "BUILT-IN-BROWSER",
    surface: "desktop",
    actor: "a person",
    promise: "a conversation opens the built-in browser with approval, and other conversations cannot see its tabs",
    areas: ["app", "desktop", "server"],
    core: ["opencode-v2-built-in-browser"],
    health: [],
  },
  {
    id: "AUTOMATIONS",
    surface: "web",
    actor: "an owner",
    promise: "an owner saves an Automation, it runs unattended on schedule, and they can pause it or return to an earlier version",
    areas: ["app", "server", "den-api"],
    core: ["saved-script-automations"],
    health: [],
  },
  {
    id: "APPS",
    surface: "web",
    actor: "an owner",
    promise: "an owner builds an App, and a teammate opens it once its Plugin is shared",
    areas: ["app", "den-api", "den-web"],
    core: ["mcp-app-servers", "mcp-app-servers-chat"],
    health: [],
  },
  {
    id: "UNTRUSTED-CONTENT-ISOLATED",
    surface: "web",
    actor: "a member",
    promise: "a member previews an untrusted HTML file or App and its script cannot reach OpenWork",
    areas: ["app", "desktop"],
    core: ["html-preview-isolation"],
    health: [],
  },

  {
    id: "DRIVE-FILES",
    surface: "desktop",
    actor: "a member",
    promise: "a member pulls a Google Drive file into the workspace, edits it locally, and saves it back to Drive",
    areas: ["app", "desktop", "server", "den-api"],
    core: ["drive-files"],
    health: [],
  },

  // ── First run and desktop lifecycle ───────────────────────────────────────
  {
    id: "FIRST-RUN-LOCAL",
    surface: "desktop",
    actor: "a person",
    promise: "a person opens OpenWork for the first time, signed out, and runs a first prompt without onboarding",
    areas: ["app", "desktop", "server"],
    core: ["first-run-local"],
    health: [],
  },
  {
    id: "FIRST-RUN-CLOUD",
    surface: "desktop",
    actor: "a person",
    promise: "a person signs in through the browser on first run and shares a skill with a colleague",
    areas: ["app", "desktop", "den-api", "den-web"],
    core: ["first-run-cloud-share"],
    health: [],
  },
  {
    id: "CRASH-RECOVERY",
    surface: "desktop",
    actor: "a person",
    promise: "a person whose app fails to start or render gets a recovery screen and keeps their profile",
    areas: ["app", "desktop"],
    core: ["reliable-app-recovery", "reliable-app-recovery-render"],
    health: [],
  },
  {
    id: "PACKAGED-LAUNCH",
    surface: "packaged",
    actor: "a person",
    promise: "each packaged flavor installs, launches past activation, and quits cleanly",
    areas: ["desktop"],
    core: ["packaged-first-launch", "app-smoke", "packaged-preactivation-updater", "packaged-preactivation-egress", "packaged-activated-launch", "released-enterprise-activated", "desktop-quit-path"],
    health: [],
  },
  {
    id: "DESKTOP-UPDATE",
    surface: "packaged",
    actor: "a person",
    promise: "an install downloads a newer build, installs it on quit, and never installs a version the organization revoked",
    areas: ["desktop", "den-api"],
    core: ["packaged-update-install", "background-desktop-update"],
    health: [],
  },

  // ── Den: accounts and access ──────────────────────────────────────────────
  {
    id: "SIGNUP",
    surface: "den",
    actor: "a person",
    promise: "a new person signs up, verifies their email, and lands in their own organization",
    areas: ["den-api", "den-web"],
    core: ["signup-verification-recovery"],
    health: [],
  },
  {
    id: "INVITE-JOIN",
    surface: "den",
    actor: "an owner",
    promise: "an owner invites someone, they join, and a plain member cannot read anyone's join token",
    areas: ["den-api", "den-web"],
    core: ["org-invite-join"],
    health: [],
  },
  {
    id: "SSO",
    surface: "den",
    actor: "a member",
    promise: "a member of an SSO organization signs in through their identity provider and recovers from an interrupted sign-in",
    areas: ["den-api", "den-web", "app"],
    core: ["reauth-popup"],
    health: [],
  },
  {
    id: "SCIM",
    surface: "den",
    actor: "an admin",
    promise: "an admin's identity provider adds, changes and removes members, and removed members lose access",
    areas: ["den-api"],
    core: ["scim-okta-lifecycle"],
    health: [],
  },
  {
    id: "TEAMS-AND-ROLES",
    surface: "den",
    actor: "an owner",
    promise: "an owner gives a team a role, and only that team's members gain it",
    areas: ["den-api", "den-web"],
    core: ["team-roles", "team-roles-boundaries"],
    health: [],
  },
  {
    id: "AGENT-POLICY",
    surface: "den",
    actor: "an admin",
    promise: "an admin makes a team's agents ask before commands, and undoes it",
    areas: ["den-api", "den-web"],
    core: ["agent-permissions-editor", "agent-permissions-editor-rules"],
    health: [],
  },

  // ── Den: plugins, connectors, library ─────────────────────────────────────
  {
    id: "PLUGINS-TO-TEAM",
    surface: "den",
    actor: "an admin",
    promise: "an admin gives a team a plugin and every member of the team gets the same skills",
    areas: ["den-api", "den-web", "server"],
    core: ["den-manage-plugins"],
    health: [],
  },
  {
    id: "CONNECTORS-ADMIN",
    surface: "den",
    actor: "an admin",
    promise: "an admin adds a connector for chosen teams and can remove it without surprising anyone who loses access",
    areas: ["den-api", "den-web"],
    core: ["den-manage-connectors", "den-manage-connectors-credentials"],
    health: [],
  },
  {
    id: "LIBRARY-SHARE",
    surface: "den",
    actor: "a member",
    promise: "a member shares a connection with a person and a team, and they use it without asking again",
    areas: ["den-api", "den-web", "app"],
    core: ["den-library-share"],
    health: [],
  },

  // ── AI Gateway ────────────────────────────────────────────────────────────
  {
    id: "GATEWAY-PROVIDER",
    surface: "den",
    actor: "an owner",
    promise: "an owner shares a provider's models with the organization, and a teammate cannot administer it",
    areas: ["den-api", "den-web", "gateway"],
    core: ["ai-gateway-admin-provider", "ai-gateway-admin-provider-setup"],
    health: [],
  },
  {
    id: "GATEWAY-REACHES-MEMBERS",
    surface: "desktop",
    actor: "a member",
    promise: "a gateway model an owner shares appears on a member's desktop and web picker and answers",
    areas: ["den-api", "gateway", "app", "server"],
    core: ["inference-gateway-desktop-sync"],
    health: [],
  },
  {
    id: "GATEWAY-LIMITS",
    surface: "den",
    actor: "an owner",
    promise: "an owner sets spend limits, members are paused at the limit, and a member's own limit is kept separately",
    areas: ["den-api", "den-web", "gateway"],
    core: ["ai-gateway-spend-limits", "ai-gateway-spend-limits-enforced"],
    health: [],
  },
  {
    id: "DEFAULT-MODEL",
    surface: "den",
    actor: "an owner",
    promise: "an owner sets the organization's default model and overrides it per team",
    areas: ["den-api", "den-web", "app"],
    core: ["den-org-default-model"],
    health: [],
  },
  {
    id: "AUDIT",
    surface: "den",
    actor: "an owner",
    promise: "an owner reads and filters what happened in their organization, and a teammate cannot",
    areas: ["den-api", "den-web"],
    core: ["audit-logs", "audit-logs-actors"],
    health: [],
  },

  // ── MCP gateway, agents and CLIs ──────────────────────────────────────────
  {
    id: "MCP-GATEWAY",
    surface: "mcp",
    actor: "an MCP client",
    promise: "an MCP client searches a member's assigned capabilities, executes a connector, and reads its result",
    areas: ["den-api"],
    core: ["engine-connectors-parity", "mcp-gateway-metadata"],
    health: [],
  },
  {
    id: "MCP-CONSENT",
    surface: "mcp",
    actor: "a member",
    promise: "a member sees which app is asking for MCP access, and can grant read-only, grant write, or decline",
    areas: ["den-api", "den-web"],
    core: ["mcp-consent-client-identity"],
    health: [],
  },
  {
    id: "AGENT-SIGNUP",
    surface: "mcp",
    actor: "an agent",
    promise: "an agent signs a new person up and sets up their workspace, and the person claims it",
    areas: ["den-api", "server"],
    core: ["agent-signup-via-mcp"],
    health: [],
  },
  {
    id: "CLI-SIGN-IN",
    surface: "mcp",
    actor: "a person",
    promise: "a person signs the OpenWork CLI or OpenCode in from their browser without typing a password",
    areas: ["den-api", "den-web", "opencode-plugin"],
    // Two journeys: the OpenWork CLI and the OpenCode plugin are different binaries and installs.
    core: ["cli-device-login", "cli-device-login-opencode"],
    health: [],
  },
  {
    id: "REMOTE-SESSIONS",
    surface: "mcp",
    actor: "a member",
    promise: "a member offloads a session to another computer and reads its progress, and no other member or organization can",
    areas: ["den-api", "opencode-plugin", "server"],
    core: ["opencode-plugin-remote-sessions"],
    health: [],
  },

  // ── Secrets and tenant isolation ──────────────────────────────────────────
  {
    id: "TENANT-ISOLATION",
    surface: "den",
    actor: "an owner",
    promise: "an organization's analytics, keys and sign-in origins never reach or serve another organization",
    areas: ["den-api", "den-web"],
    core: ["org-model-analytics"],
    health: [],
  },
  {
    id: "SECRETS-STAY-PRIVATE",
    surface: "web",
    actor: "an admin",
    promise: "keys entered in chat are stored privately, and an Automation never runs on a teammate's key",
    areas: ["app", "server", "den-api"],
    // Two journeys: the Automation half needs a real OpenWork Web computer and Automations runtime, not the chat app.
    core: ["secure-keys-in-chat", "secure-keys-in-chat-automation"],
    health: [],
  },
] as const satisfies readonly ProductPromise[];

// Worlds a core journey or proof may import. Today these are the worlds the
// starting specs above already use (one per journey); the target is ~8 shared
// worlds (core-web, den-admin, self-hosted, gateway, mcp-client,
// desktop-packaged, automation, sso), each with seed options. Shrink this list
// as journeys move onto them; never grow it to fit one test.
export const sharedWorlds: readonly string[] = [
  "drive-files",
  "mcp-gateway-metadata",
  "agent-mcp-signup",
  "agent-permissions",
  "agent-visibility",
  "ai-gateway-catalog-states",
  "ai-gateway-spend-limits",
  "audit-logs",
  "chat",
  "cli-device-login",
  "composer-plus-menu",
  "core-web",
  "den-library-manage",
  "den-org-default-model",
  "engine-connectors-parity",
  "engine-parity",
  "first-run",
  "html-preview-isolation",
  "library",
  "mcp-app-servers",
  "mcp-consent-client-identity",
  "opencode-plugin-sign-in",
  "org-model-analytics",
  "org-invite",
  "packaged-first-launch",
  "packaged-update-install",
  "providers-before-workspace",
  "reauth-popup",
  "secure-keys-in-chat",
  "secure-keys-automation",
  "session-shell",
  "team-roles",
  "thread-restart",
  "v2-built-in-browser",
  "desktop-quit-path",
  "packaged-preactivation-egress",
  "packaged-preactivation-updater",
  "released-enterprise-activated",
];
