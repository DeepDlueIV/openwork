import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import {
  mcpGatewayMetadata,
  metadataRecord,
  metadataRows,
  metadataString,
} from "../worlds/mcp-gateway-metadata.ts";

const test = spec.world(mcpGatewayMetadata, {
  timeout: 300_000,
  needs: { commands: ["bun", "pnpm"] },
  resources: { surfaces: [], services: ["den"] },
});

function properties(schema: unknown) {
  return metadataRecord(metadataRecord(schema).properties);
}

function documentedFields(schema: unknown, names: string[]) {
  const fields = properties(schema);
  for (const name of names) {
    const description = metadataString(metadataRecord(fields[name]).description);
    expect(description.length, `${name} explains its purpose`).toBeGreaterThan(15);
  }
  return fields;
}

function toolNamed(tools: Record<string, unknown>[], name: string) {
  const tool = tools.find(entry => entry.name === name);
  if (!tool) throw new Error(`The member cannot discover ${name}`);
  return tool;
}

function invocationLabels(tool: Record<string, unknown>) {
  const meta = metadataRecord(tool._meta);
  const starting = metadataString(meta["openai/toolInvocation/invoking"]);
  const finished = metadataString(meta["openai/toolInvocation/invoked"]);
  expect(metadataRecord(meta["openai/toolInvocation"])).toEqual({ invoking: starting, invoked: finished });
  expect(starting.length).toBeLessThanOrEqual(64);
  expect(finished.length).toBeLessThanOrEqual(64);
  expect(starting).not.toBe(finished);
  return `${starting} → ${finished}`;
}

test("a connected member's MCP client discovers OpenWork with concise guidance and documented Apps", async ({ world, step, evidence }) => {
  await step("given a connected member, the client recognizes OpenWork without oversized startup guidance", async () => {
    // A synthetic MCP client acts over the public protocol; this journey has no visual surface.
    const initialized = await world.rpc("initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Metadata journey", version: "1.0.0" },
    });
    const server = metadataRecord(initialized.serverInfo);
    const title = metadataString(server.title);
    expect(title).toMatch(/OpenWork/i);
    const description = metadataString(server.description);
    expect(description).toMatch(/skill|workflow|connection|tool/i);
    const website = new URL(metadataString(server.websiteUrl));
    expect(website.protocol).toBe("https:");
    expect(website.username).toBe("");
    expect(website.password).toBe("");
    const icons = metadataRows(server.icons);
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(new URL(metadataString(icon.src)).protocol).toBe("https:");
      const mimeType = metadataString(icon.mimeType);
      expect(mimeType).toMatch(/^image\//);
      const sizes = icon.sizes;
      expect(mimeType === "image/svg+xml" || (Array.isArray(sizes) && sizes.some(size =>
        typeof size === "string" && /^\d+x\d+$/.test(size) && size.split("x").every(dimension => Number(dimension) >= 128),
      )), "Icons are scalable or at least 128px in each dimension").toBe(true);
    }
    const instructions = metadataString(initialized.instructions);
    const instructionBytes = Buffer.byteLength(instructions, "utf8");
    expect(instructionBytes).toBeLessThanOrEqual(2048);
    expect(instructions).toMatch(/search.*capabilit/i);
    expect(instructions).toMatch(/execute/i);
    expect(instructions).toMatch(/get_skill/);
    const guidanceUri = "openwork://agent/guidance.md";
    expect(instructions).toContain(guidanceUri);
    const guidance = metadataRows((await world.rpc("resources/read", { uri: guidanceUri })).contents);
    expect(guidance).toHaveLength(1);
    expect(guidance[0].uri).toBe(guidanceUri);
    const detailedGuidance = metadataString(guidance[0].text);
    expect(detailedGuidance).toMatch(/intent connect/);
    expect(detailedGuidance).toMatch(/connectionStatus\.action/);
    expect(detailedGuidance).toMatch(/remote-session:read/);
    expect(detailedGuidance).toMatch(/schemaGuidance/);
    expect(detailedGuidance).toMatch(/cloudReadiness/);
    expect(Buffer.byteLength(detailedGuidance, "utf8")).toBeGreaterThan(2048);
  });

  await step("when the member discovers App authoring, each input explains what to supply and each tool advertises its result", async () => {
    const tools = metadataRows((await world.rpc("tools/list")).tools);
    const shared = ["title", "description", "reactSource", "cssSource", "textFallback", "tools"];
    const cases = [
      { name: "prepare_app", inputs: ["title", "description", "tools"], outputs: ["preparationId", "title", "tools", "starter", "nextSteps"] },
      { name: "create_app", inputs: [...shared, "pluginId", "preparationId"], outputs: ["app", "input", "mcpUrl", "launch"] },
      { name: "update_app", inputs: [...shared, "appId", "expectedRevisionId"], outputs: ["app", "input", "mcpUrl", "launch"] },
      { name: "read_app", inputs: ["appId"], outputs: ["app", "reactSource", "cssSource"] },
    ];
    const observed = [];
    for (const entry of cases) {
      const tool = toolNamed(tools, entry.name);
      const fields = documentedFields(tool.inputSchema, entry.inputs);
      expect(Object.keys(properties(tool.outputSchema))).toEqual(expect.arrayContaining(entry.outputs));
      if (entry.inputs.includes("tools")) {
        documentedFields(metadataRecord(fields.tools).items, ["name", "description", "capability", "mode"]);
      }
      observed.push(`${entry.name}: ${entry.inputs.length} documented fields, ${entry.outputs.length} result fields`);
    }
    const otherDocumentedTools = [
      { name: "search_capabilities", inputs: ["query", "intent", "limit", "type"], outputs: ["matches", "hint", "connectionAction", "connectorCatalog"] },
      { name: "list_skills", inputs: ["query", "limit"], outputs: ["skills", "total", "hint"] },
      { name: "get_skill", inputs: ["name"], outputs: ["name", "title", "description", "capability", "location", "content", "provenance"] },
      { name: "create_skill", inputs: ["pluginName", "skillMarkdown"], outputs: ["schemaVersion", "mode", "name", "description", "pluginId", "skillId", "libraryUrl"] },
      { name: "update_skill", inputs: ["skillId", "skillMarkdown", "reason"], outputs: ["schemaVersion", "mode", "name", "description", "pluginId", "skillId", "libraryUrl"] },
      { name: "execute_capability_script", inputs: ["code", "mode", "input", "timeZone", "inputSchema", "outputSchema"], outputs: ["value", "metadata"] },
    ];
    for (const entry of otherDocumentedTools) {
      const tool = toolNamed(tools, entry.name);
      documentedFields(tool.inputSchema, entry.inputs);
      expect(Object.keys(properties(tool.outputSchema))).toEqual(expect.arrayContaining(entry.outputs));
      observed.push(`${entry.name}: ${entry.inputs.length} documented fields, ${entry.outputs.length} result fields`);
    }
    // Heterogeneous executors must retain text-only successes: a declared output
    // schema would make the installed SDK reject results without structuredContent.
    documentedFields(toolNamed(tools, "execute_capability").inputSchema, ["name", "schemaDigest", "path", "query", "body"]);
    const legacySkill = await world.rpc("tools/call", {
      name: "execute_capability", arguments: { name: "skill:create-skill" },
    });
    expect(legacySkill.isError).not.toBe(true);
    expect(legacySkill.structuredContent).toBeUndefined();
    expect(metadataString(metadataRows(legacySkill.content)[0].text)).toMatch(/create.skill/i);
    observed.push("execute_capability preserved a successful text-only skill result");
    const script = await world.rpc("tools/call", {
      name: "execute_capability_script", arguments: { code: "return { total: 2 };" },
    });
    expect(script.isError).not.toBe(true);
    const scriptResult = metadataRecord(script.structuredContent);
    expect(scriptResult.value).toEqual({ total: 2 });
    const scriptMetadata = metadataRecord(scriptResult.metadata);
    expect(scriptMetadata.executionType).toBe("authoring-test");
    expect(scriptMetadata.mode).toBe("adhoc");
    expect(scriptMetadata.verification).toBe("not-requested");
    expect(typeof metadataRecord(scriptMetadata.retention).canSaveByReceipt).toBe("boolean");
    observed.push("execute_capability_script returned its advertised value and authoring metadata");
    const skills = await world.rpc("tools/call", { name: "list_skills", arguments: {} });
    expect(skills.isError).not.toBe(true);
    const catalog = metadataRecord(skills.structuredContent);
    expect(metadataRows(catalog.skills).some(skill => skill.name === "build-an-app")).toBe(true);
    expect(catalog.total).toBeGreaterThan(0);
    const skill = await world.rpc("tools/call", { name: "get_skill", arguments: { name: "build-an-app" } });
    expect(skill.isError).not.toBe(true);
    const skillText = metadataString(metadataRecord(skill.structuredContent).content);
    expect(skillText).toMatch(/app\.callServerTool/);
    expect(skillText).toMatch(/hostContext/);
    expect(skillText).toMatch(/openwork\/result-cache/);
    expect(skillText).toMatch(/approval/);
    observed.push("list_skills/get_skill retain the App source, host-context, cache and approval rules");
    const create = toolNamed(tools, "create_app");
    const description = metadataString(create.description);
    const descriptionBytes = Buffer.byteLength(description, "utf8");
    expect(descriptionBytes).toBeLessThanOrEqual(2048);
    expect(description).toMatch(/build-an-app|get_skill/i);
    // Prove the advertised preparation result is usable, not just a tool-list declaration.
    const preparation = await world.rpc("tools/call", {
      name: "prepare_app", arguments: { title: "Weekly total calculator", description: "Calculate a weekly total without an external connection.", tools: [] },
    });
    expect(preparation.isError).not.toBe(true);
    const result = metadataRecord(preparation.structuredContent);
    expect(metadataString(result.preparationId)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.tools).toEqual([]);
    expect(metadataString(metadataRecord(result.starter).reactSource)).toMatch(/export default/);
    expect(metadataRows(preparation.content).some(part => part.type === "text")).toBe(true);
  });

  await step("after: both built-in views tell the host their purpose and share one secure sandbox origin", async () => {
    const resources = metadataRows((await world.rpc("resources/list")).resources);
    const tools = metadataRows((await world.rpc("tools/list")).tools);
    const views = [
      { uri: "ui://openwork/workflow-artifact/v1/view.html", tool: "render_workflow_artifact", purpose: /workflow|artifact/i },
      { uri: "ui://openwork/connection-action/v2/view.html", tool: "connection_action", purpose: /connect|sign.in|authoriz/i },
    ];
    const origins = [];
    const observations = [];
    for (const view of views) {
      const listed = resources.find(resource => resource.uri === view.uri);
      expect(listed, `${view.uri} is discoverable`).toBeDefined();
      const contents = metadataRows((await world.rpc("resources/read", { uri: view.uri })).contents);
      expect(contents).toHaveLength(1);
      const resource = contents[0];
      expect(resource.uri).toBe(view.uri);
      expect(resource.mimeType).toBe("text/html;profile=mcp-app");
      expect(metadataString(resource.text)).toMatch(/<!doctype html>/i);
      const meta = metadataRecord(resource._meta);
      const ui = metadataRecord(meta.ui);
      const domain = metadataString(ui.domain);
      const parsed = new URL(domain);
      expect(parsed.protocol).toBe("https:");
      expect(domain).toBe(parsed.origin);
      expect(parsed.username).toBe("");
      expect(parsed.password).toBe("");
      origins.push(domain);
      const widgetDescription = metadataString(meta["openai/widgetDescription"]);
      expect(widgetDescription).toMatch(view.purpose);
      const listedMeta = metadataRecord(metadataRecord(listed)._meta);
      expect(metadataRecord(listedMeta.ui).domain).toBe(domain);
      expect(listedMeta["openai/widgetDescription"]).toBe(widgetDescription);
      const tool = toolNamed(tools, view.tool);
      expect(metadataRecord(metadataRecord(tool._meta).ui).resourceUri).toBe(view.uri);
      observations.push(`${view.tool}: ${invocationLabels(tool)}; ${resource.mimeType}; ${widgetDescription}`);
    }
    expect(new Set(origins).size).toBe(1);
    // The second connection tool must also explain its transition to hosts.
    invocationLabels(toolNamed(tools, "connection_action_intent"));
  });

  await step("then a person without a gateway credential cannot read the member's discovery or views", async () => {
    const requests = [
      { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Anonymous client", version: "1.0.0" } } },
      { method: "tools/list", params: {} },
      { method: "resources/list", params: {} },
      { method: "resources/read", params: { uri: "ui://openwork/workflow-artifact/v1/view.html" } },
      { method: "resources/read", params: { uri: "ui://openwork/connection-action/v2/view.html" } },
    ];
    const statuses = [];
    for (const request of requests) {
      const response = await world.request(request.method, request.params, false);
      expect(response.status).toBe(401);
      expect(response.challenge).toMatch(/Bearer/i);
      expect(response.text).not.toMatch(/<!doctype html>|reactSource|structuredContent/i);
      statuses.push(`${request.method}${"uri" in request.params ? ` ${request.params.uri}` : ""}: ${response.status}`);
    }
  });
});
