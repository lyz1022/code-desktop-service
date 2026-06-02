import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestAppContext } from "./helpers.js";
import { createAppContext } from "../appContext.js";
import { createServer } from "../server/httpServer.js";

describe("http server", () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it("returns service health", async () => {
    const context = createTestAppContext();
    const checkLocalCertificateTrust = vi.fn(async () => ({
      supported: true,
      trusted: true,
      message: "当前用户已信任 code 本地开发 CA"
    }));
    (context as unknown as {
      certificateTrust: typeof context.certificateTrust & {
        checkLocalCertificateTrust: typeof checkLocalCertificateTrust;
      };
    }).certificateTrust = {
      ...context.certificateTrust,
      checkLocalCertificateTrust
    };
    server = await createServer(context);
    const response = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "localhost:37631" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      product: "code",
      version: "v1",
      processId: process.pid,
      host: expect.any(String),
      serviceUrl: expect.stringMatching(/^https:\/\//),
      macId: context.localMacId,
      candidateServiceUrls: expect.arrayContaining([expect.stringMatching(/^https:\/\//)]),
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      uptimeSeconds: expect.any(Number),
      certificateTrustStatus: {
        supported: true,
        trusted: true,
        message: "当前用户已信任 code 本地开发 CA"
      }
    });
    expect(checkLocalCertificateTrust).toHaveBeenCalledWith({
      serverCertPath: context.transport.certPath,
      caCertPath: context.transport.caCertPath,
      caFingerprint: context.transport.caFingerprint,
      hostname: "localhost"
    });
  });

  it("returns structured blocked Codex preflight when the configured binary is unavailable", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-preflight-missing-codex-"));
    const context = createAppContext({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      codexBin: path.join(dataDir, "missing-codex.exe"),
      codexIpcSocketPath: path.join(dataDir, "missing-codex-ipc.sock"),
      projectRoots: [],
      launchAgentDir: path.join(dataDir, "LaunchAgents"),
      startupCommand: "pnpm dev"
    });
    server = await createServer(context);

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/codex-preflight"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "blocked",
        codexBin: null,
        appServerAvailable: false
      });
      expect(response.body).toContain("CODEX_BIN");
    } finally {
      context.db.close();
    }
  });

  it("prepares, uploads, and downloads an authorized asset", async () => {
    const context = createTestAppContext();
    server = await createServer(context);
    const pairingCode = context.pairing.createPairingCode("Mac");
    const claimed = context.pairing.claimPairingCode(pairingCode.value, "Phone");

    const prepare = await server.inject({
      method: "POST",
      url: "/api/assets/prepare",
      headers: { authorization: `Bearer ${claimed.authToken}` },
      payload: { sessionId: "thread-1", fileName: "screen.png", mimeType: "image/png", sizeBytes: 4 }
    });
    expect(prepare.statusCode).toBe(200);
    const prepared = JSON.parse(prepare.body) as { assetId: string; uploadUrl: string };

    const upload = await server.inject({
      method: "PUT",
      url: prepared.uploadUrl,
      headers: { authorization: `Bearer ${claimed.authToken}`, "content-type": "application/octet-stream", "content-length": "4" },
      payload: Buffer.from("data")
    });
    expect(upload.statusCode).toBe(200);
    const uploaded = upload.json() as { asset: { id: string; status: string }; attachment: { assetId: string; codexInputStatus: string } };
    expect(uploaded.attachment).toMatchObject({
      assetId: prepared.assetId,
      codexInputStatus: "pending"
    });
    expect(context.repositories.sessionAttachments.listBySession("thread-1")).toMatchObject([{
      assetId: prepared.assetId,
      role: "userUpload",
      codexInputStatus: "pending"
    }]);

    const download = await server.inject({
      method: "GET",
      url: `/api/assets/${prepared.assetId}/content`,
      headers: { authorization: `Bearer ${claimed.authToken}` }
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("data");

    const attachments = await server.inject({
      method: "GET",
      url: "/api/sessions/thread-1/attachments",
      headers: { authorization: `Bearer ${claimed.authToken}` }
    });
    expect(attachments.statusCode).toBe(200);
    expect(attachments.json()).toMatchObject({
      attachments: [{
        assetId: prepared.assetId,
        role: "userUpload",
        codexInputStatus: "pending"
      }]
    });
  });

  it("accepts mobile document uploads with their original mime type", async () => {
    const context = createTestAppContext();
    server = await createServer(context);
    const pairingCode = context.pairing.createPairingCode("Mac");
    const claimed = context.pairing.claimPairingCode(pairingCode.value, "Phone");

    const prepare = await server.inject({
      method: "POST",
      url: "/api/assets/prepare",
      headers: { authorization: `Bearer ${claimed.authToken}` },
      payload: { sessionId: "thread-1", fileName: "note.md", mimeType: "text/markdown", sizeBytes: 6 }
    });
    expect(prepare.statusCode).toBe(200);
    const prepared = JSON.parse(prepare.body) as { assetId: string; uploadUrl: string };

    const upload = await server.inject({
      method: "PUT",
      url: prepared.uploadUrl,
      headers: { authorization: `Bearer ${claimed.authToken}`, "content-type": "text/markdown", "content-length": "6" },
      payload: Buffer.from("hello\n")
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toMatchObject({
      asset: {
        id: prepared.assetId,
        status: "available",
        mimeType: "text/markdown"
      },
      attachment: {
        assetId: prepared.assetId,
        codexInputStatus: "pending"
      }
    });
  });

  it("accepts text upload bodies parsed as strings", async () => {
    const context = createTestAppContext();
    server = await createServer(context);
    const pairingCode = context.pairing.createPairingCode("Mac");
    const claimed = context.pairing.claimPairingCode(pairingCode.value, "Phone");
    const text = "mobile text upload\n";

    const prepare = await server.inject({
      method: "POST",
      url: "/api/assets/prepare",
      headers: { authorization: `Bearer ${claimed.authToken}` },
      payload: { sessionId: "thread-1", fileName: "note.txt", mimeType: "text/plain", sizeBytes: Buffer.byteLength(text) }
    });
    expect(prepare.statusCode).toBe(200);
    const prepared = JSON.parse(prepare.body) as { assetId: string; uploadUrl: string };

    const upload = await server.inject({
      method: "PUT",
      url: prepared.uploadUrl,
      headers: { authorization: `Bearer ${claimed.authToken}`, "content-type": "text/plain", "content-length": String(Buffer.byteLength(text)) },
      payload: text
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toMatchObject({
      asset: {
        id: prepared.assetId,
        status: "available",
        mimeType: "text/plain"
      }
    });
  });

  it("does not expose Mac web artifact registration", async () => {
    const context = createTestAppContext();
    server = await createServer(context);

    const response = await server.inject({
      method: "POST",
      url: "/api/sessions/thread-1/artifacts",
      headers: {
        "x-code-file-name": encodeURIComponent("/Users/me/Desktop/demo.mov"),
        "content-type": "video/quicktime",
        "content-length": "5"
      },
      payload: Buffer.from("movie")
    });

    expect(response.statusCode).toBe(404);
    expect(context.repositories.mediaAssets.listBySession("thread-1")).toHaveLength(0);
    expect(context.repositories.sessionAttachments.listBySession("thread-1")).toHaveLength(0);
  });

  it("copies a referenced desktop file into an asset only after an authorized mobile request", async () => {
    const context = createTestAppContext();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-reference-"));
    const filePath = path.join(projectDir, "README.md");
    fs.writeFileSync(filePath, "# Demo\n");
    context.sessions.addSession({
      id: "thread-1",
      toolId: "codex-mac",
      title: "Demo",
      projectPath: projectDir,
      projectName: "demo",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      isPinned: false,
      needsUserInput: false,
      waitsForNextDirection: false,
      statusLabel: "idle",
      lastMessagePreview: ""
    });
    server = await createServer(context);
    const pairingCode = context.pairing.createPairingCode("Mac");
    const claimed = context.pairing.claimPairingCode(pairingCode.value, "Phone");

    const response = await server.inject({
      method: "POST",
      url: "/api/sessions/thread-1/file-reference-assets",
      headers: { authorization: `Bearer ${claimed.authToken}` },
      payload: { path: filePath, fileName: "README.md" }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      asset: { id: string; source: string; fileName: string; status: string; url: string };
      attachment: { role: string; codexInputStatus: string };
    };
    expect(body.asset).toMatchObject({
      source: "macFile",
      fileName: "README.md",
      status: "available"
    });
    expect(body.attachment).toMatchObject({
      role: "macArtifact",
      codexInputStatus: "notRequired"
    });
    const download = await server.inject({
      method: "GET",
      url: body.asset.url,
      headers: { authorization: `Bearer ${claimed.authToken}` }
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("# Demo\n");
    expect(context.repositories.mediaAssets.get(body.asset.id)?.relativePath).not.toContain(projectDir);
  });

  it("rejects referenced desktop file sync without a paired device", async () => {
    const context = createTestAppContext();
    server = await createServer(context);

    const response = await server.inject({
      method: "POST",
      url: "/api/sessions/thread-1/file-reference-assets",
      payload: { path: "/tmp/README.md", fileName: "README.md" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorCode: "AUTH_INVALID" });
  });

  it("rejects referenced desktop file sync for unknown sessions", async () => {
    const context = createTestAppContext();
    server = await createServer(context);
    const pairingCode = context.pairing.createPairingCode("Mac");
    const claimed = context.pairing.claimPairingCode(pairingCode.value, "Phone");

    const response = await server.inject({
      method: "POST",
      url: "/api/sessions/missing-thread/file-reference-assets",
      headers: { authorization: `Bearer ${claimed.authToken}` },
      payload: { path: "/tmp/README.md", fileName: "README.md" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ errorCode: "MEDIA_ASSET_NOT_FOUND" });
  });

  it("rejects referenced desktop files outside the session project path", async () => {
    const context = createTestAppContext();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-reference-project-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-reference-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    context.sessions.addSession({
      id: "thread-1",
      toolId: "codex-mac",
      title: "Demo",
      projectPath: projectDir,
      projectName: "demo",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      isPinned: false,
      needsUserInput: false,
      waitsForNextDirection: false,
      statusLabel: "idle",
      lastMessagePreview: ""
    });
    server = await createServer(context);
    const pairingCode = context.pairing.createPairingCode("Mac");
    const claimed = context.pairing.claimPairingCode(pairingCode.value, "Phone");

    const response = await server.inject({
      method: "POST",
      url: "/api/sessions/thread-1/file-reference-assets",
      headers: { authorization: `Bearer ${claimed.authToken}` },
      payload: { path: outsideFile, fileName: "secret.txt" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errorCode: "MEDIA_ASSET_REJECTED" });
  });

  it("rejects referenced desktop file sync when the session has no project path", async () => {
    const context = createTestAppContext();
    const filePath = path.join(os.tmpdir(), "code-file-reference-projectless.txt");
    fs.writeFileSync(filePath, "projectless secret");
    context.sessions.addSession({
      id: "thread-1",
      toolId: "codex-mac",
      title: "Projectless",
      projectPath: null,
      projectName: "无项目",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      isPinned: false,
      needsUserInput: false,
      waitsForNextDirection: false,
      statusLabel: "idle",
      lastMessagePreview: ""
    });
    server = await createServer(context);
    const pairingCode = context.pairing.createPairingCode("Mac");
    const claimed = context.pairing.claimPairingCode(pairingCode.value, "Phone");

    const response = await server.inject({
      method: "POST",
      url: "/api/sessions/thread-1/file-reference-assets",
      headers: { authorization: `Bearer ${claimed.authToken}` },
      payload: { path: filePath, fileName: "projectless.txt" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errorCode: "MEDIA_ASSET_REJECTED" });
  });

  it("rejects project-local symlinks that resolve outside the session project path", async () => {
    const context = createTestAppContext();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-reference-symlink-project-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-file-reference-symlink-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    const symlinkPath = path.join(projectDir, "linked-secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(outsideFile, symlinkPath);
    context.sessions.addSession({
      id: "thread-1",
      toolId: "codex-mac",
      title: "Demo",
      projectPath: projectDir,
      projectName: "demo",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      isPinned: false,
      needsUserInput: false,
      waitsForNextDirection: false,
      statusLabel: "idle",
      lastMessagePreview: ""
    });
    server = await createServer(context);
    const pairingCode = context.pairing.createPairingCode("Mac");
    const claimed = context.pairing.claimPairingCode(pairingCode.value, "Phone");

    const response = await server.inject({
      method: "POST",
      url: "/api/sessions/thread-1/file-reference-assets",
      headers: { authorization: `Bearer ${claimed.authToken}` },
      payload: { path: symlinkPath, fileName: "linked-secret.txt" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errorCode: "MEDIA_ASSET_REJECTED" });
  });

  it("rejects asset upload routes without paired device authorization", async () => {
    server = await createServer(createTestAppContext());
    const response = await server.inject({
      method: "POST",
      url: "/api/assets/prepare",
      payload: { sessionId: "thread-1", fileName: "screen.png", mimeType: "image/png", sizeBytes: 4 }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorCode: "AUTH_INVALID" });
  });
});
