const fs = require("node:fs");
const path = require("node:path");
const upstreamAfterPack = require("./electron-after-pack.cjs");

module.exports = async function afterPack(context) {
  await upstreamAfterPack(context);
  // Persist only the resolved identity/isolation settings. Unlike the optional
  // electron-builder debug dump, this verification input also exists on CI.
  const config = context.packager.config;
  const evidence = {
    appId: context.packager.appInfo.id,
    productName: context.packager.appInfo.productName,
    publish: config.publish ?? null,
    protocols: config.protocols,
    nsis: {
      include: config.nsis?.include,
      deleteAppDataOnUninstall: config.nsis?.deleteAppDataOnUninstall,
    },
  };
  fs.writeFileSync(path.join(context.appOutDir, "noclip-build-config.json"), JSON.stringify(evidence, null, 2));
};
