# Enterprise workshop handoff

## Requested next work

Make the internal Jira and Confluence browser surfaces substantially closer to the real products (not a generic table with the logo). Use real product references, preserve accessible compact layouts, and keep every visible mutation tied to the same mock service state the agent uses. Polish the Microsoft 365 demo similarly. Run the API, parity and headless-browser tests and the connected workday end to end. Capture actual screenshots. This repository is public: use fictional Acme Robotics only, never external organization/person names in commits, fixtures, branches or evidence.

## Current code

- `evals/packages/labs/src/demo-atlassian.mjs`: in-memory Data Center REST + 28 exact mcp-atlassian 3.4.9 definitions and native implementations. Real mcp-atlassian works against its REST endpoints. Prior 57-call comparison matched normalized output, including errors.
- `evals/packages/labs/src/demo-atlassian.test.ts`: 10 tests, including optional real-server parity (`DEMO_ATLASSIAN_PARITY=1`, requires uvx).
- `evals/packages/labs/src/demo-workplace-ui.mjs`: stateful Jira/Confluence browser UI, synthetic backend proxy, CSRF, sanitized rich Confluence body, 2-second polling. Currently recognizable but too basic visually. Supports Data Center page-link redirects.
- `evals/packages/labs/src/demo-workplace-ui.test.mjs`: Node test with actual headless Chrome (2 passed, zero skips). Optional `DEMO_SCREENSHOT_DIR` captures Jira list, created issue, Confluence page at 1440x1000.
- `evals/packages/labs/src/demo-microsoft365.mjs` + `.test.ts`: stateful Graph-shaped mail/calendar/drive service + unofficial demo MCP, Outlook/OneDrive UIs. 13 tests passed. Actual OOXML files in seed. Absolute browser links and nested-file deep links were added.
- `worlds/lib/demo-workspace.ts`: reused lifecycle, exported `startDemoScript` and `connectDemoServer`, opt-in Atlassian support. No production feature rollout: internal eval/demo tooling only.
- `worlds/acme-web.ts`: optional Atlassian and `beforeRuntime` hook; explicitly isolates OPENCODE_CONFIG_DIR + XDG_CONFIG_HOME so V1 does not load the coding agent's V2 permissions.
- `worlds/enterprise-workshop.ts` / `.md`: local workshop composition, real OpenAI provider seeded BEFORE runtime startup, fake fixed-response provider removed, mock services and UIs, WORKSHOP.md in scratch workspace.

## Important unresolved isolation blocker

DO NOT call the connected workshop safe/ready yet.

`bootAcmeWeb` workspace currently lives under `<repo>/tmp/worlds/.../workspace`. OpenCode still discovers repository-level configuration/plugins/agents from ancestors. A paid-model rehearsal revealed the runtime's `mcp.openwork.url` was the production gateway, not this world's Den, and capability searches queried production service metadata. No external writes were performed; the model reported it could not find the fictional tools, and mock backend inspection confirmed no ticket/draft was created. Do not continue this rehearsal until isolation is fixed.

- Initial V1 config failure was resolved by isolated OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME. Baseline acme-web then booted and completed its deterministic gateway chat.
- Seeding a real provider AFTER runtime startup led to stale catalog / ProviderModelNotFound; the beforeRuntime hook now seeds it first and /provider confirms the proper paid model.
- Explicit `agent: build` with the paid provider answered WORKSHOP_READY successfully. Default openwork agent initially returned opaque HTTP 500; do not gloss over that. Need fix/test the actual app path too.
- Strong next step: put the scratch workspace outside the source checkout, isolate project config (use supported OpenCode configuration controls), and point the world's MCP/activation at its own Den. Reuse established seeded-world bootstrap mechanisms instead of inventing tokens or bypassing authentication. Assert no production MCP origins before any paid prompt.

## Verification commands

```sh
DEMO_ATLASSIAN_PARITY=1 pnpm --dir evals exec vitest run --config vitest.config.ts --project pr packages/labs/src/demo-atlassian.test.ts packages/labs/src/demo-microsoft365.test.ts
node --test evals/packages/labs/src/demo-workplace-ui.test.mjs
pnpm --dir evals typecheck
```

Inspect any new Microsoft browser test alongside these. Existing evals typecheck passed (257 source files at the earlier checkpoint). An ad-hoc worlds TypeScript check has baseline transitive errors; don't claim a globally clean worlds typecheck. No test result here is a claim about full Office editing.

OpenAI key: Infisical `OPENAI_API_KEY`, environment `dev`, root path `/`. Fetch scoped to one process; never print/store it in source/evidence. CLI on original host was 0.28.4. gpt-4.1-mini and gpt-4.1 work; current gpt-6 family tool calls require Responses API. Workshop defaults to gpt-4.1. Never put keys into remote VM snapshots.

## Original-host runtime

The original-host `enterprise-workshop` world at stage `connected-rehearsal` was stopped and its resources reaped before remote handoff. It had a paid provider, isolated fixture DB, and service UIs. Its private receipt is local only: `evals/results/.worlds/scripts/enterprise-workshop--connected-rehearsal.json`. Do not transfer receipts, tokens, passwords, runtime configs, logs or tmp/worlds. New Mac must create its own world. Original host local MySQL needed an explicit localhost override (passwordless root refused by Drizzle); never assume those credentials apply on another machine.

Read `worlds/enterprise-workshop.md` for the demo narrative. Demonstrate: read fictional mail → look up product/customer docs → create document and draft reply → create/assign DOC ticket → raise password-reset request → update Confluence → verify browser shows every write → unknown policy returns no match. Actual Word/Excel/PowerPoint editing requires the existing Documents/Collabora engine; do not mislabel a text preview as Microsoft Office.
