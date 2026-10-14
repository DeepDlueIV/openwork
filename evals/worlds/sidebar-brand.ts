import { createAndSelectWorkspace, waitFor } from "@openwork/behaviors";
import { appWeb, browserScript, type Place, type Surface } from "@openwork/testkit";

export async function setSidebarBrandTheme(app: Surface, dark: boolean) {
  const theme = dark ? "dark" : "light";
  await app.client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await waitFor(app, browserScript(theme => document.documentElement.dataset.theme === theme
    && getComputedStyle(document.documentElement).colorScheme === theme, [theme]), { timeoutMs: 5_000 });
}

/** The app in headless Chrome with one workspace; the brand geometry is app UI. */
export async function sidebarBrandApp(place: Place) {
  const workspacePath = `/tmp/openwork-sidebar-brand-${Date.now()}`;
  const app = await appWeb({ place, name: "sidebar-brand-geometry", workspacePath, mouse: true });
  try {
    await createAndSelectWorkspace(app, { path: workspacePath });
    return app;
  } catch (error) {
    await app.stop();
    throw error;
  }
}
