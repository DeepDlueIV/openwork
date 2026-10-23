import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

export const NOCLIP_APP_ID = "io.github.deepdlueiv.noclip";

// Use the OS account home, not HOME/USERPROFILE: Electron relaunch inherits the
// private runtime environment and must not create a nested profile each time.
export function resolveNoClipProfile({ hostHome = userInfo().homedir, platform = process.platform } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!hostHome || !paths.isAbsolute(hostHome)) throw new TypeError("NoClip requires an absolute OS account home.");
  const rootPath = paths.join(hostHome, ".noclip");
  const homePath = paths.join(rootPath, "runtime", "home");
  const config = paths.join(rootPath, "runtime", "config");
  const userDataPath = paths.join(rootPath, "desktop");
  const environment = {
    HOME: homePath,
    USERPROFILE: homePath,
    APPDATA: paths.join(rootPath, "runtime", "roaming"),
    LOCALAPPDATA: paths.join(rootPath, "runtime", "local"),
    XDG_CONFIG_HOME: paths.join(rootPath, "runtime", "xdg", "config"),
    XDG_DATA_HOME: paths.join(rootPath, "runtime", "xdg", "data"),
    XDG_CACHE_HOME: paths.join(rootPath, "runtime", "xdg", "cache"),
    XDG_STATE_HOME: paths.join(rootPath, "runtime", "xdg", "state"),
    OPENWORK_ELECTRON_USERDATA: userDataPath,
    OPENWORK_ELECTRON_APP_IDENTIFIER: NOCLIP_APP_ID,
    OPENWORK_DESKTOP_DISTRIBUTION: "noclip",
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: paths.join(config, "desktop-bootstrap.json"),
    OPENWORK_SERVER_CONFIG: paths.join(config, "server.json"),
    OPENWORK_ENV_STORE: paths.join(config, "env.json"),
    OPENWORK_TOKEN_STORE: paths.join(config, "tokens.json"),
    OPENWORK_RUNTIME_DB: paths.join(config, "runtime.sqlite"),
    OPENWORK_DATA_DIR: paths.join(rootPath, "runtime", "data"),
    OPENCODE_CONFIG_DIR: paths.join(rootPath, "runtime", "opencode", "config"),
    OPENCODE_DB: paths.join(rootPath, "runtime", "opencode", "data", "opencode.db"),
    OPENCODE_TEST_HOME: homePath,
  };
  const directories = [rootPath, userDataPath, homePath, config,
    environment.APPDATA, environment.LOCALAPPDATA,
    environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME,
    environment.XDG_CACHE_HOME, environment.XDG_STATE_HOME,
    environment.OPENWORK_DATA_DIR, environment.OPENCODE_CONFIG_DIR,
    paths.dirname(environment.OPENCODE_DB),
    paths.join(rootPath, "logs"), paths.join(rootPath, "crashes")];
  return { rootPath, userDataPath, homePath, environment, directories };
}

export function applyNoClipProfile({ app, env = process.env, hostHome, platform = process.platform,
  createDirectory = (directory) => mkdirSync(directory, { recursive: true, mode: 0o700 }),
} = {}) {
  const profile = resolveNoClipProfile({ hostHome, platform });
  const paths = platform === "win32" ? path.win32 : path.posix;
  for (const directory of profile.directories) createDirectory(directory);
  // Electron resolves appData through native OS paths, not just env.APPDATA.
  // Redirecting USERPROFILE first breaks cold Windows known-folder resolution.
  // Register the existing private directory before mutating the environment or
  // importing upstream modules; never fall back to OpenWork's shared appData.
  app.setPath("appData", profile.environment.APPDATA);
  // Inherited OpenWork/OpenCode overrides must not reconnect this installation
  // to the original application's server, database, credentials or updater.
  for (const key of Object.keys(env)) {
    if (/^(OPENWORK_|OPENCODE_)/i.test(key)) delete env[key];
  }
  Object.assign(env, profile.environment);
  app.setName("NoClip");
  app.setAppUserModelId(NOCLIP_APP_ID);
  app.setPath("home", profile.homePath);
  app.setPath("userData", profile.userDataPath);
  app.setPath("sessionData", profile.userDataPath);
  app.setPath("crashDumps", paths.join(profile.rootPath, "crashes"));
  app.setAppLogsPath(paths.join(profile.rootPath, "logs"));
  return profile;
}
