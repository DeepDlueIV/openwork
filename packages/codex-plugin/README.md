# OpenWork for Codex — local prototype

Installable, dependency-free Codex plugin in a separate development worktree. It packages OpenWork device-code sign-in, explicit remote enrollment, a native desktop IPC adapter, and the **existing** `@openwork/remote-sessions` journal/transport. It does not copy OpenAI credentials, spawn another Codex CLI/app-server, or create a second queue.

## Current status — not full remote-session parity

The desktop IPC connection and existing-thread owner/settings discovery were verified against the running macOS desktop build 155. Sending, observing, reading and guarded interruption use contracts extracted from that installed runtime and have mock tests; they still need an explicitly authorized live write test.

**New GUI-chat creation is not verified.** The follower socket does not expose the bundled app-tools `create_thread` operation. That operation requires a genuine executor context and an authorized native pipe; this prototype does not fabricate those or bypass peer authorization. Until a verified creation path is available, the runner **fails closed before registering or claiming remote commands**. Installing/signing in is not evidence that remote control works.

This limitation is intentional: an existing-thread bridge or a separate CLI session must not be advertised as full `remote-session:create/send/read/stop` support.

## Install from the branch

Run these on the **same Mac as the Codex desktop app**, using Node 22 or newer. The branch includes the bundled runtime, so there is **no dependency install or build step**.

```sh
node --version
git clone --single-branch --branch prototype/codex-remote-plugin \
  https://github.com/different-ai/openwork.git \
  "$HOME/openwork-codex-prototype"
node "$HOME/openwork-codex-prototype/packages/codex-plugin/scripts/install.mjs" --dry-run
node "$HOME/openwork-codex-prototype/packages/codex-plugin/scripts/install.mjs"
```

If the clone directory already exists, choose a different empty directory rather than overwriting it. If `node` is not on your terminal PATH on an Apple Silicon Mac, use `/opt/homebrew/bin/node` only if that executable is already installed.

### Prompt to paste into Codex

> Install the local OpenWork prototype from https://github.com/different-ai/openwork/tree/prototype/codex-remote-plugin. First read packages/codex-plugin/README.md. Clone this branch into a new directory outside my existing checkout; do not overwrite any files. It includes the bundled runtime, so do not install dependencies or rebuild it. Run the installer's dry-run, show me its destination and marketplace change, then run the installer with my approval. Do not restart Codex, sign me in, enable remote control, create chats, or send messages automatically. This version only has working sign-in and read-only diagnostics; full remote enrollment deliberately fails closed.

From an existing checkout of this branch, the equivalent commands are:

```sh
node packages/codex-plugin/scripts/install.mjs --dry-run
node packages/codex-plugin/scripts/install.mjs
```

The installer copies the package to `~/.codex/plugins/openwork-local`, adds one entry to your existing personal marketplace, and preserves other entries and its name. It refuses unfamiliar destinations. It does **not** enable the plugin, sign in, or allow remote control.

In Codex, restart when convenient, open Plugins, choose your personal marketplace and install **openwork-local**. The package includes the `setup` skill and local MCP tools. Do not restart Codex while an important turn is running.

In a Codex conversation:

> Use the OpenWork local plugin to sign me in. Show me the browser approval link. Do not enable remote control yet.

Approve the code in your browser, then ask it to check `sign_in_status` and `status`.

### Terminal alternative

Use the installed copy (on the same machine as the Codex desktop app):

```sh
node ~/.codex/plugins/openwork-local/src/cli.mjs login
node ~/.codex/plugins/openwork-local/src/cli.mjs status
node ~/.codex/plugins/openwork-local/src/cli.mjs doctor --directory /absolute/project/path --source-thread YOUR_NATIVE_THREAD_UUID
```

Copy a chat deep link from Codex to obtain its technical native thread UUID. The diagnostic only discovers its owner and lists settings key names; it does not read/print prompts, send messages, enroll the thread or change its settings.

Credentials and config are outside your repository in `~/.openwork/codex-plugin`, with owner-only permissions on POSIX. `OPENWORK_CODEX_STATE_DIR` changes this path; repository paths and symlinks are refused. Native Windows ACL protection is not implemented in this prototype. Logout disables enrollment and removes the local OpenWork credential; it does not sign out of OpenAI.

## Intended full flow once creation is verified

1. Explicitly enroll one folder, separately from sign-in.
2. Run the local receiver while Codex is open (the MCP process can own it, or `cli.mjs run` can).
3. From OpenCode, discover the registered Codex computer using `remote-session:targets`.
4. Create a task with `target: "registered"` and its exact `computerId`.
5. Read delivery with `commandId`, then read/send/stop using its returned native session receipt.
6. Answer native permissions/questions **inside Codex**. The runner never approves them.

The existing `remoteSessionTargets` organization gate must be enabled. No production routes, contracts, feature flags or deployment settings are changed by this local prototype. Released inventory schemas only recognize OpenCode v1/v2: the receiver reports an honestly labeled Codex **computer with no workspace/model inventory**, rather than pretending to be either engine. Use computerId-only routing, without model/workspace overrides.

Creation and send use conservative at-most-once recovery. Unknown delivery is not replayed automatically. A crash can leave a stale `runner.lock`: first close all other local receiver instances and verify its recorded PID is no longer running before removing that file. Native chats and execution journals are never deleted by disabling enrollment.

## Development

```sh
node scripts/build.mjs
node --test tests/*.test.mjs
```

The build bundles the dependency-free shared runner using the repository's already-installed builder. The installed package needs no package-manager install. Tests use fake native sockets and HTTP responses; no real prompts, credentials or user conversation contents are fixtures.

References: [plugin packaging](https://developers.openai.com/plugins/build/plugins), [plugin extensions](https://developers.openai.com/plugins/build/extensions), and `docs/session-offloading-architecture.md` in the repository.
