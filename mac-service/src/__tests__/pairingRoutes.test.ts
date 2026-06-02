import { afterEach, describe, expect, it } from "vitest";
import { createTestAppContext } from "./helpers.js";
import { createServer } from "../server/httpServer.js";

describe("pairing routes", () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it("claims a pairing ticket and rejects token after revoke", async () => {
    const context = createTestAppContext();
    server = await createServer(context);

    const ticket = await server.inject({ method: "POST", url: "/api/pairing-ticket" });
    const ticketBody = ticket.json() as { value: string };
    const claim = await server.inject({
      method: "POST",
      url: "/api/pairing-claim",
      payload: { pairingCode: ticketBody.value, deviceName: "Mate 60 Pro" }
    });
    const claimed = claim.json() as { device: { id: string }; authToken: string; macName: string };

    expect(claim.statusCode).toBe(200);
    expect(claimed.macName).toBe(context.localMacName);
    expect(context.pairing.validateToken(claimed.authToken)?.id).toBe(claimed.device.id);
    const devices = await server.inject({ method: "GET", url: "/api/devices" });
    const devicesBody = devices.json() as { devices: Array<{ id: string; tokenHash?: string; expiresAt: string }> };
    expect(devicesBody.devices[0].id).toBe(claimed.device.id);
    expect(devicesBody.devices[0].tokenHash).toBeUndefined();
    expect(Date.parse(devicesBody.devices[0].expiresAt)).toBeGreaterThan(Date.now());

    const revoke = await server.inject({ method: "POST", url: `/api/devices/${claimed.device.id}/revoke` });
    expect(revoke.statusCode).toBe(200);
    expect(context.pairing.validateToken(claimed.authToken)).toBeNull();

    const devicesAfterRevoke = await server.inject({ method: "GET", url: "/api/devices" });
    const devicesAfterRevokeBody = devicesAfterRevoke.json() as { devices: Array<{ id: string }> };
    expect(devicesAfterRevokeBody.devices).toHaveLength(0);

    const auditLogs = await server.inject({ method: "GET", url: "/api/audit-logs" });
    const auditLogsBody = auditLogs.json() as { logs: Array<{ actionType: string; deviceId: string | null }> };
    expect(auditLogsBody.logs.some((log) => log.actionType === "device.revoke" && log.deviceId === claimed.device.id)).toBe(true);
  });

  it("keeps only the latest active authorization for the same named device", async () => {
    const context = createTestAppContext();
    server = await createServer(context);

    const firstTicket = await server.inject({ method: "POST", url: "/api/pairing-ticket" });
    const firstTicketBody = firstTicket.json() as { value: string };
    const firstClaim = await server.inject({
      method: "POST",
      url: "/api/pairing-claim",
      payload: { pairingCode: firstTicketBody.value, deviceName: "HarmonyOS Device" }
    });
    const firstClaimed = firstClaim.json() as { device: { id: string }; authToken: string };

    const secondTicket = await server.inject({ method: "POST", url: "/api/pairing-ticket" });
    const secondTicketBody = secondTicket.json() as { value: string };
    const secondClaim = await server.inject({
      method: "POST",
      url: "/api/pairing-claim",
      payload: { pairingCode: secondTicketBody.value, deviceName: "HarmonyOS Device" }
    });
    const secondClaimed = secondClaim.json() as { device: { id: string }; authToken: string };

    expect(secondClaim.statusCode).toBe(200);
    expect(context.pairing.validateToken(firstClaimed.authToken)).toBeNull();
    expect(context.pairing.validateToken(secondClaimed.authToken)?.id).toBe(secondClaimed.device.id);

    const devices = await server.inject({ method: "GET", url: "/api/devices" });
    const devicesBody = devices.json() as { devices: Array<{ id: string; deviceName: string }> };
    expect(devicesBody.devices).toHaveLength(1);
    expect(devicesBody.devices[0].id).toBe(secondClaimed.device.id);
    expect(devicesBody.devices[0].deviceName).toBe("HarmonyOS Device");

    const auditLogs = await server.inject({ method: "GET", url: "/api/audit-logs" });
    const auditLogsBody = auditLogs.json() as { logs: Array<{ actionType: string; deviceId: string | null; detail: string }> };
    expect(auditLogsBody.logs.some((log) => log.actionType === "device.revoke" &&
      log.deviceId === firstClaimed.device.id &&
      log.detail === "设备重新配对，旧授权已自动撤销")).toBe(true);
  });

  it("includes the service port and reconnect candidates in QR pairing payloads", async () => {
    const context = createTestAppContext({ host: "0.0.0.0" });
    server = await createServer(context);

    const ticket = await server.inject({ method: "POST", url: "/api/pairing-ticket", headers: { host: "127.0.0.1:37631" } });
    const ticketBody = ticket.json() as {
      qrPayload: string;
      serviceUrl: string;
      issuedAt: string;
      serverStartedAt: string;
      tlsPublicKeyHash: string;
    };
    const qrPayload = JSON.parse(ticketBody.qrPayload) as {
      serviceUrl: string;
      candidateServiceUrls: string[];
      tlsPublicKeyHash: string;
    };

    expect(ticketBody.serviceUrl).toMatch(/^https:\/\/.+:37631$/);
    expect(ticketBody.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ticketBody.serverStartedAt).toBe(context.serviceStartedAt);
    expect(ticketBody.tlsPublicKeyHash).toBe(context.transport.publicKeyHash);
    expect(qrPayload.serviceUrl).toBe(ticketBody.serviceUrl);
    expect(qrPayload.tlsPublicKeyHash).toBe(context.transport.publicKeyHash);
    expect(qrPayload.candidateServiceUrls).toContain(ticketBody.serviceUrl);
    expect(qrPayload.candidateServiceUrls.some((url) => url.endsWith(".local:37631"))).toBe(true);
  });

  it("does not advertise LAN reconnect candidates when the service is loopback-only", async () => {
    const context = createTestAppContext({ host: "127.0.0.1" });
    server = await createServer(context);

    const ticket = await server.inject({ method: "POST", url: "/api/pairing-ticket", headers: { host: "127.0.0.1:37631" } });
    const ticketBody = ticket.json() as { qrPayload: string; serviceUrl: string };
    const qrPayload = JSON.parse(ticketBody.qrPayload) as { serviceUrl: string; candidateServiceUrls: string[] };

    expect(ticketBody.serviceUrl).toBe("https://127.0.0.1:37631");
    expect(qrPayload.serviceUrl).toBe("https://127.0.0.1:37631");
    expect(qrPayload.candidateServiceUrls).toEqual(["https://127.0.0.1:37631"]);
  });

  it("records failed pairing claims for diagnosis without authorizing a device", async () => {
    const context = createTestAppContext();
    server = await createServer(context);

    const claim = await server.inject({
      method: "POST",
      url: "/api/pairing-claim",
      payload: { pairingCode: "expired-code", deviceName: "Mate 80" }
    });

    expect(claim.statusCode).toBe(400);
    expect(context.pairing.listDevices()).toHaveLength(0);
    const auditLogs = await server.inject({ method: "GET", url: "/api/audit-logs" });
    const auditLogsBody = auditLogs.json() as { logs: Array<{ actionType: string; result: string; detail: string }> };
    expect(auditLogsBody.logs.some((log) => log.actionType === "pairing.claim" &&
      log.result === "failed" &&
      log.detail.includes("Mate 80"))).toBe(true);
  });

  it("uses the detected local Mac name in QR pairing payloads", async () => {
    const context = createTestAppContext();
    context.localMacName = "真实 MacBook Air";
    server = await createServer(context);

    const ticket = await server.inject({ method: "POST", url: "/api/pairing-ticket", headers: { host: "127.0.0.1:37631" } });
    const ticketBody = ticket.json() as { qrPayload: string };
    const qrPayload = JSON.parse(ticketBody.qrPayload) as { macName: string };

    expect(qrPayload.macName).toBe("真实 MacBook Air");
  });
});
