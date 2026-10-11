#!/usr/bin/env node
import { homedir } from "node:os"
import { realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"

const PLUGIN_NAME = "openwork-local"
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
async function statOptional(path) {
  try { return await lstat(path) } catch (error) { if (error.code === "ENOENT") return null; throw error }
}
async function noSymlinkParents(path) {
  let current = resolve(path)
  while (true) {
    const info = await statOptional(current)
    if (info?.isSymbolicLink()) throw new Error("Installer paths must not contain symlinks.")
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
async function assertSourceTree(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("Plugin source must contain only regular files and directories.")
  if (info.isDirectory()) for (const name of await readdir(path)) {
    if (["node_modules", ".git"].includes(name)) continue
    await assertSourceTree(join(path, name))
  }
}
async function loadMarketplace(path) {
  try {
    const text = await readFile(path, "utf8")
    const catalog = JSON.parse(text)
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog) || typeof catalog.name !== "string" || !catalog.name || !Array.isArray(catalog.plugins)) throw new Error("Invalid personal marketplace; refusing to overwrite it.")
    return { catalog, text }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return { catalog: { name: "local-personal", interface: { displayName: "Personal Local Plugins" }, plugins: [] }, text: null }
  }
}

/** Personal marketplace root is HOME, not HOME/.agents/plugins (OpenAI docs). */
export async function installPlugin({ home = homedir(), installDirectory, sourceDirectory = sourceRoot, dryRun = false } = {}) {
  const root = resolve(home)
  const destination = resolve(installDirectory ?? join(root, ".codex", "plugins", PLUGIN_NAME))
  const source = resolve(sourceDirectory)
  const marketplacePath = join(root, ".agents", "plugins", "marketplace.json")
  if (!inside(root, destination)) throw new Error("Install directory must be inside the personal marketplace root (your home directory).")
  if (destination === source || inside(source, destination) || inside(destination, source)) throw new Error("Plugin source and install directory must not overlap.")
  if (destination === marketplacePath || inside(destination, marketplacePath) || inside(join(root, ".agents"), destination)) throw new Error("Install directory must not overlap the personal marketplace configuration.")
  await noSymlinkParents(destination)
  await noSymlinkParents(marketplacePath)
  const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"))
  if (manifest.name !== PLUGIN_NAME) throw new Error("Unexpected plugin source identity.")
  // Built runtime is mandatory: installed plugin cannot depend on repository imports.
  for (const name of ["lib/index.mjs", "src/mcp.mjs", "src/cli.mjs", ".mcp.json", ".codex-plugin/plugin.json", "skills/setup/SKILL.md"]) {
    if (!(await lstat(join(source, name))).isFile()) throw new Error(`Missing plugin runtime file: ${name}. Build the prototype first.`)
  }
  await assertSourceTree(source)
  const existing = await statOptional(destination)
  if (existing) {
    if (!existing.isDirectory()) throw new Error("Install destination is not a plugin directory.")
    let previous
    try { previous = JSON.parse(await readFile(join(destination, "package.json"), "utf8")) } catch { throw new Error("Refusing to overwrite an unfamiliar install directory.") }
    if (previous.name !== "@openwork/codex-plugin") throw new Error("Refusing to overwrite an unfamiliar install directory.")
  }
  const { catalog, text } = await loadMarketplace(marketplacePath)
  const path = `./${relative(root, destination).split(sep).join("/")}`
  const matches = catalog.plugins.filter((entry) => entry?.name === PLUGIN_NAME)
  if (matches.length > 1) throw new Error("Personal marketplace has duplicate OpenWork prototype entries; resolve them manually.")
  const match = matches[0]
  if (match && (typeof match.source === "string" ? match.source : match.source?.path) !== path) throw new Error("A different plugin already uses this marketplace name; refusing to replace its entry.")
  const entry = match ?? {
    name: PLUGIN_NAME, source: { source: "local", path },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Productivity",
  }
  // Preserve all existing fields, entries, ordering, policies, and marketplace name.
  const updated = match ? catalog : { ...catalog, plugins: [...catalog.plugins, entry] }
  const result = { dryRun, installDirectory: destination, marketplacePath, marketplaceName: catalog.name, sourcePath: path,
    message: "Copy the plugin and add its marketplace entry only. Review/install it in Codex; login and remote enrollment remain separate explicit steps." }
  if (dryRun) return result

  await mkdir(dirname(marketplacePath), { recursive: true, mode: 0o700 })
  const lockPath = `${marketplacePath}.openwork-install.lock`
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new Error("Another install is in progress; refusing concurrent marketplace updates.") })
  const staging = `${destination}.staging-${randomUUID()}`
  const backup = `${destination}.backup-${randomUUID()}`
  const marketTemp = `${marketplacePath}.${randomUUID()}.tmp`
  let backedUp = false
  let installed = false
  try {
    if ((await loadMarketplace(marketplacePath)).text !== text) throw new Error("Personal marketplace changed; retry the installation.")
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await cp(source, staging, { recursive: true, filter: (path) => !["node_modules", ".git"].includes(path.split(sep).at(-1)) })
    const mcp = JSON.parse(await readFile(join(staging, ".mcp.json"), "utf8"))
    mcp.mcpServers[PLUGIN_NAME] = { command: process.execPath, args: [join(destination, "src", "mcp.mjs")] }
    await writeFile(join(staging, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 })
    // Also provide the new portable format; no undocumented MCP path variable.
    await writeFile(join(staging, "mcp.json"), `${JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [PLUGIN_NAME]: { type: "stdio", ...mcp.mcpServers[PLUGIN_NAME] } },
    }, null, 2)}\n`, { mode: 0o600 })
    if (existing) { await rename(destination, backup); backedUp = true }
    await rename(staging, destination)
    installed = true
    if (!match) {
      const handle = await open(marketTemp, "wx", 0o600)
      try { await handle.writeFile(`${JSON.stringify(updated, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
      if ((await loadMarketplace(marketplacePath)).text !== text) throw new Error("Personal marketplace changed; installation rolled back.")
      await rename(marketTemp, marketplacePath)
    }
  } catch (error) {
    if (installed) await rm(destination, { recursive: true, force: true })
    if (backedUp) { await rename(backup, destination); backedUp = false }
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(marketTemp, { force: true })
    if (backedUp) await rm(backup, { recursive: true, force: true })
    await lock.close()
    await rm(lockPath, { force: true })
  }
  return result
}

async function main(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") options.dryRun = true
    else if (args[i] === "--install-dir" && args[i + 1]) options.installDirectory = args[++i]
    else if (["--help", "-h"].includes(args[i])) {
      console.log("Usage: node scripts/install.mjs [--dry-run] [--install-dir <directory-inside-home>]\nCopies the built local plugin and preserves your personal marketplace. Does not enable plugins or remote control.")
      return
    } else throw new Error("Unknown installer option. Use --help.")
  }
  console.log(JSON.stringify(await installPlugin(options), null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
