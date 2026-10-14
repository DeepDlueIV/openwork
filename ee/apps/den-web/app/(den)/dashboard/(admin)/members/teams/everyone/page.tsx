import { EveryoneScreen } from "../../../../_components/everyone-screen";

export default async function EveryonePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { tab } = await searchParams;
  return <EveryoneScreen initialTab={tab === "agents" ? "agents" : tab === "role" ? "role" : null} />;
}
