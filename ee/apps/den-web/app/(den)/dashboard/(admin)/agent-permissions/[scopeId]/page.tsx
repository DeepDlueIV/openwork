import { AgentPermissionsScopeScreen } from "../../../_components/agent-permissions-screen";

export default async function AgentPermissionsScopePage({
  params,
}: {
  params: Promise<{ scopeId: string }>;
}) {
  const { scopeId } = await params;
  return <AgentPermissionsScopeScreen scopeId={decodeURIComponent(scopeId)} />;
}
