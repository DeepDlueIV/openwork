import { createRoot } from "react-dom/client"
import { ComputerPanel } from "../src/react-app/domains/session/computer/computer-panel"
import "../src/app/index.css"

// Renderer-only helper fixture. The production broker's approval boundary is
// exercised separately; no native transport or user files are connected here.
let active = true
const output = document.createElement("output")
output.setAttribute("role", "status")
output.textContent = "No window approved"
document.body.append(output)
Reflect.set(window, "__OPENWORK_ELECTRON__", {
  invokeDesktop: async (command: string, input: unknown) => {
    if (command === "computerPresentation") return active ? {
      id: "fixture-window-choice", phase: "approval", appName: "Text Editor", mode: "control",
      task: "Edit the project draft", inputs: [], windows: [{ id: 17, title: "Project draft" }, { id: 18, title: "Planning notes" }],
    } : null
    if (command === "computerInteract") {
      if (typeof input !== "object" || input === null || !("action" in input)) throw new Error("Missing window decision")
      await fetch("/fixture/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
      active = false
      output.textContent = input.action === "approve" ? "Selected window approved" : "Window access declined"
      return
    }
    throw new Error(`Unexpected fixture command: ${command}`)
  },
})
const slot = document.createElement("main")
slot.style.cssText = "position:relative;width:min(800px,100vw);height:600px"
document.body.append(slot)
const root = document.createElement("div")
document.body.append(root)
createRoot(root).render(<ComputerPanel sessionId="fixture-chat" slot={slot} enabled canStop controlsBusy={false} stopping={false} cleanupPending={false} stopError="" onStop={() => { active = false }} />)
