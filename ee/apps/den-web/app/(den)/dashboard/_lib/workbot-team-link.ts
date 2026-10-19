/** Workbot links choose an explicit member workspace, never the browser's last active workspace. */
export function linkedWorkbotOrganization(href: string, organizations: readonly { id: string }[]): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("workbotOrganizationId")) return null;
  const id = url.searchParams.get("workbotOrganizationId");
  if (!id || url.searchParams.getAll("workbotOrganizationId").length !== 1
    || !["/dashboard/workbot-settings", "/dashboard/mcp-connections"].includes(url.pathname)
    || !organizations.some(org => org.id === id)) {
    throw new Error("This Workbot workspace is unavailable. Open Workbot and check your team access.");
  }
  return id;
}
