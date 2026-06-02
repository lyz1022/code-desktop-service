import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestAppContext } from "./helpers.js";
import { chooseProjectRootWithSystemPicker, createServer } from "../server/httpServer.js";

function saveSession(
  context: ReturnType<typeof createTestAppContext>,
  input: {
    id: string;
    title: string;
    projectPath: string | null;
    projectName: string | null;
    updatedAt?: string;
  }
) {
  context.repositories.saveSession({
    id: input.id,
    toolId: "codex-mac",
    title: input.title,
    projectPath: input.projectPath,
    projectName: input.projectName,
    createdAt: "2026-05-18T08:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-05-18T08:00:00.000Z",
    isPinned: false,
    needsUserInput: false,
    waitsForNextDirection: false,
    statusLabel: "idle",
    lastMessagePreview: ""
  });
}

describe("web management routes", () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("serves the local management page", async () => {
    server = await createServer(createTestAppContext());
    const response = await server.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("桌面端服务管理");
    expect(response.body).not.toContain("code 服务管理");
    expect(response.body).toContain("service-process-id");
    expect(response.body).toContain("certificate-mode");
    expect(response.body).toContain("certificate-ca-fingerprint");
    expect(response.body).toContain("trust-certificate");
    expect(response.body).toContain("certificate-trust-status");
    expect(response.body).not.toContain("page-title-area");
    expect(response.body).toContain('<div class="page-title"><strong>code</strong><span>桌面端服务管理</span></div>');
    expect(response.body.indexOf('id="trust-certificate"')).toBeGreaterThan(response.body.indexOf('id="service-status"'));
    expect(response.body.indexOf('id="trust-certificate"')).toBeLessThan(response.body.indexOf('id="refresh-page"'));
    expect(response.body).toContain("本机 localhost 或 127.0.0.1");
    expect(response.body).not.toContain('id="refresh-service"');
    expect(response.body).not.toContain("刷新状态</button>");
    expect(response.body).not.toContain("service-actions");
    expect(response.body).toContain("startup-toggle");
    expect(response.body).toContain("startup-status");
    expect(response.body).toContain('role="switch"');
    expect(response.body).toContain("startup-switch");
    expect(response.body).toContain("startup-switch-thumb");
    expect(response.body).toContain("开启");
    expect(response.body).toContain("关闭");
    expect(response.body).not.toContain("startup-toggle-pill");
    expect(response.body).toContain("align-items: stretch");
    expect(response.body).not.toContain("align-items: start;");
    expect(response.body).toContain("--overview-card-height");
    expect(response.body).toContain("--overview-card-height: 456px");
    expect(response.body).toContain("--media-card-height");
    expect(response.body).toContain("--media-card-height: 476px");
    expect(response.body).not.toContain("--overview-card-height: clamp");
    expect(response.body).not.toContain("--media-card-height: clamp");
    expect(response.body).toContain(".overview-grid > .card");
    expect(response.body).toContain("height: var(--overview-card-height)");
    expect(response.body).toContain(".media-grid > .card");
    expect(response.body).toContain("height: var(--media-card-height)");
    expect(response.body).toContain("#paired-devices");
    expect(response.body).toContain("max-height: none");
    expect(response.body).toContain("pairing-countdown");
    expect(response.body).toContain("media-storage-total");
    expect(response.body).toContain("local-web-sessions");
    expect(response.body).toContain("media-search");
    expect(response.body).toContain("select-media-assets");
    expect(response.body).toContain("全选");
    expect(response.body).toContain("media-selected-count");
    expect(response.body).not.toContain("mac-artifact-session-id");
    expect(response.body).not.toContain("mac-artifact-file");
    expect(response.body).not.toContain("upload-mac-artifact");
    expect(response.body).not.toContain("登记 Mac 文件产物");
    expect(response.body).not.toContain("登记桌面端文件产物");
    expect(response.body).toContain("project-roots");
    expect(response.body).toContain("choose-project-root");
    expect(response.body).toContain("选择文件夹");
    expect(response.body).toContain("manual-project-root-path");
    expect(response.body).toContain("add-project-root-path");
    expect(response.body).toContain("添加路径");
    expect(response.body).toContain("C:\\\\Users\\\\52960\\\\Documents\\\\Codex");
    expect(response.body).toContain("项目根目录只用于移动端新建项目和创建新会话");
    expect(response.body).toContain('id="paired-devices" class="card-body device-list bounded-list"');
    expect(response.body).toContain('id="recent-media-assets" class="audit-list bounded-list"');
    expect(response.body).toContain('id="local-web-sessions" class="card-body audit-list bounded-list local-web-list"');
    expect(response.body).toContain("media-storage-body");
    expect(response.body).not.toContain("max-height: calc(var(--local-web-visible-items)");
    expect(response.body).toContain("overflow-y: auto");
    expect(response.body).toContain("clear-media-assets");
    expect(response.body).toContain("批量清理");
    expect(response.body).not.toContain("清理过期");
  });

  it("serves desktop-neutral management script copy", async () => {
    server = await createServer(createTestAppContext());
    const response = await server.inject({ method: "GET", url: "/web/main.js" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("桌面端服务地址已变化");
    expect(response.body).toContain("桌面端认证已就绪");
    expect(response.body).toContain("桌面端服务保存的媒体副本");
    expect(response.body).toContain("请在本机 localhost 或 127.0.0.1 管理页安装信任");
    expect(response.body).not.toContain("Mac 服务地址");
    expect(response.body).not.toContain("Mac 服务不可用");
    expect(response.body).not.toContain("Mac 管理页");
    expect(response.body).not.toContain("Mac 端认证");
    expect(response.body).not.toContain("Mac 服务保存的媒体副本");
    expect(response.body).toContain("正在打开系统目录选择器");
    expect(response.body).not.toContain("正在打开访达目录选择器");
  });

  it("adds and removes project roots from the web management API", async () => {
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-static-root-"));
    const dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-dynamic-root-"));
    server = await createServer(createTestAppContext({ projectRoots: [staticRoot] }));

    const initial = await server.inject({ method: "GET", url: "/api/project-roots" });
    expect(initial.statusCode).toBe(200);
    const initialBody = JSON.parse(initial.body) as { roots: Array<{ id: string; path: string; isStatic: boolean }> };
    expect(initialBody.roots).toHaveLength(1);
    expect(initialBody.roots[0]).toMatchObject({ path: staticRoot, isStatic: true });

    const create = await server.inject({
      method: "POST",
      url: "/api/project-roots",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ path: dynamicRoot })
    });
    expect(create.statusCode).toBe(200);
    const createBody = JSON.parse(create.body) as { roots: Array<{ id: string; path: string; isStatic: boolean }> };
    const added = createBody.roots.find((root) => root.path === dynamicRoot);
    expect(added).toMatchObject({ path: dynamicRoot, isStatic: false });

    const removeStatic = await server.inject({
      method: "DELETE",
      url: `/api/project-roots/${encodeURIComponent(initialBody.roots[0].id)}`
    });
    expect(removeStatic.statusCode).toBe(400);
    expect(removeStatic.body).toContain("启动配置中的项目根目录不能在 Web 管理页移除");

    const remove = await server.inject({
      method: "DELETE",
      url: `/api/project-roots/${encodeURIComponent(added?.id ?? "")}`
    });
    expect(remove.statusCode).toBe(200);
    const removeBody = JSON.parse(remove.body) as { roots: Array<{ path: string }> };
    expect(removeBody.roots.map((root) => root.path)).toEqual([staticRoot]);
  });

  it("rejects invalid project roots from the web management API", async () => {
    server = await createServer(createTestAppContext());
    const response = await server.inject({
      method: "POST",
      url: "/api/project-roots",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ path: path.join(os.tmpdir(), `code-missing-root-${Date.now()}`) })
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("项目根目录在桌面端不存在");
  });

  it("adds a Windows project root through the manual project-root API", async () => {
    const windowsRoot = "C:\\Users\\52960\\Documents\\Codex";
    const statSpy = vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true } as fs.Stats);
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    try {
      server = await createServer(createTestAppContext());

      const response = await server.inject({
        method: "POST",
        url: "/api/project-roots",
        headers: { "content-type": "application/json" },
        payload: { path: windowsRoot }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { ok: boolean; roots: Array<{ path: string }> };
      expect(body.ok).toBe(true);
      expect(body.roots.some((root) => root.path.includes(windowsRoot))).toBe(true);
    } finally {
      statSpy.mockRestore();
      accessSpy.mockRestore();
    }
  });

  it("adds project roots through a system directory picker route", async () => {
    const dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-picker-root-"));
    server = await createServer(createTestAppContext(), {
      chooseProjectRoot: async () => dynamicRoot
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/project-roots/choose"
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      ok: boolean;
      cancelled: boolean;
      roots: Array<{ path: string; isStatic: boolean }>;
    };
    expect(body).toMatchObject({ ok: true, cancelled: false });
    expect(body.roots.find((root) => root.path === dynamicRoot)).toMatchObject({
      path: dynamicRoot,
      isStatic: false
    });
  });

  it("keeps project roots unchanged when the system directory picker is cancelled", async () => {
    server = await createServer(createTestAppContext(), {
      chooseProjectRoot: async () => null
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/project-roots/choose"
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      ok: boolean;
      cancelled: boolean;
      roots: Array<{ path: string }>;
    };
    expect(body).toEqual({ ok: false, cancelled: true, roots: [] });
  });

  it("returns a structured unsupported result when the project-root picker is unavailable", async () => {
    server = await createServer(createTestAppContext(), {
      chooseProjectRoot: async () => {
        throw new Error("当前平台不支持访达目录选择器");
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/project-roots/choose"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: false,
      cancelled: false,
      unsupported: true,
      message: "当前平台不支持系统目录选择器，请手动输入项目根目录路径。",
      roots: []
    });
  });

  it("uses a Windows PowerShell folder picker for project roots", async () => {
    const calls: Array<{ file: string; args: string[]; timeout?: number; windowsHide?: boolean }> = [];
    const selected = await chooseProjectRootWithSystemPicker({
      platform: "win32",
      run: async (file, args, options) => {
        calls.push({ file, args, timeout: options.timeout, windowsHide: options.windowsHide });
        return { stdout: "C:\\Users\\52960\\Documents\\Codex\r\n", stderr: "" };
      }
    });

    expect(selected).toBe("C:\\Users\\52960\\Documents\\Codex");
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("powershell.exe");
    expect(calls[0].args).toContain("-STA");
    expect(calls[0].args).toContain("-ExecutionPolicy");
    expect(calls[0].args).toContain("-EncodedCommand");
    const encodedIndex = calls[0].args.indexOf("-EncodedCommand") + 1;
    const decodedScript = Buffer.from(calls[0].args[encodedIndex], "base64").toString("utf16le");
    expect(decodedScript).toContain("Shell.Application");
    expect(decodedScript).toContain("BrowseForFolder");
    expect(decodedScript).not.toContain("FolderBrowserDialog");
    expect(calls[0].timeout).toBe(120_000);
    expect(calls[0].windowsHide).toBe(false);
  });

  it("treats Windows folder picker cancellation as a cancelled project-root choice", async () => {
    const selected = await chooseProjectRootWithSystemPicker({
      platform: "win32",
      run: async () => ({ stdout: "__CODE_PROJECT_ROOT_PICKER_CANCELLED__\r\n", stderr: "" })
    });

    expect(selected).toBeNull();
  });

  it("reads and toggles desktop service startup from the web management API", async () => {
    const launchAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-web-startup-"));
    const context = createTestAppContext({ launchAgentDir });
    server = await createServer(context);

    const initial = await server.inject({ method: "GET", url: "/api/startup" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      supported: true,
      enabled: false,
      label: "com.liuyongzhe.code.mac-service"
    });

    const enable = await server.inject({
      method: "PUT",
      url: "/api/startup",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ enabled: true })
    });
    expect(enable.statusCode).toBe(200);
    const enabledBody = enable.json() as { enabled: boolean; plistPath: string };
    expect(enabledBody.enabled).toBe(true);
    expect(fs.existsSync(enabledBody.plistPath)).toBe(true);

    const disable = await server.inject({
      method: "PUT",
      url: "/api/startup",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ enabled: false })
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toMatchObject({ enabled: false });
    expect(fs.existsSync(enabledBody.plistPath)).toBe(false);

    const audit = await server.inject({ method: "GET", url: "/api/audit-logs" });
    const auditBody = audit.json() as { logs: Array<{ detail: string }> };
    expect(auditBody.logs.some((log) => log.detail.includes("桌面端服务开机登录后自启动"))).toBe(true);
    expect(auditBody.logs.some((log) => log.detail.includes("Mac 服务开机登录后自启动"))).toBe(false);
  });

  it("installs local CA trust only after an explicit web management action", async () => {
    const context = createTestAppContext();
    const trustLocalCertificate = vi.fn(async () => ({
      supported: true,
      trusted: true,
      caCertPath: context.transport.caCertPath,
      caFingerprint: context.transport.caFingerprint,
      message: "已安装 code 本地开发 CA 到 macOS 登录钥匙串"
    }));
    (context as unknown as {
      certificateTrust: {
        trustLocalCertificate: typeof trustLocalCertificate;
      };
    }).certificateTrust = { trustLocalCertificate };
    server = await createServer(context);

    const rejected = await server.inject({
      method: "POST",
      url: "/api/certificate/trust"
    });
    expect(rejected.statusCode).toBe(400);
    expect(trustLocalCertificate).not.toHaveBeenCalled();

    const accepted = await server.inject({
      method: "POST",
      url: "/api/certificate/trust",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "127.0.0.1:37631",
        "x-code-management-action": "trust-local-ca"
      }
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      supported: true,
      trusted: true,
      caFingerprint: context.transport.caFingerprint
    });
    expect(trustLocalCertificate).toHaveBeenCalledWith({
      caCertPath: context.transport.caCertPath,
      caFingerprint: context.transport.caFingerprint
    });
  });

  it("rejects local CA trust installation from LAN clients even with the management action header", async () => {
    const context = createTestAppContext();
    const trustLocalCertificate = vi.fn(async () => ({
      supported: true,
      trusted: true,
      message: "should not run"
    }));
    (context as unknown as {
      certificateTrust: {
        trustLocalCertificate: typeof trustLocalCertificate;
      };
    }).certificateTrust = { trustLocalCertificate };
    server = await createServer(context);

    const response = await server.inject({
      method: "POST",
      url: "/api/certificate/trust",
      remoteAddress: "192.168.1.50",
      headers: {
        host: "192.168.1.10:37631",
        "x-code-management-action": "trust-local-ca"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      errorCode: "LOCAL_MANAGEMENT_ONLY"
    });
    expect(trustLocalCertificate).not.toHaveBeenCalled();
  });

  it("rejects local CA trust installation when a local request is addressed through a LAN host", async () => {
    const context = createTestAppContext();
    const trustLocalCertificate = vi.fn(async () => ({
      supported: true,
      trusted: true,
      message: "should not run"
    }));
    (context as unknown as {
      certificateTrust: {
        trustLocalCertificate: typeof trustLocalCertificate;
      };
    }).certificateTrust = { trustLocalCertificate };
    server = await createServer(context);

    const response = await server.inject({
      method: "POST",
      url: "/api/certificate/trust",
      remoteAddress: "127.0.0.1",
      headers: {
        host: "192.168.1.10:37631",
        "x-code-management-action": "trust-local-ca"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      errorCode: "LOCAL_MANAGEMENT_ONLY"
    });
    expect(trustLocalCertificate).not.toHaveBeenCalled();
  });

  it("keeps legacy plistPath when startup status uses abstract path", async () => {
    type StartupStatusStub = {
      supported: boolean;
      enabled: boolean;
      label: string;
      path: string;
      message: string;
    };
    type StartupServiceStub = {
      status(): Promise<StartupStatusStub>;
      setEnabled(enabled: boolean): Promise<StartupStatusStub>;
    };
    const context = createTestAppContext();
    const startupPath = path.join(context.config.dataDir, "Startup", "Code.lnk");
    (context as unknown as { startup: StartupServiceStub }).startup = {
      status: async () => ({
        supported: false,
        enabled: false,
        label: "Windows user Startup folder",
        path: startupPath,
        message: "Windows 用户级 Startup 文件夹自启动尚未启用。"
      }),
      setEnabled: async (enabled: boolean) => ({
        supported: false,
        enabled,
        label: "Windows user Startup folder",
        path: startupPath,
        message: "Windows 用户级 Startup 文件夹自启动尚未启用。"
      })
    };
    server = await createServer(context);

    const response = await server.inject({ method: "GET", url: "/api/startup" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      path: startupPath,
      plistPath: startupPath
    });
  });

  it("clears one media asset from the web management API", async () => {
    const context = createTestAppContext();
    const asset = await context.mediaAssets.storeMacArtifactContent({
      sessionId: "thread-1",
      fileName: "demo.txt",
      mimeType: "text/plain",
      content: Buffer.from("demo")
    });
    const storedAsset = context.repositories.mediaAssets.get(asset.id);
    const assetDirectory = storedAsset
      ? path.join(context.config.dataDir, "media-assets", path.dirname(storedAsset.relativePath))
      : "";
    expect(fs.existsSync(assetDirectory)).toBe(true);
    context.repositories.sessionAttachments.insert({
      id: "attachment-1",
      sessionId: "thread-1",
      assetId: asset.id,
      role: "macArtifact",
      codexInputStatus: "notRequired",
      codexInputMessage: "桌面端文件产物已保存",
      createdAt: "2026-05-18T08:00:00.000Z"
    });
    server = await createServer(context);

    const response = await server.inject({
      method: "DELETE",
      url: `/api/media-assets/${encodeURIComponent(asset.id)}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, deletedCount: 1 });
    expect(context.repositories.mediaAssets.get(asset.id)).toBeNull();
    expect(fs.existsSync(assetDirectory)).toBe(false);
    expect(context.repositories.sessionAttachments.listBySession("thread-1")).toHaveLength(0);
    const assets = await server.inject({ method: "GET", url: "/api/media-assets" });
    expect(assets.json()).toMatchObject({ totalSizeBytes: 0, assets: [] });
  });

  it("groups media assets by project and searches project-associated media", async () => {
    const context = createTestAppContext();
    saveSession(context, {
      id: "thread-code",
      title: "Code 媒体同步",
      projectPath: "/repo/Code",
      projectName: "Code",
      updatedAt: "2026-05-18T09:00:00.000Z"
    });
    saveSession(context, {
      id: "thread-mobile",
      title: "Mobile 产物",
      projectPath: "/repo/Mobile",
      projectName: "Mobile",
      updatedAt: "2026-05-18T08:30:00.000Z"
    });
    const codeAsset = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-code",
      fileName: "README.md",
      mimeType: "text/markdown",
      sizeBytes: 6
    });
    await context.mediaAssets.storeUploadedContent(codeAsset.asset.id, Buffer.from("readme"), 6);
    const mobileAsset = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-mobile",
      fileName: "screen.png",
      mimeType: "image/png",
      sizeBytes: 4
    });
    await context.mediaAssets.storeUploadedContent(mobileAsset.asset.id, Buffer.from("shot"), 4);
    server = await createServer(context);

    const response = await server.inject({ method: "GET", url: "/api/media-assets" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      projects: Array<{ projectName: string; assetCount: number; assets: Array<{ fileName: string }> }>;
    };
    expect(body.projects.map((project) => project.projectName)).toEqual(["Code", "Mobile"]);
    expect(body.projects[0]).toMatchObject({ projectName: "Code", assetCount: 1 });
    expect(body.projects[0].assets[0]).toMatchObject({ fileName: "README.md" });

    const search = await server.inject({ method: "GET", url: "/api/media-assets?query=Mobile" });
    expect(search.statusCode).toBe(200);
    const searchBody = search.json() as {
      projects: Array<{ projectName: string; assets: Array<{ fileName: string }> }>;
    };
    expect(searchBody.projects).toHaveLength(1);
    expect(searchBody.projects[0]).toMatchObject({ projectName: "Mobile" });
    expect(searchBody.projects[0].assets).toEqual([expect.objectContaining({ fileName: "screen.png" })]);
  });

  it("clears only selected media assets from the web management API", async () => {
    const context = createTestAppContext();
    const first = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-1",
      fileName: "demo-1.txt",
      mimeType: "text/plain",
      sizeBytes: 6
    });
    await context.mediaAssets.storeUploadedContent(first.asset.id, Buffer.from("demo-1"), 6);
    const second = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-1",
      fileName: "demo-2.txt",
      mimeType: "text/plain",
      sizeBytes: 6
    });
    await context.mediaAssets.storeUploadedContent(second.asset.id, Buffer.from("demo-2"), 6);
    const third = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-2",
      fileName: "demo-3.txt",
      mimeType: "text/plain",
      sizeBytes: 6
    });
    await context.mediaAssets.storeUploadedContent(third.asset.id, Buffer.from("demo-3"), 6);
    server = await createServer(context);

    const response = await server.inject({
      method: "DELETE",
      url: "/api/media-assets",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ assetIds: [first.asset.id, third.asset.id] })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, deletedCount: 2 });
    expect(context.repositories.mediaAssets.get(first.asset.id)).toBeNull();
    expect(context.repositories.mediaAssets.get(second.asset.id)).not.toBeNull();
    expect(context.repositories.mediaAssets.get(third.asset.id)).toBeNull();
    const assets = await server.inject({ method: "GET", url: "/api/media-assets" });
    expect(assets.json()).toMatchObject({ totalSizeBytes: 6 });
  });

  it("keeps service uptime increasing after the management page has loaded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T00:00:00.000Z"));

    const mainScript = await readFile(new URL("../web/main.js", import.meta.url), "utf8");

    class FakeElement {
      textContent = "";
      className = "";
      disabled = false;
      src = "";
      style: Record<string, string> = {};
      attributes: Record<string, string> = {};
      dataset: Record<string, string> = {};
      children: FakeElement[] = [];
      listeners = new Map<string, Array<(event?: { key?: string; preventDefault?: () => void }) => void>>();
      private classes = new Set<string>();
      classList = {
        add: (name: string) => {
          this.classes.add(name);
          this.className = Array.from(this.classes).join(" ");
        },
        remove: (name: string) => {
          this.classes.delete(name);
          this.className = Array.from(this.classes).join(" ");
        },
        toggle: (name: string, force?: boolean) => {
          const shouldAdd = force ?? !this.classes.has(name);
          if (shouldAdd) {
            this.classes.add(name);
          } else {
            this.classes.delete(name);
          }
          this.className = Array.from(this.classes).join(" ");
          return shouldAdd;
        },
        contains: (name: string) => this.classes.has(name)
      };

      constructor(readonly id = "") {}

      addEventListener(type: string, listener: (event?: { key?: string; preventDefault?: () => void }) => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      appendChild(child: FakeElement) {
        this.children.push(child);
        return child;
      }

      replaceChildren(...children: FakeElement[]) {
        this.children = children;
      }

      removeAttribute(name: string) {
        delete this.attributes[name];
        if (name.startsWith("data-")) delete this.dataset[name.slice(5)];
      }

      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
        if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
      }

      click() {
        for (const listener of this.listeners.get("click") ?? []) listener();
      }

      dispatch(type: string, event?: { key?: string; preventDefault?: () => void }) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    class FakeButtonElement extends FakeElement {}
    class FakeInputElement extends FakeElement {
      value = "";
    }
    class FakeImageElement extends FakeElement {}

    const elements = new Map<string, FakeElement>();
    const buttonIds = new Set(["refresh-page", "create-pairing", "copy-code", "clear-media-assets", "choose-project-root", "add-project-root-path", "startup-toggle", "trust-certificate"]);
    const inputIds = new Set(["manual-project-root-path"]);
    const getElement = (id: string): FakeElement => {
      const existing = elements.get(id);
      if (existing) return existing;
      const element =
        id === "pairing-qr" ? new FakeImageElement(id) : buttonIds.has(id) ? new FakeButtonElement(id) : inputIds.has(id) ? new FakeInputElement(id) : new FakeElement(id);
      elements.set(id, element);
      return element;
    };

    const qrFrame = new FakeElement("qr-frame");
    let startupEnabled = false;
    let certificateTrusted = false;
    const reload = vi.fn();
    const windowLocation = { hostname: "127.0.0.1", port: "37631", reload };
    const confirm = vi.fn(() => true);
    const fetch = vi.fn(async (url: string, options?: { method?: string; body?: string; headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        if (url === "/api/project-roots" && options?.method === "POST") {
          const rootPath = JSON.parse(options.body || "{}").path;
          return {
            ok: true,
            roots: [{
              id: "root-win",
              name: "Codex",
              path: rootPath,
              isAvailable: true,
              isWritable: true,
              lastCheckedAt: "2026-05-16T00:00:00.000Z",
              errorMessage: ""
            }]
          };
        }
        if (url === "/api/startup" && options?.method === "PUT") {
          startupEnabled = Boolean(JSON.parse(options.body || "{}").enabled);
          return { supported: true, enabled: startupEnabled, label: "com.liuyongzhe.code.mac-service" };
        }
        if (url === "/api/health") {
          return {
            ok: true,
            version: "v1",
            port: 37631,
            processId: 1234,
            startedAt: "2026-05-16T00:00:00.000Z",
            uptimeSeconds: 0,
            serviceUrl: "https://127.0.0.1:37631",
            tlsFingerprint: "abcdef1234567890",
            certificateMode: "local-ca",
            caFingerprint: "ca1234567890abcdef",
            certificateTrustStatus: {
              supported: true,
              trusted: certificateTrusted,
              message: certificateTrusted ? "当前用户已信任 code 本地开发 CA" : "当前用户尚未信任 code 本地开发 CA"
            },
            certificateSubjectAltNames: {
              dnsNames: ["localhost"],
              ipAddresses: ["127.0.0.1"]
            }
          };
        }
        if (url === "/api/certificate/trust") {
          certificateTrusted = true;
          return {
            supported: true,
            trusted: true,
            caFingerprint: "ca1234567890abcdef",
            message: "已安装 code 本地开发 CA 到 macOS 登录钥匙串"
          };
        }
        if (url === "/api/codex-preflight") {
          return {
            status: "ok",
            message: "可用",
            codexBin: "/usr/local/bin/codex",
            cliVersion: "1.0.0",
            appServerAvailable: true,
            remoteControlAvailable: true,
            provider: "openai",
            model: "gpt-5",
            authStatus: "ok",
            capabilities: { sessions: true }
          };
        }
        if (url === "/api/devices") return { devices: [] };
        if (url === "/api/project-roots") return { roots: [] };
        if (url === "/api/audit-logs") return { logs: [] };
        if (url === "/api/media-assets") return { totalSizeBytes: 0, assets: [] };
        if (url === "/api/local-web-sessions") return { sessions: [] };
        if (url === "/api/startup") return { supported: true, enabled: startupEnabled, label: "com.liuyongzhe.code.mac-service" };
        if (url === "/api/pairing-ticket") {
          return {
            value: "123456",
            expiresAt: Date.now() + 60_000,
            serviceUrl: "https://127.0.0.1:37631",
            tlsFingerprint: "abcdef1234567890",
            qrPayload: JSON.stringify({ serviceUrl: "https://127.0.0.1:37631" }),
            qrPngDataUrl: "data:image/png;base64,AA=="
          };
        }
        throw new Error(`Unexpected fetch ${url}`);
      }
    }));

    vm.runInNewContext(mainScript, {
      Date,
      Error,
      HTMLButtonElement: FakeButtonElement,
      HTMLImageElement: FakeImageElement,
      HTMLInputElement: FakeInputElement,
      URL,
      document: {
        createElement: () => new FakeElement(),
        getElementById: getElement,
        querySelector: () => qrFrame
      },
      fetch,
      navigator: { clipboard: { writeText: vi.fn() } },
      window: {
        clearInterval,
        clearTimeout,
        confirm,
        location: windowLocation,
        setInterval,
        setTimeout
      }
    });

    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }

    expect(elements.get("service-uptime")?.textContent).toBe("0s");
    expect(elements.get("certificate-mode")?.textContent).toBe("本机 CA");
    expect(elements.get("certificate-ca-fingerprint")?.textContent).toBe("ca123456...90abcdef");
    expect(elements.get("certificate-trust-status")?.textContent).toBe("本机可安装信任");
    expect(elements.get("certificate-trust-status")?.attributes["title"]).toBe("当前为本机管理页，可安装当前用户信任。");
    expect(elements.get("startup-toggle")?.dataset.enabled).toBe("false");
    expect(elements.get("startup-toggle")?.attributes["aria-checked"]).toBe("false");
    expect(elements.get("startup-status")?.textContent).toBe("已关闭");

    const manualProjectRootInput = elements.get("manual-project-root-path") as FakeInputElement;
    manualProjectRootInput.value = "C:\\Users\\52960\\Documents\\Codex";
    elements.get("add-project-root-path")?.click();
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }

    expect(fetch).toHaveBeenCalledWith("/api/project-roots", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "C:\\Users\\52960\\Documents\\Codex" })
    }));
    expect(manualProjectRootInput.value).toBe("");
    expect(elements.get("project-root-status")?.textContent).toBe("项目根目录已保存，移动端刷新项目后可选择该根目录创建项目或新会话。");

    const preventDefault = vi.fn();
    manualProjectRootInput.value = "D:\\Code";
    manualProjectRootInput.dispatch("keydown", { key: "Enter", preventDefault });
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }

    expect(preventDefault).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("/api/project-roots", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ path: "D:\\Code" })
    }));

    elements.get("startup-toggle")?.click();
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }

    expect(fetch).toHaveBeenCalledWith("/api/startup", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ enabled: true })
    }));
    expect(elements.get("startup-toggle")?.dataset.enabled).toBe("true");
    expect(elements.get("startup-toggle")?.attributes["aria-checked"]).toBe("true");
    expect(elements.get("startup-status")?.textContent).toBe("已开启，开机登录后自启动");

    elements.get("startup-toggle")?.click();
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }

    expect(fetch).toHaveBeenCalledWith("/api/startup", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ enabled: false })
    }));
    expect(elements.get("startup-toggle")?.dataset.enabled).toBe("false");
    expect(elements.get("startup-toggle")?.attributes["aria-checked"]).toBe("false");
    expect(elements.get("startup-status")?.textContent).toBe("已关闭");

    elements.get("trust-certificate")?.click();
    for (let index = 0; index < 30; index += 1) {
      await Promise.resolve();
    }

    expect(confirm).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("/api/certificate/trust", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "x-code-management-action": "trust-local-ca"
      })
    }));
    expect(elements.get("certificate-trust-status")?.textContent).toBe("本机已信任");
    expect(elements.get("certificate-trust-status")?.attributes["title"]).toBe("当前用户已信任 code 本地开发 CA。浏览器重新加载后会重新校验证书。");
    expect(elements.get("trust-certificate")?.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);

    expect(elements.get("service-uptime")?.textContent).toBe("2s");
    expect(reload).toHaveBeenCalled();
  });

  it("reveals media checkboxes only after entering batch cleanup mode and confirms before deleting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T08:00:00.000Z"));

    const mainScript = await readFile(new URL("../web/main.js", import.meta.url), "utf8");

    class FakeElement {
      textContent = "";
      className = "";
      disabled = false;
      checked = false;
      indeterminate = false;
      href = "";
      target = "";
      rel = "";
      type = "";
      style: Record<string, string> = {};
      attributes: Record<string, string> = {};
      children: FakeElement[] = [];
      listeners = new Map<string, Array<() => void>>();
      classList = {
        add: vi.fn(),
        remove: vi.fn(),
        toggle: vi.fn()
      };

      constructor(readonly id = "") {}

      addEventListener(type: string, listener: () => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      appendChild(child: FakeElement) {
        this.children.push(child);
        return child;
      }

      click() {
        for (const listener of this.listeners.get("click") ?? []) listener();
      }

      dispatch(type: string) {
        for (const listener of this.listeners.get(type) ?? []) listener();
      }

      replaceChildren(...children: FakeElement[]) {
        this.children = children;
      }

      removeAttribute(name: string) {
        delete this.attributes[name];
      }

      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      }
    }

    class FakeButtonElement extends FakeElement {}
    class FakeInputElement extends FakeElement {}
    class FakeImageElement extends FakeElement {}

    const elements = new Map<string, FakeElement>();
    const buttonIds = new Set(["refresh-page", "create-pairing", "copy-code", "clear-media-assets", "choose-project-root"]);
    const inputIds = new Set(["select-media-assets", "startup-toggle"]);
    const getElement = (id: string): FakeElement => {
      const existing = elements.get(id);
      if (existing) return existing;
      const element =
        id === "pairing-qr" ? new FakeImageElement(id) : buttonIds.has(id) ? new FakeButtonElement(id) : inputIds.has(id) ? new FakeInputElement(id) : new FakeElement(id);
      elements.set(id, element);
      return element;
    };
    const findByClassName = (root: FakeElement | undefined, className: string): FakeElement[] => {
      if (!root) return [];
      const matches = root.className.split(/\s+/).includes(className) ? [root] : [];
      for (const child of root.children) matches.push(...findByClassName(child, className));
      return matches;
    };
    const flushPromises = async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    };

    const qrFrame = new FakeElement("qr-frame");
    const confirm = vi.fn(() => false);
    const fetch = vi.fn(async (url: string, options?: { method?: string; body?: string }) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        if (url === "/api/health") {
          return {
            ok: true,
            version: "v1",
            port: 37631,
            processId: 1234,
            startedAt: "2026-05-18T08:00:00.000Z",
            uptimeSeconds: 0,
            serviceUrl: "https://127.0.0.1:37631",
            tlsFingerprint: "abcdef1234567890"
          };
        }
        if (url === "/api/codex-preflight") {
          return {
            status: "ok",
            message: "可用",
            codexBin: "/usr/local/bin/codex",
            cliVersion: "1.0.0",
            appServerAvailable: true,
            remoteControlAvailable: true,
            provider: "openai",
            model: "gpt-5",
            authStatus: "ok",
            capabilities: { sessions: true }
          };
        }
        if (url === "/api/devices") return { devices: [] };
        if (url === "/api/project-roots") return { roots: [] };
        if (url === "/api/audit-logs") return { logs: [] };
        if (url === "/api/local-web-sessions") return { sessions: [] };
        if (url === "/api/startup") return { supported: true, enabled: false, label: "com.liuyongzhe.code.mac-service" };
        if (url === "/api/media-assets" && options?.method !== "DELETE") {
          return {
            totalSizeBytes: 8,
            projects: [{
              projectKey: "code",
              projectPath: "/repo/Code",
              projectName: "Code",
              assetCount: 2,
              totalSizeBytes: 8,
              assets: [{
                id: "asset-1",
                fileName: "screen.png",
                kind: "image",
                sizeBytes: 4,
                expiresAt: "2026-05-19T08:00:00.000Z",
                url: "/api/media-assets/asset-1/download"
              }, {
                id: "asset-2",
                fileName: "notes.md",
                kind: "document",
                sizeBytes: 4,
                expiresAt: "2026-05-19T08:00:00.000Z",
                url: "/api/media-assets/asset-2/download"
              }]
            }]
          };
        }
        if (url === "/api/pairing-ticket") {
          return {
            value: "123456",
            expiresAt: Date.now() + 60_000,
            serviceUrl: "https://127.0.0.1:37631",
            tlsFingerprint: "abcdef1234567890",
            qrPayload: JSON.stringify({ serviceUrl: "https://127.0.0.1:37631" }),
            qrPngDataUrl: "data:image/png;base64,AA=="
          };
        }
        throw new Error(`Unexpected fetch ${url}`);
      }
    }));

    vm.runInNewContext(mainScript, {
      Date,
      Error,
      HTMLButtonElement: FakeButtonElement,
      HTMLImageElement: FakeImageElement,
      URL,
      document: {
        createElement: () => new FakeElement(),
        getElementById: getElement,
        querySelector: () => qrFrame
      },
      fetch,
      navigator: { clipboard: { writeText: vi.fn() } },
      window: {
        clearInterval,
        clearTimeout,
        confirm,
        location: { hostname: "127.0.0.1", port: "37631" },
        setInterval,
        setTimeout
      }
    });

    await flushPromises();

    const mediaList = elements.get("recent-media-assets");
    const clearButton = elements.get("clear-media-assets");
    const selectAll = elements.get("select-media-assets");
    expect(selectAll?.style.display).toBe("none");
    expect(findByClassName(mediaList, "media-checkbox")).toHaveLength(0);
    expect(clearButton?.disabled).toBe(false);
    expect(clearButton?.textContent).toBe("批量清理");

    clearButton?.click();

    const checkboxes = findByClassName(mediaList, "media-checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(selectAll?.style.display).toBe("");
    expect(clearButton?.textContent).toBe("取消清理");

    checkboxes[0].checked = true;
    checkboxes[0].dispatch("change");
    expect(elements.get("media-selected-count")?.textContent).toBe("已选择 1 个文件");
    expect(selectAll?.checked).toBe(false);
    expect(selectAll?.indeterminate).toBe(true);

    selectAll?.click();

    expect(elements.get("media-selected-count")?.textContent).toBe("已选择 2 个文件");
    expect(selectAll?.checked).toBe(true);
    expect(selectAll?.indeterminate).toBe(false);
    expect(findByClassName(mediaList, "media-checkbox").every((checkbox) => checkbox.checked)).toBe(true);
    expect(clearButton?.textContent).toBe("批量清理 (2)");

    clearButton?.click();

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("批量清理已勾选的 2 个媒体文件"));
    expect(fetch).not.toHaveBeenCalledWith("/api/media-assets", expect.objectContaining({ method: "DELETE" }));
  });
});
