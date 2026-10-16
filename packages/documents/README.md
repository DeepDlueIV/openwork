# Connected documents

`@openwork/documents` provides a document browser that a host can reuse without
embedding Workbot, its sign-in, or Google credentials. Workbot mounts it in its
Documents tab, next to Calendar.

## First version

- Google Drive: My Drive, nested folders, breadcrumbs, search within the current
  folder, paginated results, folders first, name/date sorting of loaded files,
  list/grid views, file details and opening the file in Google Drive in a new tab.
- Loading, empty, failed, connection-blocked and feature-disabled states.
- Read-only metadata. Browsing does not send documents into chat, download file
  bytes, or grant Workbot permission to edit a file.
- Opening a file uses the browser's Google sign-in. This is not an embedded
  document editor or a document-content preview.

Shared drives, shared-with-me, recent/starred/trash views, an account picker,
content previews, uploads, edits, moving, sharing and deleting are later slices.
Drive shortcuts open at Google; they are not navigable folders in this version.

## Package boundary

- `@openwork/documents`: provider-neutral `DocumentItem`, `DocumentsPage`,
  `DocumentsProvider`, the Google Drive adapter, response validation and URL safety.
- `@openwork/documents/react`: `DocumentsBrowser`, accepting a provider,
  authenticated cache scope, feature availability and a connections link.
- `@openwork/documents/styles.css`: scoped styles using host semantic variables
  (Workbot's `--wb-*`, with OpenWork semantic-token fallbacks).

Import styles once. Render inside a TanStack Query provider. Supply an identity
scope containing the organization and authenticated person; remount the browser
when identity or provider changes. The browser has no global host singleton.
The host owns authentication and transport; provider adapters translate their
service's metadata into the shared contract. Another service implements the same
`DocumentsProvider` rather than branching Workbot's UI around Google APIs.

The Drive adapter uses Den's existing file-list/search route, including its
pagination and incomplete-search signal. It accepts no Google access token.
Only HTTPS links on `drive.google.com` and `docs.google.com` may open from Google
metadata. File names render as text. No remote thumbnails or HTML are rendered.

## Workbot integration and rollout

`workbotDocuments` is off by default on cloud and self-hosted deployments.
Den's Workbot session exposes `documents = workbot && workbotDocuments`.
Older hosts/Dens omit it and stay off. The tab remains visible with a lock and
an explanation when off (DESIGN P4).

The Workbot site forwards exactly one GET metadata route under
`/v1/workbot/documents`; Den independently verifies the OAuth grant, active
membership, `mcp:read`, Workbot and Documents features on every request. It
creates its own signed internal principal and reuses the existing Drive route's
connector authorization. Client-supplied identity or internal headers are never
forwarded. Disabling the feature rejects subsequent reads without changing chat,
Calendar, stored files, or the person's Drive. Responses use `no-store`.

Design: P1/P2 (data over explanatory copy), P4 (locked availability), P6/S2
(compact file rows), S5 (only a person's action opens a document), C6 (recovery),
V1/V2 (host typography and tokens).
