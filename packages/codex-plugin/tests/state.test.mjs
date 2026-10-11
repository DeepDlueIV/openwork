import test from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { deleteCredentials, readConfig, readCredentials, readStateFile, writeConfig, writeCredentials, writeStateFile } from "../src/state.mjs"
import { installPlugin } from "../scripts/install.mjs"

const credentials = { apiBaseUrl: "https://api.openworklabs.com", token: "test-secret-do-not-log", orgId: "org-test", user: { id: "user-test" }, expiresAt: "2099-01-01T00:00:00.000Z" }
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "openwork-codex-state-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test("credentials are atomically owner-only outside repositories; config starts unenrolled", async (t) => {
  const root = await fixture(t)
  const directory = join(root, "state")
  assert.equal(await readCredentials(directory), null)
  assert.deepEqual(await readConfig(directory), {})
  await writeCredentials(credentials, directory)
  assert.deepEqual(await readCredentials(directory), credentials)
  if (process.platform !== "win32") {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700)
    assert.equal((await lstat(join(directory, "credentials.json"))).mode & 0o777, 0o600)
  }
  assert.deepEqual(await readdir(directory), ["credentials.json"])
  await writeCredentials({ ...credentials, token: "updated-secret" }, directory)
  assert.equal((await readCredentials(directory)).token, "updated-secret")
  await writeConfig({ remoteControl: { enabled: false }, custom: "preserved" }, directory)
  assert.equal((await readConfig(directory)).remoteControl.enabled, false)
  await deleteCredentials(directory)
  assert.equal(await readCredentials(directory), null)
  assert.equal((await readConfig(directory)).custom, "preserved")
})

test("expired credentials return null; invalid data never gets stored", async (t) => {
  const directory = join(await fixture(t), "state")
  await writeCredentials({ ...credentials, expiresAt: "2000-01-01T00:00:00.000Z" }, directory)
  assert.equal(await readCredentials(directory), null)
  await assert.rejects(writeCredentials({ ...credentials, token: "" }, directory), /Invalid/)
  await assert.rejects(writeCredentials({ ...credentials, expiresAt: "not-a-date" }, directory), /expiry/)
  await assert.rejects(writeCredentials({ ...credentials, apiBaseUrl: "http://evil.test" }, directory), /HTTPS/)
})

test("state rejects symlinks, insecure files, repository directories and traversal", async (t) => {
  const root = await fixture(t)
  const directory = join(root, "state")
  await writeCredentials(credentials, directory)
  await symlink(directory, join(root, "linked"))
  await assert.rejects(readCredentials(join(root, "linked")), /symlink/)
  await assert.rejects(writeCredentials(credentials, join(root, "linked", "nested")), /symlink/)
  await rm(join(directory, "credentials.json"))
  const target = join(root, "user-file")
  await writeFile(target, "preserve")
  await symlink(target, join(directory, "credentials.json"))
  await assert.rejects(writeCredentials(credentials, directory), /non-file/)
  await assert.rejects(readCredentials(directory), /symlink/)
  assert.equal(await readFile(target, "utf8"), "preserve")
  await mkdir(join(root, "repository"))
  await writeFile(join(root, "repository", ".git"), "gitdir: /elsewhere")
  await assert.rejects(writeCredentials(credentials, join(root, "repository", "state")), /outside a Git repository/)
  await assert.rejects(writeStateFile("../escape.json", {}, directory), /file name/)
  await assert.rejects(readStateFile("../escape.json", directory), /file name/)
  if (process.platform !== "win32") {
    await chmod(directory, 0o755)
    await assert.rejects(readConfig(directory), /directory permissions/)
    await writeConfig({}, directory)
    assert.equal((await lstat(directory)).mode & 0o777, 0o700)
    await chmod(join(directory, "config.json"), 0o644)
    await assert.rejects(readConfig(directory), /file permissions/)
  }
})

async function pluginFixture(root) {
  const source = join(root, "source")
  const files = {
    "plugin.json": JSON.stringify({ name: "openwork-local", version: "0.1.0-local" }),
    "package.json": JSON.stringify({ name: "@openwork/codex-plugin" }),
    "lib/index.mjs": "export const test = true\n",
    "src/mcp.mjs": "// runtime\n",
    "src/cli.mjs": "// CLI\n",
    ".mcp.json": JSON.stringify({ mcpServers: { "openwork-local": { command: "/bin/sh", args: ["./scripts/launch-mcp.sh", "./src/mcp.mjs"], env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH"] } } }),
    "scripts/launch-mcp.sh": "#!/bin/sh\nexec node \"$@\"\n",
    ".codex-plugin/plugin.json": JSON.stringify({ name: "openwork-local" }),
    "skills/setup/SKILL.md": "# Setup\n",
    "scripts/helper.mjs": "// helper\n",
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(source, name)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, content)
  }
  return source
}

test("installer dry-run touches neither destination nor fixture personal config", async (t) => {
  const root = await fixture(t)
  const source = await pluginFixture(root)
  const home = join(root, "home")
  const result = await installPlugin({ home, sourceDirectory: source, dryRun: true })
  assert.equal(result.sourcePath, "./.codex/plugins/openwork-local")
  await assert.rejects(lstat(home), { code: "ENOENT" })
})

test("installer preserves marketplace identity and all existing entries, rewrites absolute stdio", async (t) => {
  const root = await fixture(t)
  const source = await pluginFixture(root)
  const home = join(root, "home")
  const marketplace = join(home, ".agents", "plugins", "marketplace.json")
  const original = { name: "user-marketplace", custom: { keep: true }, plugins: [{ name: "user-plugin", source: "./plugins/user-plugin", extra: "keep" }] }
  await mkdir(join(home, ".agents", "plugins"), { recursive: true })
  await writeFile(marketplace, JSON.stringify(original))
  const result = await installPlugin({ home, sourceDirectory: source })
  const updated = JSON.parse(await readFile(marketplace, "utf8"))
  assert.equal(updated.name, original.name)
  assert.deepEqual(updated.custom, original.custom)
  assert.deepEqual(updated.plugins[0], original.plugins[0])
  assert.equal(updated.plugins[1].policy.installation, "AVAILABLE")
  assert.equal(updated.plugins[1].source.path, "./.codex/plugins/openwork-local")
  const mcp = JSON.parse(await readFile(join(result.installDirectory, ".mcp.json"), "utf8"))
  assert.deepEqual(mcp.mcpServers["openwork-local"], { command: "/bin/sh", args: [join(result.installDirectory, "scripts", "launch-mcp.sh"), join(result.installDirectory, "src", "mcp.mjs")], env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH"] })
  assert.equal(JSON.parse(await readFile(join(result.installDirectory, "mcp.json"), "utf8")).mcpServers["openwork-local"].type, "stdio")
  assert.equal(await readFile(join(result.installDirectory, "scripts", "helper.mjs"), "utf8"), "// helper\n")
  const text = await readFile(marketplace, "utf8")
  await installPlugin({ home, sourceDirectory: source })
  assert.equal(await readFile(marketplace, "utf8"), text)
  await assert.rejects(lstat(join(home, ".codex", "config.toml")), { code: "ENOENT" })
})

test("installer refuses external/overlapping directories and unfamiliar user work", async (t) => {
  const root = await fixture(t)
  const source = await pluginFixture(root)
  const home = join(root, "home")
  await assert.rejects(installPlugin({ home, sourceDirectory: source, installDirectory: join(root, "outside"), dryRun: true }), /inside/)
  await assert.rejects(installPlugin({ home: root, sourceDirectory: source, installDirectory: source, dryRun: true }), /overlap/)
  const destination = join(home, ".codex", "plugins", "openwork-local")
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, "user.txt"), "preserve")
  await assert.rejects(installPlugin({ home, sourceDirectory: source }), /unfamiliar/)
  assert.equal(await readFile(join(destination, "user.txt"), "utf8"), "preserve")
})
