import { connectAvailable } from "./connect-opt-out.js"
import { env } from "./env.js"

/**
 * Whether members of this organization can build their own Apps, each served
 * as its own MCP server. It is on for every organization: the deployment allows
 * it (DEN_APP_MCP_SERVERS_ENABLED, default true) and Connect is available to
 * the organization (see connect-opt-out.ts).
 *
 * It gates only Apps built in OpenWork. MCP Apps from connected MCP servers
 * work either way, and where it is off, Workflow-bound views stay writable.
 */
export function appMcpServersEnabled(connectIsAvailable: boolean): boolean {
  return env.appMcpServersEnabled && connectIsAvailable
}

/** The same check by organization id, for callers that have not resolved Connect. */
export async function organizationBuildsMcpApps(organizationId: string): Promise<boolean> {
  return env.appMcpServersEnabled && await connectAvailable(organizationId)
}
