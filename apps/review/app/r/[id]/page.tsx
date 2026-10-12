import { notFound } from "next/navigation";
import { readReview } from "@openwork/review/storage";
import { Report } from "../../../components/report";
import { connectedCheckpointProviders, previewProviderStatus } from "../../../lib/provider-status";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const report = await readReview(id);
  if (!report) notFound();
  const preview = previewProviderStatus();
  return <Report id={id} report={report} connected={preview.connected} providerLabel={preview.label} checkpointProviders={connectedCheckpointProviders()} />;
}
