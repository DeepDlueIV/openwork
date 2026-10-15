import { createAndSelectWorkspace, waitFor } from "@openwork/behaviors";
import { appWeb, browserScript, evalIn, type Place, type Surface } from "@openwork/testkit";

/** Read real SVG ink over the composited row surface; never recolor the product. */
export function readOpenWorkMarkContrast(app: Surface) {
  return evalIn(app, () => {
    const rgba = (color: string) => {
      const values = color.match(/[\d.]+/g)?.map(Number);
      if (!values || values.length < 3) throw new Error(`Unsupported color: ${color}`);
      return { rgb: values.slice(0, 3), alpha: values[3] ?? 1 };
    };
    const luminance = (rgb: number[]) => rgb.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    return [...document.querySelectorAll<SVGSVGElement>('svg[aria-label="OpenWork"]')].filter(mark => {
      const rect = mark.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && mark.closest('[role="dialog"]');
    }).map(mark => {
      const ancestors: Element[] = [];
      for (let element: Element | null = mark; element; element = element.parentElement) ancestors.unshift(element);
      let background = [255, 255, 255];
      for (const element of ancestors) {
        const layer = rgba(getComputedStyle(element).backgroundColor);
        background = background.map((channel, index) => layer.rgb[index] * layer.alpha + channel * (1 - layer.alpha));
      }
      const fill = getComputedStyle(mark).fill;
      const ink = luminance(rgba(fill).rgb);
      const surface = luminance(background);
      const rect = mark.getBoundingClientRect();
      const paths = [...mark.querySelectorAll('path')];
      return {
        fill, color: getComputedStyle(mark).color,
        contrast: (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05),
        width: rect.width, height: rect.height,
        pathsFollowInk: paths.length === 2 && paths.every(path => getComputedStyle(path).fill === fill && path.getAttribute('fill-rule') === 'evenodd'),
      };
    });
  });
}

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
