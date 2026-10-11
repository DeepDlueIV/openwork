# claude-openwork

Use your OpenWork organization's **AI Gateway** models and **OpenWork MCP** in [Claude Code](https://code.claude.com) — the `claude` CLI and the Claude Code IDE extensions (VS Code, JetBrains). It only uses Claude Code's supported settings and `claude mcp add`.

**Claude Desktop is not supported.** It does not read Claude Code's settings and uses its own inference configuration, so it is not affected.

## Install

Requires Node.js 20 or newer and Claude Code.

```sh
npx claude-openwork login
npx claude-openwork setup
```

Or install it globally and run `claude-openwork login` / `claude-openwork setup`.

- `login` signs you in to OpenWork: it prints a link and a code; open the link, confirm the code, and approve. Add `--open` to open the browser for you, `--api https://…` for a self-hosted OpenWork, and `--org <id>` to pick an organization. Your sign-in and AI Gateway key are saved in `~/.openwork/claude-openwork` (only your user can read it; set `CLAUDE_OPENWORK_STATE_DIR` to use another folder).
- `setup` shows what it will change and asks before changing anything. Without a terminal, pass `--provider ipr_…`, `--model gwm_…` and `--yes`. Run `claude-openwork models` to see the ids.

Then start a new Claude Code session and run `/mcp` to sign in to the `openwork` server.

## What setup changes

In `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`), keeping everything else:

| Setting | Value |
| --- | --- |
| `apiKeyHelper` | Runs a small script in `~/.openwork/claude-openwork` that prints your gateway key. The script is self-contained, so it keeps working after `npx` clears its cache. |
| `env.ANTHROPIC_BASE_URL` | Your organization's gateway (`…/api`); it routes each request by the model id. |
| `env.ANTHROPIC_DEFAULT_OPUS_MODEL`, `env.ANTHROPIC_DEFAULT_SONNET_MODEL` | The model you picked (`--model`). |
| `env.ANTHROPIC_DEFAULT_HAIKU_MODEL` | The fast model for background tasks (`--fast-model`, defaults to `--model`). |
| `model` | The model you picked, as the default. |
| `permissions.deny` | Adds `WebSearch` (skip with `--no-deny-websearch`). |

The first setup backs up your file next to it (`settings.json.openwork-backup-<time>`), and every key's previous value is recorded so `uninstall` can restore it. Running setup again only changes these keys, never adds duplicates, and makes no further backups.

If Claude Code is already set up with another `apiKeyHelper`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, or a Bedrock/Vertex/Foundry switch in `settings.json`, setup stops and explains. `--force` replaces them; uninstall puts them back. Setup refuses a `settings.json` that is not plain JSON (comments are not supported).

Unless you pass `--no-mcp`, setup also runs:

```sh
claude mcp add --transport http --scope user openwork https://api.openworklabs.com/mcp/agent
```

if no `openwork` MCP server exists yet. It brings your organization's skills, plugins and connections into Claude Code; sign in to it with `/mcp`.

## Limitations

- **Anthropic-format models only.** The gateway does not translate between protocols, so Claude Code can only use models from your organization's Anthropic-protocol providers. Run `setup` again to switch models.
- **No token counting endpoint.** The gateway does not serve `/v1/messages/count_tokens`; Claude Code estimates token counts instead.
- **WebSearch is denied.** Claude Code's web search runs as an Anthropic server-side tool, which the gateway rejects.
- **Subscription features are off while active.** Requests are billed to your organization's gateway instead of a claude.ai subscription, and Remote Control and voice dictation are unavailable. Run `uninstall` to go back.
- **Claude Desktop is not supported** (see above).
- Shell variables win over settings: if `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` is set in your shell, Claude Code uses it instead. `setup` and `status` warn about this. Project settings (`.claude/settings.json` in a repository) and organization-managed settings can also override these user settings.
- The helper runs with the Node.js that ran `setup` (the stable `node` on your PATH when it is the same program). If you remove or switch that Node.js, run `setup` again.

## Other commands

```sh
claude-openwork status        # sign-in, setup and drift; never prints secrets
claude-openwork models        # models Claude Code can use (--all for every model)
claude-openwork token         # print the gateway key for scripts (--reveal to print to a terminal)
claude-openwork uninstall     # restore your previous Claude Code settings
claude-openwork logout        # sign out and delete the saved sign-in and key
```

## Uninstall

```sh
npx claude-openwork uninstall
npx claude-openwork logout
```

`uninstall` restores each setting to the value it had before setup, or removes it if setup added it, and removes the `openwork` MCP server if setup added it. Settings you changed yourself after setup are left as they are and listed. It keeps your OpenWork sign-in; `logout` deletes it.
