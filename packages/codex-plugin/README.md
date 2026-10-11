# OpenWork for Codex — local receiver prototype

This plugin connects a **dedicated Codex GUI coordinator chat** to OpenWork's existing remote-session queue. Each incoming task is created through Codex's own app tools as a real local GUI chat, with its initial prompt included once. Existing child chats are read, messaged, observed and stopped through the GUI-owned follower connection.

It does not spawn a separate Codex CLI/app-server, invent caller IDs, reuse a waiter's native call identity, or automatically approve native permissions.

## Verification status

The desktop follower connection was tested live on macOS build 155. Native project discovery/creation contracts and signed-process requirements were inspected in that installed runtime. Automated tests cover the bridge and durable runner.

**Full installed-plugin creation and end-to-end OpenCode → Codex → reply still require a human-approved live test.** Passing unit tests or seeing a pipe variable is not proof that native peer authorization or GUI creation works on your build. These are internal desktop APIs, not a public compatibility guarantee. Unknown schemas, missing genuine context and unsafe connections fail closed.

## Install or update

Run on the same **Mac as the Codex desktop app**, with Node 22 or newer. The bundled runner is committed; **no dependency install or build is needed**.

For a new clone:

```sh
git clone --single-branch --branch prototype/codex-remote-plugin \
  https://github.com/different-ai/openwork.git \
  "$HOME/openwork-codex-prototype"
node "$HOME/openwork-codex-prototype/packages/codex-plugin/scripts/install.mjs" --dry-run
node "$HOME/openwork-codex-prototype/packages/codex-plugin/scripts/install.mjs"
```

If that directory already exists, do not overwrite it. For an unmodified existing clone on this branch:

```sh
git -C "$HOME/openwork-codex-prototype" status --short
git -C "$HOME/openwork-codex-prototype" pull --ff-only
node "$HOME/openwork-codex-prototype/packages/codex-plugin/scripts/install.mjs" --dry-run
node "$HOME/openwork-codex-prototype/packages/codex-plugin/scripts/install.mjs"
```

Stop if your checkout contains work you need to preserve or pull cannot fast-forward. On Apple Silicon, `/opt/homebrew/bin/node` can replace `node` if already installed but absent from PATH.

The installer copies to `~/.codex/plugins/openwork-local`, preserves your personal marketplace, then runs Codex's **official plugin add** operation. It verifies that the exact receiver version is **installed and enabled** using Codex's plugin list. Copying/cataloguing alone is not success. It does not sign in, restart Codex, approve tool permissions or start remote control. `--files-only` is an explicit development option and reports that the native plugin is not installed.

The receiver is **OpenWork Codex Receiver**, ID `openwork-local@local-personal` for the default marketplace. It is distinct from an existing cloud plugin named **OpenWork**. Do not choose that cloud plugin as a substitute for the receiver.

After installation, use one setup prompt in a dedicated desktop Codex chat:

> [@OpenWork Codex Receiver](plugin://openwork-local@local-personal) Set me up using your setup skill. Guide me through sign-in and one explicit native-project enrollment, then start receiving tasks. Do not approve permissions for me.

If your existing marketplace has a different name, use the exact `pluginId` returned by the installer rather than the example's `local-personal`. You do not need to type individual diagnostic/tool commands. Sign-in and project consent are still human actions; mandatory Codex permissions cannot be bypassed or guaranteed to collapse into a single approval.

Existing chats can retain an old tool catalogue. Refresh/reload the receiver or start a new dedicated chat if needed. Only restart the app if refresh fails, when no important turn is running. The MCP launcher selects the runtime **Codex supplies** through its normal environment allowlist; it never disables signing/ancestry checks. A terminal substitute is not a native-context test.

### Paste this installation prompt into Codex

> Install or update the local OpenWork receiver prototype from https://github.com/different-ai/openwork/tree/prototype/codex-remote-plugin. Read packages/codex-plugin/README.md first. Preserve any existing checkout changes and personal marketplace entries. No dependency install or build is needed. Show the installer dry-run before applying it. Do not restart Codex, approve tools, sign me in, enroll or create chats automatically.

## Setup in a dedicated Codex coordinator chat

Do these in a new **desktop Codex** chat, not through a shell pretending to be the plugin:

1. Call `diagnose_native_context`. It reports only presence booleans. Native pipe, thread/turn context and real call correlation must be present.
2. In a **separate native tool invocation**, call `list_codex_projects`. Choose a saved **local** project. Discovery is read-only; it is not enrollment.
3. Call `sign_in`, open its browser approval link and approve the code yourself. Check `sign_in_status`. This uses OpenWork's existing device-login client and may be labeled OpenWork CLI on the approval page. OpenAI credentials are not copied.
4. Explicitly approve the project and call `enable_remote_sessions` with the discovered `projectId`, its initial `directory`, `confirm: true`, and **`confirmNativeProjectScope: true`**.
5. Start the wait/create loop below in **that same coordinator chat**. Approval of this project is bound to the genuine chat identity; another chat cannot silently act as its coordinator.

### Project scope is not a folder sandbox

Codex's native creation API resolves a saved project's **current roots**, including additional roots and future changes made in Codex. It has no atomic expected-folder/version guard. Enrollment therefore explicitly authorizes that native **project resource**, not an immutable directory or a new filesystem sandbox. Native permissions/managed policy continue to control actions.

Creation records the accepted native receipt before snapshot verification. Child controls stay disabled while verification is pending. Once verified, the child is pinned to its actual canonical root; later unexpected child-root changes are denied. Never claim that post-creation checking confines the initial prompt to the initially displayed folder.

If you require fixed-folder confinement, **do not enroll** with this prototype.

### Paste this receiver prompt after setup

> Use openwork-local as this dedicated OpenWork receiver. Keep calling wait_remote_task until I stop you. When it returns task_available, call create_remote_task with exactly its commandId in a fresh, separate tool invocation, then wait again. Do not execute the task content in this coordinator; the new native GUI child chat receives the immutable queued prompt. Do not combine project discovery and creation in one Code Mode script, synthesize metadata, reuse caller IDs, run a terminal substitute, or approve permissions yourself. If a wait returns waiting, wait again. On errors, stop and report them; do not retry uncertain creation under a new command ID.

**Keep the coordinator running.** A background daemon cannot create new GUI chats using stale caller context. The plugin advertises creation while a genuine coordinator wait/create operation is active; when that stops, it withdraws creation capability while retaining control of already-owned children. If the model finishes instead of waiting, resume the receiver prompt. Native tool approval may require your action; review it yourself.

## Test from OpenCode

Once the receiver is waiting and the existing `remoteSessionTargets` organization feature is enabled:

> Find my registered remote-session targets. Select the entry labeled Codex, not OpenWork, using its exact computerId. Create a task titled “OpenWork smoke test” with prompt “Reply exactly OPENWORK_CODEX_OK. Do not use tools or access files.” Use target registered, without workspace or model overrides. Read its commandId until delivered, then read the returned native session and report its reply. Do not blindly retry an uncertain creation.

Successful proof requires **both** the reply and a real new chat visible in Codex. A native RPC success, mocked test, or separate CLI session is insufficient.

Use `remote-session:send/read/stop` with the delivered receipt for followups. New-task creation includes the first prompt; it is not sent twice. Model/thinking overrides, worktrees, cloud targets, projectless targets and empty-prompt creation are not supported in this pilot. Choose native model settings in Codex.

Codex and OpenWork on one machine have separate runner identities/computerIds. The default Codex label is `Codex · <hostname>`. Released inventories only recognize OpenCode v1/v2, so this prototype honestly reports a Codex **computer with no workspace/model inventory**, rather than pretending to be either engine.

## Stop, recover and troubleshoot

- `disable_remote_sessions` stops receiver control without deleting/interfering with native chats.
- `sign_out` additionally removes the local OpenWork credential, not the OpenAI login.
- Credential/account/project changes stop the pinned host; token renewal within the same identity does not erase journals.
- Lost acknowledgements replay receipts, not model/tool effects. Unknown creation is inspected, never blindly repeated. Known accepted-but-unverified children retain private ownership records and can verify later without creating again.
- A temporarily unavailable historical child does not block healthy-child controls or new work. Unknown observed schemas and authority inconsistencies still fail closed.
- Missing context/peer authorization: run the installed plugin in the GUI, not a terminal, check the presence diagnostic and supplied runtime, and report the safe error code. Never hardcode pipe values, alter signatures or use debug authorization bypasses.
- No target: ensure the coordinator is waiting and ask your organization admin to enable the existing `remoteSessionTargets` feature. Do not reconnect unrelated connections or invent credentials.
- Another coordinator owns the receiver: close/disable it before starting a second. A crash can leave `runner.lock`; verify its PID is no longer running and close all receivers before removing that lock. Never remove journals/native ownership records to force a replay.
- Storage/claim limits intentionally apply backpressure; inspect rather than deleting idempotency history.

Credentials, config and journals use owner-only files outside Git at `~/.openwork/codex-plugin`; `OPENWORK_CODEX_STATE_DIR` can change that location. These are protected local files, not a claim of Keychain encryption. Native Windows ACL enforcement is not implemented; the verified prototype is macOS.

Terminal setup/diagnostics remain available:

```sh
node ~/.codex/plugins/openwork-local/src/cli.mjs login
node ~/.codex/plugins/openwork-local/src/cli.mjs status
node ~/.codex/plugins/openwork-local/src/cli.mjs doctor --directory /absolute/project/path --source-thread NATIVE_THREAD_UUID
```

Do not use terminal `enable`/`run` as a substitute for genuine GUI coordinator creation.

## Development and Claude research

```sh
node packages/codex-plugin/scripts/build.mjs
node --test packages/codex-plugin/tests/*.test.mjs
node --test packages/remote-sessions/test/*.test.ts
```

Build uses the repository's installed builder; shipped runtime has no dependencies. Fixtures contain synthetic IDs, not real credentials/transcripts. See `docs/claude-mod-remote-sessions.md` for the parallel Claude Code mods investigation: native existing-session control is documented, but top-level Desktop session creation is not.

References: [plugin packaging](https://developers.openai.com/plugins/build/plugins), [Codex MCP](https://developers.openai.com/codex/mcp), and `docs/session-offloading-architecture.md`.
