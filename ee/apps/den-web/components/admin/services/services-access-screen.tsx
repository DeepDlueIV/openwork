import { Lock } from "lucide-react";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { AdminAccessScreen } from "../admin-access-screen";
import { SERVICES_LOCK_REASON } from "./service-readiness-data";

export function ServicesAccessScreen({ status, message, onRetry }: {
  status: "checking" | "signed-out" | "forbidden" | "error" | "locked";
  message?: string;
  onRetry: () => void;
}) {
  if (status !== "locked") return <AdminAccessScreen state={status} message={message} onRetry={onRetry} />;
  return (
    <section data-testid="admin-services-locked" className="grid gap-4">
      <h1 className="text-lg font-semibold text-[var(--dls-text-primary)]">Services</h1>
      <DenNotice tone="neutral" icon={Lock} message={SERVICES_LOCK_REASON} />
      <DenButton href="/admin/features" variant="secondary" size="sm" className="w-fit">Open Feature rollouts</DenButton>
    </section>
  );
}
