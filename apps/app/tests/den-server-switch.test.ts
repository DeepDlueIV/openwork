import { describe, expect, test } from "bun:test";
import { resolveDenServerSwitch } from "../src/app/lib/den-server-switch";

describe("sign-in link server switch", () => {
  test("the same server never prompts, whatever shape the link uses", () => {
    const current = "https://den.example.com";
    expect(resolveDenServerSwitch({ currentBaseUrl: current, linkBaseUrl: "https://den.example.com" })).toBeNull();
    expect(resolveDenServerSwitch({ currentBaseUrl: current, linkBaseUrl: "https://den.example.com/" })).toBeNull();
    expect(resolveDenServerSwitch({ currentBaseUrl: current, linkBaseUrl: "https://den.example.com/api/den" })).toBeNull();
    expect(resolveDenServerSwitch({ currentBaseUrl: current, linkBaseUrl: "https://DEN.example.com/api/den/" })).toBeNull();
    expect(
      resolveDenServerSwitch({ currentBaseUrl: "https://den.example.com/api/den", linkBaseUrl: "https://den.example.com" }),
    ).toBeNull();
  });

  test("the hosted cloud never prompts for its own links", () => {
    expect(
      resolveDenServerSwitch({
        currentBaseUrl: "https://app.openworklabs.com",
        linkBaseUrl: "https://app.openworklabs.com/api/den",
      }),
    ).toBeNull();
  });

  test("loopback aliases are the same server", () => {
    expect(
      resolveDenServerSwitch({ currentBaseUrl: "http://localhost:3005", linkBaseUrl: "http://127.0.0.1:3005/api/den" }),
    ).toBeNull();
  });

  test("a different server names both hosts", () => {
    expect(
      resolveDenServerSwitch({
        currentBaseUrl: "https://den.example.com",
        linkBaseUrl: "https://app.openworklabs.com/api/den",
      }),
    ).toEqual({ currentHost: "den.example.com", newHost: "app.openworklabs.com" });
  });

  test("a different port is a different server", () => {
    expect(
      resolveDenServerSwitch({ currentBaseUrl: "https://den.example.com", linkBaseUrl: "https://den.example.com:8443" }),
    ).not.toBeNull();
  });
});
