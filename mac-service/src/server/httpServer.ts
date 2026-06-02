import websocket from "@fastify/websocket";
import fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import QRCode from "qrcode";
import { z } from "zod";
import { createAppContext, type AppContext } from "../appContext.js";
import { LocalWebProxyError } from "../domain/localWebProxy.js";
import { MediaAssetError, type PublicMediaAsset } from "../domain/mediaAssetService.js";
import type { PairedDevice } from "../security/pairing.js";
import { createPairingPayload } from "../security/pairingPayload.js";
import type { StoredMediaAssetWithSession, StoredSessionAttachment } from "../storage/repositories.js";
import { serviceUptimeSeconds } from "./serviceStatus.js";
import { createServiceUrl, createServiceUrlCandidates } from "./serviceUrl.js";
import { registerWsServer } from "./wsServer.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(dirname, "../web");
const execFileAsync = promisify(execFile);
const LOCAL_WEB_PREVIEW_LANGUAGE_QUERY = "__code_preview_lang";
const CERTIFICATE_TRUST_MANAGEMENT_ACTION = "trust-local-ca";
type LocalWebErrorLanguage = "zh" | "en";

export interface CreateServerOptions {
  chooseProjectRoot?: () => Promise<string | null>;
}

interface StartupStatusResponse {
  supported: boolean;
  enabled: boolean;
  label: string;
  plistPath?: string;
  path?: string;
  message?: string;
}
type ProjectRootPickerPlatform = typeof process.platform;
type ProjectRootPickerRunner = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide?: boolean }
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

const PairingClaimBodySchema = z.object({
  pairingCode: z.string().min(1),
  deviceName: z.string().min(1)
});
const PairingTicketBodySchema = z.object({
  preferredServiceUrl: z.string().trim().optional()
});
const PrepareAssetBodySchema = z.object({
  sessionId: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative()
});
const FileReferenceAssetBodySchema = z.object({
  path: z.string().min(1),
  fileName: z.string().trim().min(1).optional()
});
const ProjectRootBodySchema = z.object({
  path: z.string().trim().min(1)
});
const StartupBodySchema = z.object({
  enabled: z.boolean()
});
const ClearMediaAssetsBodySchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1)
});
const PROJECT_ROOT_PICKER_UNSUPPORTED_MESSAGE = "当前平台不支持系统目录选择器，请手动输入项目根目录路径。";
const PROJECT_ROOT_PICKER_UNSUPPORTED_ERROR = "当前平台不支持系统目录选择器";
const PROJECT_ROOT_PICKER_PROMPT = "选择用于移动端新建项目和创建新会话的项目根目录";
const WINDOWS_PROJECT_ROOT_PICKER_CANCELLED = "__CODE_PROJECT_ROOT_PICKER_CANCELLED__";

function isDeviceVisible(device: { expiresAt: string; revokedAt: string | null }): boolean {
  return device.revokedAt === null && Date.parse(device.expiresAt) > Date.now();
}

function projectNameFromPath(projectPath: string | null): string | null {
  if (!projectPath) return null;
  const parts = projectPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : projectPath;
}

function mediaProjectLabel(asset: StoredMediaAssetWithSession): string {
  if (asset.projectName && asset.projectName.trim().length > 0) return asset.projectName;
  const pathName = projectNameFromPath(asset.projectPath);
  if (pathName) return pathName;
  return asset.sessionTitle ? "无项目会话" : "未关联项目";
}

function mediaProjectKey(asset: StoredMediaAssetWithSession): string {
  if (asset.projectPath && asset.projectPath.trim().length > 0) return asset.projectPath;
  return asset.sessionTitle ? "__projectless__" : "__unlinked__";
}

function normalizeStartupStatus(status: StartupStatusResponse): StartupStatusResponse {
  return {
    ...status,
    plistPath: status.plistPath ?? status.path
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return normalized === "::1" || normalized.startsWith("127.");
}

function hostnameFromHostHeader(hostHeader: string | string[] | undefined): string {
  const rawHost = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const host = (rawHost ?? "").trim().toLowerCase();
  if (host.startsWith("[")) {
    const bracketEnd = host.indexOf("]");
    return bracketEnd > 0 ? host.slice(1, bracketEnd) : host;
  }
  return host.split(":")[0] ?? "";
}

function isLoopbackManagementHost(hostHeader: string | string[] | undefined): boolean {
  const hostname = hostnameFromHostHeader(hostHeader);
  if (hostname === "localhost" || hostname === "::1") return true;
  return net.isIP(hostname) === 4 && hostname.startsWith("127.");
}

function isLocalManagementRequest(request: FastifyRequest): boolean {
  return isLoopbackAddress(request.ip) && isLoopbackManagementHost(request.headers.host);
}

function isUnsupportedProjectRootPickerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes(PROJECT_ROOT_PICKER_UNSUPPORTED_ERROR) || message.includes("当前平台不支持访达目录选择器");
}

function sslVerificationHostname(hostHeader: string | string[] | undefined): string {
  const hostname = hostnameFromHostHeader(hostHeader);
  return hostname.length > 0 ? hostname : "localhost";
}

function isAdvertisableServiceUrl(value: string, expectedPort: number): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0") {
      return false;
    }
    const parsedPort = parsed.port.length > 0 ? Number(parsed.port) : 443;
    return parsedPort === expectedPort;
  } catch {
    return false;
  }
}

function serviceUrlPort(value: string, fallbackPort: number): number {
  try {
    const parsed = new URL(value);
    if (parsed.port.length > 0) {
      const port = Number(parsed.port);
      return Number.isFinite(port) && port > 0 ? port : fallbackPort;
    }
    return parsed.protocol === "https:" ? 443 : fallbackPort;
  } catch {
    return fallbackPort;
  }
}

function pushUniqueUrl(values: string[], value: string): void {
  if (value.length === 0 || values.includes(value)) {
    return;
  }
  values.push(value);
}

function prioritizeAdvertisedServiceUrls(preferredServiceUrl: string, fallbackServiceUrl: string, fallbackCandidates: string[], port: number) {
  const serviceUrl = isAdvertisableServiceUrl(preferredServiceUrl, port) ? preferredServiceUrl : fallbackServiceUrl;
  const candidateServiceUrls: string[] = [];
  pushUniqueUrl(candidateServiceUrls, serviceUrl);
  for (const candidate of fallbackCandidates) {
    pushUniqueUrl(candidateServiceUrls, candidate);
  }
  return { serviceUrl, candidateServiceUrls };
}

function parseJsonRequestBody(body: unknown): unknown {
  if (Buffer.isBuffer(body)) {
    return parseJsonTextBody(body.toString("utf8"), body);
  }
  if (typeof body === "string") {
    return parseJsonTextBody(body, body);
  }
  return body;
}

function parseJsonTextBody(text: string, fallback: unknown): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

function listMediaAssetsForWeb(context: AppContext, query: string) {
  const rows = context.repositories.mediaAssets.listForManagement(query);
  const assets = rows.map((asset) => ({
    ...context.mediaAssets.publicAsset(asset),
    sessionTitle: asset.sessionTitle,
    projectPath: asset.projectPath,
    projectName: asset.projectName
  }));
  const groups = new Map<string, {
    projectKey: string;
    projectPath: string | null;
    projectName: string;
    assetCount: number;
    totalSizeBytes: number;
    assets: typeof assets;
  }>();

  for (const asset of rows) {
    const key = mediaProjectKey(asset);
    let group = groups.get(key);
    if (!group) {
      group = {
        projectKey: key,
        projectPath: asset.projectPath,
        projectName: mediaProjectLabel(asset),
        assetCount: 0,
        totalSizeBytes: 0,
        assets: []
      };
      groups.set(key, group);
    }
    const publicAsset = {
      ...context.mediaAssets.publicAsset(asset),
      sessionTitle: asset.sessionTitle,
      projectPath: asset.projectPath,
      projectName: asset.projectName
    };
    group.assets.push(publicAsset);
    group.assetCount += 1;
    if (asset.status === "available") {
      group.totalSizeBytes += asset.sizeBytes;
    }
  }

  return {
    totalSizeBytes: context.repositories.mediaAssets.totalSizeBytes(),
    query,
    assets,
    projects: Array.from(groups.values())
  };
}

export async function createServer(context: AppContext = createAppContext(), options: CreateServerOptions = {}) {
  const chooseProjectRoot = options.chooseProjectRoot ?? chooseProjectRootWithSystemPicker;
  const app = fastify({ logger: true, https: context.tls, bodyLimit: 105 * 1024 * 1024 });

  await app.register(websocket);
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/", async (_request, reply) => {
    const html = await readFile(path.join(webRoot, "index.html"), "utf8");
    reply.type("text/html").send(html);
  });

  app.get("/web/main.js", async (_request, reply) => {
    const source = await readFile(path.join(webRoot, "main.js"), "utf8");
    reply.type("text/javascript").send(source);
  });

  app.get("/api/health", async (request) => {
    const serviceUrl = createServiceUrl({
      bindHost: context.config.host,
      hostHeader: request.headers.host,
      hostname: request.hostname,
      port: context.config.port
    });
    const certificateTrustStatus = await context.certificateTrust.checkLocalCertificateTrust({
      serverCertPath: context.transport.certPath,
      caCertPath: context.transport.caCertPath,
      caFingerprint: context.transport.caFingerprint,
      hostname: sslVerificationHostname(request.headers.host)
    });
    return {
      ok: true,
      product: "code",
      version: "v1",
      host: context.config.host,
      port: context.config.port,
      processId: process.pid,
      startedAt: context.serviceStartedAt,
      uptimeSeconds: serviceUptimeSeconds(context.serviceStartedAt),
      serviceUrl,
      macId: context.localMacId,
      candidateServiceUrls: createServiceUrlCandidates({
        bindHost: context.config.host,
        hostHeader: request.headers.host,
        hostname: request.hostname,
        port: context.config.port,
        localHostname: context.localMacName
      }),
      tlsFingerprint: context.transport.fingerprint,
      tlsPublicKeyHash: context.transport.publicKeyHash,
      certificateMode: context.transport.mode,
      caFingerprint: context.transport.caFingerprint,
      certificateTrustStatus,
      certificateSubjectAltNames: context.transport.subjectAltNames
    };
  });

  app.get("/api/codex-preflight", async () => context.codex.runPreflight());

  app.post("/api/certificate/trust", async (request, reply) => {
    if (request.headers["x-code-management-action"] !== CERTIFICATE_TRUST_MANAGEMENT_ACTION) {
      reply.code(400);
      return { errorCode: "BAD_REQUEST", message: "安装本地信任证书需要明确的管理页确认" };
    }
    if (!isLocalManagementRequest(request)) {
      reply.code(403);
      return {
        errorCode: "LOCAL_MANAGEMENT_ONLY",
        message: "安装本地信任证书只能在本机 localhost 或 127.0.0.1 管理页执行"
      };
    }

    try {
      const result = await context.certificateTrust.trustLocalCertificate({
        caCertPath: context.transport.caCertPath,
        caFingerprint: context.transport.caFingerprint
      });
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "certificate.trust",
        result: result.trusted ? "success" : "failed",
        detail: result.message
      });
      return {
        ...result,
        caCertPath: context.transport.caCertPath,
        caFingerprint: context.transport.caFingerprint
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "本地信任证书安装失败";
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "certificate.trust",
        result: "failed",
        detail: message
      });
      reply.code(500);
      return { errorCode: "CERTIFICATE_TRUST_FAILED", message };
    }
  });

  app.get("/api/startup", async () => normalizeStartupStatus(await context.startup.status()));

  app.put("/api/startup", async (request, reply) => {
    const body = StartupBodySchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { errorCode: "BAD_REQUEST", message: "开机自启动设置格式错误" };
    }

    try {
      const result = normalizeStartupStatus(await context.startup.setEnabled(body.data.enabled));
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "startup.update",
        result: "success",
        detail: body.data.enabled ? "已开启桌面端服务开机登录后自启动" : "已关闭桌面端服务开机登录后自启动"
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "开机自启动设置失败";
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "startup.update",
        result: "failed",
        detail: message
      });
      reply.code(500);
      return { errorCode: "STARTUP_UPDATE_FAILED", message };
    }
  });

  app.get("/api/project-roots", async () => ({
    roots: webProjectRoots(context)
  }));

  app.post("/api/project-roots", async (request, reply) => {
    const body = ProjectRootBodySchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { errorCode: "BAD_REQUEST", message: "项目根目录不能为空" };
    }
    try {
      const roots = context.projects.addRoot({ rootPath: body.data.path });
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "projectRoots.add",
        result: "success",
        detail: `已添加项目根目录 ${path.resolve(body.data.path)}`
      });
      return { ok: true, roots: withStaticRootFlags(context, roots) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "项目根目录添加失败";
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "projectRoots.add",
        result: "failed",
        detail: message
      });
      reply.code(400);
      return { errorCode: "PROJECT_ROOT_INVALID", message };
    }
  });

  app.post("/api/project-roots/choose", async (_request, reply) => {
    let selectedPath: string | null;
    try {
      selectedPath = await chooseProjectRoot();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法打开系统目录选择器";
      if (isUnsupportedProjectRootPickerError(error)) {
        context.audit.record({
          deviceId: null,
          sessionId: null,
          actionType: "projectRoots.choose",
          result: "failed",
          detail: PROJECT_ROOT_PICKER_UNSUPPORTED_MESSAGE
        });
        return {
          ok: false,
          cancelled: false,
          unsupported: true,
          message: PROJECT_ROOT_PICKER_UNSUPPORTED_MESSAGE,
          roots: webProjectRoots(context)
        };
      }
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "projectRoots.choose",
        result: "failed",
        detail: message
      });
      reply.code(500);
      return { errorCode: "PROJECT_ROOT_PICKER_FAILED", message };
    }

    if (!selectedPath) {
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "projectRoots.choose",
        result: "success",
        detail: "用户取消选择项目根目录"
      });
      return { ok: false, cancelled: true, roots: webProjectRoots(context) };
    }

    try {
      const roots = context.projects.addRoot({ rootPath: selectedPath });
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "projectRoots.add",
        result: "success",
        detail: `已通过系统目录选择器添加项目根目录 ${path.resolve(selectedPath)}`
      });
      return { ok: true, cancelled: false, roots: withStaticRootFlags(context, roots) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "项目根目录添加失败";
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "projectRoots.add",
        result: "failed",
        detail: message
      });
      reply.code(400);
      return { errorCode: "PROJECT_ROOT_INVALID", message };
    }
  });

  app.delete("/api/project-roots/:rootId", async (request, reply) => {
    const params = request.params as { rootId: string };
    try {
      const roots = context.projects.removeRoot(params.rootId);
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "projectRoots.remove",
        result: "success",
        detail: `已移除项目根目录 ${params.rootId}`
      });
      return { ok: true, roots: withStaticRootFlags(context, roots) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "项目根目录移除失败";
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "projectRoots.remove",
        result: "failed",
        detail: message
      });
      reply.code(400);
      return { errorCode: "PROJECT_ROOT_REMOVE_FAILED", message };
    }
  });

  app.get("/api/audit-logs", async () => ({
    logs: context.audit.list().map((log) => {
      const row = log as {
        id: string;
        created_at: string;
        device_id: string | null;
        session_id: string | null;
        action_type: string;
        result: string;
        detail: string;
      };
      return {
        id: row.id,
        createdAt: row.created_at,
        deviceId: row.device_id,
        sessionId: row.session_id,
        actionType: row.action_type,
        result: row.result,
        detail: row.detail
      };
    })
  }));

  app.get("/api/devices", async () => ({
    devices: context.pairing.listDevices().filter(isDeviceVisible).map((device) => ({
      id: device.id,
      deviceName: device.deviceName,
      createdAt: device.createdAt,
      expiresAt: device.expiresAt,
      revokedAt: device.revokedAt
    }))
  }));

  app.post("/api/pairing-ticket", async (request) => {
    const code = context.pairing.createPairingCode(context.localMacName);
    const body = PairingTicketBodySchema.safeParse(parseJsonRequestBody(request.body));
    const preferredServiceUrl = body.success ? body.data.preferredServiceUrl ?? "" : "";
    const fallbackServiceUrl = createServiceUrl({
      bindHost: context.config.host,
      hostHeader: request.headers.host,
      hostname: request.hostname,
      port: context.config.port
    });
    const fallbackCandidateServiceUrls = createServiceUrlCandidates({
      bindHost: context.config.host,
      hostHeader: request.headers.host,
      hostname: request.hostname,
      port: context.config.port
    });
    const advertised = prioritizeAdvertisedServiceUrls(
      preferredServiceUrl,
      fallbackServiceUrl,
      fallbackCandidateServiceUrls,
      serviceUrlPort(fallbackServiceUrl, context.config.port)
    );
    const payload = createPairingPayload({
      serviceUrl: advertised.serviceUrl,
      candidateServiceUrls: advertised.candidateServiceUrls,
      macId: context.localMacId,
      macName: code.macName,
      tlsFingerprint: context.transport.fingerprint,
      tlsPublicKeyHash: context.transport.publicKeyHash,
      code
    });
    const qrPayload = JSON.stringify(payload);
    return {
      value: code.value,
      expiresAt: code.expiresAt,
      issuedAt: new Date().toISOString(),
      serverStartedAt: context.serviceStartedAt,
      serviceUrl: advertised.serviceUrl,
      candidateServiceUrls: advertised.candidateServiceUrls,
      tlsFingerprint: context.transport.fingerprint,
      tlsPublicKeyHash: context.transport.publicKeyHash,
      qrPayload,
      qrPngDataUrl: await QRCode.toDataURL(qrPayload)
    };
  });

  app.post("/api/pairing-claim", async (request, reply) => {
    const body = PairingClaimBodySchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { errorCode: "BAD_REQUEST", message: "请求格式错误" };
    }

    try {
      const claimed = context.pairing.claimPairingCode(body.data.pairingCode, body.data.deviceName);
      for (const replacedDeviceId of claimed.replacedDeviceIds) {
        context.audit.record({
          deviceId: replacedDeviceId,
          sessionId: null,
          actionType: "device.revoke",
          result: "success",
          detail: "设备重新配对，旧授权已自动撤销"
        });
      }
      context.audit.record({
        deviceId: claimed.device.id,
        sessionId: null,
        actionType: "pairing.claim",
        result: "success",
        detail: "设备完成配对"
      });
      return claimed;
    } catch (error) {
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "pairing.claim",
        result: "failed",
        detail: "设备配对失败，deviceName=" + body.data.deviceName + "，reason=" + (error instanceof Error ? error.message : "配对码无效或已过期")
      });
      reply.code(400);
      return { errorCode: "PAIRING_INVALID", message: error instanceof Error ? error.message : "配对码无效或已过期" };
    }
  });

  app.post("/api/assets/prepare", async (request, reply) => {
    const device = requirePairedDevice(context, request, reply);
    if (!device) return;
    const body = PrepareAssetBodySchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { errorCode: "BAD_REQUEST", message: "请求格式错误" };
    }
    try {
      const prepared = context.mediaAssets.prepareMobileUpload(body.data);
      context.audit.record({
        deviceId: device.id,
        sessionId: body.data.sessionId,
        actionType: "media.prepare",
        result: "success",
        detail: `媒体上传已准备，assetId=${prepared.asset.id}，kind=${prepared.asset.kind}，sizeBytes=${prepared.asset.sizeBytes}`
      });
      return {
        assetId: prepared.asset.id,
        uploadUrl: prepared.uploadUrl,
        asset: prepared.asset
      };
    } catch (error) {
      context.audit.record({
        deviceId: device.id,
        sessionId: body.data.sessionId,
        actionType: "media.prepare",
        result: "failed",
        detail: error instanceof Error ? error.message : "媒体上传准备失败"
      });
      reply.code(error instanceof MediaAssetError && error.code === "MEDIA_ASSET_REJECTED" ? 400 : 500);
      return mediaAssetErrorBody(error);
    }
  });

  app.put("/api/assets/:assetId/content", async (request, reply) => {
    const device = requirePairedDevice(context, request, reply);
    if (!device) return;
    const params = request.params as { assetId: string };
    const body = requestBodyBuffer(request.body);
    const contentLength = readContentLength(request);
    try {
      const asset = await context.mediaAssets.storeUploadedContent(params.assetId, body, contentLength);
      const attachment = createUploadedAttachment(context, {
        sessionId: asset.sessionId,
        assetId: asset.id
      });
      context.audit.record({
        deviceId: device.id,
        sessionId: asset.sessionId,
        actionType: "media.upload",
        result: "success",
        detail: `媒体上传完成，assetId=${asset.id}，kind=${asset.kind}，sizeBytes=${asset.sizeBytes}`
      });
      return {
        asset,
        attachment,
        assets: context.mediaAssets.listSessionAssets(asset.sessionId),
        attachments: context.repositories.sessionAttachments.listBySession(asset.sessionId)
      };
    } catch (error) {
      context.audit.record({
        deviceId: device.id,
        sessionId: null,
        actionType: "media.upload",
        result: "failed",
        detail: error instanceof Error ? error.message : "媒体上传失败"
      });
      reply.code(mediaAssetStatusCode(error));
      return mediaAssetErrorBody(error);
    }
  });

  app.get("/api/assets/:assetId/content", async (request, reply) => {
    const device = requirePairedDevice(context, request, reply);
    if (!device) return;
    const params = request.params as { assetId: string };
    try {
      const result = await context.mediaAssets.readAssetContent(params.assetId);
      context.audit.record({
        deviceId: device.id,
        sessionId: result.asset.sessionId,
        actionType: "media.download",
        result: "success",
        detail: `媒体下载成功，assetId=${result.asset.id}`
      });
      reply.type(result.asset.mimeType);
      return result.content;
    } catch (error) {
      context.audit.record({
        deviceId: device.id,
        sessionId: null,
        actionType: "media.download",
        result: "failed",
        detail: error instanceof Error ? error.message : "媒体下载失败"
      });
      reply.code(mediaAssetStatusCode(error));
      return mediaAssetErrorBody(error);
    }
  });

  app.get("/api/sessions/:sessionId/assets", async (request, reply) => {
    const device = requirePairedDevice(context, request, reply);
    if (!device) return;
    const params = request.params as { sessionId: string };
    return { assets: context.mediaAssets.listSessionAssets(params.sessionId) };
  });

  app.get("/api/sessions/:sessionId/attachments", async (request, reply) => {
    const device = requirePairedDevice(context, request, reply);
    if (!device) return;
    const params = request.params as { sessionId: string };
    return { attachments: context.repositories.sessionAttachments.listBySession(params.sessionId) };
  });

  app.post("/api/sessions/:sessionId/file-reference-assets", async (request, reply) => {
    const device = requirePairedDevice(context, request, reply);
    if (!device) return;
    const params = request.params as { sessionId: string };
    const body = FileReferenceAssetBodySchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { errorCode: "BAD_REQUEST", message: "请求格式错误" };
    }
    const session = context.sessions.get(params.sessionId);
    if (!session) {
      reply.code(404);
      return { errorCode: "MEDIA_ASSET_NOT_FOUND", message: "会话不存在或尚未同步" };
    }
    if (!session.projectPath || session.projectPath.trim().length === 0) {
      reply.code(400);
      return { errorCode: "MEDIA_ASSET_REJECTED", message: "只能同步当前会话项目目录内的文件" };
    }
    if (!(await isPathInsideRoot(body.data.path, session.projectPath))) {
      reply.code(400);
      return { errorCode: "MEDIA_ASSET_REJECTED", message: "只能同步当前会话项目目录内的文件" };
    }
    try {
      const asset = await context.mediaAssets.storeMacFileReferenceAsset({
        sessionId: params.sessionId,
        filePath: body.data.path,
        fileName: body.data.fileName
      });
      const attachment = createMacArtifactAttachment(context, {
        sessionId: asset.sessionId,
        assetId: asset.id
      });
      context.audit.record({
        deviceId: device.id,
        sessionId: asset.sessionId,
        actionType: "media.macFileReference",
        result: "success",
        detail: `桌面端文件引用已按需同步，assetId=${asset.id}，kind=${asset.kind}，sizeBytes=${asset.sizeBytes}`
      });
      return {
        asset,
        attachment,
        assets: context.mediaAssets.listSessionAssets(asset.sessionId),
        attachments: context.repositories.sessionAttachments.listBySession(asset.sessionId)
      };
    } catch (error) {
      context.audit.record({
        deviceId: device.id,
        sessionId: params.sessionId,
        actionType: "media.macFileReference",
        result: "failed",
        detail: error instanceof Error ? error.message : "桌面端文件引用同步失败"
      });
      reply.code(mediaAssetStatusCode(error));
      return mediaAssetErrorBody(error);
    }
  });

  app.get("/api/media-assets", async (request) => {
    const rawQuery = (request.query as { query?: unknown }).query;
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    return listMediaAssetsForWeb(context, query);
  });

  app.delete("/api/media-assets", async (request, reply) => {
    const body = ClearMediaAssetsBodySchema.safeParse(request.body);
    if (!body.success) {
      reply.code(400);
      return { errorCode: "BAD_REQUEST", message: "请选择要清理的媒体文件" };
    }
    const assetIds = Array.from(new Set(body.data.assetIds));
    try {
      const deleted: PublicMediaAsset[] = [];
      for (const assetId of assetIds) {
        deleted.push(await context.mediaAssets.deleteAsset(assetId));
      }
      for (const asset of deleted) {
        context.repositories.sessionAttachments.deleteByAssetId(asset.id);
      }
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "media.clearAll",
        result: "success",
        detail: `已批量清理媒体资产 ${deleted.length} 条`
      });
      return {
        ok: true,
        deletedCount: deleted.length,
        ...listMediaAssetsForWeb(context, "")
      };
    } catch (error) {
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "media.clearAll",
        result: "failed",
        detail: error instanceof Error ? error.message : "批量清理媒体资产失败"
      });
      reply.code(mediaAssetStatusCode(error));
      return mediaAssetErrorBody(error);
    }
  });

  app.delete("/api/media-assets/:assetId", async (request, reply) => {
    const params = request.params as { assetId: string };
    try {
      const deleted = await context.mediaAssets.deleteAsset(params.assetId);
      context.repositories.sessionAttachments.deleteByAssetId(deleted.id);
      context.audit.record({
        deviceId: null,
        sessionId: deleted.sessionId,
        actionType: "media.clear",
        result: "success",
        detail: `已清理媒体资产 ${deleted.id}，fileName=${deleted.fileName}`
      });
      return {
        ok: true,
        deletedCount: 1,
        assetId: deleted.id,
        ...listMediaAssetsForWeb(context, "")
      };
    } catch (error) {
      context.audit.record({
        deviceId: null,
        sessionId: null,
        actionType: "media.clear",
        result: "failed",
        detail: error instanceof Error ? error.message : "清理媒体资产失败"
      });
      reply.code(mediaAssetStatusCode(error));
      return mediaAssetErrorBody(error);
    }
  });

  app.get("/api/local-web-sessions", async () => ({
    sessions: context.repositories.localWebSessions.listActive()
  }));

  app.post("/api/media-assets/cleanup", async () => {
    const nowIso = new Date().toISOString();
    const deletedCount = context.repositories.mediaAssets.deleteExpired(nowIso);
    context.audit.record({
      deviceId: null,
      sessionId: null,
      actionType: "media.cleanup",
      result: "success",
      detail: `已清理过期媒体资产 ${deletedCount} 条`
    });
    return { ok: true, deletedCount };
  });

  app.post("/api/local-web-sessions/:localWebSessionId/close", async (request, reply) => {
    const params = request.params as { localWebSessionId: string };
    const existing = context.repositories.localWebSessions.get(params.localWebSessionId);
    if (!existing) {
      reply.code(404);
      return { errorCode: "LOCAL_WEB_SESSION_NOT_FOUND", message: "本地 Web 会话不存在" };
    }
    context.repositories.localWebSessions.updateStatus({
      id: params.localWebSessionId,
      status: "closed",
      updatedAt: new Date().toISOString(),
      error: ""
    });
    context.audit.record({
      deviceId: null,
      sessionId: existing.sessionId,
      actionType: "localWeb.close",
      result: "success",
      detail: `桌面端 Web 已关闭本地 Web 代理 ${params.localWebSessionId}`
    });
    return { ok: true, session: context.repositories.localWebSessions.get(params.localWebSessionId) };
  });

  app.route({
    method: "GET",
    url: "/local-web/:localWebSessionId/*",
    handler: localWebHttpHandler,
    wsHandler: (socket, request) => {
      handleLocalWebWebSocket(context, socket, request);
    }
  });

  app.route({
    method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/local-web/:localWebSessionId/*",
    handler: localWebHttpHandler
  });

  async function localWebHttpHandler(request: FastifyRequest, reply: FastifyReply) {
    const device = requirePairedDevice(context, request, reply);
    if (!device) return;
    const params = request.params as { localWebSessionId: string; "*": string };
    try {
      const result = await context.localWebProxy.proxyRequest(request, params.localWebSessionId, params["*"] ?? "");
      reply.code(result.statusCode);
      for (const [name, value] of Object.entries(result.headers)) {
        reply.header(name, value);
      }
      return result.body;
    } catch (error) {
      const statusCode = error instanceof LocalWebProxyError && error.code === "LOCAL_WEB_SESSION_NOT_FOUND" ? 404 : 502;
      const body = {
        errorCode: error instanceof LocalWebProxyError ? error.code : "LOCAL_WEB_PROXY_FAILED",
        message: error instanceof Error ? error.message : "本地 Web 代理失败"
      };
      reply.code(statusCode);
      if (shouldRenderLocalWebHtmlError(request)) {
        reply.header("content-type", "text/html; charset=utf-8");
        return localWebErrorHtml(statusCode, body.errorCode, body.message, localWebErrorLanguage(request));
      }
      return body;
    }
  }

  app.post("/api/devices/:deviceId/revoke", async (request) => {
    const params = request.params as { deviceId: string };
    context.pairing.revokeDevice(params.deviceId);
    context.audit.record({
      deviceId: params.deviceId,
      sessionId: null,
      actionType: "device.revoke",
      result: "success",
      detail: "设备授权已撤销"
    });
    return { ok: true };
  });

  registerWsServer(app, context);
  return app;
}

function configuredStaticRootPaths(context: AppContext): string[] {
  const result: string[] = [];
  for (const root of context.config.projectRoots) {
    const trimmed = root.trim();
    if (trimmed.length === 0) continue;
    const resolved = path.resolve(trimmed);
    if (!result.includes(resolved)) result.push(resolved);
  }
  return result;
}

function withStaticRootFlags(context: AppContext, roots: ReturnType<AppContext["projects"]["listRoots"]>) {
  const staticRoots = configuredStaticRootPaths(context);
  return roots.map((root) => ({
    ...root,
    isStatic: staticRoots.includes(path.resolve(root.path))
  }));
}

function webProjectRoots(context: AppContext) {
  return withStaticRootFlags(context, context.projects.listRoots());
}

export async function chooseProjectRootWithSystemPicker(options: {
  platform?: ProjectRootPickerPlatform;
  run?: ProjectRootPickerRunner;
} = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? execFileAsync;
  if (platform === "darwin") {
    return chooseProjectRootWithFinder(run);
  }
  if (platform === "win32") {
    return chooseProjectRootWithWindowsFolderDialog(run);
  }
  throw new Error(PROJECT_ROOT_PICKER_UNSUPPORTED_ERROR);
}

async function chooseProjectRootWithFinder(run: ProjectRootPickerRunner): Promise<string | null> {
  const script = `POSIX path of (choose folder with prompt "${PROJECT_ROOT_PICKER_PROMPT}")`;
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-e", script], {
      timeout: 120_000,
      maxBuffer: 8 * 1024
    });
    const selectedPath = commandOutputText(stdout).trim();
    return selectedPath.length > 0 ? selectedPath : null;
  } catch (error) {
    const message = commandErrorMessage(error);
    if (message.includes("User canceled") || message.includes("-128")) {
      return null;
    }
    throw new Error(`无法打开访达目录选择器：${message || "未知错误"}`);
  }
}

async function chooseProjectRootWithWindowsFolderDialog(run: ProjectRootPickerRunner): Promise<string | null> {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    "$shell = New-Object -ComObject Shell.Application",
    "$options = 0x00000051",
    `$folder = $shell.BrowseForFolder(0, '${PROJECT_ROOT_PICKER_PROMPT}', $options, 0)`,
    "if ($null -ne $folder -and $null -ne $folder.Self -and -not [string]::IsNullOrWhiteSpace($folder.Self.Path)) {",
    "  Write-Output $folder.Self.Path",
    "} else {",
    `  Write-Output '${WINDOWS_PROJECT_ROOT_PICKER_CANCELLED}'`,
    "}"
  ].join("\n");
  try {
    const { stdout } = await run("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      powershellEncodedCommand(script)
    ], {
      timeout: 120_000,
      maxBuffer: 16 * 1024,
      windowsHide: false
    });
    const selectedPath = commandOutputText(stdout).trim();
    if (selectedPath.length === 0 || selectedPath === WINDOWS_PROJECT_ROOT_PICKER_CANCELLED) {
      return null;
    }
    return selectedPath;
  } catch (error) {
    const message = commandErrorMessage(error);
    throw new Error(`无法打开 Windows 目录选择器：${message || "未知错误"}`);
  }
}

function powershellEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function commandOutputText(value: string | Buffer | undefined): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function commandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const parts: string[] = [];
  const maybeError = error as { message?: unknown; stderr?: unknown; stdout?: unknown; code?: unknown };
  for (const value of [maybeError.message, maybeError.stderr, maybeError.stdout, maybeError.code]) {
    if (typeof value === "string" && value.trim().length > 0) parts.push(value.trim());
    if (typeof value === "number") parts.push(String(value));
  }
  return parts.join("\n");
}

function requirePairedDevice(
  context: AppContext,
  request: FastifyRequest,
  reply: FastifyReply
): PairedDevice | null {
  const token = request.headers.authorization?.replace("Bearer ", "") ?? readCookieToken(request.headers.cookie);
  const device = context.pairing.validateToken(token);
  if (!device) {
    reply.code(401).send({ errorCode: "AUTH_INVALID", message: "授权失效，请重新配对" });
    return null;
  }
  return device;
}

function readCookieToken(cookieHeader: string | undefined): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("code_auth=")) continue;
    const rawValue = trimmed.slice("code_auth=".length);
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return "";
}

function handleLocalWebWebSocket(context: AppContext, socket: {
  send(value: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (value: Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: () => void): void;
}, request: FastifyRequest): void {
  const headerToken = request.headers.authorization?.replace("Bearer ", "") ?? readCookieToken(request.headers.cookie);
  const token = headerToken.length > 0 ? headerToken : readQueryToken(request.url);
  const device = context.pairing.validateToken(token);
  if (!device) {
    socket.close(1008, "AUTH_INVALID");
    return;
  }
  const params = request.params as { localWebSessionId: string; "*": string };
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(localWebWebSocketTargetUrl(context, params.localWebSessionId, params["*"] ?? "", stripLocalWebAuthQuery(request.url)));
  } catch {
    socket.close(1011, "LOCAL_WEB_TARGET_INVALID");
    return;
  }

  const pending: Buffer[] = [];
  let downstreamClosed = false;
  let upstreamClosed = false;
  upstream.binaryType = "arraybuffer";
  upstream.addEventListener("open", () => {
    while (pending.length > 0 && upstream.readyState === WebSocket.OPEN) {
      const next = pending.shift();
      if (next) upstream.send(next);
    }
  });
  upstream.addEventListener("message", (event) => {
    sendWebSocketMessage(socket, event.data);
  });
  upstream.addEventListener("close", () => {
    upstreamClosed = true;
    if (!downstreamClosed) socket.close();
  });
  upstream.addEventListener("error", () => {
    if (!downstreamClosed) socket.close(1011, "LOCAL_WEB_UPSTREAM_ERROR");
  });
  socket.on("message", (value) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(value);
      return;
    }
    pending.push(value);
  });
  socket.on("close", () => {
    downstreamClosed = true;
    if (!upstreamClosed && upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
  });
  socket.on("error", () => {
    downstreamClosed = true;
    if (!upstreamClosed && upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
  });
}

function readQueryToken(requestUrl: string): string {
  try {
    return new URL(requestUrl, "https://code.local").searchParams.get("code_auth") ?? "";
  } catch {
    return "";
  }
}

function stripLocalWebAuthQuery(requestUrl: string): string {
  try {
    const parsed = new URL(requestUrl, "https://code.local");
    parsed.searchParams.delete("code_auth");
    return parsed.pathname + parsed.search;
  } catch {
    return requestUrl;
  }
}

function sendWebSocketMessage(socket: { send(value: string | Buffer): void }, value: unknown): void {
  if (typeof value === "string") {
    socket.send(value);
    return;
  }
  if (value instanceof ArrayBuffer) {
    socket.send(Buffer.from(value));
    return;
  }
  if (ArrayBuffer.isView(value)) {
    socket.send(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
}

function localWebWebSocketTargetUrl(context: AppContext, localWebSessionId: string, forwardedPath: string, requestUrl: string): string {
  const session = context.repositories.localWebSessions.get(localWebSessionId);
  if (!session || session.status !== "active") {
    throw new LocalWebProxyError("LOCAL_WEB_SESSION_NOT_FOUND", "本地 Web 会话不存在或已关闭");
  }
  const targetUrl = localWebTargetUrl(session.targetUrl, forwardedPath, requestUrl);
  const target = new URL(targetUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.href;
}

function localWebTargetUrl(sessionTargetUrl: string, forwardedPath: string, requestUrl: string): string {
  const targetBase = new URL(sessionTargetUrl);
  if (forwardedPath.length === 0) {
    return targetBase.href;
  }
  const target = new URL(forwardedPath, targetBase.href.endsWith("/") ? targetBase.href : new URL(".", targetBase.href).href);
  const queryStart = requestUrl.indexOf("?");
  if (queryStart >= 0) {
    target.search = requestUrl.slice(queryStart);
  }
  return target.href;
}

function readContentLength(request: FastifyRequest): number | null {
  const value = request.headers["content-length"];
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requestBodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from("");
}

function createUploadedAttachment(
  context: AppContext,
  input: { sessionId: string; assetId: string }
): StoredSessionAttachment {
  return context.repositories.sessionAttachments.insert({
    id: `attachment-${input.assetId}`,
    sessionId: input.sessionId,
    assetId: input.assetId,
    role: "userUpload",
    codexInputStatus: "pending",
    codexInputMessage: "附件已上传，待发送给 Codex",
    createdAt: new Date().toISOString()
  });
}

function createMacArtifactAttachment(
  context: AppContext,
  input: { sessionId: string; assetId: string }
): StoredSessionAttachment {
  return context.repositories.sessionAttachments.insert({
    id: `attachment-${input.assetId}`,
    sessionId: input.sessionId,
    assetId: input.assetId,
    role: "macArtifact",
    codexInputStatus: "notRequired",
    codexInputMessage: "桌面端文件产物已保存",
    createdAt: new Date().toISOString()
  });
}

async function isPathInsideRoot(candidatePath: string, rootPath: string): Promise<boolean> {
  try {
    const resolvedCandidate = await realpath(path.resolve(candidatePath));
    const resolvedRoot = await realpath(path.resolve(rootPath));
    return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
  } catch {
    return false;
  }
}

function mediaAssetStatusCode(error: unknown): number {
  if (!(error instanceof MediaAssetError)) return 500;
  if (error.code === "MEDIA_ASSET_NOT_FOUND") return 404;
  if (error.code === "MEDIA_ASSET_EXPIRED") return 410;
  if (error.code === "MEDIA_ASSET_REJECTED" || error.code === "MEDIA_ASSET_SIZE_MISMATCH" || error.code === "MEDIA_ASSET_STATE_INVALID") {
    return 400;
  }
  return 409;
}

function shouldRenderLocalWebHtmlError(request: FastifyRequest): boolean {
  if (request.method !== "GET") {
    return false;
  }
  if (hasLocalWebPreviewLanguage(request)) {
    return true;
  }
  const accept = String(request.headers.accept ?? "");
  return accept.length === 0 || accept.includes("text/html") || accept.includes("*/*");
}

function hasLocalWebPreviewLanguage(request: FastifyRequest): boolean {
  return localWebPreviewLanguageValue(request).length > 0;
}

function localWebErrorLanguage(request: FastifyRequest): LocalWebErrorLanguage {
  return localWebPreviewLanguageValue(request) === "en" ? "en" : "zh";
}

function localWebPreviewLanguageValue(request: FastifyRequest): string {
  try {
    const url = new URL(request.url, "https://code.local");
    return url.searchParams.get(LOCAL_WEB_PREVIEW_LANGUAGE_QUERY) ?? "";
  } catch {
    return "";
  }
}

function localWebErrorHtml(statusCode: number, errorCode: string, message: string, language: LocalWebErrorLanguage = "zh"): string {
  const title = localWebErrorTitle(errorCode, language);
  const detail = localWebErrorDetail(errorCode, message, language);
  const htmlLang = language === "en" ? "en" : "zh-CN";
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;background:#f8fafc}
    main{padding:28px 22px}
    h1{font-size:22px;line-height:1.25;margin:0 0 10px}
    p{font-size:15px;line-height:1.6;color:#4b5563;margin:0 0 14px}
    code{display:inline-block;font-size:12px;color:#64748b;background:#eef2f7;border-radius:6px;padding:4px 7px}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
    <code>${statusCode} · ${escapeHtml(errorCode)}</code>
  </main>
</body>
</html>`;
}

function localWebErrorTitle(errorCode: string, language: LocalWebErrorLanguage): string {
  if (errorCode === "LOCAL_WEB_TARGET_UNAVAILABLE") {
    if (language === "en") {
      return "Local Web target unavailable";
    }
    return "本地 Web 目标不可访问";
  }
  if (errorCode === "LOCAL_WEB_SESSION_NOT_FOUND") {
    if (language === "en") {
      return "Local Web session expired";
    }
    return "本地 Web 会话已失效";
  }
  if (errorCode === "LOCAL_WEB_UPGRADE_UNSUPPORTED") {
    if (language === "en") {
      return "Realtime connection unsupported";
    }
    return "暂不支持该实时连接";
  }
  if (language === "en") {
    return "Local Web failed to open";
  }
  return "本地 Web 打开失败";
}

function localWebErrorDetail(errorCode: string, message: string, language: LocalWebErrorLanguage): string {
  if (errorCode === "LOCAL_WEB_TARGET_UNAVAILABLE") {
    if (language === "en") {
      return "The desktop service received the request, but the target address did not respond. Check that the local dev server is running, the port is correct, and the service is not bound only to another address.";
    }
    return "桌面端服务已经收到打开请求，但目标地址没有响应。请确认本地 dev server 已启动、端口正确，并且不是只对其他地址开放。";
  }
  if (errorCode === "LOCAL_WEB_SESSION_NOT_FOUND") {
    if (language === "en") {
      return "This web proxy session does not exist or has been closed. Go back and open it again.";
    }
    return "这个网页代理会话不存在或已关闭，请返回后重新打开。";
  }
  if (errorCode === "LOCAL_WEB_UPGRADE_UNSUPPORTED") {
    if (language === "en") {
      return "This page requested a direct WebSocket/HMR connection. Mobile preview currently supports regular HTTP pages only.";
    }
    return "当前页面请求 WebSocket/HMR 直连，移动端暂时只能打开普通 HTTP 页面。";
  }
  if (language === "en") {
    return message.length > 0 ? message : "The desktop service did not return a more specific failure reason.";
  }
  return message.length > 0 ? message : "桌面端服务没有返回更具体的失败原因。";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mediaAssetErrorBody(error: unknown): { errorCode: string; message: string } {
  if (error instanceof MediaAssetError) {
    return { errorCode: error.code, message: error.message };
  }
  return { errorCode: "MEDIA_ASSET_FAILED", message: error instanceof Error ? error.message : "媒体资产处理失败" };
}
