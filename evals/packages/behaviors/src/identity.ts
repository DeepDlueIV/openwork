// Identity calls a real client makes against Den: Den Web's settings pages
// (SSO, SCIM, member roles) and an identity provider posting to the SAML ACS.
import { denFetch, type DenFetchResult, type DenRef, type DenSession } from "./den.ts";

/** An organization member as Den Web calls on their behalf: bearer, session cookie and selected organization. */
export interface OrgCaller {
  session: DenSession;
  cookie: string;
  orgId: string;
}

export interface SamlConnectionInput {
  issuer: string;
  domain: string;
  entryPoint: string;
  cert: string;
  audience: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callerHeaders(caller: OrgCaller): Record<string, string> {
  return { authorization: `Bearer ${caller.session.token}`, cookie: caller.cookie, "x-openwork-org-id": caller.orgId };
}

/** Signs in through the email form Den Web uses and returns the browser session cookie it receives. */
export async function signInForSessionCookie(den: DenRef, credentials: { email: string; password: string }): Promise<string> {
  const result = await denFetch(den, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify(credentials) });
  const cookie = result.response.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "";
  if (!result.response.ok || !cookie) {
    throw new Error(`Cookie sign-in failed for ${credentials.email}: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  }
  return cookie;
}

/** Den Web's organization member list, resolved to one member's membership id. */
export async function organizationMembershipId(den: DenRef, caller: OrgCaller, email: string): Promise<string> {
  const result = await denFetch(den, "/v1/org", { headers: callerHeaders(caller) });
  const members = isRecord(result.body) && Array.isArray(result.body.members) ? result.body.members.filter(isRecord) : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const id = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !id) throw new Error(`Membership for ${email} not found: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  return id;
}

/** The SSO settings page's "Save SAML connection". */
export async function registerSamlConnection(den: DenRef, caller: OrgCaller, input: SamlConnectionInput): Promise<DenFetchResult> {
  return denFetch(den, "/v1/sso/saml", { method: "POST", headers: callerHeaders(caller), body: JSON.stringify(input) });
}

/** The SP metadata document an admin downloads and uploads to their identity provider. */
export async function readSamlServiceProviderMetadata(den: DenRef, caller: OrgCaller): Promise<DenFetchResult> {
  return denFetch(den, "/v1/sso/metadata", { headers: callerHeaders(caller) });
}

/** The ACS location the SP metadata advertises to the identity provider. */
export function advertisedAcsLocation(metadataXml: string): string {
  // Linear scans: find the element, then read its Location attribute.
  const start = metadataXml.indexOf("AssertionConsumerService");
  const tag = start < 0 ? "" : metadataXml.slice(start, metadataXml.indexOf(">", start) + 1 || undefined);
  const marker = 'Location="';
  const at = tag.indexOf(marker);
  if (at < 0) return "";
  const end = tag.indexOf('"', at + marker.length);
  return end < 0 ? "" : tag.slice(at + marker.length, end);
}

/** A minimal, unsigned Google Workspace-shaped SAML response carrying the fields the delivery policy inspects. */
export function googleShapedSamlResponse(input: { destination: string; recipient: string; audience: string }): string {
  const stamp = Date.now();
  const xml = `
    <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="response-${stamp}" Version="2.0" IssueInstant="2026-08-28T00:00:00Z" Destination="${input.destination}">
      <saml:Issuer>https://accounts.google.com/o/saml2?idpid=mock</saml:Issuer>
      <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success" /></samlp:Status>
      <saml:Assertion ID="assertion-${stamp}" Version="2.0" IssueInstant="2026-08-28T00:00:00Z">
        <saml:Issuer>https://accounts.google.com/o/saml2?idpid=mock</saml:Issuer>
        <saml:Subject>
          <saml:NameID>enterprise-user@customer.test</saml:NameID>
          <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
            <saml:SubjectConfirmationData Recipient="${input.recipient}" NotOnOrAfter="2027-01-01T00:00:00Z" />
          </saml:SubjectConfirmation>
        </saml:Subject>
        <saml:Conditions NotBefore="2026-01-01T00:00:00Z" NotOnOrAfter="2027-01-01T00:00:00Z">
          <saml:AudienceRestriction><saml:Audience>${input.audience}</saml:Audience></saml:AudienceRestriction>
        </saml:Conditions>
      </saml:Assertion>
    </samlp:Response>
  `;
  return Buffer.from(xml, "utf8").toString("base64");
}

/** What an identity provider's browser POST to the ACS URL does. */
export async function deliverSamlResponse(acsUrl: string, samlResponse: string): Promise<{ status: number; text: string; finalUrl: string }> {
  const response = await fetch(acsUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: "openwork-eval" }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, text: await response.text(), finalUrl: response.url };
}

/** The SCIM settings page's "Remove SCIM provisioning". */
export async function removeScimProvisioning(den: DenRef, caller: OrgCaller): Promise<DenFetchResult> {
  return denFetch(den, "/v1/scim", { method: "DELETE", headers: callerHeaders(caller) });
}
