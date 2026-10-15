import { createServer } from "node:http";

/** Neutral, deterministic OAuth provider: no real service or sign-in is contacted. */
export async function redirectDiscoveryMock() {
  const requests: { path: string; method: string; authorized: boolean }[] = [];
  let mode: "valid" | "issuer-mismatch" | "missing" = "valid";
  let origin = "";
  const path = "/mcp/team";
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", origin).pathname;
    requests.push({ path: pathname, method: req.method ?? "GET", authorized: Boolean(req.headers.authorization || req.headers.cookie) });
    if (pathname === path) {
      res.writeHead(302, { location: "/login?return=private", "content-type": "text/html" });
      res.end("<html>Sign in</html>");
      return;
    }
    if (pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>Sign in</html>");
      return;
    }
    res.setHeader("content-type", "application/json");
    if (pathname.startsWith("/.well-known/oauth-protected-resource") && mode !== "missing") {
      res.end(JSON.stringify({ resource: `${origin}${path}`, authorization_servers: [`${origin}${path}`] }));
      return;
    }
    if (pathname === `/.well-known/oauth-authorization-server${path}`) {
      res.end(JSON.stringify({
        issuer: mode === "issuer-mismatch" ? origin : `${origin}${path}`,
        authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"],
      }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock did not bind a port");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    mcpUrl: `${origin}${path}`, origin, requests,
    setMode(value: typeof mode) { mode = value; requests.length = 0; },
    async stop() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
