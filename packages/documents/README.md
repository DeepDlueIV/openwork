# Connected documents

`@openwork/documents` is a reusable document workspace. Workbot supplies its
signed-in transport and identity; other hosts can use the same browser and
provider/editor contracts without embedding Workbot.

## Documents workspace

- Recent files from Drive API v3, ordered by `recency desc`, excluding folders.
  The sidebar is not a fabricated list or local browsing history.
- My Drive and folder breadcrumbs, folder-scoped search, pagination,
  list/grid views and name/date sorting of loaded files.
- Files open in internal tabs with close buttons and an unsaved-change dot. Switching or reordering tabs retains unsaved edits; closing an edited tab offers save, keep editing, or discard. Drag tabs to reorder, or focus a tab and use Alt+Shift+Left/Right. Delete closes the focused tab. The Files tab stays fixed.
  Closing a dirty file or leaving Documents asks whether to keep/discard edits.
  Page unload uses the browser's unsaved-changes protection.
- Missing/expired Drive access shows Connect/Reconnect through Den's existing
  connections page. Returning to the page rechecks the listing.
- Explicit Save to Drive writes to the original file; no background writes.

| File | Inline experience | Save path |
| --- | --- | --- |
| Word `.docx` | Full Collabora document editor: page layout, rich formatting, tables, images, comments, find/replace | Explicit Save to Drive updates the original Office file |
| Excel `.xlsx` | Full Collabora spreadsheet editor: formulas and recalculation, formatting, worksheets, charts, sorting/filtering | Explicit Save to Drive updates the original Office file |
| Native Google Doc / Sheet | Exported Word / Excel copy in the same full editor, with a visible copy notice | First save creates an Office file in My Drive; later saves update that copy. The native original is preserved. Use Open original in Drive to edit it natively |
| UTF-8 text | Plain text editing, up to 1 MB | Explicit save to the original file |
| PDF and common raster images | Read-only inline preview | No edits |
| Other formats | Link to original editor | No edits |

The Office editor is a real, separately hosted engine, loaded only when an
Office tab opens. It is not bundled into chat or model context. It is not the
Microsoft Word/Excel product. Macro-enabled packages are refused, and the
service must run with macro execution disabled. No third-party plugins are
installed by the integration. Complex OOXML round trips can differ from desktop Office;
representative customer files need acceptance testing before rollout. Office
files retain the shared bounded ZIP protections (12 MB compressed, 10 MB inflated,
128 parts); signed, encrypted and macro-enabled packages are refused.

Editor autosave synchronizes to the document service. Only **Save to Drive**
commits to Drive. WOPI writes stage snapshots and never write to Google. Unsaved indicators remain until Drive confirms the write. The explicit commit binds the exact staged draft version.

## Free and open-source editor

Documents uses **Collabora Online**, whose editor source is MPL-2.0, with
LibreOffice Writer and Calc underneath. No paid SDK, vendor license key,
commercial-only import/export or proprietary editing dependency is required.
The integration also uses free MIT-licensed React, React DOM, Zod and htmlparser2.

- [Editor source and MPL-2.0 license](https://github.com/CollaboraOnline/online/blob/main/COPYING)
- [Source mirror and build instructions](https://github.com/CollaboraOnline/online.mirror)
- [WOPI integration](https://sdk.collaboraonline.com/docs/advanced_integration.html)
- [PostMessage API](https://sdk.collaboraonline.com/docs/postmessage_api.html)

Collabora CODE is the free development build and works for local evaluation and
small teams. The vendor recommends its supported subscription build for business
production. A maintained MPL source build is also an option without a paid editor
license; maintainers then own builds, updates, security and operation. The
integration calls the open WOPI protocol and does not depend on subscription-only
features. Hosting the service still uses infrastructure resources.

Configure Den, leaving `workbotDocuments` off until the service is ready:

```
DEN_DOCUMENTS_COLLABORA_URL=https://office.example.com
DEN_DOCUMENTS_HOST_ORIGIN=https://workbot.example.com
DEN_DOCUMENTS_CALLBACK_BASE_URL=https://api.example.com
DATABASE_REDIS_URL=rediss://<private shared Redis>
```

The callback origin defaults to `DEN_API_PUBLIC_URL`. All origins are operator
configuration, never a request Host header or file metadata. Collabora must reach
Den; browsers and Den must reach Collabora. The discovery action must use that
same editor origin. The browser POSTs a random, expiring, file-bound access token
into the editor iframe; it never receives Google credentials. PostMessage events
must match the exact iframe window and configured service origin.

WOPI reads, locks and writes independently recheck the pinned connection,
membership, both flags, connector grants and provider access. WOPI PutFile only
stages encrypted temporary bytes. It cannot upload to Google. Save to Drive asks
the editor to finish a snapshot, waits for its response, then explicitly commits
that exact draft version with the user's authenticated Workbot request. A newer
staged version rejects the commit instead of silently selecting different bytes.
The standard WOPI LOCK/REFRESH_LOCK/GET_LOCK/UNLOCK operations serialize editing.

Keep Collabora isolated on a separate origin with TLS, sandboxing, its WOPI host
allowlist and restricted network egress. Disable document macros in its server
configuration and deny cloud metadata/private-network fetches. Keep the service
updated and redact WOPI access tokens from proxy/service logs. Never disable
sandboxing or enable all WOPI hosts in production. No production deployment or
feature rollout is included here. Missing service/shared Redis configuration
shows an explicit unavailable state with Open in Drive.

Drafts are AES-GCM encrypted in shared Redis for at most four hours, limited to
five concurrent sessions per member. Closing a tab removes its temporary Den
session; abandoned sessions expire. Collabora storage has its own retention
policy, which operators must also configure. Save or download before refreshing:
a page refresh does not restore the temporary editing session. The component
warns on expiry and allows recovery downloads from the open editor.

## Package boundary

- `@openwork/documents`: metadata provider contract, Google Drive adapter and
  authenticated editor client.
- `@openwork/documents/model`: platform-neutral, Zod-validated editor/read/save
  contracts. No authentication or React.
- `@openwork/documents/office-engine`: provider-independent full-editor contract,
  schemas and configurable transport.
- `@openwork/documents/office-server`: Collabora WOPI protocol and bounded
  snapshot reads; no Google credentials, authentication framework or Drive writes.
- `@openwork/documents/office`: existing bounded cell/text edit helpers for hosts
  that explicitly choose that smaller editing surface.
- `@openwork/documents/react`: `DocumentsBrowser` and its file editors.
- `@openwork/documents/styles.css`: scoped semantic styles.

A host imports styles, renders inside TanStack Query, supplies its authenticated
organization/person cache scope, feature availability, connection URL and
`DocumentsEditor` transport. It should honor `onDirtyChange` before unmounting
the workspace. Remount on identity/provider changes. Text drafts remain in
component memory; full Office drafts live temporarily on
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
use Google's atomic revision write control. Drive binary uploads and Sheets
cell writes have a check-then-write concurrency window; they are not atomic
compare-and-swap and not a replacement for Google's live collaboration engine.
A detected conflict retains the draft, with an explicit reload/discard action.
Uncertain saves are never retried automatically. Disabling a feature stops new
reads/writes without deleting Drive files or changing Calendar/chat behavior.

Design: P1/P2 (data and state), P4 (blocked presence and connection recovery),
P6/S2 (compact files), S5 (user opens a file), C6 (recoverable failure), V1/V2
(host typography and semantic tokens).
