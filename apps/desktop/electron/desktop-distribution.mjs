export const PUBLIC_DESKTOP_DISTRIBUTION = Object.freeze({
  flavor: "public",
  appName: "OpenWork",
  appIdentifier: "com.differentai.openwork",
  protocolScheme: "openwork",
  requireSignin: false,
  requireActivation: false,
});

export const CLOUD_DESKTOP_DISTRIBUTION = Object.freeze({
  flavor: "cloud",
  appName: "OpenWork Cloud",
  appIdentifier: "com.differentai.openwork",
  protocolScheme: "openwork",
  requireSignin: true,
  requireActivation: false,
});

export const ENTERPRISE_DESKTOP_DISTRIBUTION = Object.freeze({
  flavor: "enterprise",
  appName: "OpenWork Enterprise",
  appIdentifier: "com.differentai.openwork",
  protocolScheme: "openwork",
  requireSignin: true,
  requireActivation: true,
});

// NoClip keeps the public renderer's existing capabilities, not Den's enterprise
// activation flow. The build identity is separate from the capability flavor.
export const NOCLIP_DESKTOP_DISTRIBUTION = Object.freeze({
  ...PUBLIC_DESKTOP_DISTRIBUTION,
  appName: "NoClip",
  appIdentifier: "io.github.deepdlueiv.noclip",
  protocolScheme: "noclip",
});

function normalizeFlavor(value) {
  const flavor = value?.trim().toLowerCase();
  return ["cloud", "enterprise", "noclip"].includes(flavor) ? flavor : "public";
}

/**
 * Packaged builds trust only electron-builder's immutable package metadata.
 * The environment override exists solely so development and coded evals can
 * exercise the enterprise gate without producing a signed installer.
 */
export function resolveDesktopDistribution({
  isPackaged,
  packageFlavor,
  environmentFlavor,
}) {
  const flavor = normalizeFlavor(
    isPackaged ? packageFlavor : (environmentFlavor || packageFlavor),
  );
  if (flavor === "noclip") return NOCLIP_DESKTOP_DISTRIBUTION;
  if (flavor === "cloud") return CLOUD_DESKTOP_DISTRIBUTION;
  if (flavor === "enterprise") return ENTERPRISE_DESKTOP_DISTRIBUTION;
  return PUBLIC_DESKTOP_DISTRIBUTION;
}

export function enterpriseActivationComplete(config) {
  if (!config || typeof config !== "object") return false;
  const activation = config.enterpriseActivation;
  return Boolean(
    activation
    && typeof activation === "object"
    && typeof activation.activatedAt === "string"
    && activation.activatedAt.trim()
    && typeof activation.denBaseUrl === "string"
    && activation.denBaseUrl.trim(),
  );
}

export function desktopActivationRequired(distribution, config) {
  const requireActivation = distribution.flavor === "enterprise"
    ? distribution.requireActivation
    : (typeof config?.requireActivation === "boolean"
        ? config.requireActivation
        : distribution.requireActivation);
  return requireActivation && !enterpriseActivationComplete(config);
}

const ENTERPRISE_PREACTIVATION_COMMANDS = new Set([
  "__showContextMenu",
  "__cancelContextMenu",
  "__fetch",
  "appBuildInfo",
  "connectLinkAccept",
  "connectLinkVerify",
  "getDesktopBootstrapConfig",
  "setDesktopBootstrapConfig",
]);

export function enterprisePreactivationCommandAllowed(command) {
  return ENTERPRISE_PREACTIVATION_COMMANDS.has(command);
}
