// A computer use driver for a Linux VM with an X11 display. It needs only two
// things from the VM, which every `@openwork/sandbox` provider supplies: run a
// shell command and read a file. Input goes through xdotool and screenshots
// through ImageMagick, batched so one action costs one round trip.
import { randomUUID } from "node:crypto";

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const KEYS = {
  enter: "Return", return: "Return", escape: "Escape", esc: "Escape", tab: "Tab", backspace: "BackSpace", delete: "Delete", space: "space",
  arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "Page_Up", pagedown: "Page_Down",
};
// Shortcuts written for a Mac work on Linux: command sends control.
const MODIFIERS = { command: "ctrl", control: "ctrl", shift: "shift", option: "alt" };
const TOOLS = ["xdotool", "import", "python3"];

/**
 * @param {{
 *   machine: { run: (command: string, timeoutMs: number) => Promise<{ exitCode: number, stdout: string, stderr: string }>, read: (path: string, timeoutMs: number) => Promise<Uint8Array> },
 *   display?: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {import("./computer-remote.mjs").ComputerDriver}
 */
export function createX11Driver({ machine, display = ":99", timeoutMs = 20_000 }) {
  const validDisplay = /^:\d{1,3}(\.\d)?$/.test(display);
  const directory = `/tmp/openwork-computer-${randomUUID().slice(0, 8)}`;
  const run = (script, ms = timeoutMs) => {
    if (!validDisplay) throw new Error("Use an X display such as :99.");
    return machine.run(`export DISPLAY=${display}; ${script}`, ms);
  };
  const key = (name, modifiers = []) => {
    const base = KEYS[String(name).toLowerCase()] ?? (String(name).length === 1 ? String(name) : String(name));
    if (!/^[A-Za-z0-9_+\-.,;:'"/\\=[\]`]{1,24}$/.test(base)) throw new Error(`Unsupported key ${name}.`);
    return [...modifiers.map((modifier) => MODIFIERS[modifier] ?? "ctrl"), base].join("+");
  };
  const integer = (value) => {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || Math.abs(number) > 100_000) throw new Error("Coordinates must be finite pixels.");
    return number;
  };
  // X11 window ids are large; they are not pixels.
  const windowId = (value) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Unknown window.");
    return id;
  };
  const withModifiers = (modifiers = [], command) => {
    const keys = modifiers.map((modifier) => MODIFIERS[modifier] ?? "ctrl");
    return keys.length ? `(trap 'xdotool keyup ${keys.join(" ")}' EXIT; xdotool keydown ${keys.join(" ")} && ${command})` : command;
  };
  /** One shell line per step; markers report how far a batch got. */
  function step(action, targetId) {
    const pointer = (x, y) => `xdotool mousemove ${targetId === undefined ? "" : `--window ${windowId(targetId)} `}${integer(x)} ${integer(y)}`;
    switch (action.type) {
      case "move": return pointer(action.x, action.y);
      case "click": case "double_click": case "triple_click": {
        const repeat = action.type === "click" ? 1 : action.type === "double_click" ? 2 : 3;
        return withModifiers(action.modifiers, `${pointer(action.x, action.y)} click --repeat ${repeat} --delay 80 1`);
      }
      case "drag": {
        const [first, ...rest] = action.path ?? [];
        if (!first || !rest.length) throw new Error("A drag needs at least two points.");
        const drag = [`${pointer(first.x, first.y)} mousedown 1`, ...rest.map((point) => pointer(point.x, point.y))].join(" && ");
        return `(trap 'xdotool mouseup 1' EXIT; ${drag})`;
      }
      case "scroll": {
        // X11 wheel buttons: 4 up, 5 down, 6 left, 7 right; one notch is about 100 pixels.
        const vertical = Math.min(24, Math.round(Math.abs(Number(action.delta_y ?? 0)) / 100));
        const horizontal = Math.min(24, Math.round(Math.abs(Number(action.delta_x ?? 0)) / 100));
        const parts = [pointer(action.x, action.y)];
        if (vertical) parts.push(`xdotool click --repeat ${vertical} --delay 30 ${Number(action.delta_y) > 0 ? 4 : 5}`);
        if (horizontal) parts.push(`xdotool click --repeat ${horizontal} --delay 30 ${Number(action.delta_x) > 0 ? 6 : 7}`);
        return parts.join(" && ");
      }
      case "type": return `xdotool type --delay 12 -- ${quote(action.text ?? "")}`;
      case "key": return `xdotool key --clearmodifiers ${quote(key(action.key, action.modifiers))}`;
      case "wait": return `sleep ${Math.min(3, Math.max(0.05, Number(action.ms ?? 0) / 1000)).toFixed(2)}`;
      default: throw new Error(`Unsupported action ${action.type}.`);
    }
  }

  return {
    platform: "linux",
    async describe() {
      try {
        const result = await run(`missing=""; for tool in ${TOOLS.join(" ")}; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done; echo "missing:$missing"; xdotool getdisplaygeometry >/dev/null 2>&1 && echo display:ok`, 10_000);
        const missing = result.stdout.match(/missing:(.*)/)?.[1].trim();
        if (missing) return { readiness: "setup-required", detail: `This VM needs ${missing.split(/\s+/).join(" and ")}. Install them (for example apt-get install -y xdotool imagemagick python3).` };
        if (!result.stdout.includes("display:ok")) return { readiness: "setup-required", detail: `This VM has no desktop on display ${display}. Start one (for example Xvfb ${display}) and try again.` };
        return { readiness: "ready", detail: "Ready" };
      } catch (error) {
        return { readiness: "unavailable", detail: `Could not reach this VM: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    async screen() {
      const result = await run("xdotool getdisplaygeometry");
      const [width, height] = result.stdout.trim().split(/\s+/).map(Number);
      if (!width || !height) throw new Error("The VM's display size is unavailable.");
      return { x: 0, y: 0, width, height };
    },
    async windows() {
      // Metadata is untrusted. JSON framing prevents titles/classes containing
      // tabs or newlines from creating another approval candidate. Geometry is
      // parsed as numbers, never evaluated as shell code.
      const script = String.raw`
import json, pathlib, subprocess

def command(*args):
    return subprocess.run(["xdotool", *args], check=True, capture_output=True, text=True, timeout=3).stdout.rstrip("\n")

windows = []
try: ids = command("search", "--onlyvisible", "--name", ".").splitlines()
except subprocess.CalledProcessError: ids = []
for value in dict.fromkeys(ids):
    if len(windows) >= 128: break
    try:
        window = int(value)
        if not 0 < window <= 0xffffffff: continue
        raw = dict(line.split("=", 1) for line in command("getwindowgeometry", "--shell", str(window)).splitlines() if "=" in line)
        region = {key: int(raw[name]) for key, name in [("x", "X"), ("y", "Y"), ("width", "WIDTH"), ("height", "HEIGHT")]}
        if region["width"] < 80 or region["height"] < 60: continue
        try: app = command("getwindowclassname", str(window))
        except subprocess.CalledProcessError:
            try:
                pid = int(command("getwindowpid", str(window)))
                app = pathlib.Path(f"/proc/{pid}/comm").read_text().strip()
            except (ValueError, OSError, subprocess.SubprocessError): app = "app"
        title = command("getwindowname", str(window))
        windows.append({"id": window, "app": app[:120] or "app", "title": title[:500] or "Untitled window", "region": region})
    except (KeyError, ValueError, OSError, subprocess.SubprocessError): continue
print(json.dumps(windows))
`;
      const result = await run(`python3 -c ${quote(script)}`);
      if (result.exitCode !== 0) throw new Error("The VM could not enumerate its windows.");
      const windows = JSON.parse(result.stdout);
      if (!Array.isArray(windows)) throw new Error("The VM returned an invalid window list.");
      const seen = new Set();
      return windows.slice(0, 128).filter((window) => {
        if (!window || !Number.isSafeInteger(window.id) || window.id <= 0 || window.id > 0xffffffff || seen.has(window.id)
          || typeof window.app !== "string" || typeof window.title !== "string" || !window.region
          || !["x", "y", "width", "height"].every((key) => Number.isSafeInteger(window.region[key]))
          || window.region.width < 80 || window.region.height < 60) return false;
        seen.add(window.id);
        return true;
      });
    },
    async focus(id) {
      const result = await run(`xdotool windowactivate --sync ${windowId(id)} 2>/dev/null || xdotool windowraise ${windowId(id)} windowfocus --sync ${windowId(id)}`);
      if (result.exitCode !== 0) throw new Error("The selected window could not be focused.");
    },
    async screenshot(region, { maxWidth, windowId: targetId } = {}) {
      const file = `${directory}/shot-${randomUUID().slice(0, 8)}.png`;
      const resize = maxWidth && region.width > maxWidth ? ` -resize ${integer(maxWidth)}x` : "";
      const geometry = `${integer(region.width)}x${integer(region.height)}+${integer(region.x)}+${integer(region.y)}`;
      // Never use -screen for an approved window: it includes overlapping windows.
      // Unavailable/occluded drawable pixels may be blank, which is safe to withhold.
      const drawable = targetId === undefined ? "root" : windowId(targetId);
      try {
        const result = await run(`mkdir -p ${quote(directory)} && import -silent -window ${drawable} -crop ${geometry} +repage${resize} png:${quote(file)} && identify -format '%w %h' ${quote(file)}`);
        if (result.exitCode !== 0) throw new Error(result.stderr.trim().slice(0, 300) || "The screenshot failed.");
        const [width, height] = result.stdout.trim().split(/\s+/).map(Number);
        if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 8192)) throw new Error("The VM returned an invalid screenshot size.");
        const png = await machine.read(file, timeoutMs);
        if (!png.byteLength || png.byteLength > 16 * 1024 * 1024) throw new Error("The screenshot is empty or too large.");
        return { png, width, height };
      } finally { await run(`rm -f ${quote(file)}`).catch(() => {}); }
    },
    async input(steps, { windowId: targetId } = {}) {
      // Lines run in order and stop at the first failure; markers count the finished steps.
      // The rollout grants access to the configured VM. XTest input reaches
      // real apps, including apps that ignore XSendEvent. Window-relative
      // motion is translated by X11; keyboard input uses the focused window.
      const command = (action) => step(action, targetId);
      const lines = steps.map((action, index) => `${command(action)} || { echo "failed:${index}"; exit 0; }; echo "done:${index}"`);
      const result = await run(lines.join("\n"));
      const done = [...result.stdout.matchAll(/done:(\d+)/g)].length;
      const failed = result.stdout.match(/failed:(\d+)/);
      return { completed: done, ...(failed || result.exitCode !== 0 ? { error: `Step ${(failed ? Number(failed[1]) : done) + 1} failed: ${result.stderr.trim().slice(0, 200) || "xdotool refused it"}.` } : {}) };
    },
  };
}
