// Calls a real client makes whose effects an owner later reads in audit logs:
// Den Web's email sign-in form and sign-out, and a script using an
// organization API key. Each returns only what that client would observe.
import { denFetch, type DenFetchResult, type DenRef, type DenSession } from "./den.ts";

export interface PasswordSignInAttempt {
  status: number;
  /** The session token in the response body, or "" when sign-in was refused. */
  token: string;
  /** The browser session cookie the response set, or "" when none was set. */
  cookie: string;
}

/** One submission of Den Web's email sign-in form, right or wrong password. */
export async function attemptPasswordSignIn(den: DenRef, credentials: { email: string; password: string }): Promise<PasswordSignInAttempt> {
  const result = await denFetch(den, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify(credentials) });
  const body = result.body;
  const token = typeof body === "object" && body !== null && "token" in body && typeof body.token === "string" ? body.token : "";
  const cookie = result.response.headers.getSetCookie().map((value) => value.split(";")[0]?.trim() ?? "").find((value) => value.includes("session_token=")) ?? "";
  return { status: result.response.status, token, cookie };
}

/** Den Web's Sign out for the browser session holding this cookie. */
export async function signOutBrowserSession(den: DenRef, cookie: string): Promise<number> {
  const result = await denFetch(den, "/api/auth/sign-out", { method: "POST", headers: { cookie }, body: "{}" });
  return result.response.status;
}

/** Den Web's API keys page: "Create key". Returns the key shown once and its id. */
export async function createOrganizationApiKey(session: DenSession, name: string): Promise<{ id: string; key: string }> {
  const result = await denFetch(session, "/v1/api-keys", { method: "POST", headers: { authorization: `Bearer ${session.token}` }, body: JSON.stringify({ name }) });
  const body = result.body;
  const key = typeof body === "object" && body !== null && "key" in body && typeof body.key === "string" ? body.key : "";
  const apiKey = typeof body === "object" && body !== null && "apiKey" in body ? body.apiKey : null;
  const id = typeof apiKey === "object" && apiKey !== null && "id" in apiKey && typeof apiKey.id === "string" ? apiKey.id : "";
  if (result.response.status !== 201 || !key || !id) throw new Error(`Creating an API key failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  return { id, key };
}

/** A script creating a team with an organization API key (no browser session). */
export function createTeamWithApiKey(den: DenRef, apiKey: string, name: string): Promise<DenFetchResult> {
  return denFetch(den, "/v1/teams", { method: "POST", headers: { "x-api-key": apiKey }, body: JSON.stringify({ name, memberIds: [] }) });
}
