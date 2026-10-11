---
name: setup
description: Set up the internal OpenWork local Codex prototype with a separate OpenWork login and explicit remote-control enrollment.
---

# Set up OpenWork Local Prototype

This is an internal, local-only prototype, not a production rollout. Installing
it makes the setup tools available; it does **not** sign in, enroll the computer,
enable remote control, or change native Codex permissions.

1. Read the installed plugin's README and CLI help for the current tool names and
   flags. Use the plugin's setup/status tools or `node <plugin-root>/src/cli.mjs`
   commands; never invent a tool name. Check status before changing anything.
2. Explain that OpenWork uses a separate browser device login. Ask the person
   which OpenWork API and organization to use; hosted API defaults to
   `https://api.openworklabs.com`. Start login only when requested. The approval
   page identifies this prototype with the existing **OpenWork CLI** client
   (`openwork-cli`), not an OpenCode plugin client. Show the one-time user code
   and verification link; the person approves the organization in their browser.
   An explicit organization ID must match that approved organization.
3. Never read or copy Codex/OpenAI credentials, session tokens, browser cookies,
   or another OpenWork application's saved login. Never print the OpenWork bearer
   token. Plugin state belongs outside repositories in the owner-only
   `~/.openwork/codex-plugin` directory (or an explicitly chosen safe directory).
4. Explain remote control before enrollment: it allows the existing OpenWork
   remote-session runner to request native Codex work on the chosen computer and
   workspace. Obtain explicit confirmation and choose the workspace before using
   the enrollment command. Existing `remoteSessionTargets` server authorization
   must still allow this organization; enrollment is not a bypass of that gate.
5. Native Codex's sandbox and approval policy remain controlled by the person.
   Do not silently choose full access, disable approvals, or accept a permission
   request. Relay any waiting permission/question to the person in native Codex.
6. Verify status after setup and explain the CLI's disable/unenroll command.
   Disabling remote control must remain available without running more remote
   work. Do not claim the runner is active until its status actually confirms it.

The local installer only copies the plugin and adds an AVAILABLE entry to the
personal marketplace. The person reviews/enables the plugin in their supported
Codex host. It does not edit `~/.codex/config.toml`, auto-start a daemon, add hooks,
or automatically enroll this computer. Restart the host and use a new chat after
installation or refreshing the local plugin.
