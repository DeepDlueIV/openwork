# OpenWork Model Catalog

This directory holds the generated OpenWork model catalog. A Cloudflare Worker with static assets and no Worker code (`wrangler.jsonc`) serves the `models/` folder at `https://models.openworklabs.com`, and Workers Builds deploys it from `dev`:

- Root directory: `ee/apps/gateway/models-site`
- Build command: `node ../scripts/build-models.mjs`
- Deploy command: `npx wrangler deploy` (the default)
- Build watch paths: `ee/apps/gateway/src/models/*`, `ee/apps/gateway/scripts/build-models.mjs` and `ee/apps/gateway/models-site/*`
- Catalog URL: `https://models.openworklabs.com/api.json`

The generated `models/api.json` file is ignored by git. It is rebuilt from `src/models/base.json` and the active OpenWork overlay by `scripts/build-models.mjs`, which needs no installed dependencies.

OpenWork-specific models live in `src/models/openwork-models.json`. `scripts/build-models.mjs` turns that list into the OpenWork provider overlay at build time and switches the provider API URL based on `OPENWORK_DEV_MODE`.

Local development still serves the generated catalog from the gateway Hono app at `/models/api.json` so one local service can provide both the proxy API and model catalog during dev. To check the Worker locally, run `node ../scripts/build-models.mjs && npx wrangler dev` here.

## Custom domain and caching

The `models.openworklabs.com` Custom Domain is attached to the Worker in the Cloudflare dashboard. `wrangler.jsonc` has no `routes`, so deploys leave it attached. Listing it there would make every deploy replace the Worker's domains with that list.

Cloudflare caches static assets on its network and switches to the new files when a deploy goes live, so the catalog needs no Cache Rule or purge. Clients get `Cache-Control: public, max-age=0, must-revalidate` with an ETag and revalidate on every fetch. `models/_headers` keeps the `Access-Control-Allow-Origin: *` and `X-Content-Type-Options: nosniff` headers that Pages used to send.
