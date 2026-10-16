# Workbot's Computer tab

Workbot's **Computer** tab appears after **Documents** when `workbot`,
`computerUse`, and `remoteComputers` are enabled for the organization in
`/admin`. It opens directly, without a consent screen. The combined testing
branch also includes Documents; its `workbotDocuments` rollout remains independent.

The two views use one conversation computer:

- **Browser** streams the Chromium window, including its tabs and address bar.
- **Computer** streams the entire Linux desktop.
- **Take control** interrupts Workbot's current turn, pauses both browser and
  computer tools, and enables native mouse/keyboard input through noVNC.
- **Return to Workbot** ends the manual connection and releases the tools.
- **Pause** suspends the VM; reopening the tab leaves it paused until **Resume**.
  Memory, browser tabs and unsaved applications survive VM pause/resume.

The main Workbot conversation's existing `hc-…` computer owns both views. The
viewer does not create a second computer or accept a sandbox/session id from the
page. Agent browser and computer operations use the shared computer-use package,
with the existing `bash` and `look` tools available on the same machine.

## Prepare the headless runner

Build `ee/packages/headless-computer/Dockerfile.desktop` using a pinned
`node:24-bookworm-slim@sha256:…` base, push it to your registry, and create a
Daytona Linux VM snapshot from the resulting image digest.
[Daytona’s snapshot requirements](https://www.daytona.io/docs/en/snapshots/)
require an AMD64 image and an existing image reference for Linux VMs:

```sh
docker build --platform linux/amd64 -f ee/packages/headless-computer/Dockerfile.desktop \
  --build-arg OPENWORK_COMPUTER_BASE_IMAGE="$PINNED_NODE_IMAGE" \
  -t "$COMPUTER_IMAGE" .
docker push "$COMPUTER_IMAGE"
daytona snapshot create workbot-desktop --image "$COMPUTER_IMAGE_DIGEST" \
  --sandbox-class linux-vm --cpu 2 --memory 4 --disk 12
```

Configure the existing headless runner (these are operator capabilities, not
organization rollout flags):

```dotenv
HEADLESS_COMPUTER=daytona
HEADLESS_COMPUTER_CLASS=linux-vm
HEADLESS_COMPUTER_DESKTOP=true
HEADLESS_COMPUTER_SNAPSHOT=workbot-desktop
DAYTONA_TARGET=<the snapshot's region>
```

Keep `DAYTONA_API_KEY` in the runner's existing secret configuration. Build the
runner normally; the headless computer build bundles the guest bridge and copies
its startup helper. On first desktop use they are installed into the member's
existing computer. Older computers need the desktop packages and Node 22+ before
they can open a stream; this change does not replace an existing VM or its files.

## Transport and rollout

The Workbot server checks signed-in membership and the organization flags before
issuing a viewer connection. Daytona signs access to port 6080 for 75 seconds.
The guest additionally consumes an origin-bound, one-use ticket, valid for 15
seconds, and closes each WebSocket after 60 seconds. Reconnection checks
membership and flags again. An already-open connection can outlive a flag change
for the 30-second membership cache plus its remaining 60-second connection.
Provider API keys and sandbox-wide preview tokens never enter the page.

VNC listeners bind to loopback. Watching uses x11vnc's server-side read-only
mode; noVNC's `viewOnly` setting also disables accidental input. Both manual
streams and structured tools operate the same broad desktop. Browser processes
run as an unprivileged account with Chromium's sandbox and a protected X cookie.
Workbot's model and connected-app tokens are not passed to the desktop.

## Useful applications

The desktop image includes a practical set of applications on the same display:

| Application | Useful work |
| --- | --- |
| Blender | 3D modeling, animation and CPU rendering |
| LibreOffice Writer, Calc, Impress and Draw | Documents, spreadsheets, presentations, diagrams and PDF edits |
| GIMP and Inkscape | Photo editing, illustrations, SVG and graphics |
| Evince and VLC | Inspect PDF, audio and video outputs |
| Thunar, Mousepad and Xterm | Files, text/code editing and Linux commands |

The existing command tools also include Python data/document libraries, FFmpeg,
ImageMagick, OCR and document conversion. The non-desktop headless image keeps
its lighter LibreOffice packages; GUI apps are installed only in the desktop image.

**Applications** in the bottom taskbar, **Super+Space**, or a desktop right-click
opens the app menu. The taskbar switches between open windows. Uploaded files
are in `/workspace/files`; save deliverables in `/workspace/out`. The desktop's
Uploads, Outputs and Downloads shortcuts point to these shared folders. Both
the command user and GUI user can save outputs without making broker secrets
readable. App profiles live in `/home/openwork-browser` and survive VM pause/resume.

Workbot's `desktop` tool exposes `computer_apps {}` to discover app availability,
package versions, supported formats, paths and environment guidance, and
`computer_launch {app:"blender"}` to launch an app. Pass an optional absolute
`path` to open a file. A launch receipt is followed by a fresh desktop observation;
it does not prove the application is ready or the file saved. Older snapshots
report missing apps honestly and need an operator rebuild to add them. Existing
computers are never replaced automatically. Launches use the same input rail
and takeover pause as browser and native actions, with no extra consent screen.

Blender uses Mesa software OpenGL; Cycles renders run on CPU. This image does
not supply a GPU. Its initial scene uses CPU Cycles with denoising off so builds
without OpenImageDenoiser can render. Start with small scenes and previews. For Blender and multiple
large apps, size the snapshot explicitly (for example 4 CPUs, 8 GiB memory,
32 GiB disk); the smaller example above is intended for light desktop work.
Use the snapshot's pinned image digest to reproduce its package versions.

This follows the published [OpenAI dot computer model](https://learn.chatgpt.com/docs/dots/computers-and-apps):
a persistent cloud computer with its own software, files and browser sessions,
with explicit takeover and return of control. OpenAI's public
[Linux environment recipe](https://developers.openai.com/api/docs/guides/tools-computer-use-integration#prepare-an-environment)
also uses an ordinary user, a shared X11 display, screenshots and browser viewing.
OpenWork retains its authenticated session transport and credential isolation.
The application selection here is OpenWork's; OpenAI does not document its
dot's installed package list on those pages.

Focused checks:

```sh
pnpm evals:e2e workbot-computer --local
pnpm --filter @openwork-ee/workbot exec tsx --conditions=development --test scripts/computer.test.ts
pnpm --dir ee/packages/headless-computer exec tsx --conditions=development \
  scripts/prove-desktop-vnc.ts <dedicated-test-vm>
```

The Workbot journey proves rollout, navigation and recovery through the real
signed-in application. The CLI diagnostic operates a dedicated prepared VM and
checks actual signed RFB streams; it does not provision or delete a sandbox.

For image acceptance, copy `ee/packages/headless-computer/scripts/prove-desktop-apps.mjs`
into a dedicated prepared test guest, start its desktop, then run it as root with
`DISPLAY=:99 XAUTHORITY=/workspace/.openwork-desktop/cloud-desktop/.Xauthority node prove-desktop-apps.mjs --dedicated-guest`.
It checks the installed catalog, launches four GUI apps, saves text through the
editor and renders a small Blender scene on CPU. It leaves its outputs and
desktop screenshot under `/workspace/out/desktop-apps-proof-…` for inspection.
