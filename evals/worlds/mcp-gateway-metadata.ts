import type { Seed } from "@openwork/env";
import { seededOrganizationId } from "./organization-capabilities.ts";

export function metadataRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an MCP object");
  return value;
}

export function metadataString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected non-empty MCP text");
  return value;
}

export function metadataRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected an MCP list");
  return value.map(metadataRecord);
}

/** A real Den and a member's scoped gateway token; no browser or provider mocks. */
export async function mcpGatewayMetadata(seed: Seed) {
  const den = await seed.den({
    org: { name: "Gateway metadata workspace", members: {} },
    env: { DEN_APP_MCP_SERVERS_ENABLED: "true" },
  });
  const organizationId = await seededOrganizationId(seed, den.admin);
  const minted = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  if (!minted.response.ok) throw new Error(`Gateway token setup: HTTP ${minted.response.status}`);
  const token = metadataString(metadataRecord(minted.body).token);
  let sequence = 0;

  async function request(method: string, params: Record<string, unknown> = {}, authenticated = true) {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: {
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await response.text();
    return { status: response.status, challenge: response.headers.get("www-authenticate"), text };
  }

  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const response = await request(method, params);
    if (response.status !== 200) throw new Error(`Gateway ${method}: HTTP ${response.status}: ${response.text.slice(0, 300)}`);
    const data = response.text.split("\n").find(line => line.startsWith("data:"));
    const frame = metadataRecord(JSON.parse(data ? data.slice(5) : response.text));
    if (frame.error) throw new Error(`Gateway ${method}: ${JSON.stringify(frame.error)}`);
    return metadataRecord(frame.result);
  }

  return { rpc, request };
}
