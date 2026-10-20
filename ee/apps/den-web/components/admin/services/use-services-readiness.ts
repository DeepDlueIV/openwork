"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeploymentServiceReadiness } from "@openwork/types/den/service-readiness";
import { requestAdmin, sendAdmin, type AdminResult } from "../admin-request";
import {
  CHECK_COOLDOWN_MS, finishServicesRun, parseServicesSnapshot, runServicesReadiness, SERVICES_PATH,
  SERVICES_VERIFY_ERROR, waitForServicePoll, type ServicesViewState,
} from "./service-readiness-data";

export function useServicesReadiness(enabled: boolean) {
  const [state, setState] = useState<ServicesViewState>({ status: "checking", snapshot: null, pending: false });
  const [cooldown, setCooldown] = useState(false);
  const active = useRef<AbortController | null>(null);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const startCooldown = useCallback((milliseconds: number) => {
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    setCooldown(true);
    cooldownTimer.current = setTimeout(() => { cooldownTimer.current = null; setCooldown(false); }, milliseconds);
  }, []);

  const load = useCallback(async (check: boolean) => {
    if (!enabled || busy.current || (check && cooldownTimer.current)) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    busy.current = true;
    if (check) startCooldown(CHECK_COOLDOWN_MS);
    setState((previous) => ({ ...previous, status: "checking", pending: true, message: undefined }));
    try {
      const result = await runServicesReadiness({
        signal: controller.signal, check,
        getSnapshot: () => requestAdmin(SERVICES_PATH, parseServicesSnapshot, controller.signal),
        startCheck: async (): Promise<AdminResult<DeploymentServiceReadiness>> => {
          // No body, browser-selected endpoint, or probe options are sent.
          const response = await sendAdmin(`${SERVICES_PATH}/check`, "POST", undefined, controller.signal);
          controller.signal.throwIfAborted();
          if (!response.ok) {
            if (response.status === 429 && response.retryAfterSeconds) startCooldown(response.retryAfterSeconds * 1_000);
            return { access: "error", message: "", status: response.status, code: response.code };
          }
          const snapshot = parseServicesSnapshot(response.payload);
          return snapshot ? { access: "ready", data: snapshot } : { access: "error", message: "" };
        },
        wait: () => waitForServicePoll(controller.signal),
        onSnapshot: (snapshot) => setState({ status: "checking", snapshot, pending: true }),
      });
      if (controller.signal.aborted) return;
      setState((previous) => finishServicesRun(previous.snapshot, result));
    } catch {
      if (!controller.signal.aborted) setState((previous) => ({ ...previous, status: "error", pending: false, message: SERVICES_VERIFY_ERROR }));
    } finally {
      if (active.current === controller) busy.current = false;
    }
  }, [enabled, startCooldown]);

  useEffect(() => {
    setCooldown(false);
    if (enabled) void load(false);
    else setState({ status: "checking", snapshot: null, pending: false });
    return () => {
      active.current?.abort();
      active.current = null;
      busy.current = false;
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
      cooldownTimer.current = null;
    };
  }, [enabled, load]);
  return { state, cooldown, checkNow: () => void load(true), refresh: () => void load(false) };
}
