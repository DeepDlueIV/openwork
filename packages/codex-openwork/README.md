# codex-openwork

Use your OpenWork organization's AI models and connections in the
[Codex CLI](https://github.com/openai/codex). Sign in once, pick a model, and
start Codex with `codex --profile openwork`.

Requires Node.js 20 or later and Codex CLI 0.134 or later.

## Install and set up

```sh
npx codex-openwork login
npx codex-openwork setup
codex --profile openwork
```

Or install it globally and drop the `npx`:

```sh
npm install -g codex-openwork
codex-openwork login
codex-openwork setup
```

`login` shows a web address and a short code. Open the address, check the code
matches, and approve. `setup` asks which model to use and shows what it will
change before changing anything.

For scripts, pass everything up front:

```sh
npx codex-openwork setup --model gwm_… --yes
```

## Commands

| Command | What it does |
| --- | --- |
| `login [--api URL] [--org ID] [--open]` | Sign in to OpenWork in your browser. |
| `setup [--model ID] [--profile NAME] [--no-mcp] [--yes] [--force]` | Create the Codex profile and add the OpenWork MCP server. |
| `status [--profile NAME]` | Show what is set up. Never shows keys. |
| `models [--all]` | List the models Codex can use (`--all` also lists the ones it cannot). |
| `token` | Print your AI Gateway key. Codex runs this for you. |
| `uninstall [--profile NAME] [--yes]` | Remove the profile and helper. Keeps your sign-in. |
| `logout` | Sign out and delete the saved sign-in. |

## What it changes

- **`~/.codex/openwork.config.toml`** (or `$CODEX_HOME/<profile>.config.toml`):
  a Codex profile file. Codex only reads it when you run
  `codex --profile openwork`, so your normal Codex setup and `config.toml` are
  not touched. The file starts with `# Managed by codex-openwork`. Setup will
  not replace a file without that line unless you pass `--force`. Running setup
  again rewrites only this file and leaves no extra files behind; a backup copy
  (`….openwork-backup-<time>`) is kept only if you had edited the file yourself.
  The profile sets an `openwork` model provider that points at your
  organization's OpenWork AI Gateway (`…/api/v1`, OpenAI Responses format).
- **`~/.openwork/codex-openwork/`** (or `$CODEX_OPENWORK_STATE_DIR`): your
  sign-in (`credentials.json`, readable only by you) and `token-helper.mjs`, a
  small script Codex runs to get your gateway key. The key is never written into
  Codex's config.
- **The OpenWork MCP server** is declared inside the same profile file
  (`[mcp_servers.openwork]`), so it never changes `config.toml`. Sign in once
  with `codex --profile openwork mcp login openwork` (setup offers to run it).
  Skip this with `--no-mcp`. If your `config.toml` already has the OpenWork MCP
  server (under any name), the profile uses that one, and a different server
  named `openwork` is never replaced.

## Limitations

- Only models from OpenAI-type providers (OpenAI, Azure OpenAI,
  OpenAI-compatible) work. The gateway does not convert between formats, so
  Anthropic, Gemini, and similar models are not offered. `models --all` shows
  them, marked as not compatible.
- **Needs a gateway update.** The OpenWork AI Gateway currently rejects Codex's
  requests (`unsupported_gateway_resource`): Codex sends message ids, tool
  namespaces and thread ids in `client_metadata`, which the gateway treats as
  stored provider state. The fix is in `ee/apps/gateway/src/payload-policy.ts`
  in this branch; Codex works once that is deployed.
- Codex's built-in web search is turned off in this profile, because the
  gateway does not run OpenAI-hosted tools. Use web search tools from your
  OpenWork MCP connections instead.
- The profile is for the Codex CLI. It has not been tested with the Codex
  desktop app or IDE extensions.
- MCP sign-in is handled by Codex (`codex mcp login openwork`) in your browser.
- The profile stores the path of the Node.js you ran setup with (the stable
  `node` on your PATH when it is the same program, so Homebrew upgrades keep
  working). If you remove or switch that Node.js, run `setup` again.

## Uninstall

```sh
npx codex-openwork uninstall   # removes the profile (and the MCP server it declares) and the helper
npx codex-openwork logout      # signs out and deletes the saved sign-in
```
