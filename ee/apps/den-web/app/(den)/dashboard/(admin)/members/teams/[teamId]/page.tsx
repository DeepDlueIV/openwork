import { TeamDetailScreen } from "../../../../_components/team-detail-screen";

export default async function TeamDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { teamId } = await params;
  const { tab } = await searchParams;
  // ?tab=agents opens the team's Agents tab, e.g. from Agent permissions.
  return <TeamDetailScreen teamId={teamId} initialTab={tab === "agents" ? "agents" : null} />;
}
