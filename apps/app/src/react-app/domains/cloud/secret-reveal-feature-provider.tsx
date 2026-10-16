/** @jsxImportSource react */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { SecretRevealProvider } from "@/components/secret-field";
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations";

/**
 * Lets every SecretField offer "Show while typing" when the signed-in
 * organization has `secureSecretFields`. Signed out, unreachable or missing
 * means off, so fields stay plain masked inputs.
 */
export function SecretRevealFeatureProvider({ children }: { children: ReactNode }) {
  const context = useAutomationsDenContext();
  const enabled = useQuery({
    // Shares the cache with the other organization feature reads.
    queryKey: ["den", "org-features", context.organizationId],
    queryFn: (): Promise<Record<string, boolean>> => context.client && context.organizationId
      ? context.client.getOrgFeatures(context.organizationId)
      : Promise.resolve({}),
    enabled: context.ready,
    staleTime: 30_000,
    retry: false,
    select: (features) => features.secureSecretFields === true,
  });
  return <SecretRevealProvider enabled={context.ready && enabled.data === true}>{children}</SecretRevealProvider>;
}
