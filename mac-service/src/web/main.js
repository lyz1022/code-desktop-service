let latestPairingCode = "";
let latestPairingPayload = "";
let latestPairingExpiresAtMs = 0;
let latestPairingServiceUrl = "";
let latestServiceUrl = "";
let latestCaFingerprint = "";
let latestServiceStartedAtMs = 0;
let pairingTimer = 0;
let serviceUptimeTimer = 0;
let toastTimer = 0;
let mediaSearchTimer = 0;
let mediaSelectionMode = false;
let latestMediaProjects = [];
const selectedMediaAssetIds = new Set();

function byId(id) {
  return document.getElementById(id);
}

function text(id, value) {
  const target = byId(id);
  if (target) target.textContent = value;
}

function fingerprintPreview(value) {
  if (!value || value.length <= 16) return value || "未知";
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function certificateModeLabel(value) {
  return value === "local-ca" ? "本机 CA" : "自签名";
}

function setTrustCertificateStatus(label, fullMessage) {
  const target = byId("certificate-trust-status");
  if (!target) return;
  target.textContent = label;
  if (typeof target.setAttribute === "function") {
    target.setAttribute("title", fullMessage || label);
  }
}

function isLocalTrustHostname() {
  const hostname = String(window.location.hostname || "").trim().toLowerCase();
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname.startsWith("127.");
}

function updateTrustCertificateControl(caFingerprint, trustStatus = null) {
  latestCaFingerprint = caFingerprint || "";
  const trustCertificate = byId("trust-certificate");
  const isLocal = isLocalTrustHostname();
  const isTrusted = Boolean(isLocal && trustStatus && trustStatus.trusted === true);
  if (trustCertificate && "disabled" in trustCertificate) {
    trustCertificate.disabled = !latestCaFingerprint || !isLocal || isTrusted;
  }
  if (!latestCaFingerprint) {
    setTrustCertificateStatus("等待本机 CA", "等待生成本机 CA 后可安装信任。");
    return;
  }
  if (isTrusted) {
    setTrustCertificateStatus("本机已信任", "当前用户已信任 code 本地开发 CA。浏览器重新加载后会重新校验证书。");
    return;
  }
  setTrustCertificateStatus(
    isLocal ? "本机可安装信任" : "请回到本机安装",
    isLocal ? "当前为本机管理页，可安装当前用户信任。" : "请在本机 localhost 或 127.0.0.1 管理页安装信任。"
  );
}

function formatTime(value) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function serviceAddressPreview(serviceUrl) {
  try {
    const url = new URL(serviceUrl);
    return url.host;
  } catch {
    return serviceUrl || "";
  }
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds - hours * 3600) / 60);
  const remainingSeconds = safeSeconds - hours * 3600 - minutes * 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function serviceStartedAtMsFromHealth(startedAt, uptimeSeconds) {
  const parsed = Date.parse(startedAt);
  if (Number.isFinite(parsed)) return parsed;
  const fallbackSeconds = Number(uptimeSeconds);
  if (!Number.isFinite(fallbackSeconds)) return 0;
  return Date.now() - Math.max(0, Math.floor(fallbackSeconds)) * 1000;
}

function clearServiceUptimeTicker() {
  if (serviceUptimeTimer !== 0) {
    window.clearInterval(serviceUptimeTimer);
    serviceUptimeTimer = 0;
  }
  latestServiceStartedAtMs = 0;
}

function updateServiceUptime() {
  if (latestServiceStartedAtMs <= 0) return;
  text("service-uptime", formatDuration((Date.now() - latestServiceStartedAtMs) / 1000));
}

function startServiceUptimeTicker(startedAt, uptimeSeconds) {
  const startedAtMs = serviceStartedAtMsFromHealth(startedAt, uptimeSeconds);
  clearServiceUptimeTicker();
  if (startedAtMs <= 0) {
    text("service-uptime", "未知");
    return;
  }
  latestServiceStartedAtMs = startedAtMs;
  updateServiceUptime();
  serviceUptimeTimer = window.setInterval(updateServiceUptime, 1000);
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

function pairingPayloadServiceUrl(payloadText) {
  try {
    const payload = JSON.parse(payloadText);
    return typeof payload.serviceUrl === "string" ? payload.serviceUrl : "";
  } catch {
    return "";
  }
}

function setCopyEnabled(enabled) {
  const copy = byId("copy-code");
  if (copy instanceof HTMLButtonElement) copy.disabled = !enabled;
}

function setQrExpiredState(expired) {
  const frame = document.querySelector(".qr-frame");
  if (frame) frame.classList.toggle("expired", expired);
}

function clearPairingTimer() {
  if (pairingTimer !== 0) {
    window.clearInterval(pairingTimer);
    pairingTimer = 0;
  }
}

function clearPairingTicket(message = "生成后可扫码；复制备用文本可在鸿蒙端粘贴配对。") {
  clearPairingTimer();
  latestPairingCode = "";
  latestPairingPayload = "";
  latestPairingExpiresAtMs = 0;
  latestPairingServiceUrl = "";
  const qr = byId("pairing-qr");
  const placeholder = byId("qr-placeholder");
  if (qr instanceof HTMLImageElement) {
    qr.removeAttribute("src");
    qr.style.display = "none";
  }
  if (placeholder) {
    placeholder.style.display = "block";
    placeholder.textContent = message;
  }
  setQrExpiredState(false);
  text("pairing-code", "未生成");
  text("pairing-countdown", "等待生成");
  text("pairing-meta", message);
  setCopyEnabled(false);
}

function expirePairingTicket(message = "配对二维码已过期，请重新生成。") {
  clearPairingTimer();
  latestPairingPayload = "";
  latestPairingCode = "";
  latestPairingExpiresAtMs = 0;
  const qr = byId("pairing-qr");
  const placeholder = byId("qr-placeholder");
  if (qr instanceof HTMLImageElement) {
    qr.style.display = "none";
  }
  if (placeholder) {
    placeholder.style.display = "block";
    placeholder.textContent = message;
  }
  setQrExpiredState(true);
  text("pairing-code", "已过期");
  text("pairing-countdown", "已过期");
  text("pairing-meta", message);
  setCopyEnabled(false);
}

function updatePairingCountdown() {
  if (latestPairingExpiresAtMs <= 0) {
    text("pairing-countdown", "等待生成");
    return;
  }
  const remainingMs = latestPairingExpiresAtMs - Date.now();
  if (remainingMs <= 0) {
    expirePairingTicket("配对二维码已过期，请在桌面端管理页重新生成后扫码。");
    return;
  }
  text("pairing-countdown", `剩余 ${formatCountdown(remainingMs)}`);
}

function startPairingCountdown() {
  clearPairingTimer();
  updatePairingCountdown();
  pairingTimer = window.setInterval(updatePairingCountdown, 1000);
}

function maybeInvalidatePairingForServiceUrl(serviceUrl) {
  if (!latestPairingPayload || !latestPairingServiceUrl || !serviceUrl) return;
  if (latestPairingServiceUrl !== serviceUrl) {
    expirePairingTicket("桌面端服务地址已变化，请重新生成配对二维码。");
  }
}

function showToast(message) {
  const target = byId("toast");
  if (!target) return;
  target.textContent = message;
  target.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => target.classList.remove("show"), 1800);
}

function stateFromBoolean(value, warnWhenFalse = false) {
  if (value) return "ok";
  return warnWhenFalse ? "warn" : "danger";
}

function setDot(element, state) {
  if (!element) return;
  element.className = `dot ${state}`;
}

function setStatus(id, label, state) {
  const target = byId(id);
  if (!target) return;
  target.className = `status-text ${state}`;
  target.replaceChildren();
  const dot = document.createElement("span");
  dot.className = `dot ${state}`;
  const span = document.createElement("span");
  span.textContent = label;
  target.appendChild(dot);
  target.appendChild(span);
}

function renderEmpty(target, message) {
  target.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = message;
  target.appendChild(empty);
}

function rootStateLabel(root) {
  if (!root.isAvailable) {
    return { label: root.errorMessage || "不可用", state: "danger" };
  }
  if (!root.isWritable) {
    return { label: root.errorMessage || "只读", state: "warn" };
  }
  return { label: "可用可写", state: "ok" };
}

function projectRootBadge(label) {
  const badge = document.createElement("span");
  badge.className = "pill";
  badge.textContent = label;
  return badge;
}

function renderProjectRoots(roots) {
  const target = byId("project-roots");
  if (!target) return;
  if (!Array.isArray(roots) || roots.length === 0) {
    renderEmpty(target, "暂无项目根目录。请先在这里添加桌面端可写的项目目录。");
    return;
  }
  target.replaceChildren();
  for (const root of roots) {
    const item = document.createElement("div");
    item.className = "project-root-item";

    const content = document.createElement("div");
    const title = document.createElement("div");
    title.className = "project-root-title";
    const name = document.createElement("span");
    name.textContent = root.name || root.path || "项目根目录";
    title.appendChild(name);
    const state = rootStateLabel(root);
    const stateNode = document.createElement("span");
    stateNode.className = `status-text ${state.state}`;
    const dot = document.createElement("span");
    dot.className = `dot ${state.state}`;
    const label = document.createElement("span");
    label.textContent = state.label;
    stateNode.appendChild(dot);
    stateNode.appendChild(label);
    title.appendChild(stateNode);

    const meta = document.createElement("div");
    meta.className = "project-root-meta";
    meta.textContent = `${root.path || "未知路径"} · 校验 ${formatTime(root.lastCheckedAt)}`;

    const badges = document.createElement("div");
    badges.className = "project-root-badges";
    if (root.isDefault) badges.appendChild(projectRootBadge("默认"));
    if (root.isStatic) badges.appendChild(projectRootBadge("启动配置"));

    content.appendChild(title);
    content.appendChild(meta);
    if (badges.children.length > 0) content.appendChild(badges);
    item.appendChild(content);

    if (root.isStatic) {
      const staticLabel = document.createElement("span");
      staticLabel.className = "empty";
      staticLabel.textContent = "不可移除";
      item.appendChild(staticLabel);
    } else {
      const button = document.createElement("button");
      button.className = "danger";
      button.type = "button";
      button.textContent = "移除";
      button.addEventListener("click", () => {
        void removeProjectRoot(root.id, root.name || root.path || "该根目录").catch((error) => {
          showToast(error instanceof Error ? error.message : "移除失败");
        });
      });
      item.appendChild(button);
    }

    target.appendChild(item);
  }
}

function authLabel(value) {
  if (value === "ok") return { label: "有效", state: "ok", value: "桌面端认证已就绪" };
  if (value === "api-key") return { label: "API", state: "warn", value: "API 登录；账号用量需 Codex 账号登录" };
  if (value === "requires-openai-auth") return { label: "需登录", state: "warn", value: "需要在桌面端完成 OpenAI 登录" };
  if (value === "missing") return { label: "缺失", state: "danger", value: "未检测到可用认证" };
  return { label: "未知", state: "warn", value: value || "未知" };
}

function deviceStatus(device) {
  if (device.revokedAt) return { label: "已撤销", state: "danger" };
  if (Date.parse(device.expiresAt) < Date.now()) return { label: "已过期", state: "warn" };
  return { label: "在线", state: "ok" };
}

function normalizeAudit(log) {
  return {
    actionType: log.actionType || log.action_type || "未知操作",
    result: log.result || "unknown",
    detail: log.detail || "无详情",
    createdAt: log.createdAt || log.created_at,
    deviceId: log.deviceId || log.device_id || null
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function refreshHealth() {
  try {
    const health = await fetchJson("/api/health");
    const ok = Boolean(health.ok);
    const serviceUrl = health.serviceUrl || "";
    latestServiceUrl = serviceUrl;
    text("service-status", ok ? "运行中" : "不可用");
    text("service-detail", ok ? "运行中" : "不可用");
    text("service-version", health.version || "v1");
    text("service-port", String(health.port || "未知"));
    text("service-url", serviceUrl || "待获取");
    text("service-process-id", health.processId ? String(health.processId) : "未知");
    text("service-started-at", formatTime(health.startedAt));
    if (ok) {
      startServiceUptimeTicker(health.startedAt, health.uptimeSeconds);
    } else {
      clearServiceUptimeTicker();
      text("service-uptime", "未知");
    }
    text("tls-fingerprint", fingerprintPreview(health.tlsFingerprint));
    text("certificate-mode", certificateModeLabel(health.certificateMode));
    text("certificate-ca-fingerprint", fingerprintPreview(health.caFingerprint));
    updateTrustCertificateControl(health.caFingerprint, health.certificateTrustStatus);
    text("local-address", serviceUrl ? serviceAddressPreview(serviceUrl) : `${window.location.hostname}:${health.port || window.location.port || "37631"}`);
    setDot(byId("service-dot"), ok ? "ok" : "danger");
    setDot(byId("service-state-dot"), ok ? "ok" : "danger");
    maybeInvalidatePairingForServiceUrl(serviceUrl);
  } catch (error) {
    text("service-status", "不可用");
    text("service-detail", "服务不可用");
    text("service-version", "未知");
    text("service-port", "未知");
    text("service-url", "未知");
    text("service-process-id", "未知");
    text("service-started-at", "未知");
    clearServiceUptimeTicker();
    text("service-uptime", "未知");
    text("tls-fingerprint", error instanceof Error ? error.message : "读取失败");
    text("certificate-mode", "未知");
    text("certificate-ca-fingerprint", "未知");
    updateTrustCertificateControl("");
    clearPairingTicket("桌面端服务不可用，请确认服务运行后重新生成二维码。");
    setDot(byId("service-dot"), "danger");
    setDot(byId("service-state-dot"), "danger");
  }
}

function renderStartupStatus(data) {
  const toggle = byId("startup-toggle");
  const supported = data.supported !== false;
  const enabled = Boolean(data.enabled);
  if (toggle && "disabled" in toggle) toggle.disabled = !supported;
  if (toggle) {
    const active = supported && enabled;
    toggle.classList.toggle("is-on", active);
    if ("dataset" in toggle) toggle.dataset.enabled = active ? "true" : "false";
    if (typeof toggle.setAttribute === "function") {
      toggle.setAttribute("data-enabled", active ? "true" : "false");
      toggle.setAttribute("aria-checked", active ? "true" : "false");
    }
  }
  if (!supported) {
    text("startup-status", data.message || "当前平台不支持");
    return;
  }
  text("startup-status", enabled ? "已开启，开机登录后自启动" : "已关闭");
}

async function refreshStartup() {
  const toggle = byId("startup-toggle");
  if (toggle && "disabled" in toggle) toggle.disabled = true;
  try {
    const data = await fetchJson("/api/startup");
    renderStartupStatus(data);
  } catch (error) {
    if (toggle && "disabled" in toggle) toggle.disabled = true;
    text("startup-status", error instanceof Error ? error.message : "读取失败");
  }
}

async function toggleStartup() {
  const toggle = byId("startup-toggle");
  if (!toggle || ("disabled" in toggle && toggle.disabled)) return;
  const currentEnabled =
    ("dataset" in toggle && toggle.dataset.enabled === "true") ||
    (typeof toggle.getAttribute === "function" && toggle.getAttribute("data-enabled") === "true");
  const enabled = !currentEnabled;
  if (toggle && "disabled" in toggle) toggle.disabled = true;
  if (typeof toggle.setAttribute === "function") toggle.setAttribute("aria-busy", "true");
  try {
    const data = await fetchJson("/api/startup", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    renderStartupStatus(data);
    showToast(data.enabled ? "已开启开机自启动" : "已关闭开机自启动");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "开机自启动设置失败");
    await refreshStartup();
    return;
  } finally {
    if (typeof toggle.removeAttribute === "function") toggle.removeAttribute("aria-busy");
  }

  try {
    await refreshAuditLogs();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "审计日志刷新失败");
  }
}

async function trustLocalCertificate() {
  const button = byId("trust-certificate");
  if (button && "disabled" in button && button.disabled) return;
  const confirmed = window.confirm("安装本地信任证书后，当前系统用户的浏览器会信任本机生成的 code 服务证书。证书私钥只保存在本机，不会打包发布或共享。是否继续？");
  if (!confirmed) return;

  let installed = false;
  if (button && "disabled" in button) button.disabled = true;
  try {
    const data = await fetchJson("/api/certificate/trust", {
      method: "POST",
      headers: {
        "x-code-management-action": "trust-local-ca"
      }
    });
    installed = Boolean(data.trusted);
    showToast(installed ? `${data.message || "本地信任证书已安装"}，正在重新加载页面` : data.message || "本地信任证书安装未完成");
    await refreshHealth();
    if (installed) {
      setTrustCertificateStatus("本机已信任", "当前用户已信任 code 本地开发 CA。浏览器重新加载后会重新校验证书。");
      if (button && "disabled" in button) button.disabled = true;
      window.setTimeout(() => {
        if (window.location && typeof window.location.reload === "function") {
          window.location.reload();
        }
      }, 800);
    }
    await refreshAuditLogs();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "本地信任证书安装失败");
  } finally {
    if (button && "disabled" in button) button.disabled = installed || !latestCaFingerprint || !isLocalTrustHostname();
  }
}

async function refreshCodexPreflight() {
  try {
    const data = await fetchJson("/api/codex-preflight");
    const pageState = data.status === "ok" ? "ok" : data.status === "warning" ? "warn" : "danger";
    text("preflight-status", data.status === "ok" ? "可用" : data.status === "warning" ? "需注意" : "不可用");
    text("codex-preflight-summary", data.message || "未返回预检摘要");
    setDot(byId("preflight-dot"), pageState);

    text("codex-cli", data.codexBin ? `${data.codexBin}${data.cliVersion ? ` · ${data.cliVersion}` : ""}` : "未检测到 Codex CLI");
    setStatus("codex-cli-status", data.codexBin ? "已安装" : "缺失", data.codexBin ? "ok" : "danger");

    text("codex-channel", data.appServerAvailable ? "App Server 可用" : "App Server 不可用");
    setStatus("codex-channel-status", data.appServerAvailable ? "可用" : "不可用", stateFromBoolean(data.appServerAvailable));

    text("codex-remote-control", data.remoteControlAvailable ? "remote-control 可用" : "未检测到 remote-control");
    setStatus("codex-remote-control-status", data.remoteControlAvailable ? "可用" : "未启用", stateFromBoolean(data.remoteControlAvailable, true));

    text("codex-provider", data.provider || "未配置");
    setStatus("codex-provider-status", data.provider ? "已配置" : "缺失", data.provider ? "ok" : "warn");

    text("codex-model", data.model || "未配置");
    setStatus("codex-model-status", data.model ? "已配置" : "缺失", data.model ? "ok" : "warn");

    const auth = authLabel(data.authStatus);
    text("codex-auth", auth.value);
    setStatus("codex-auth-status", auth.label, auth.state);

    const capabilities = data.capabilities && typeof data.capabilities === "object" ? Object.values(data.capabilities) : [];
    const available = capabilities.filter(Boolean).length;
    const total = capabilities.length;
    text("codex-capabilities", total > 0 ? `${available}/${total} 项可用` : "未返回能力摘要");
    setStatus("codex-capabilities-status", total > 0 && available === total ? "完整" : "需检查", total > 0 && available === total ? "ok" : "warn");
  } catch (error) {
    text("preflight-status", "不可用");
    text("codex-preflight-summary", error instanceof Error ? error.message : "Codex 预检失败");
    setDot(byId("preflight-dot"), "danger");
    for (const id of ["codex-cli", "codex-channel", "codex-remote-control", "codex-provider", "codex-model", "codex-auth", "codex-capabilities"]) {
      text(id, "读取失败");
    }
    for (const id of ["codex-cli-status", "codex-channel-status", "codex-remote-control-status", "codex-provider-status", "codex-model-status", "codex-auth-status", "codex-capabilities-status"]) {
      setStatus(id, "失败", "danger");
    }
  }
}

async function refreshProjectRoots() {
  const target = byId("project-roots");
  try {
    const data = await fetchJson("/api/project-roots");
    renderProjectRoots(Array.isArray(data.roots) ? data.roots : []);
  } catch (error) {
    if (target) renderEmpty(target, error instanceof Error ? error.message : "项目根目录读取失败");
  }
}

async function chooseProjectRoot() {
  const button = byId("choose-project-root");
  const status = byId("project-root-status");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  if (status) status.textContent = "正在打开系统目录选择器...";
  try {
    const result = await fetchJson("/api/project-roots/choose", { method: "POST" });
    renderProjectRoots(Array.isArray(result.roots) ? result.roots : []);
    if (result.unsupported) {
      if (status) status.textContent = result.message || "当前平台不支持系统目录选择器，请手动输入项目根目录路径。";
      return;
    }
    if (result.cancelled) {
      if (status) status.textContent = "已取消选择，项目根目录未变化。";
      showToast("已取消选择");
      return;
    }
    if (status) status.textContent = "项目根目录已保存，移动端刷新项目后可选择该根目录创建项目或新会话。";
    showToast("项目根目录已添加");
    await refreshAuditLogs();
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

async function addManualProjectRoot() {
  const input = byId("manual-project-root-path");
  const status = byId("project-root-status");
  const rawPath = input instanceof HTMLInputElement ? input.value.trim() : "";
  if (!rawPath) {
    if (status) status.textContent = "请输入项目根目录路径。";
    return;
  }
  const result = await fetchJson("/api/project-roots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: rawPath })
  });
  renderProjectRoots(Array.isArray(result.roots) ? result.roots : []);
  if (input instanceof HTMLInputElement) input.value = "";
  if (status) status.textContent = "项目根目录已保存，移动端刷新项目后可选择该根目录创建项目或新会话。";
  showToast("项目根目录已添加");
  await refreshAuditLogs();
}

async function removeProjectRoot(rootId, rootName) {
  if (!window.confirm(`移除 ${rootName}？不会删除桌面端上的真实目录。`)) return;
  const result = await fetchJson(`/api/project-roots/${encodeURIComponent(rootId)}`, { method: "DELETE" });
  renderProjectRoots(Array.isArray(result.roots) ? result.roots : []);
  const status = byId("project-root-status");
  if (status) status.textContent = "项目根目录已移除，不会影响已经识别到的桌面端项目和历史对话。";
  showToast("项目根目录已移除");
  await refreshAuditLogs();
}

async function revokeDevice(deviceId, deviceName) {
  if (!window.confirm(`撤销 ${deviceName} 的授权？撤销后该设备需要重新配对。`)) return;
  await fetchJson(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" });
  showToast("设备授权已撤销");
  await Promise.all([refreshDevices(), refreshAuditLogs()]);
}

async function refreshDevices() {
  const target = byId("paired-devices");
  if (!target) return;
  try {
    const data = await fetchJson("/api/devices");
    const devices = Array.isArray(data.devices) ? data.devices : [];
    if (devices.length === 0) {
      renderEmpty(target, "暂无设备");
      return;
    }
    target.replaceChildren();
    for (const device of devices) {
      const status = deviceStatus(device);
      const item = document.createElement("div");
      item.className = "device-item";

      const main = document.createElement("div");
      main.className = "device-main";

      const name = document.createElement("div");
      name.className = "device-name";
      name.textContent = device.deviceName || "未命名设备";

      const statusNode = document.createElement("div");
      statusNode.className = `device-status ${status.state}`;
      const dot = document.createElement("span");
      dot.className = `dot ${status.state}`;
      const label = document.createElement("span");
      label.textContent = status.label;
      statusNode.appendChild(dot);
      statusNode.appendChild(label);

      main.appendChild(name);
      main.appendChild(statusNode);

      const meta = document.createElement("div");
      meta.className = "device-meta";
      meta.textContent = `绑定 ${formatTime(device.createdAt)} · 到期 ${formatTime(device.expiresAt)}`;

      item.appendChild(main);
      item.appendChild(meta);

      if (!device.revokedAt) {
        const actions = document.createElement("div");
        actions.className = "device-actions";
        const button = document.createElement("button");
        button.className = "danger";
        button.type = "button";
        button.textContent = "撤销授权";
        button.addEventListener("click", () => {
          void revokeDevice(device.id, device.deviceName || "该设备").catch((error) => {
            showToast(error instanceof Error ? error.message : "撤销失败");
          });
        });
        actions.appendChild(button);
        item.appendChild(actions);
      }

      target.appendChild(item);
    }
  } catch (error) {
    renderEmpty(target, error instanceof Error ? error.message : "设备列表读取失败");
  }
}

async function refreshAuditLogs() {
  const target = byId("audit-log");
  if (!target) return;
  try {
    const data = await fetchJson("/api/audit-logs");
    const logs = Array.isArray(data.logs) ? data.logs.map(normalizeAudit).slice(0, 12) : [];
    if (logs.length === 0) {
      renderEmpty(target, "暂无审计记录");
      return;
    }
    target.replaceChildren();
    for (const log of logs) {
      const item = document.createElement("div");
      item.className = "audit-item";
      const title = document.createElement("div");
      title.className = "audit-title";
      title.textContent = `${log.actionType} · ${log.result}`;
      const meta = document.createElement("div");
      meta.className = "audit-meta";
      meta.textContent = `${formatTime(log.createdAt)} · ${log.detail}`;
      item.appendChild(title);
      item.appendChild(meta);
      target.appendChild(item);
    }
  } catch (error) {
    renderEmpty(target, error instanceof Error ? error.message : "审计日志读取失败");
  }
}

async function refreshMediaAssets() {
  const target = byId("recent-media-assets");
  try {
    const query = mediaSearchQuery();
    const endpoint = query ? `/api/media-assets?query=${encodeURIComponent(query)}` : "/api/media-assets";
    const data = await fetchJson(endpoint);
    text("media-storage-total", formatBytes(data.totalSizeBytes));
    if (!target) return;
    const projects = Array.isArray(data.projects) ? data.projects : fallbackMediaProjects(data.assets);
    latestMediaProjects = projects;
    renderMediaProjects(projects, query ? "未找到关联媒体" : "暂无媒体产物");
  } catch (error) {
    text("media-storage-total", "读取失败");
    if (target) renderEmpty(target, error instanceof Error ? error.message : "媒体资产读取失败");
  }
}

function mediaSearchQuery() {
  const input = byId("media-search");
  return input && "value" in input ? String(input.value || "").trim() : "";
}

function fallbackMediaProjects(rawAssets) {
  const assets = Array.isArray(rawAssets) ? rawAssets : [];
  if (assets.length === 0) return [];
  const totalSizeBytes = assets.reduce((sum, asset) => sum + (Number(asset.sizeBytes) || 0), 0);
  return [{
    projectKey: "__unlinked__",
    projectPath: null,
    projectName: "未关联项目",
    assetCount: assets.length,
    totalSizeBytes,
    assets
  }];
}

function mediaAssetIds(projects) {
  return projects.flatMap((project) => Array.isArray(project.assets) ? project.assets.map((asset) => asset.id) : []);
}

function visibleMediaAssetIds() {
  return mediaAssetIds(latestMediaProjects);
}

function setMediaSelectAllVisible(visible) {
  const selectAll = byId("select-media-assets");
  const control = byId("media-select-all-control");
  if (selectAll) selectAll.style.display = visible ? "" : "none";
  if (control) control.style.display = visible ? "" : "none";
}

function updateMediaSelectAllState() {
  const visibleIds = visibleMediaAssetIds();
  const selectAll = byId("select-media-assets");
  const isVisible = mediaSelectionMode && visibleIds.length > 0;
  setMediaSelectAllVisible(isVisible);
  if (!selectAll) return;
  const selectedVisibleCount = visibleIds.filter((id) => selectedMediaAssetIds.has(id)).length;
  selectAll.checked = isVisible && selectedVisibleCount === visibleIds.length;
  selectAll.indeterminate = isVisible && selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
  selectAll.disabled = !isVisible;
}

function setAllVisibleMediaSelected(selected) {
  for (const assetId of visibleMediaAssetIds()) {
    if (selected) {
      selectedMediaAssetIds.add(assetId);
    } else {
      selectedMediaAssetIds.delete(assetId);
    }
  }
  renderMediaProjects(latestMediaProjects, mediaSearchQuery() ? "未找到关联媒体" : "暂无媒体产物");
}

function renderMediaProjects(projects, emptyMessage) {
  const target = byId("recent-media-assets");
  if (!target) return;
  const visibleIds = mediaAssetIds(projects);
  for (const selectedId of Array.from(selectedMediaAssetIds)) {
    if (!visibleIds.includes(selectedId)) selectedMediaAssetIds.delete(selectedId);
  }
  updateMediaSelectionState();
  if (projects.length === 0) {
    renderEmpty(target, emptyMessage);
    return;
  }
  target.replaceChildren();
  for (const project of projects) {
    const section = document.createElement("div");
    section.className = "media-project";

    const projectTitle = document.createElement("div");
    projectTitle.className = "media-project-title";
    projectTitle.textContent = project.projectName || "未关联项目";

    const projectMeta = document.createElement("div");
    projectMeta.className = "media-project-meta";
    const projectPath = project.projectPath ? ` · ${project.projectPath}` : "";
    projectMeta.textContent = `${project.assetCount || 0} 个文件 · ${formatBytes(project.totalSizeBytes)}${projectPath}`;

    section.appendChild(projectTitle);
    section.appendChild(projectMeta);

    const assets = Array.isArray(project.assets) ? project.assets : [];
    for (const asset of assets) {
      section.appendChild(renderMediaAssetItem(asset));
    }
    target.appendChild(section);
  }
}

function renderMediaAssetItem(asset) {
  const item = document.createElement("div");
  item.className = "audit-item";

  const main = document.createElement("div");
  main.className = "media-item-main";

  if (mediaSelectionMode) {
    const checkbox = document.createElement("input");
    checkbox.className = "media-checkbox";
    checkbox.type = "checkbox";
    checkbox.checked = selectedMediaAssetIds.has(asset.id);
    checkbox.setAttribute("aria-label", `选择 ${asset.fileName || asset.id || "媒体文件"}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedMediaAssetIds.add(asset.id);
      } else {
        selectedMediaAssetIds.delete(asset.id);
      }
      updateMediaSelectionState();
    });
    main.appendChild(checkbox);
  }

  const content = document.createElement("div");
  content.className = "media-item-content";

  const title = document.createElement("div");
  title.className = "media-item-title";
  title.textContent = asset.fileName || asset.id || "未命名文件";

  const meta = document.createElement("div");
  meta.className = "audit-meta";
  const sessionTitle = asset.sessionTitle ? ` · ${asset.sessionTitle}` : "";
  meta.textContent = `${asset.kind || "文件"} · ${formatBytes(asset.sizeBytes)} · 过期 ${formatTime(asset.expiresAt)}${sessionTitle}`;

  const actions = document.createElement("div");
  actions.className = "media-actions";
  if (asset.url) {
    const link = document.createElement("a");
    link.className = "media-action";
    link.href = asset.url;
    link.textContent = "下载";
    link.target = "_blank";
    link.rel = "noreferrer";
    actions.appendChild(link);
  }

  content.appendChild(title);
  content.appendChild(meta);
  content.appendChild(actions);
  main.appendChild(content);
  item.appendChild(main);
  return item;
}

function updateMediaSelectionState() {
  const count = selectedMediaAssetIds.size;
  const hasMediaAssets = mediaAssetIds(latestMediaProjects).length > 0;
  updateMediaSelectAllState();
  if (!mediaSelectionMode) {
    text("media-selected-count", hasMediaAssets ? "点击批量清理后选择文件" : "未选择文件");
  } else {
    text("media-selected-count", count > 0 ? `已选择 ${count} 个文件` : "请选择要清理的文件");
  }
  const button = byId("clear-media-assets");
  if (button && "disabled" in button) button.disabled = !hasMediaAssets && !mediaSelectionMode;
  if (!button) return;
  if (!mediaSelectionMode) {
    button.textContent = "批量清理";
    return;
  }
  button.textContent = count > 0 ? `批量清理 (${count})` : "取消清理";
}

function enterMediaSelectionMode() {
  mediaSelectionMode = true;
  renderMediaProjects(latestMediaProjects, mediaSearchQuery() ? "未找到关联媒体" : "暂无媒体产物");
}

function exitMediaSelectionMode() {
  mediaSelectionMode = false;
  selectedMediaAssetIds.clear();
  renderMediaProjects(latestMediaProjects, mediaSearchQuery() ? "未找到关联媒体" : "暂无媒体产物");
}

async function refreshLocalWebSessions() {
  const target = byId("local-web-sessions");
  if (!target) return;
  try {
    const data = await fetchJson("/api/local-web-sessions");
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (sessions.length === 0) {
      renderEmpty(target, "暂无活动代理");
      return;
    }
    target.replaceChildren();
    for (const session of sessions) {
      const item = document.createElement("div");
      item.className = "audit-item";
      const title = document.createElement("div");
      title.className = "media-item-title";
      title.textContent = session.targetUrl || session.id || "本地 Web 页面";
      const meta = document.createElement("div");
      meta.className = "audit-meta";
      meta.textContent = `${session.status || "active"} · 打开 ${formatTime(session.createdAt)}`;
      item.appendChild(title);
      item.appendChild(meta);
      target.appendChild(item);
    }
  } catch (error) {
    renderEmpty(target, error instanceof Error ? error.message : "本地 Web 代理读取失败");
  }
}

async function clearMediaAssets() {
  if (!mediaSelectionMode) {
    enterMediaSelectionMode();
    return;
  }
  const assetIds = Array.from(selectedMediaAssetIds);
  if (assetIds.length === 0) {
    exitMediaSelectionMode();
    return;
  }
  if (!window.confirm(`批量清理已勾选的 ${assetIds.length} 个媒体文件？会删除桌面端服务保存的媒体副本。`)) return;
  const result = await fetchJson("/api/media-assets", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetIds })
  });
  for (const assetId of assetIds) selectedMediaAssetIds.delete(assetId);
  mediaSelectionMode = false;
  showToast(`已清理 ${result.deletedCount || 0} 个媒体文件`);
  await Promise.all([refreshMediaAssets(), refreshAuditLogs()]);
}

async function createPairingTicket() {
  const button = byId("create-pairing");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    const data = await fetchJson("/api/pairing-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredServiceUrl: latestServiceUrl })
    });
    const qr = byId("pairing-qr");
    const placeholder = byId("qr-placeholder");
    if (qr instanceof HTMLImageElement) {
      qr.src = data.qrPngDataUrl;
      qr.style.display = "block";
    }
    if (placeholder) placeholder.style.display = "none";
    setQrExpiredState(false);
    latestPairingCode = data.value || "";
    latestPairingPayload = data.qrPayload || "";
    latestPairingServiceUrl = data.serviceUrl || pairingPayloadServiceUrl(latestPairingPayload);
    latestPairingExpiresAtMs = Number(data.expiresAt) || 0;
    const serviceUrl = latestPairingServiceUrl;
    if (serviceUrl.length > 0) text("local-address", serviceAddressPreview(serviceUrl));
    if (latestServiceUrl.length > 0 && serviceUrl.length > 0 && latestServiceUrl !== serviceUrl) {
      text("pairing-meta", "桌面端服务地址刚发生变化，请重新生成二维码。");
      expirePairingTicket("桌面端服务地址已变化，请重新生成配对二维码。");
      return;
    }
    text("pairing-code", latestPairingCode || "未生成");
    text("pairing-meta", `有效期至 ${formatTime(data.expiresAt)} · 地址 ${serviceAddressPreview(serviceUrl)} · 复制备用文本可在鸿蒙端粘贴配对 · 证书 ${fingerprintPreview(data.tlsFingerprint)}`);
    setCopyEnabled(latestPairingPayload.length > 0);
    startPairingCountdown();
  } catch (error) {
    clearPairingTimer();
    latestPairingPayload = "";
    latestPairingCode = "";
    latestPairingExpiresAtMs = 0;
    latestPairingServiceUrl = "";
    const qr = byId("pairing-qr");
    const placeholder = byId("qr-placeholder");
    if (qr instanceof HTMLImageElement) qr.style.display = "none";
    if (placeholder) {
      placeholder.style.display = "block";
      placeholder.textContent = error instanceof Error ? error.message : "二维码生成失败";
    }
    setQrExpiredState(false);
    text("pairing-code", "生成失败");
    text("pairing-countdown", "生成失败");
    text("pairing-meta", "请确认桌面端服务可用后重试。");
    setCopyEnabled(false);
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

async function copyPairingCode() {
  if (!latestPairingPayload) {
    showToast("请先生成有效的备用配对文本");
    return;
  }
  if (latestPairingExpiresAtMs > 0 && Date.now() >= latestPairingExpiresAtMs) {
    expirePairingTicket("配对二维码已过期，请在桌面端管理页重新生成后复制。");
    return;
  }
  try {
    await navigator.clipboard.writeText(latestPairingPayload);
    showToast("备用配对文本已复制");
  } catch {
    showToast("浏览器未允许复制");
  }
}

async function refreshAll() {
  await Promise.all([
    refreshHealth(),
    refreshStartup(),
    refreshCodexPreflight(),
    refreshProjectRoots(),
    refreshDevices(),
    refreshAuditLogs(),
    refreshMediaAssets(),
    refreshLocalWebSessions()
  ]);
}

byId("refresh-page")?.addEventListener("click", () => {
  void refreshAll();
});

byId("trust-certificate")?.addEventListener("click", () => {
  void trustLocalCertificate();
});

byId("create-pairing")?.addEventListener("click", () => {
  void createPairingTicket();
});

byId("copy-code")?.addEventListener("click", () => {
  void copyPairingCode();
});

byId("choose-project-root")?.addEventListener("click", () => {
  void chooseProjectRoot().catch((error) => {
    const message = error instanceof Error ? error.message : "项目根目录选择失败";
    const status = byId("project-root-status");
    if (status) status.textContent = message;
    showToast(message);
  });
});

byId("add-project-root-path")?.addEventListener("click", () => {
  void addManualProjectRoot().catch((error) => {
    const message = error instanceof Error ? error.message : "项目根目录添加失败";
    const status = byId("project-root-status");
    if (status) status.textContent = message;
    showToast(message);
  });
});

byId("manual-project-root-path")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void addManualProjectRoot().catch((error) => {
    const message = error instanceof Error ? error.message : "项目根目录添加失败";
    const status = byId("project-root-status");
    if (status) status.textContent = message;
    showToast(message);
  });
});

byId("clear-media-assets")?.addEventListener("click", () => {
  void clearMediaAssets().catch((error) => {
    showToast(error instanceof Error ? error.message : "清理失败");
  });
});

byId("select-media-assets")?.addEventListener("click", () => {
  const visibleIds = visibleMediaAssetIds();
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedMediaAssetIds.has(id));
  setAllVisibleMediaSelected(!allSelected);
});

byId("startup-toggle")?.addEventListener("click", () => {
  void toggleStartup();
});

byId("media-search")?.addEventListener("input", () => {
  if (mediaSearchTimer !== 0) window.clearTimeout(mediaSearchTimer);
  mediaSearchTimer = window.setTimeout(() => {
    void refreshMediaAssets().catch((error) => {
      showToast(error instanceof Error ? error.message : "媒体资产读取失败");
    });
  }, 180);
});

void refreshAll();
void createPairingTicket();
