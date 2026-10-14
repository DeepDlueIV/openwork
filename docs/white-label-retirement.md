# Reversible white-label retirement

White-label controls and rendering are removed, not the underlying customer data.
This change includes no database schema change or migration.

## Stored data

- Keep `organization_brand_asset` and its image bytes unchanged. Organization deletion still deletes the organization's assets as before.
- Preserve existing application-name, logo, icon, accent, and asset-reference metadata during reads, normalization, and unrelated writes. Omit retired fields only from member-facing projections; never persist that filtered projection back to the database.
- Preserve dormant desktop bootstrap settings and cached icon/sidecar files for rollback. Current desktops must not apply these settings or fetch their URLs.
- Do not carry dormant settings to a different Den target. Explicit resets and organization deletion remain destructive by design.

## Older desktop compatibility

Older desktops require a `brand` object in connection claims and application-name/image fields in install configuration. Keep these wire fields as a compatibility shim, using fixed OpenWork identity and null image URLs. Do not derive them from the preserved organization metadata or allow them to enable customization.

Signature verification, issuer binding, HTTPS checks, expiration, and one-use exchange behavior remain required. Current desktops ignore incoming custom-brand values from previously issued links.

Remove the wire compatibility shim only when the supported-desktop policy no longer includes clients requiring these fields, with upgrade and mixed-version connection tests first.

## Fleet rollout

Upgrade desktops before deploying the Den retirement to preserve their local rollback settings and caches. Back up manual/MDM bootstrap sources first. An unupdated desktop still runs its old write/cleanup logic; the new server cannot prevent that binary from replacing its local customization during a configuration refresh. Server-side organization settings and asset rows remain retained independently.

## Bringing the feature back

Restore the feature's server routes, settings UI, and desktop rendering in a later code change. The retained organization metadata, asset bytes, and dormant local settings are the source of restoration; do not reconstruct customer choices from stock compatibility payloads.

Desktop archive locations, snapshot receipts, and explicit restoration steps are documented in the [desktop rollback storage contract](../apps/desktop/electron/desktop-brand-rollback.md).

A future database-cleanup proposal must explicitly decide whether to retain, export, or delete this data. Deferring migrations must not be treated as permission to erase it during ordinary application use.

## Verification

Cover persisted settings through unrelated updates, new-server/old-desktop connection payloads, old-link/new-desktop acceptance, and dormant local storage through upgrade and rollback. Native operating-system smoke tests remain necessary before claiming visual taskbar/Dock behavior is verified.
