---
name: browser-automation
description: "Drive the running OpenWork app over CDP, headless by default (nothing opens on screen): eval, screenshot, new session, send with a chosen model, wait. Reproduce chat states, fake model faults (refused, DNS, reset, 429, 5xx, 401, 402, stall) and measure chat flicker. Hand checks and local UI smoke tests."
---

# Browser Automation

Hand checks and fast repros. Per **Prove It on the Real Thing**, verdicts come from an `evals/specs` run (`write-a-spec`, `run-tests`).

## Attach

Default to this checkout's app in headless Chrome, with Vite hot reload. Nothing opens on the developer's screen:

```bash
pnpm world up dev-app-web --detach -- --browser   # prints webUrl and cdp http://127.0.0.1:<port>
pnpm world down dev-app-web                        # when done
```

Use a desktop window only when the change needs the desktop shell (titlebar, native menus, deep links, the built-in browser pane, updater, quit and relaunch) or the user asks. It opens and takes focus on this computer:

- `pnpm dev`: CDP on `http://127.0.0.1:9823` (`OPENWORK_ELECTRON_REMOTE_DEBUG_PORT` changes it, `0` disables).
- `pnpm world up live-desktop -- --allow-shared-state` prints `cdp http://127.0.0.1:<port>` and uses the real installed profile.

OpenCode browser tools: `browser_list` with `browser_url` set to the printed address, then pick the `OpenWork` target.

```bash
export CDP_URL=http://127.0.0.1:<port>
S=.opencode/skills/browser-automation/scripts
node $S/cdp.mjs new-session                          # always first
node $S/cdp.mjs send "Claude Opus 5.5" "Say hello"   # model by picker name, pastes and clicks Run task
node $S/cdp.mjs wait-idle 180
node $S/cdp.mjs shot /tmp/after.png                   # the whole page
node $S/cdp.mjs eval 'document.querySelector("main")?.innerText.slice(-500)'
node $S/cdp.mjs eval 'location.reload(); 1'          # after state-heavy changes
```

Per **Touch Only What You Own**, never type into an existing session. The app can switch sessions between commands, and `--allow-shared-state` worlds use your real config, so anything sent is real.

Stored v2 history shows what the engine recorded. For Code Mode steps, read `state.metadata.toolCalls` and `openworkMcpResults` on the `execute` part:

```bash
sqlite3 ~/.config/openwork/opencode-v2/state/opencode.db "select type, substr(data,1,400) from session_message where session_id='<ses_…>' order by seq"
```

## Reproduce chat states

`node $S/repro.mjs <state> [model]` fires a state in a new session. No argument lists states. `GATEWAY_MODEL` sets the real model for non-fault states.

| State | Check |
|---|---|
| `provider-refused`, `provider-dns`, `provider-reset` | one error per turn, plain title, raw text only behind the details icon |
| `provider-retrying` (first 30s) | "Reconnecting to the model" with attempt progress, no raw text |
| `provider-midstream`, `provider-stall` | interrupted reply keeps its partial text |
| `http-429`, `http-5xx`, `http-401`, `http-402` | matching plain-language title and next action |
| `codemode-wrong-tool` | a recovered step does not read as a hard failure |
| `den-script-rejected` | Den's real reason in details, not a placeholder |
| `den-script-service-failure` | "Script on OpenWork Cloud failed", reason behind the icon |
| `den-script-parallel` | 20 Slack calls as one readable group, collapsed until opened |
| `parallel-searches` | clean service names and logos, no routing ids |
| `app-create` | one card per app advancing through its steps |
| `sequential-commands` | no jumps (measure below) |

## Fake model faults

Provider errors come from the engine, so CDP throttling cannot make them. Point test providers at a local fault server:

```bash
node $S/fault-server.mjs &                       # 127.0.0.1:55600 (PORT=...)
python3 $S/fault-providers.py add                # backs up and edits ~/.config/openwork/runtime.sqlite (OPENWORK_RUNTIME_DB for another)
node $S/cdp.mjs refresh-providers                # expect 200; the server mirrors providers into the engine
```

| Provider · model | Error |
|---|---|
| Fault Refused · `refused` | `ConnectionRefused`, retried |
| Fault DNS · `enotfound` | `getaddrinfo ENOTFOUND`, retried |
| Fault Lab · `reset` / `mid-stream-reset` / `stall` | `ECONNRESET` retried / partial reply then close / never answers |
| Fault Lab · `http-429` `http-500` `http-503` `http-401` `http-402` | that status with a JSON body |
| Fault Lab · `ok` | a normal reply |

Writing the v2 engine config directly does not stick; the server rewrites it. A DNS timeout and the "OpenWork Cloud is temporarily unavailable" banner need a real cut (`networksetup -setairportpower en0 off`, about 40s, then `on`). Ask first: it drops the whole machine, VPNs included.

Clean up with `python3 $S/fault-providers.py remove`, delete the `fault-lab` auth through the server, and `kill %1`:

```bash
node $S/cdp.mjs eval '(async()=>{const w=((location.hash||location.pathname).match(/\/workspace\/([^/]+)/)||[])[1];const r=await fetch("http://127.0.0.1:"+localStorage.getItem("openwork.server.port")+"/workspace/"+w+"/opencode/auth/fault-lab",{method:"DELETE",headers:{Authorization:"Bearer "+localStorage.getItem("openwork.server.token")}});return r.status})()'
```

## Measure chat flicker

Content shrinking during a run moves everything up and reads as flicker.

```bash
node $S/cdp.mjs new-session && node $S/flicker.mjs arm
node $S/cdp.mjs send "<model>" "<prompt>" && node $S/cdp.mjs wait-idle
node $S/flicker.mjs report                       # { upwardJumps, downwardMoves, samples }
```

`repro.mjs` opens its own session, so arm after it or use `send`. Expect 0 upward jumps (1 at the start is fine). Compare before and after at a fixed window size. Reference: five sequential commands went from 6 jumps of about 22px to 1.
