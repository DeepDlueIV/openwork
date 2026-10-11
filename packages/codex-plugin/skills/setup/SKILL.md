---
name: setup
description: Set up the local OpenWork receiver in a dedicated Codex GUI coordinator chat, with separate sign-in, explicit native-project approval and genuine per-task creation calls.
---

# OpenWork receiver setup

Read the plugin's README before setup. This is a macOS local prototype using internal desktop contracts; full installed-plugin creation still needs human-approved live verification.

## Diagnose and sign in

1. Use the installed plugin's `diagnose_native_context` tool. Report only presence booleans. Do not print caller IDs, environment values, pipe paths or credentials, or substitute a terminal script for genuine tool context.
2. Use `list_codex_projects` in its own separate native invocation. Show discovered local projects and let the user choose one. Do not fabricate project IDs, choose remote/cloud/worktree/projectless targets, or treat discovery as enrollment.
3. Use `sign_in` and show its browser approval URL/code. The user approves it themselves. Check `sign_in_status`; never request/copy an OpenAI token. OpenWork's existing device-login client may appear as OpenWork CLI on the approval page.

## Explicit project enrollment

Use a dedicated desktop Codex chat for enrollment and the receiver. Explain the scope plainly:

- New tasks use the saved project's native current roots, including additional roots and future changes made in Codex.
- This is **project-resource authorization**, not immutable-folder confinement or a new filesystem sandbox.
- Native permissions/managed policy remain in force; you never approve them automatically.
- The coordinator must stay running. An idle daemon cannot reuse old caller context to create chats.

Only after explicit approval call `enable_remote_sessions` with the discovered `projectId`, its initial directory, `confirm: true`, and `confirmNativeProjectScope: true`. Do not set either consent flag merely because sign-in succeeded. Creation and waiting are bound to the genuine chat that enrolled the project.

## Receive tasks

When the user asks to run the receiver:

1. Call `wait_remote_task`.
2. If it returns `waiting`, wait again while the user wants the receiver active.
3. If it returns `task_available`, call `create_remote_task` with exactly its `commandId` in a **fresh, separate invocation**. Never combine discovery and creation in one Code Mode execution; native call identity is single-use.
4. Native creation includes the immutable task prompt once. Do not execute its content in the coordinator, add another initial send, change its target/prompt, impersonate a user or synthesize caller IDs.
5. After delivery, call `wait_remote_task` again. Keep waiting until the user stops you; do not announce the receiver is permanently active after returning a final answer.
6. On errors, stop and report the safe error. Never retry uncertain creation under a new command ID or delete journals/ownership records to force another effect.

The user may need to approve native tool calls. Do not click approval prompts, weaken policy or enable debug/authorization bypasses for them.

From OpenCode, discover `remote-session:targets` and select the exact Codex computerId, not an OpenWork client on the same machine. Use registered creation with a nonempty prompt, without workspace/model overrides. The organization's existing `remoteSessionTargets` feature must be enabled; route feature/setup problems to its administrator rather than inventing credentials or reconnecting unrelated services.

## Stop

Use `disable_remote_sessions` when requested. It stops receiver control without deleting or interrupting child chats. `sign_out` also removes the local OpenWork credential, not the OpenAI login. Keep accepted-but-unverified receipts and at-most-once recovery records intact.
