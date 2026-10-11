# @openwork/agent-gateway-core

Private shared source for the `codex-openwork` and `claude-openwork` CLIs. It
is **never published**: each CLI imports it by relative path
(`../../agent-gateway-core/src/index.ts`) and tsup bundles it in. It has zero
runtime dependencies (Node >= 20 built-ins only).

| Module | What it does |
| --- | --- |
| `den.ts` | Den base URL rules (https, or http to loopback only), authenticated requests with org headers, `/v1/me`, `/v1/me/orgs`, sign-out. Errors never contain tokens or bodies. |
| `device.ts` | RFC 8628 device sign-in with client id `openwork-cli`: pending, `slow_down` (+5s), 429 `Retry-After`, timeout backoff, abort. `deviceLogin` validates the identity and org. |
| `state.ts` | Owner-only state in `~/.openwork/<app>` (0700 dir, 0600 files, atomic writes, symlinks and loose permissions refused) and the saved credential schema. |
| `gateway.ts` | AI Gateway inventory from Den, the member's `ow_gw_` key, the gateway's `/api/v1/models`, and protocol classification (`anthropic_messages` for Claude Code, `openai_responses` for Codex). The gateway does not translate protocols. |
| `files.ts` | Atomic edits of a tool's config file with a timestamped 0600 backup, keeping the file mode and refusing symlinks. |
| `prompt.ts` | Yes/no and pick-from-list prompts; without a TTY they return the default or explain which flag to pass. |

```sh
pnpm --filter @openwork/agent-gateway-core test
pnpm --filter @openwork/agent-gateway-core typecheck
```
