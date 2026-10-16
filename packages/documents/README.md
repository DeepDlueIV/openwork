# Connected documents

`@openwork/documents` is a reusable document workspace. Workbot supplies its
signed-in transport and identity; other hosts can use the same browser and
provider/editor contracts without embedding Workbot.

## Documents workspace

- Recent files from Drive API v3, ordered by `recency desc`, excluding folders.
  The sidebar is not a fabricated list or local browsing history.
- My Drive and folder breadcrumbs, folder-scoped search, pagination,
  list/grid views and name/date sorting of loaded files.
- Files open in internal tabs. Switching file tabs retains unsaved edits.
  Closing a dirty file or leaving Documents asks whether to keep/discard edits.
  Page unload uses the browser's unsaved-changes protection.
- Missing/expired Drive access shows Connect/Reconnect through Den's existing
  connections page. Returning to the page rechecks the listing.
- Explicit Save to Drive writes to the original file; no background writes.

| File | Inline experience | Save path |
| --- | --- | --- |
| Word `.docx` | Full ONLYOFFICE document editor: page layout, rich formatting, tables, images, comments, find/replace | Explicit Save to Drive updates the original Office file |
| Excel `.xlsx` | Full ONLYOFFICE spreadsheet editor: formulas and recalculation, formatting, worksheets, charts, sorting/filtering | Explicit Save to Drive updates the original Office file |
| Native Google Doc / Sheet | Exported Word / Excel copy in the same full editor, with a visible copy notice | First save creates an Office file in My Drive; later saves update that copy. The native original is preserved. Use Open original in Drive to edit it natively |
| UTF-8 text | Plain text editing, up to 1 MB | Explicit save to the original file |
| PDF and common raster images | Read-only inline preview | No edits |
| Other formats | Link to original editor | No edits |

The Office editor is a real, separately hosted engine, loaded only when an
Office tab opens. It is not bundled into chat or model context. It is not the
Microsoft Word/Excel product and does not execute VBA. Macros and third-party
plugins are disabled. Complex OOXML round trips can differ from desktop Office;
representative customer files need acceptance testing before rollout. Office
files retain the shared bounded ZIP protections (12 MB compressed, 10 MB inflated,
128 parts); signed, encrypted and macro-enabled packages are refused.

Editor autosave synchronizes to the document service. Only **Save to Drive**
commits to Drive. A signed service callback stages a snapshot and never writes to
Google. Unsaved indicators remain until Drive confirms the write. A unique
force-save nonce binds the requested snapshot; stale callbacks cannot confirm it.

## Engine choice and operation

ONLYOFFICE Docs was selected for an established Word and Excel editing surface,
OOXML input/output and a documented signed embed/save protocol. Collabora is a
viable WOPI alternative but requires a different storage integration. Univer's
XLSX import/export also requires its Pro server, so a browser-only grid would not
meet the Word and Excel round-trip requirement.

- [ONLYOFFICE integration](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/)
- [Saving and force save](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/saving-file/)
- [Signature protocol](https://api.onlyoffice.com/docs/docs-api/additional-api/signature/)
- [Edition and licensing FAQ](https://helpcenter.onlyoffice.com/docs/faq/docs-community.aspx)
- [Collabora integration](https://sdk.collaboraonline.com/docs/introduction.html)
- [Univer import/export](https://docs.univer.ai/en-US/guides/sheets/features/import-export)

Configure Den, leaving `workbotDocuments` off until the service is ready:

```
DEN_DOCUMENTS_ONLYOFFICE_URL=https://office.example.com
DEN_DOCUMENTS_ONLYOFFICE_JWT_SECRET=<matching high-entropy service secret>
DEN_DOCUMENTS_CALLBACK_BASE_URL=https://api.example.com
DATABASE_REDIS_URL=rediss://<private shared Redis>
```

The callback origin defaults to `DEN_API_PUBLIC_URL`. Origins come only from
operator configuration, never request Host/forwarded headers or file metadata.
Docs must reach Den; browsers and Den must reach the Docs origin. Configure JWT
validation for browser, inbox and outbox, with the same secret and the standard
Authorization header (signed callback tokens in the body are also supported).
Use a separate Docs origin, TLS, private storage, restricted network egress and
no public example service. Keep the document service updated. Its parser runs
outside Den; deny cloud metadata/private-network access and external-data fetches
at the service network boundary. Local development can use loopback HTTP; do not
carry permissive local private-IP settings into production.

Use the appropriate ONLYOFFICE edition and license for the deployment. Community
Edition retains branding and has AGPL obligations; proprietary embedding and
white-labeling require appropriate commercial terms. No license purchase,
production service deployment or feature rollout is included in this change.
The adapter fails visibly with Open in Drive when no service/shared Redis is
configured; it does not claim the basic grid provides a full Office experience.

Drafts are AES-GCM encrypted in shared Redis with a fixed four-hour expiry and
five concurrent sessions per member. Closing a tab removes its temporary Den
session; abandoned sessions expire automatically. Redis must be sized and isolated accordingly. Engine
storage has its own retention policy and must also be configured by the operator.
The UI warns on expiry and retains an open editor for downloading a recovery
copy. A page refresh does not restore the temporary session; save or download
before leaving. Shared storage supports API replicas; Redis loss expires sessions.

## Package boundary

- `@openwork/documents`: metadata provider contract, Google Drive adapter and
  authenticated editor client.
- `@openwork/documents/model`: platform-neutral, Zod-validated editor/read/save
  contracts. No authentication or React.
- `@openwork/documents/onlyoffice`: provider-independent full-editor contract,
  schemas and configurable transport.
- `@openwork/documents/onlyoffice-server`: signed ONLYOFFICE protocol and bounded
  snapshot reads; no Google credentials, authentication framework or Drive writes.
- `@openwork/documents/office`: existing bounded cell/text edit helpers for hosts
  that explicitly choose that smaller editing surface.
- `@openwork/documents/react`: `DocumentsBrowser` and its file editors.
- `@openwork/documents/styles.css`: scoped semantic styles.

A host imports styles, renders inside TanStack Query, supplies its authenticated
organization/person cache scope, feature availability, connection URL and
`DocumentsEditor` transport. It should honor `onDirtyChange` before unmounting
the workspace. Remount on identity/provider changes. Text drafts remain in component memory; full Office drafts live temporarily on
the configured document service and in encrypted server storage. They never go
into browser storage, chat or model context. Another storage provider
implements the metadata/editor contracts rather than changing Workbot's UI.

## Authority and rollout

`workbotDocuments` remains off by default on cloud and self-hosted, and requires
Workbot. Both the Workbot site and Den independently check availability. Den's
proxy allowlists metadata reads and the editor/content route families; writes
require `mcp:write`. Direct editor routes also require both flags, authenticated
organization membership, connector policy and Google permission.

Editor reads resolve and pin the actual connection ID. Every later page/read/save
uses that exact connection, so a changed default cannot silently switch accounts.
Drive read access is required to browse. Existing-file edits require the relevant
connector/account write grants and Google's `capabilities.canEdit`. Credentials
stay on the server. All responses are `no-store`; content is excluded from MCP
capability discovery and audit evidence.

Every full-editor save checks the pinned connection, current permissions and Drive
version, and serializes writes through shared file/session locks. If Google
provides an ETag, updates also send If-Match. An unconfirmed write is marked
before dispatch and cannot be retried automatically. Reopen after checking Drive.
There remains a check-then-write window when no ETag is supplied; this is not
Google native collaboration. Different Documents sessions do not share an editor
room.

The existing basic editor routes recheck revision and permissions. Native Docs additionally
uses Google's atomic revision write control. Drive binary uploads and Sheets
cell writes have a check-then-write concurrency window; they are not atomic
compare-and-swap and not a replacement for Google's live collaboration engine.
A detected conflict retains the draft, with an explicit reload/discard action.
Uncertain saves are never retried automatically. Disabling a feature stops new
reads/writes without deleting Drive files or changing Calendar/chat behavior.

Design: P1/P2 (data and state), P4 (blocked presence and connection recovery),
P6/S2 (compact files), S5 (user opens a file), C6 (recoverable failure), V1/V2
(host typography and semantic tokens).
