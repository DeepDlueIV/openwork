"use client";

import { useMemo } from "react";
import { googleDocumentsEditor, googleDriveProvider } from "@openwork/documents";
import { DocumentsBrowser } from "@openwork/documents/react";
import { workbotHost } from "./host";

/** Workbot supplies authentication and identity; the document browser is reusable by other hosts. */
export function WorkbotDocuments({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }) {
  const host = workbotHost();
  const provider = useMemo(() => googleDriveProvider((path, signal) => host.requestJson(`/v1/workbot/documents${path}`, { signal })), [host]);
  const editor = useMemo(() => googleDocumentsEditor((path, init) => host.requestJson(`/v1/workbot/documents${path}`, init), path => `/v1/workbot/documents${path}`), [host]);
  const identity = host.identity;
  return <DocumentsBrowser key={`${identity?.organizationId}:${identity?.principalId}`} provider={provider} editor={editor} scope={[host.homeHref, identity?.organizationId ?? "", identity?.principalId ?? ""]} onDirtyChange={onDirtyChange} enabled={host.documents === true && identity !== undefined} connectionsHref={host.connectionsHref} />;
}
