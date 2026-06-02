import { describe, expect, it } from "vitest";
import { createServiceUrl, createServiceUrlCandidates } from "../server/serviceUrl.js";

describe("service url resolver", () => {
  it("uses a reachable LAN address when the management page is opened through loopback on an all-interface service", () => {
    const serviceUrl = createServiceUrl({
      bindHost: "0.0.0.0",
      hostHeader: "127.0.0.1:37631",
      hostname: "127.0.0.1",
      port: 37631,
      networkInterfaces: {
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [{ address: "192.168.2.27", family: "IPv4", internal: false }]
      }
    });

    expect(serviceUrl).toBe("https://192.168.2.27:37631");
  });

  it("keeps an explicit reachable host from the browser request", () => {
    const serviceUrl = createServiceUrl({
      bindHost: "0.0.0.0",
      hostHeader: "192.168.2.27:37631",
      hostname: "192.168.2.27",
      port: 37631,
      networkInterfaces: {
        en0: [{ address: "192.168.2.27", family: "IPv4", internal: false }]
      }
    });

    expect(serviceUrl).toBe("https://192.168.2.27:37631");
  });

  it("includes stable local host and LAN candidates for IP changes", () => {
    const candidates = createServiceUrlCandidates({
      bindHost: "0.0.0.0",
      hostHeader: "127.0.0.1:37631",
      hostname: "127.0.0.1",
      port: 37631,
      localHostname: "macbook-pro.local",
      networkInterfaces: {
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [{ address: "192.168.2.27", family: "IPv4", internal: false }],
        en1: [{ address: "192.168.43.6", family: "IPv4", internal: false }]
      }
    });

    expect(candidates).toEqual([
      "https://192.168.2.27:37631",
      "https://macbook-pro.local:37631",
      "https://192.168.43.6:37631"
    ]);
  });

  it("does not advertise unreachable LAN candidates for a loopback-only service", () => {
    const candidates = createServiceUrlCandidates({
      bindHost: "127.0.0.1",
      hostHeader: "127.0.0.1:37631",
      hostname: "127.0.0.1",
      port: 37631,
      localHostname: "windows-pc",
      networkInterfaces: {
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        ethernet: [{ address: "192.168.2.31", family: "IPv4", internal: false }]
      }
    });

    expect(candidates).toEqual(["https://127.0.0.1:37631"]);
  });

  it("uses a specific reachable bind host when no reachable request host is available", () => {
    const serviceUrl = createServiceUrl({
      bindHost: "192.168.2.31",
      hostHeader: undefined,
      hostname: "localhost",
      port: 37631,
      networkInterfaces: {
        ethernet: [{ address: "192.168.2.31", family: "IPv4", internal: false }]
      }
    });

    expect(serviceUrl).toBe("https://192.168.2.31:37631");
  });
});
