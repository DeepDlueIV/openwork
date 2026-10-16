"use client";

import { useMemo } from "react";
import { googleDriveProvider } from "@openwork/documents";
import { DocumentsBrowser } from "@openwork/documents/react";
import { workbotHost } from "./host";

/** Workbot supplies authentication and identity; the document browser is reusable by other hosts. */
export function WorkbotDocuments() {
  const host = workbotHost();
  const provider = useMemo(() => googleDriveProvider((path, signal) => host.requestJson(`/v1/workbot/documents${path}`, { signal })), [host]);
  const identity = host.identity;
  return <DocumentsBrowser key={`${identity?.organizationId}:${identity?.principalId}`} provider={provider} scope={[host.homeHref, identity?.organizationId ?? "", identity?.principalId ?? ""]} enabled={host.documents === true && identity !== undefined} connectionsHref={host.connectionsHref} />;
}
