import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { normalizeDenDesktopConfig, type DenDesktopConfig } from "../src/app/lib/den";
import { DenSignInSurface, type DenSignInSurfaceProps } from "../src/react-app/domains/cloud/den-signin-surface";
import * as desktopConfig from "../src/react-app/domains/cloud/desktop-config-provider";
import { DesktopPolicyNotificationEffect } from "../src/react-app/domains/cloud/desktop-policy-notification-effect";
import { useNotificationStore } from "../src/react-app/kernel/notification-store";

const legacyBranding = {
  brandAppName: "Custom Workspace",
  brandLogoUrl: "https://example.test/custom-logo.svg",
  brandIconUrl: "https://example.test/custom-icon.png",
  brandAccentColor: "purple",
};

const signInProps: DenSignInSurfaceProps = {
  variant: "fullscreen",
  developerMode: false,
  baseUrl: "https://den.example.test",
  baseUrlDraft: "https://den.example.test",
  baseUrlError: null,
  statusMessage: null,
  authError: null,
  authBusy: false,
  baseUrlBusy: false,
  sessionBusy: false,
  manualAuthOpen: false,
  manualAuthInput: "",
  onBaseUrlDraftInput: () => {},
  onResetBaseUrl: () => {},
  onApplyBaseUrl: () => {},
  onOpenControlPlane: () => {},
  onOpenBrowserAuth: () => {},
  onToggleManualAuth: () => {},
  onManualAuthInput: () => {},
  onSubmitManualAuth: () => {},
};

test("sign-in always uses OpenWork identity, ignoring legacy presentation overrides", () => {
  const legacyProps = {
    ...signInProps,
    appName: legacyBranding.brandAppName,
    logoUrl: legacyBranding.brandLogoUrl,
  };
  const markup = renderToStaticMarkup(<DenSignInSurface {...legacyProps} />);
  expect(markup).toContain("Welcome to OpenWork");
  expect(markup).toContain("openwork-mark.svg");
  expect(markup).not.toContain("Custom Workspace");
  expect(markup).not.toContain("custom-logo.svg");
});

test("desktop config discards legacy identity overrides without losing policies or onboarding", () => {
  expect(normalizeDenDesktopConfig({
    ...legacyBranding,
    allowCustomProviders: false,
    connectEnabled: true,
    onboardingPrompts: ["Summarize my files", "Plan my week"],
  })).toEqual({
    allowCustomProviders: false,
    connectEnabled: true,
    onboardingPrompts: ["Summarize my files", "Plan my week"],
  });
});

describe("independent desktop policy notification", () => {
  let actEnvironment: unknown;

  beforeEach(() => {
    GlobalRegistrator.register({ url: "http://localhost:5173/" });
    actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    useNotificationStore.getState().clearAll();
  });

  afterEach(async () => {
    useNotificationStore.getState().clearAll();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    await GlobalRegistrator.unregister();
  });

  test("notifies for restrictions, never for legacy branding, and only once per mount", async () => {
    let config: DenDesktopConfig = { ...legacyBranding, allowCustomProviders: true };
    const restrictions = spyOn(desktopConfig, "useOrgRestrictions").mockImplementation(() => config);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<DesktopPolicyNotificationEffect />));
      expect(useNotificationStore.getState().notifications).toHaveLength(0);

      config = { allowCustomProviders: false };
      await act(async () => root.render(<DesktopPolicyNotificationEffect />));
      const notifications = useNotificationStore.getState().notifications;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.title).toBe("Organization policies active");
      expect(notifications[0]?.body).toBe("Some features are managed by your administrator.");

      config = { allowCustomProviders: false, connectEnabled: false };
      await act(async () => root.render(<DesktopPolicyNotificationEffect />));
      expect(useNotificationStore.getState().notifications[0]?.count).toBe(1);
    } finally {
      await act(async () => root.unmount());
      restrictions.mockRestore();
    }
  });
});
