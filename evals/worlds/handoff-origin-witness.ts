import { createServer } from "node:http";

/** A fresh per-run destination which must receive no request before consent.
 * Deliberately records no headers, query values, request bodies, or credentials. */
export async function handoffOriginWitness() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${new URL(request.url ?? "/", "http://localhost").pathname}`);
    response.writeHead(410).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing witness address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async stop() { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
