import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { UIMessage } from "ai";
import { MessageList } from "@/components/chat/message-list";
import { MessageListProvider } from "@/components/chat/message-list-provider";
import { PlatformProvider, createDefaultPlatform } from "@/react-app/kernel/platform";
import "@/app/index.css";

const startedAt = Date.now();
const request: UIMessage = {
  id: "spacing-request", role: "user",
  parts: [{ type: "text", text: "Make an App showing the deployment timeline." }],
  metadata: { opencode: { created: startedAt } },
};
const steps: UIMessage[] = Array.from({ length: 10 }, (_, index) => ({
  id: `spacing-step-${index}`, role: "assistant",
  parts: [{ type: "dynamic-tool", toolCallId: `spacing-call-${index}`, toolName: `deployment_status_${index + 1}`,
    state: "output-available", input: {}, output: { status: "checked" } }],
  metadata: { opencode: { created: startedAt + index + 1 } },
}));
const guide: UIMessage = {
  id: "spacing-guide", role: "assistant",
  parts: [{ type: "dynamic-tool", toolCallId: "spacing-guide-call", toolName: "get_skill",
    state: "output-available", input: { name: "build-an-app" }, output: { content: "Build the App." } }],
  metadata: { opencode: { created: startedAt + 20 } },
};

function SpacingFixture() {
  const [phase, setPhase] = useState("full");
  const visibleSteps = phase === "full" ? steps : steps.slice(0, 2);
  return <PlatformProvider value={createDefaultPlatform()}>
    <nav aria-label="Fixture controls" style={{ padding: 16, display: "flex", gap: 24 }}>
      <button onClick={() => setPhase("short")}>Fold earlier activity</button>
      <button onClick={() => setPhase("app")}>Start App build</button>
    </nav>
    <main style={{ paddingTop: 16 }}>
      <MessageListProvider workspaceId="spacing-workspace" sessionId="spacing-session"
        showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0}
        dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}}
        onForkAtMessage={() => {}} onEditUserMessage={() => {}}
        onMcpReconnect={async () => { throw new Error("Unexpected reconnect"); }}
        onMcpReopenAuthorization={async () => {}}>
        <MessageList messages={[request, ...visibleSteps, ...(phase === "app" ? [guide] : [])]}
          status="streaming" activityStatus="responding" />
      </MessageListProvider>
    </main>
  </PlatformProvider>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Spacing fixture root missing");
createRoot(root).render(<SpacingFixture />);
