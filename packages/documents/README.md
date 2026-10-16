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

| File | Inline support | Save path |
| --- | --- | --- |
| Google Sheet | Worksheets, paged A–Z cell grid, cell/formula bar editing, bounded table paste | Sheets `batchUpdate` changes only edited cells' `userEnteredValue`; existing formatting and other cells stay intact |
| Excel `.xlsx` | Same paged cell grid and worksheet navigation | Patches edited XML cells in the original ZIP package, retaining unrelated styles, charts, images and other sheets |
| Google Doc | Formatted text-run editing across document tabs | Docs `batchUpdate` uses `requiredRevisionId`, targeted ranges and the original run's text styles |
| Word `.docx` | Formatted text-run editing | Replaces selected `<w:t>` values in the original package, retaining other parts and run formatting |
| UTF-8 text | Plain text editing, up to 1 MB | Replaces the original Drive file content after revision checks |
| PDF and common raster images | Read-only inline preview | No edits |
| Other formats | Link to original editor | No edits |

This is bounded cell/text editing, not a complete Word/Excel layout, chart or
formatting editor, or a collaborative Office engine. Native Doc tables/images
and complex Word layouts remain in the source and are not rendered by the text
editor. Signed/macro Office packages, protected/shared-formula worksheets,
merged-cell edits, and Word tracked changes/fields are refused where an edit
could be unsafe. Office inputs retain the shared workbook package's ZIP/XML
limits (12 MB compressed, 10 MB inflated, 128 entries).

Values stay literal by default. A person must explicitly choose Save as formula;
the existing workbook safety checks reject known external-data/command formulas.
HTML pasted into document text is treated as plain text. No document HTML or
SVG is executed. Previews allowlist PDF/PNG/JPEG/GIF/WebP and use a sandbox.

## Package boundary

- `@openwork/documents`: metadata provider contract, Google Drive adapter and
  authenticated editor client.
- `@openwork/documents/model`: platform-neutral, Zod-validated editor/read/save
  contracts. No authentication or React.
- `@openwork/documents/office`: bounded, targeted XLSX/DOCX package edits, using
  existing `@openwork/workbook` primitives.
- `@openwork/documents/react`: `DocumentsBrowser` and its file editors.
- `@openwork/documents/styles.css`: scoped semantic styles.

A host imports styles, renders inside TanStack Query, supplies its authenticated
organization/person cache scope, feature availability, connection URL and
`DocumentsEditor` transport. It should honor `onDirtyChange` before unmounting
the workspace. Remount on identity/provider changes. Drafts remain in component
memory, not browser storage, chat, or model context. Another storage provider
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

Every save rechecks its revision and current permissions. Native Docs additionally
uses Google's atomic revision write control. Drive binary uploads and Sheets
cell writes have a check-then-write concurrency window; they are not atomic
compare-and-swap and not a replacement for Google's live collaboration engine.
A detected conflict retains the draft, with an explicit reload/discard action.
Uncertain saves are never retried automatically. Disabling a feature stops new
reads/writes without deleting Drive files or changing Calendar/chat behavior.

Design: P1/P2 (data and state), P4 (blocked presence and connection recovery),
P6/S2 (compact files), S5 (user opens a file), C6 (recoverable failure), V1/V2
(host typography and semantic tokens).
