// What a person does and sees around chat error cards, for the CHAT-ERRORS core journey.
import type { Target } from "@openwork/cdp";

interface ErrorCardUser {
  see(target: Target, options?: { timeoutMs?: number }): Promise<void>;
  notSee(target: Target, options?: { timeoutMs?: number }): Promise<void>;
  hover(target: Target): Promise<void>;
  click(target: Target): Promise<void>;
  press(key: string): Promise<void>;
}

export const chatErrorDetailsToggle = { testId: "session-error-details-toggle" } as const;
export const chatErrorDetailsPanel = { testId: "session-error-details" } as const;
export const chatStorageErrorTitle = "Storage error reported";
export const chatStorageErrorDescription = "A storage limit was reported by the task runtime or a connected service. This does not necessarily mean your computer is full. Check the affected service or workspace before freeing local disk space.";
const DATABASE_ERROR_TITLE = "OpenWork couldn’t access its saved data";

/** Toggle Developer mode the way a person does: command palette → "Enable/Disable Developer Mode". */
export async function chatToggleDeveloperMode(user: ErrorCardUser, next: "on" | "off", options: { mac: boolean }) {
  await user.press(options.mac ? "Meta+K" : "Control+K");
  await user.click({ role: "option", label: next === "on" ? /enable developer mode/i : /disable developer mode/i });
}

/**
 * A seeded storage error (disk full or database) shows plain recovery guidance;
 * the raw SQL error and stack trace stay behind Technical details.
 */
export async function chatSeeStorageErrorGuidance(user: ErrorCardUser, kind: "disk-full" | "database-error", detailsClosed: () => Promise<unknown>) {
  const title = kind === "disk-full" ? chatStorageErrorTitle : DATABASE_ERROR_TITLE;
  await user.see({ text: title });
  await user.see({ text: kind === "disk-full" ? chatStorageErrorDescription : /check the available disk space/ });
  await user.notSee({ text: /effect\/sql\/SqlError/ });
  await user.notSee({ text: /at runLoop/ });
  await user.notSee({ text: "Not enough disk space" });
  if (kind === "database-error") await user.notSee({ text: chatStorageErrorTitle });
  await user.hover({ text: title });
  await user.click(chatErrorDetailsToggle);
  await user.see({ text: /effect\/sql\/SqlError/ });
  await user.see({ text: /at runLoop/ });
  await user.see({ role: "button", label: /^copy$/i });
  await user.click(chatErrorDetailsToggle);
  await user.see({ text: title });
  await detailsClosed();
  await user.notSee(chatErrorDetailsPanel);
  await user.notSee({ text: /at runLoop/ });
}

/** The same storage error as a session banner keeps its stack trace hidden outside Developer mode. */
export async function chatSeeStorageErrorBanner(user: ErrorCardUser, kind: "disk-full" | "database-error", options: { mac: boolean }) {
  const title = kind === "disk-full" ? chatStorageErrorTitle : DATABASE_ERROR_TITLE;
  await user.see({ testId: "session-error-card" });
  await user.see({ text: title });
  await user.notSee({ text: /at runLoop/ });
  await chatToggleDeveloperMode(user, "on", options);
  await user.hover({ text: title });
  await user.click(chatErrorDetailsToggle);
  await user.see({ text: /effect\/sql\/SqlError/ });
  await user.see({ text: /at runLoop/ });
  await chatToggleDeveloperMode(user, "off", options);
  await user.see({ text: title });
  await user.notSee({ text: /at runLoop/ });
}
