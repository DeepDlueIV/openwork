import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { startMockIdpLab } from "@openwork/labs";
import { chrome, localHost } from "@openwork/hosts";
import { denFetch, evalIn, waitFor, clickButton } from "@openwork/behaviors";
import { browserScript } from "@openwork/cdp";
import type { Den } from "@openwork/env";

const run = promisify(execFile);
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}
function field(value: unknown, key: string): string {
  const result = record(value)[key];
  if (typeof result !== "string" || !result) throw new Error(`Missing ${key}`);
  return result;
}
function sql(value: string): string {
  return `CONVERT(0x${Buffer.from(value).toString("hex")} USING utf8mb4)`;
}

/** Local, disposable published-image lab only. DNS verification and linking the
 * pre-existing lab owner are arrangements, not claims about production SSO. */
export async function splitOriginSso(den: Den) {
  const mysql = process.env.SWITCHORG_LAB_MYSQL_CONTAINER;
  if (!mysql || !/^switchorg-proof-mysql-\d+$/.test(mysql)) {
    throw new Error("SSO arrangement requires the explicitly owned switchorg-proof MySQL container");
  }
  if (den.ref.webUrl !== "http://localhost:3305"
    || !["http://localhost:9788", "http://localhost:3305/api/den"].includes(den.ref.apiUrl)) {
    throw new Error("Refusing SSO mutations outside the explicitly owned loopback lab");
  }
  for (const container of [mysql, "switchorg-proof-den-1", "switchorg-proof-web-1"]) {
    const { stdout } = await run("podman", ["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', container]);
    if (stdout.trim() !== "switchorg-proof") throw new Error("Container is not in the owned lab project");
  }
  const address = process.env.SWITCHORG_IDP_HOST ?? Object.values(networkInterfaces()).flat()
    .find((item) => item?.family === "IPv4" && !item.internal)?.address;
  if (!address) throw new Error("No host address reachable from the lab containers");
  const idp = await startMockIdpLab({
    publicIssuer: `http://${address}:19190`, listen: { host: "0.0.0.0", port: 19190 },
    domain: den.admin.email.split("@")[1],
    defaultSubject: { email: den.admin.email, name: "Lab Owner" },
    knobs: { interactive: true },
  });
  const database = async (query: string) => {
    await run("podman", ["exec", mysql, "mysql", "-uroot", "-ppassword", "openwork_den", "-e", query]);
  };
  let registered = false;
  const headers: Record<string, string> = { authorization: `Bearer ${den.admin.token}` };
  const request = async (path: string, method = "GET", body?: unknown) => {
    const result = await denFetch(den.admin, path, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!result.response.ok) throw new Error(`${method} ${path}: HTTP ${result.response.status}`);
    return result;
  };
  const cleanup = new AsyncDisposableStack();
  cleanup.defer(() => idp.stop());
  cleanup.defer(async () => { if (registered) await request("/v1/sso/disable", "POST", {}); });
  cleanup.defer(async () => { if (registered) await request("/v1/org", "PATCH", { requireSso: false }); });
  const stop = () => cleanup.disposeAsync();
  try {
    const signIn = await denFetch(den.ref, "/api/auth/sign-in/email", {
      method: "POST", body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
    });
    if (!signIn.response.ok) throw new Error(`SSO setup sign-in HTTP ${signIn.response.status}`);
    const userId = field(record(signIn.body).user, "id");
    const cookie = signIn.response.headers.getSetCookie().map((value) => value.split(";")[0]?.trim())
      .find((value) => value?.includes("session_token="));
    if (!cookie) throw new Error("Missing lab admin cookie");
    headers.authorization = `Bearer ${field(signIn.body, "token")}`;
    headers.cookie = cookie;
    const org = await request("/v1/org");
    const organization = record(record(org.body).organization);
    if (organization.name !== "Split Origin Lab" || organization.slug !== "default") {
      throw new Error("Refusing to modify a non-fixture organization");
    }
    const existing = record((await request("/v1/sso")).body).connection;
    if (existing !== null && existing !== undefined) {
      const connection = record(existing);
      if (connection.status !== "disabled" || connection.issuer !== idp.issuer
        || connection.domain !== den.admin.email.split("@")[1]) {
        throw new Error("Refusing to replace an unrelated or enabled SSO configuration");
      }
    }
    const orgId = field(organization, "id");
    await database(`UPDATE organization SET metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()), '$.plan', JSON_OBJECT('tier','enterprise','source','manual')) WHERE id=${sql(orgId)};`);
    const registration = idp.registration({ skipDiscovery: true });
    const response = await request("/v1/sso/oidc", "POST", {
      issuer: registration.issuer, domain: registration.domain,
      clientId: registration.clientId, clientSecret: registration.clientSecret,
      scopes: registration.scopes, skipDiscovery: true,
      authorizationEndpoint: registration.authorizationEndpoint, tokenEndpoint: registration.tokenEndpoint,
      jwksEndpoint: registration.jwksEndpoint, userInfoEndpoint: registration.userInfoEndpoint,
      tokenEndpointAuthentication: registration.tokenEndpointAuthentication,
    });
    registered = true;
    const providerId = field(record(response.body).connection, "providerId");
    await database(`UPDATE sso_provider SET domain_verified=1 WHERE organization_id=${sql(orgId)} AND provider_id=${sql(providerId)};
      INSERT INTO account (id,user_id,account_id,provider_id) SELECT ${sql(`acc_0${randomBytes(13).toString("hex").slice(1)}`)},${sql(userId)},${sql(den.admin.email)},${sql(providerId)} WHERE NOT EXISTS (SELECT 1 FROM account WHERE provider_id=${sql(providerId)} AND account_id=${sql(den.admin.email)});`);
    const test = await request("/v1/sso/test", "POST", {});
    const testUrl = field(test.body, "testUrl");
    await using browser = await chrome({ host: localHost(), name: "split-origin-sso-configuration", headless: true });
    const separator = cookie.indexOf("=");
    await browser.client.send("Network.setCookie", { name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: testUrl, httpOnly: true });
    await evalIn(browser, browserScript((url) => { location.href = url; }, [testUrl]));
    await waitFor(browser, () => document.body.innerText.includes("Approve sign-in"), { timeoutMs: 60_000, label: "OIDC configuration consent" });
    await clickButton(browser, "Approve sign-in");
    await waitFor(browser, () => location.pathname === "/sso/test/complete", { timeoutMs: 60_000, label: "OIDC configuration callback" });
    const status = await request("/v1/sso");
    if (field(record(status.body).connection, "testStatus") !== "succeeded") throw new Error("OIDC configuration test did not succeed");
    await request("/v1/sso/enable", "POST", {});
    await request("/v1/org", "PATCH", { requireSso: true });
    return { issuer: idp.issuer, stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
