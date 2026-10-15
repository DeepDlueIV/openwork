import { redirect } from "next/navigation";
import { DesktopPolicyRoute } from "../../../_components/desktop-policy-route";

export default async function EditDesktopPolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ desktopPolicyId: string }>;
  searchParams: Promise<{ setup?: string }>;
}) {
  const { desktopPolicyId } = await params;
  const { setup } = await searchParams;
  // Legacy setup links may resume onboarding, but navigation never applies policy.
  if (setup === "restricted") redirect("/dashboard/onboarding/people");
  return <DesktopPolicyRoute editor desktopPolicyId={desktopPolicyId} />;
}
