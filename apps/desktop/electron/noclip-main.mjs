import { createRequire } from "node:module";
import { applyNoClipProfile } from "./noclip-profile.mjs";

const require = createRequire(import.meta.url);
const { app } = require("electron");
const metadata = require("../package.json");
if (app.isPackaged && metadata.openworkDistribution !== "noclip") {
  throw new Error("The NoClip entry point requires NoClip package metadata.");
}
// Finish isolation before evaluating any upstream module or creating a session.
applyNoClipProfile({ app });
await import("./main.mjs");
