import { lstat, realpath, readlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, resolve } from "node:path"

const SHARED_DIRECTORY = "/private/tmp/codex-browser-use"
const SOCKET_NAME = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.sock$/i

/** Filesystem endpoint integrity, not native peer authorization. Never changes
 * permissions. The host still verifies actual signing/ancestry independently.
 */
export async function validateNativeSocket(path, { uid = process.getuid?.(), platform = process.platform, fs = { lstat, realpath, readlink } } = {}) {
  const unsafe = () => { throw new Error("unsafe_native_pipe") }
  if (uid === undefined || !isAbsolute(path)) unsafe()
  const originalPipe = await fs.lstat(path)
  if (!originalPipe.isSocket() || originalPipe.isSymbolicLink() || originalPipe.uid !== uid || (originalPipe.mode & 0o077)) unsafe()
  const originalParent = await fs.lstat(dirname(path))
  if (!originalParent.isDirectory() || originalParent.isSymbolicLink()) unsafe()
  const canonical = await fs.realpath(path)
  const parentPath = dirname(canonical)
  const parent = await fs.lstat(parentPath)
  const pipe = await fs.lstat(canonical)
  if (!pipe.isSocket() || pipe.isSymbolicLink() || pipe.uid !== uid || (pipe.mode & 0o077) || pipe.dev !== originalPipe.dev || pipe.ino !== originalPipe.ino) unsafe()
  if (parent.uid === uid && !(parent.mode & 0o077) && parent.isDirectory() && !parent.isSymbolicLink()) return { path: canonical, dev: pipe.dev, ino: pipe.ino }

  // Build 155 creates precisely this shared sticky directory and chmods its
  // dynamically generated socket 0600. Other users cannot replace that socket.
  if (platform !== "darwin" || parentPath !== SHARED_DIRECTORY || !SOCKET_NAME.test(basename(canonical))) unsafe()
  if (!path.startsWith(`${SHARED_DIRECTORY}/`) && !path.startsWith("/tmp/codex-browser-use/")) unsafe()
  if (path.startsWith("/tmp/")) {
    const alias = await fs.lstat("/tmp")
    if (!alias.isSymbolicLink() || alias.uid !== 0 || resolve("/", await fs.readlink("/tmp")) !== "/private/tmp") unsafe()
  }
  for (const directory of [SHARED_DIRECTORY, "/private/tmp", "/private", "/"]) {
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, uid].includes(info.uid)) unsafe()
    if ((info.mode & 0o022) && !(info.mode & 0o1000)) unsafe()
  }
  return { path: canonical, dev: pipe.dev, ino: pipe.ino }
}

/** Recheck before sending to detect ordinary filesystem replacement. This is
 * not cryptographic server authentication or a defense against malicious
 * same-UID swap-and-restore; same-user code remains inside the trust boundary.
 */
export async function recheckNativeSocket(endpoint, fs = { lstat }) {
  const info = await fs.lstat(endpoint.path)
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.dev !== endpoint.dev || info.ino !== endpoint.ino) throw new Error("unsafe_native_pipe")
}
