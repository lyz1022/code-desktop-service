import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../appContext.js";
import type { CodexNotificationMethod, CodexServerRequestMethod } from "../codex/codexAppServerProtocol.js";
import type { CodexApprovalAnswers } from "../codex/codexApprovalMapper.js";
import { sessionDetailFromDesktopConversationState } from "../codex/codexDesktopStateMapper.js";
import { readCodexThreadMetadataFromStateDb, type CodexTurnInputSource, type SessionDetail, type SessionMessage } from "../codex/codexSessionManager.js";
import type { SessionTurn, TimelineItem, TimelineItemStatus } from "../codex/codexTimelineMapper.js";
import { createCodexDesktopFollowerBridge, type CodexDesktopFollowerBridge } from "../codex/codexIpcBridge.js";
import { CodexTimelineRuntime, type TimelineRuntimeEvent } from "../codex/codexTimelineRuntime.js";
import type { CodexGeneratedImageArtifact, CodexGeneratedImageArtifactSyncResult } from "../domain/codexGeneratedImageArtifactService.js";
import { CodexTurnInputLifecycleService } from "../domain/codexTurnInputLifecycleService.js";
import { buildGuidedInput } from "../domain/inputGuidance.js";
import { listInstalledCodexCapabilities, type InstalledCodexCapability } from "../domain/installedCodexCapabilities.js";
import type { CodexAttachmentStatus } from "../domain/codexAttachmentAdapter.js";
import { CodexTurnInputBuilder, type CodexTurnInputItem } from "../domain/codexTurnInputBuilder.js";
import type { PublicMediaAsset } from "../domain/mediaAssetService.js";
import { classifyLocalWebTarget } from "../domain/localWebTargetPolicy.js";
import type { SessionSummary } from "../domain/sessionService.js";
import type { CodexModelOption, SessionRuntimeConfig, SessionRuntimeConfigInput } from "../domain/sessionRuntimeConfigService.js";
import type { SessionInputQueueItem, SessionInputQueueSendItem } from "../domain/sessionInputQueueService.js";
import type { StoredLocalWebSession, StoredSessionAttachment } from "../storage/repositories.js";

const ApprovalAnswersSchema = z.record(z.object({ answers: z.array(z.string()) }));
const DevApprovalFixtureKindSchema = z.enum(["command", "file_change", "permission", "user_input", "mcp_elicitation"]);
const CodexReasoningEffortSchema = z.enum(["default", "low", "medium", "high", "xhigh"]);
const CodexPermissionModeSchema = z.enum(["readonly", "workspace", "full-access"]);
const CodexApprovalModeSchema = z.enum(["manual", "on-request", "on-failure", "full-access-never"]);
const CodexApprovalsReviewerSchema = z.enum(["user", "auto_review", "guardian_subagent"]);
const DEFAULT_DETAIL_READ_FALLBACK_TIMEOUT_MS = 8_000;
const DETAIL_SNAPSHOT_CACHE_TTL_MS = 2_000;
const FRESH_THREAD_DETAIL_RETRY_LIMIT = 3;
const FRESH_THREAD_DETAIL_RETRY_DELAY_MS = 150;
const USER_ATTACHMENT_MESSAGE_MATCH_WINDOW_MS = 5 * 60 * 1000;
const CodexRuntimeConfigInputSchema = z.object({
  model: z.string().min(1).nullable(),
  effort: CodexReasoningEffortSchema,
  permissionMode: CodexPermissionModeSchema,
  approvalMode: CodexApprovalModeSchema,
  approvalsReviewer: CodexApprovalsReviewerSchema.default("user")
}).strict();
const SessionInputGuidanceSchema = z.object({
  mode: z.enum(["plain", "guided", "queued", "steer-now"]),
  selectedCapabilityIds: z.array(z.string().min(1))
}).strict();
const DevCodexTurnInputItemSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string(), text_elements: z.array(z.never()) }).strict(),
  z.object({ type: z.literal("localImage"), path: z.string().min(1), detail: z.enum(["high", "original"]).optional() }).strict(),
  z.object({ type: z.literal("mention"), name: z.string().min(1), path: z.string().min(1) }).strict()
]);

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("codex.installedCapabilities.list"), requestId: z.string() }),
  z.object({ type: z.literal("codex.models.list"), requestId: z.string() }),
  z.object({ type: z.literal("projects.list"), requestId: z.string() }),
  z.object({ type: z.literal("projects.create"), requestId: z.string(), rootId: z.string().min(1), projectName: z.string().trim().min(1).max(64) }),
  z.object({ type: z.literal("projects.hide"), requestId: z.string(), projectPath: z.string().min(1) }),
  z.object({ type: z.literal("projects.unhide"), requestId: z.string(), projectPath: z.string().min(1) }),
  z.object({ type: z.literal("codex.accountUsage.refresh"), requestId: z.string() }),
  z.object({
    type: z.literal("session.create"),
    requestId: z.string(),
    clientMessageId: z.string().min(1).optional(),
    toolId: z.string(),
    projectPath: z.string().nullable(),
    text: z.string().min(1),
    guidance: SessionInputGuidanceSchema.optional(),
    attachmentIds: z.array(z.string().min(1)).optional(),
    runtimeConfig: CodexRuntimeConfigInputSchema.optional()
  }),
  z.object({ type: z.literal("session.read"), requestId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("session.runtimeConfig.read"), requestId: z.string(), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("session.runtimeConfig.update"), requestId: z.string(), sessionId: z.string().min(1), config: CodexRuntimeConfigInputSchema }),
  z.object({ type: z.literal("session.sync.enable"), requestId: z.string(), sessionId: z.string(), activeDetail: z.boolean().optional() }),
  z.object({ type: z.literal("session.sync.disable"), requestId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("session.sync.unsubscribe"), requestId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("session.rename"), requestId: z.string(), sessionId: z.string(), title: z.string().trim().min(1).max(120) }),
  z.object({
    type: z.literal("session.sendText"),
    requestId: z.string(),
    sessionId: z.string(),
    clientMessageId: z.string().min(1),
    text: z.string().min(1),
    guidance: SessionInputGuidanceSchema.optional(),
    attachmentIds: z.array(z.string().min(1)).optional(),
    skipPreflightResume: z.boolean().optional()
  }),
  z.object({ type: z.literal("session.steer"), requestId: z.string(), sessionId: z.string(), clientMessageId: z.string().min(1), text: z.string().min(1), guidance: SessionInputGuidanceSchema.optional() }),
  z.object({ type: z.literal("session.context.compact"), requestId: z.string(), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("session.inputQueue.enqueue"), requestId: z.string(), sessionId: z.string(), clientMessageId: z.string().min(1), text: z.string().min(1), guidance: SessionInputGuidanceSchema }).strict(),
  z.object({ type: z.literal("session.attachments.send"), requestId: z.string(), sessionId: z.string().min(1), clientMessageId: z.string().min(1), attachmentIds: z.array(z.string().min(1)) }),
  z.object({ type: z.literal("session.inputQueue.cancel"), requestId: z.string(), sessionId: z.string(), queueItemId: z.string().min(1) }),
  z.object({ type: z.literal("session.inputQueue.retry"), requestId: z.string(), sessionId: z.string(), queueItemId: z.string().min(1) }),
  z.object({ type: z.literal("localWeb.open"), requestId: z.string(), sessionId: z.string().min(1), targetUrl: z.string().url() }),
  z.object({ type: z.literal("localWeb.close"), requestId: z.string(), localWebSessionId: z.string().min(1) }),
  z.object({
    type: z.literal("capture.screenshot"),
    requestId: z.string(),
    sessionId: z.string().min(1),
    target: z.enum(["localWeb", "screen"]),
    localWebSessionId: z.string().min(1).nullable(),
    userConfirmed: z.boolean()
  }),
  z.object({ type: z.literal("session.interrupt"), requestId: z.string(), sessionId: z.string(), targetKind: z.enum(["turn", "startup"]).optional(), turnId: z.string().min(1).optional() }),
  z.object({ type: z.literal("session.pin"), requestId: z.string(), sessionId: z.string(), isPinned: z.boolean() }),
  z.object({ type: z.literal("approval.respond"), requestId: z.string(), sessionId: z.string(), approvalId: z.string(), actionId: z.string(), answers: ApprovalAnswersSchema.optional() }),
  z.object({ type: z.literal("dev.approvalFixture.show"), requestId: z.string(), sessionId: z.string(), kind: DevApprovalFixtureKindSchema }),
  z.object({ type: z.literal("dev.codexTurnInput.probe"), requestId: z.string(), sessionId: z.string().min(1), input: z.array(DevCodexTurnInputItemSchema).min(1) }),
  z.object({ type: z.literal("device.unbind"), requestId: z.string() })
]);

type ClientCommand = z.infer<typeof ClientCommandSchema>;
type DevApprovalFixtureKind = z.infer<typeof DevApprovalFixtureKindSchema>;

function send(socket: { send: (value: string) => void }, value: unknown): void {
  socket.send(JSON.stringify(value));
}

function isDevApprovalFixtureEnabled(): boolean {
  return process.env.CODE_ENABLE_APPROVAL_TEST_FIXTURES === "1";
}

function devApprovalFixture(input: {
  requestId: string;
  sessionId: string;
  kind: DevApprovalFixtureKind;
}): NonNullable<TimelineItem["approval"]> {
  const id = `dev-approval-${input.kind}-${input.requestId}`;
  const createdAt = new Date().toISOString();
  if (input.kind === "file_change") {
    return {
      id,
      kind: "file_change",
      method: "item/fileChange/requestApproval",
      subject: "README.md",
      title: "是否允许 Codex 修改文件？",
      body: "README.md\n+ 添加移动端审核测试内容",
      actions: [
        { id: "accept", label: "同意" },
        { id: "acceptForSession", label: "本会话同意" },
        { id: "decline", label: "不修改，继续对话" }
      ],
      createdAt
    };
  }
  if (input.kind === "permission") {
    return {
      id,
      kind: "permission",
      method: "item/permissions/requestApproval",
      subject: "network + workspace write",
      title: "是否授予 Codex 权限？",
      body: "Codex 请求临时联网，并写入当前工作区文件。",
      actions: [
        { id: "grantForTurn", label: "本轮允许" },
        { id: "grantForTurnWithStrictAutoReview", label: "本轮允许并严格自动审查" },
        { id: "grantForSession", label: "本会话允许" },
        { id: "decline", label: "拒绝", decisionType: "decline" }
      ],
      createdAt
    };
  }
  if (input.kind === "user_input") {
    return {
      id,
      kind: "user_input",
      method: "item/tool/requestUserInput",
      subject: "请输入目标文件",
      title: "需要补充信息",
      body: "请输入目标文件，并选择处理方式。",
      actions: [
        { id: "submit", label: "提交", decisionType: "user-input-submit" },
        { id: "cancel", label: "取消", decisionType: "cancel" }
      ],
      inputFields: [
        { id: "target", label: "目标文件", type: "text", defaultValue: "", options: [], isSecret: false },
        { id: "mode", label: "处理方式", type: "single-select", defaultValue: "只读", options: ["只读", "修改"], isSecret: false, isRequired: false }
      ],
      createdAt
    };
  }
  if (input.kind === "mcp_elicitation") {
    return {
      id,
      kind: "mcp_elicitation",
      method: "mcpServer/elicitation/request",
      subject: "filesystem MCP",
      title: "MCP 请求确认",
      body: "filesystem MCP 需要你的确认。",
      actions: [
        { id: "accept", label: "提供请求的信息" },
        { id: "decline", label: "不提供，但继续" },
        { id: "cancel", label: "取消请求", decisionType: "cancel" }
      ],
      createdAt
    };
  }
  return {
    id,
    kind: "command",
    method: "item/commandExecution/requestApproval",
    subject: "/bin/zsh -lc 'printf approval_fixture'",
    title: "是否允许 Codex 运行命令？",
    body: "$ /bin/zsh -lc 'printf approval_fixture'",
    actions: [
      { id: "accept", label: "同意" },
      { id: "acceptWithExecpolicyAmendment", label: "以后同意同类命令" },
      { id: "decline", label: "不执行，继续对话" }
    ],
    createdAt
  };
}

function devApprovalFixtureFollowupItem(input: {
  sessionId: string;
  approval: NonNullable<TimelineItem["approval"]>;
  actionId: string;
  answers?: CodexApprovalAnswers;
}): TimelineItem {
  const createdAt = new Date().toISOString();
  const answerText = approvalDeclineReasonFromAnswers(input.answers);
  const actionText = devApprovalFixtureActionText(input.actionId, input.approval.kind);
  const answerSummary = answerText.length > 0 ? `\n${devApprovalFixtureAnswerLabel(input.approval.kind, input.actionId)}：${answerText}` : "";
  const text = `已收到${devApprovalFixtureKindText(input.approval.kind)}决定：${actionText}${answerSummary}`;
  return {
    id: `dev-approval-result-${input.approval.id}-${input.actionId}`,
    sessionId: input.sessionId,
    turnId: `dev-approval-turn-${input.approval.id}`,
    kind: "agentMessage",
    status: "completed",
    title: "审批测试结果",
    text,
    rawText: text,
    createdAt,
    updatedAt: createdAt,
    isStreaming: false,
    isCollapsedByDefault: false,
    command: null,
    diff: null,
    approval: null,
    planSteps: [],
    assetIds: []
  };
}

function devApprovalFixtureKindText(kind: string): string {
  if (kind === "command") return "命令审核";
  if (kind === "file_change") return "文件变更审核";
  if (kind === "permission") return "权限审核";
  if (kind === "user_input") return "补充信息";
  if (kind === "mcp_elicitation") return "MCP 确认";
  return "审核";
}

function devApprovalFixtureActionText(actionId: string, kind: string): string {
  if (actionId === "accept") return "同意";
  if (actionId === "acceptForSession") return "本会话同意";
  if (actionId === "acceptWithExecpolicyAmendment") return "以后同意同类命令";
  if (actionId === "grantForTurn") return "本轮授权";
  if (actionId === "grantForTurnWithStrictAutoReview") return "本轮授权并严格自动审查";
  if (actionId === "grantForSession") return "本会话授权";
  if (actionId === "submit") return "提交";
  if (actionId === "decline") {
    if (kind === "permission") return "不授权但继续";
    if (kind === "mcp_elicitation") return "不提供但继续";
    if (kind === "user_input") return "不提交但继续";
    return "跳过";
  }
  if (actionId === "cancel") return "取消";
  return actionId;
}

function devApprovalFixtureAnswerLabel(kind: string, actionId: string): string {
  if (kind === "user_input" && actionId === "submit") return "补充内容";
  if (kind === "mcp_elicitation" && actionId === "accept") return "提供内容";
  if (kind === "command" || kind === "file_change") return "调整说明";
  return "说明";
}

function stripDiffPatchesFromItem(item: TimelineItem): TimelineItem {
  if (item.diff === null) return item;
  return {
    ...item,
    diff: {
      filesChanged: item.diff.filesChanged,
      insertions: item.diff.insertions,
      deletions: item.diff.deletions,
      files: item.diff.files.map((file) => ({
        path: file.path,
        status: file.status,
        insertions: file.insertions,
        deletions: file.deletions,
        patch: ""
      }))
    }
  };
}

function stripDiffPatchesFromTurn(turn: SessionTurn): SessionTurn {
  return {
    ...turn,
    items: turn.items.map((item) => stripDiffPatchesFromItem(item))
  };
}

function snapshotTurnsForClient(turns: SessionTurn[]): SessionTurn[] {
  const latestReviewableTurnId = latestReviewableDiffTurnId(turns);
  return turns.map((turn) => shouldStripDiffPatchesFromTurn(turn, latestReviewableTurnId) ? stripDiffPatchesFromTurn(turn) : turn);
}

function shouldStripDiffPatchesFromTurn(turn: SessionTurn, latestReviewableTurnId: string): boolean {
  if (turn.status === "running" || turn.status === "idle") return true;
  if (turnHasActiveTimelineItem(turn)) return true;
  const summary = diffConclusionSummary(turn);
  if (!summary.hasDiff || summary.lastAgent === null || summary.lastAgentIndex <= summary.lastDiffIndex) return true;
  if (hasGitConclusionAnchor(summary.lastAgent)) return false;
  return turn.id !== latestReviewableTurnId;
}

function turnHasActiveTimelineItem(turn: SessionTurn): boolean {
  for (const item of turn.items) {
    if (item.status === "running" || item.isStreaming) return true;
  }
  return false;
}

function latestReviewableDiffTurnId(turns: SessionTurn[]): string {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn.status === "running" || turn.status === "idle" || turnHasActiveTimelineItem(turn)) continue;
    const summary = diffConclusionSummary(turn);
    if (summary.hasDiff && summary.lastAgent !== null && summary.lastAgentIndex > summary.lastDiffIndex) {
      return turn.id;
    }
  }
  return "";
}

function diffConclusionSummary(turn: SessionTurn): {
  hasDiff: boolean;
  lastDiffIndex: number;
  lastAgentIndex: number;
  lastAgent: TimelineItem | null;
} {
  let hasDiff = false;
  let lastDiffIndex = -1;
  let lastAgentIndex = -1;
  let lastAgent: TimelineItem | null = null;
  for (let index = 0; index < turn.items.length; index++) {
    const item = turn.items[index];
    if (item.kind === "fileChange" || item.kind === "diffOverview") {
      hasDiff = true;
      lastDiffIndex = index;
    }
    if (item.kind === "agentMessage") {
      lastAgentIndex = index;
      lastAgent = item;
    }
  }
  return { hasDiff, lastDiffIndex, lastAgentIndex, lastAgent };
}

function hasGitConclusionAnchor(item: TimelineItem | null): boolean {
  if (item === null) return false;
  return item.rawText.includes("::git-stage") ||
    item.rawText.includes("::git-commit") ||
    item.text.includes("::git-stage") ||
    item.text.includes("::git-commit");
}

function contextCompactTimelineItem(input: {
  sessionId: string;
  requestId: string;
  status: TimelineItemStatus;
  text: string;
}): TimelineItem {
  const now = new Date().toISOString();
  const turnId = `${input.requestId}:context-compact-turn`;
  return {
    id: `${input.requestId}:context-compact-item`,
    sessionId: input.sessionId,
    turnId,
    kind: "contextCompaction",
    status: input.status,
    title: "上下文压缩",
    text: input.text,
    rawText: input.text,
    createdAt: now,
    updatedAt: now,
    isStreaming: input.status === "running",
    isCollapsedByDefault: true,
    command: null,
    diff: null,
    approval: null,
    planSteps: [],
    assetIds: []
  };
}

const commandAuditDetails: Record<ClientCommand["type"], { success: string; failed: string }> = {
  "codex.installedCapabilities.list": { success: "已读取本机已安装技能和插件", failed: "读取本机已安装技能和插件失败" },
  "codex.models.list": { success: "已读取 Codex 模型列表", failed: "读取 Codex 模型列表失败" },
  "projects.list": { success: "已读取项目列表", failed: "读取项目列表失败" },
  "projects.create": { success: "项目已创建", failed: "项目创建失败" },
  "projects.hide": { success: "项目已隐藏", failed: "项目隐藏失败" },
  "projects.unhide": { success: "项目已恢复显示", failed: "项目恢复显示失败" },
  "codex.accountUsage.refresh": { success: "已读取 Codex 账号用量", failed: "读取 Codex 账号用量失败" },
  "session.create": { success: "会话创建成功", failed: "会话创建失败" },
  "session.read": { success: "会话读取成功", failed: "会话读取失败" },
  "session.runtimeConfig.read": { success: "会话运行配置已读取", failed: "会话运行配置读取失败" },
  "session.runtimeConfig.update": { success: "会话运行配置已更新", failed: "会话运行配置更新失败" },
  "session.sync.enable": { success: "会话同步已开启", failed: "会话同步开启失败" },
  "session.sync.disable": { success: "会话详情实时同步已暂停", failed: "会话详情实时同步暂停失败" },
  "session.sync.unsubscribe": { success: "会话同步已关闭", failed: "会话同步关闭失败" },
  "session.rename": { success: "会话标题已更新", failed: "会话标题更新失败" },
  "session.sendText": { success: "文本干预已接收", failed: "文本干预发送失败" },
  "session.steer": { success: "运行中干预已接收", failed: "运行中干预发送失败" },
  "session.context.compact": { success: "上下文压缩请求已接收", failed: "上下文压缩请求失败" },
  "session.inputQueue.enqueue": { success: "输入已加入队列", failed: "输入加入队列失败" },
  "session.attachments.send": { success: "附件发送已接收", failed: "附件发送失败" },
  "session.inputQueue.cancel": { success: "队列输入已取消", failed: "队列输入取消失败" },
  "session.inputQueue.retry": { success: "队列输入已重试", failed: "队列输入重试失败" },
  "localWeb.open": { success: "本地 Web 代理会话已创建", failed: "本地 Web 代理会话创建失败" },
  "localWeb.close": { success: "本地 Web 代理会话已关闭", failed: "本地 Web 代理会话关闭失败" },
  "capture.screenshot": { success: "截图请求已接收", failed: "截图请求失败" },
  "session.interrupt": { success: "中断请求已接收", failed: "中断请求发送失败" },
  "session.pin": { success: "会话置顶状态已更新", failed: "会话置顶状态更新失败" },
  "approval.respond": { success: "审批响应已转发", failed: "审批响应转发失败" },
  "dev.approvalFixture.show": { success: "测试审批已显示", failed: "测试审批显示失败" },
  "dev.codexTurnInput.probe": { success: "Codex 输入探针已发送", failed: "Codex 输入探针发送失败" },
  "device.unbind": { success: "设备已解绑", failed: "设备解绑失败" }
};

export interface CommandRouterSessions {
  createThread?(input: { projectPath: string | null; text: string }): Promise<{ threadId: string }>;
  createSession(input: { projectPath: string | null; text: string; inputItems?: CodexTurnInputItem[]; runtimeConfig?: SessionRuntimeConfigInput; clientUserMessageId?: string }): Promise<{ threadId: string; turnId: string; status: string }>;
  readSessionDetail(threadId: string): Promise<SessionDetail>;
  startTurn(input: { threadId: string; skipPreflightResume?: boolean } & CodexTurnInputSource): Promise<unknown>;
  steerTurn(input: { threadId: string; turnId: string } & CodexTurnInputSource): Promise<unknown>;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<unknown>;
  compactContext?(input: { threadId: string }): Promise<unknown>;
  renameSession?(input: { threadId: string; title: string }): Promise<unknown>;
  recordApprovalRequest?(input: { id: string; method: CodexServerRequestMethod; params: Record<string, unknown> }): void;
  readPendingApproval?(threadId: string): TimelineItem["approval"] | null;
  forgetApprovalRequest?(approvalId: string): void;
  respondToApproval(approvalId: string, actionId: string, answers?: CodexApprovalAnswers, threadId?: string): void | Promise<unknown>;
}

type CommandRouterResult =
  | { kind: "session.created"; requestId: string; clientMessageId?: string; threadId: string; turnId?: string; status: string; projectPath: string | null; text: string; attachmentIds?: string[]; attachments?: StoredSessionAttachment[] }
  | { kind: "session.detail"; requestId: string; detail: SessionDetail }
  | { kind: "session.sync.enabled"; requestId: string; detail: SessionDetail; activeDetail: boolean }
  | { kind: "session.sync.disabled"; requestId: string; sessionId: string }
  | { kind: "session.sync.unsubscribed"; requestId: string; sessionId: string }
  | { kind: "session.renamed"; requestId: string; sessionId: string; title: string }
  | { kind: "session.context.compacted"; requestId: string; sessionId: string }
  | { kind: "message.received"; requestId: string; sessionId: string; messageId: string; text: string; sendState?: "guided"; attachmentIds?: string[]; attachments?: StoredSessionAttachment[] }
  | { kind: "installed.capabilities"; requestId: string; capabilities: InstalledCodexCapability[] }
  | { kind: "codex.models"; requestId: string; models: CodexModelOption[]; defaultModel: string | null }
  | { kind: "projects.snapshot"; requestId: string; roots: ReturnType<AppContext["projects"]["listRoots"]>; projects: ReturnType<AppContext["projects"]["listProjects"]> }
  | { kind: "project.created"; requestId: string; project: ReturnType<AppContext["projects"]["createProject"]>; roots: ReturnType<AppContext["projects"]["listRoots"]>; projects: ReturnType<AppContext["projects"]["listProjects"]> }
  | { kind: "project.visibility.updated"; requestId: string; project: ReturnType<AppContext["projects"]["hideProject"]>; roots: ReturnType<AppContext["projects"]["listRoots"]>; projects: ReturnType<AppContext["projects"]["listProjects"]> }
  | { kind: "codex.accountUsage"; requestId: string; usage: Awaited<ReturnType<AppContext["codex"]["readAccountUsage"]>> }
  | { kind: "runtime.config"; requestId: string; config: SessionRuntimeConfig }
  | { kind: "input.queue.updated"; requestId: string; sessionId: string; items: SessionInputQueueItem[] }
  | { kind: "local.web.session.updated"; requestId: string; session: StoredLocalWebSession }
  | { kind: "session.artifact.created"; requestId: string; sessionId: string; asset: PublicMediaAsset; attachment: StoredSessionAttachment }
  | { kind: "turn.status"; requestId: string; sessionId: string; turnId: string; status: "interrupted" }
  | null;

type BackgroundCommandFailure = {
  requestId: string;
  sessionId: string;
  clientMessageId?: string;
  message: string;
};

type BackgroundTurnStarted = {
  sessionId: string;
  turnId: string;
  status: string;
};

function readStartedTurn(value: unknown): { turnId: string; status: string } | null {
  const record = asRecord(value);
  let turnRecord = record;
  if (record.turn !== undefined) {
    turnRecord = asRecord(record.turn);
  }
  const turnId = stringField(turnRecord, "turnId") || stringField(turnRecord, "id");
  if (turnId.length === 0) return null;
  const status = statusLabelFromParams(turnRecord) || stringField(turnRecord, "status") || "running";
  return { turnId, status };
}

function readTurnId(value: unknown): string | null {
  return readStartedTurn(value)?.turnId ?? null;
}

function isIndeterminateCodexTurnRequestTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("Codex App Server request timed out: turn/start") ||
    error.message.includes("Codex App Server request timed out: turn/steer");
}

export function createCommandRouter(deps: {
  sessions: CommandRouterSessions;
  capabilities?: () => InstalledCodexCapability[];
  models?: () => Promise<{ models: CodexModelOption[]; defaultModel: string | null }>;
  projects?: AppContext["projects"];
  accountUsage?: AppContext["codex"]["readAccountUsage"];
  runtimeConfig?: AppContext["runtimeConfig"];
  runtimeConfigBaseline?: () => Promise<SessionRuntimeConfigInput>;
  queue?: AppContext["inputQueue"];
  localWebSessions?: AppContext["repositories"]["localWebSessions"];
  mediaAssets?: AppContext["mediaAssets"];
  sessionAttachments?: AppContext["repositories"]["sessionAttachments"];
  capture?: AppContext["capture"];
}) {
  const turnInputLifecycle = new CodexTurnInputLifecycleService();

  function guidedText(command: { text: string; guidance?: z.infer<typeof SessionInputGuidanceSchema> }): string {
    return buildGuidedInput({
      text: command.text,
      guidance: command.guidance ?? { mode: "plain", selectedCapabilityIds: [] },
      capabilities: deps.capabilities?.() ?? []
    });
  }

  function validateSelectedCapabilities(guidance: z.infer<typeof SessionInputGuidanceSchema>): void {
    if (guidance.selectedCapabilityIds.length === 0) return;
    buildGuidedInput({
      text: "capability validation",
      guidance: { mode: "guided", selectedCapabilityIds: guidance.selectedCapabilityIds },
      capabilities: deps.capabilities?.() ?? []
    });
  }

  async function readSessionDetailForCommand(threadId: string): Promise<SessionDetail> {
    let retryCount = 0;
    while (true) {
      try {
        return await deps.sessions.readSessionDetail(threadId);
      } catch (error) {
        if (!isThreadNotLoadedError(error) || retryCount >= FRESH_THREAD_DETAIL_RETRY_LIMIT) {
          throw error;
        }
        retryCount++;
        await delay(FRESH_THREAD_DETAIL_RETRY_DELAY_MS);
      }
    }
  }

  function shouldAcknowledgeSendTextAsGuided(command: { guidance?: z.infer<typeof SessionInputGuidanceSchema> }, turnId: string | undefined): boolean {
    return Boolean(turnId) && command.guidance?.mode === "steer-now";
  }

  async function refreshCachedActiveTurnBeforeOrdinarySend(sessionId: string): Promise<void> {
    if (!turnInputLifecycle.hasActiveTurn(sessionId)) return;
    try {
      const detail = await readSessionDetailForCommand(sessionId);
      const activeTurnId = activeTurnIdFromSessionDetail(detail);
      if (activeTurnId.length > 0) {
        turnInputLifecycle.noteTurnStarted(detail.session.id, activeTurnId);
        return;
      }
      if (detail.session.waitsForNextDirection || sessionStatusIndicatesIdle(detail.session.statusLabel)) {
        turnInputLifecycle.noteTurnCompleted(detail.session.id);
      }
    } catch {
      // Keep the cached active turn when the fresh detail read is unavailable.
    }
  }

  async function buildTurnInputWithAttachments(input: {
    sessionId: string;
    clientMessageId?: string;
    text: string;
    guidance?: z.infer<typeof SessionInputGuidanceSchema>;
    attachmentIds?: string[];
  }): Promise<{ inputItems: CodexTurnInputItem[]; attachments: StoredSessionAttachment[] }> {
    const baseText = guidedText(input);
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length === 0) {
      return { inputItems: [{ type: "text", text: baseText, text_elements: [] }], attachments: [] };
    }
    if (!deps.mediaAssets || !deps.sessionAttachments) {
      throw new Error("附件服务不可用");
    }
    const assets = deps.mediaAssets.listCodexAttachmentAssets(input.sessionId, attachmentIds);
    const builder = new CodexTurnInputBuilder({
      capability: { fileReferenceInput: true, legacyTextSnippetInput: false, imageInput: true }
    });
    const built = await builder.build({ text: baseText, assets });
    return {
      inputItems: built.items,
      attachments: storeAttachmentStatuses(input.sessionId, built.attachments)
    };
  }

  async function buildNewSessionDraftTurnInput(input: {
    text: string;
    attachmentIds: string[];
  }): Promise<{ inputItems: CodexTurnInputItem[]; statuses: CodexAttachmentStatus[] }> {
    const baseText = input.text;
    if (input.attachmentIds.length === 0) {
      return {
        inputItems: [{ type: "text", text: baseText, text_elements: [] }],
        statuses: []
      };
    }
    if (!deps.mediaAssets || !deps.sessionAttachments) {
      throw new Error("附件服务不可用");
    }
    const assets = deps.mediaAssets.listNewSessionDraftAttachmentAssets(input.attachmentIds);
    const builder = new CodexTurnInputBuilder({
      capability: { fileReferenceInput: true, legacyTextSnippetInput: false, imageInput: true }
    });
    const built = await builder.build({ text: baseText, assets });
    return { inputItems: built.items, statuses: built.attachments };
  }

  function storeAttachmentStatuses(sessionId: string, statuses: CodexAttachmentStatus[]): StoredSessionAttachment[] {
    if (!deps.sessionAttachments) throw new Error("附件服务不可用");
    const createdAt = new Date().toISOString();
    return statuses.map((status) => deps.sessionAttachments!.insert({
      id: attachmentRecordId(status.assetId),
      sessionId,
      assetId: status.assetId,
      role: "userUpload",
      codexInputStatus: status.codexInputStatus,
      codexInputMessage: status.codexInputMessage,
      createdAt
    }));
  }

  function attachmentRecordId(assetId: string): string {
    return `attachment-${assetId}`;
  }

  function storeArtifactAttachment(asset: PublicMediaAsset): StoredSessionAttachment {
    if (!deps.sessionAttachments) throw new Error("附件服务不可用");
    return deps.sessionAttachments.insert({
      id: attachmentRecordId(asset.id),
      sessionId: asset.sessionId,
      assetId: asset.id,
      role: "macArtifact",
      codexInputStatus: "notRequired",
      codexInputMessage: "截图产物已保存",
      createdAt: new Date().toISOString()
    });
  }

  function normalizeTurnInputSource(input: CodexTurnInputSource): CodexTurnInputSource {
    const clientUserMessageId = input.clientUserMessageId && input.clientUserMessageId.length > 0 ? input.clientUserMessageId : undefined;
    let normalized: CodexTurnInputSource;
    if (input.inputItems && input.inputItems.length > 0) {
      normalized = typeof input.text === "string" ? { text: input.text, inputItems: input.inputItems } : { inputItems: input.inputItems };
    } else if (typeof input.text === "string" && input.text.length > 0) {
      normalized = { text: input.text };
    } else {
      throw new Error("Codex turn input must include text or inputItems");
    }
    if (clientUserMessageId) {
      return { ...normalized, clientUserMessageId };
    }
    return normalized;
  }

  async function startSessionTurn(
    sessionId: string,
    input: CodexTurnInputSource,
    skipPreflightResume: boolean = false
  ): Promise<BackgroundTurnStarted | null> {
    const previousTurnId = turnInputLifecycle.activeTurnId(sessionId);
    const turnInput = normalizeTurnInputSource(input);
    const startInput: { threadId: string; skipPreflightResume?: boolean } & CodexTurnInputSource = {
      threadId: sessionId,
      ...turnInput
    };
    if (skipPreflightResume) {
      startInput.skipPreflightResume = true;
    }
    turnInputLifecycle.noteTurnStartRequested(sessionId);
    try {
      const started = await deps.sessions.startTurn(startInput);
      const startedTurn = readStartedTurn(started);
      if (startedTurn !== null) {
        turnInputLifecycle.noteTurnStartedFromStartResponse(sessionId, startedTurn.turnId, previousTurnId);
        return { sessionId, turnId: startedTurn.turnId, status: startedTurn.status };
      }
      turnInputLifecycle.noteTurnStartFailed(sessionId);
      return null;
    } catch (error) {
      if (isIndeterminateCodexTurnRequestTimeout(error)) return null;
      turnInputLifecycle.noteTurnStartFailed(sessionId);
      throw error;
    }
  }

  async function steerActiveTurnOrStart(input: { sessionId: string; turnId: string | undefined } & CodexTurnInputSource): Promise<void> {
    const turnInput = normalizeTurnInputSource(input);
    if (input.turnId) {
      try {
        await deps.sessions.steerTurn({ threadId: input.sessionId, turnId: input.turnId, ...turnInput });
        return;
      } catch (error) {
        if (isIndeterminateCodexTurnRequestTimeout(error)) return;
        if (!isMissingThreadOrTurnError(error)) throw error;
        turnInputLifecycle.noteActiveTurnMissing(input.sessionId);
      }
    }
    await startSessionTurn(input.sessionId, turnInput);
  }

  async function steerActiveTurnWithExpectedRetry(input: { sessionId: string; turnId: string } & CodexTurnInputSource): Promise<void> {
    const turnInput = normalizeTurnInputSource(input);
    try {
      await deps.sessions.steerTurn({ threadId: input.sessionId, turnId: input.turnId, ...turnInput });
      return;
    } catch (error) {
      if (isIndeterminateCodexTurnRequestTimeout(error)) return;
      const refreshedTurnId = activeTurnIdFromMismatchError(error);
      if (refreshedTurnId) {
        turnInputLifecycle.noteTurnStarted(input.sessionId, refreshedTurnId);
        try {
          await deps.sessions.steerTurn({ threadId: input.sessionId, turnId: refreshedTurnId, ...turnInput });
          return;
        } catch (retryError) {
          if (isIndeterminateCodexTurnRequestTimeout(retryError)) return;
          if (isMissingThreadOrTurnError(retryError)) turnInputLifecycle.noteActiveTurnMissing(input.sessionId);
          throw retryError;
        }
      }
      if (isMissingThreadOrTurnError(error)) turnInputLifecycle.noteActiveTurnMissing(input.sessionId);
      throw error;
    }
  }

  function guidanceForQueuedPlainSend(command: { guidance?: z.infer<typeof SessionInputGuidanceSchema> }): z.infer<typeof SessionInputGuidanceSchema> {
    return {
      mode: "queued",
      selectedCapabilityIds: command.guidance?.selectedCapabilityIds ?? []
    };
  }

  function queueOrdinaryInputForNextTurn(command: {
    requestId: string;
    sessionId: string;
    clientMessageId: string;
    text: string;
    guidance?: z.infer<typeof SessionInputGuidanceSchema>;
  }): CommandRouterResult {
    if (!deps.queue) throw new Error("输入队列服务不可用");
    const guidance = guidanceForQueuedPlainSend(command);
    validateSelectedCapabilities(guidance);
    deps.queue.enqueue({
      sessionId: command.sessionId,
      clientMessageId: command.clientMessageId,
      text: command.text,
      guidance
    });
    return { kind: "input.queue.updated", requestId: command.requestId, sessionId: command.sessionId, items: deps.queue.list(command.sessionId) };
  }

  function approvalParamsWithActiveTurnFallback(params: Record<string, unknown>): Record<string, unknown> {
    let sessionId = sessionIdFromParams(params);
    const turnId = turnIdFromParams(params);
    if (sessionId.length === 0 && turnId.length > 0) {
      sessionId = turnInputLifecycle.sessionIdForTurn(turnId) ?? "";
    }
    if (sessionId.length === 0) {
      sessionId = turnInputLifecycle.singleActiveSessionId() ?? "";
    }
    if (sessionId.length === 0) return params;
    if (turnId.length > 0) {
      return sessionIdFromParams(params).length > 0 ? params : { ...params, threadId: sessionId };
    }
    const activeTurnId = turnInputLifecycle.activeTurnId(sessionId);
    const withSessionId = sessionIdFromParams(params).length > 0 ? params : { ...params, threadId: sessionId };
    if (!activeTurnId) return withSessionId;
    return { ...withSessionId, turnId: activeTurnId };
  }

  async function ensureRuntimeConfigBaseline(sessionId: string): Promise<void> {
    if (!deps.runtimeConfig || !deps.runtimeConfigBaseline) return;
    if (deps.runtimeConfig.hasUserOverride(sessionId) || deps.runtimeConfig.hasCodexSessionConfig(sessionId)) return;
    const baseline = await deps.runtimeConfigBaseline();
    deps.runtimeConfig.saveCodexSessionConfig(sessionId, baseline, "codex-default-snapshot");
  }

  async function activeTurnIdForInterrupt(sessionId: string, preferredTurnId?: string): Promise<string | undefined> {
    if (preferredTurnId && preferredTurnId.length > 0) return preferredTurnId;
    const currentTurnId = turnInputLifecycle.activeTurnId(sessionId);
    if (currentTurnId) return currentTurnId;
    const detail = await readSessionDetailForCommand(sessionId);
    const inferredTurnId = activeTurnIdFromSessionDetail(detail);
    if (inferredTurnId.length > 0) {
      turnInputLifecycle.noteTurnStarted(sessionId, inferredTurnId);
      return inferredTurnId;
    }
    return undefined;
  }

  return {
    noteTurnStarted(sessionId: string, turnId: string): void {
      turnInputLifecycle.noteTurnStarted(sessionId, turnId);
    },

    noteTurnCompleted(sessionId: string, turnId?: string): void {
      turnInputLifecycle.noteTurnCompleted(sessionId, turnId);
    },

    noteTurnStartRequested(sessionId: string): void {
      turnInputLifecycle.noteTurnStartRequested(sessionId);
    },

    noteTurnStartFailed(sessionId: string): void {
      turnInputLifecycle.noteTurnStartFailed(sessionId);
    },

    hasActiveTurn(sessionId: string): boolean {
      return turnInputLifecycle.hasActiveTurn(sessionId);
    },

    canStartNewTurn(sessionId: string): boolean {
      return turnInputLifecycle.canStartNewTurn(sessionId);
    },

    canDrainQueueAfterTerminal(sessionId: string, terminalTurnId?: string): boolean {
      return turnInputLifecycle.canDrainQueueAfterTerminal(sessionId, terminalTurnId);
    },

    activeTurnId(sessionId: string): string | undefined {
      return turnInputLifecycle.activeTurnId(sessionId);
    },

    noteTurnStartedFromStartResponse(sessionId: string, turnId: string, previousTurnId: string | undefined): void {
      turnInputLifecycle.noteTurnStartedFromStartResponse(sessionId, turnId, previousTurnId);
    },

    noteApprovalRequest(input: { id: string; method: CodexServerRequestMethod; params: Record<string, unknown> }): Record<string, unknown> {
      const params = approvalParamsWithActiveTurnFallback(input.params);
      deps.sessions.recordApprovalRequest?.({
        id: input.id,
        method: input.method,
        params
      });
      return params;
    },

    noteApprovalResolved(approvalId: string): void {
      deps.sessions.forgetApprovalRequest?.(approvalId);
    },

    async handle(
      command: ClientCommand,
      onBackgroundFailure?: (failure: BackgroundCommandFailure) => void,
      onBackgroundTurnStarted?: (started: BackgroundTurnStarted) => void
    ): Promise<CommandRouterResult> {
      if (command.type === "codex.installedCapabilities.list") {
        return { kind: "installed.capabilities", requestId: command.requestId, capabilities: deps.capabilities?.() ?? [] };
      }

      if (command.type === "codex.models.list") {
        if (!deps.models) throw new Error("模型列表服务不可用");
        const snapshot = await deps.models();
        return {
          kind: "codex.models",
          requestId: command.requestId,
          models: snapshot.models,
          defaultModel: snapshot.defaultModel
        };
      }

      if (command.type === "dev.codexTurnInput.probe") {
        if (process.env.CODE_ENABLE_DEV_PROBES !== "1") {
          throw new Error("dev Codex turn input probe is disabled");
        }
        const inputItems = command.input as unknown as CodexTurnInputItem[];
        const turnId = turnInputLifecycle.activeTurnId(command.sessionId);
        if (turnId) {
          await deps.sessions.steerTurn({ threadId: command.sessionId, turnId, inputItems });
        } else {
          turnInputLifecycle.noteTurnStartRequested(command.sessionId);
          try {
            const started = await deps.sessions.startTurn({ threadId: command.sessionId, inputItems });
            const startedTurnId = readTurnId(started);
            if (startedTurnId) turnInputLifecycle.noteTurnStartedFromStartResponse(command.sessionId, startedTurnId, undefined);
            else turnInputLifecycle.noteTurnStartFailed(command.sessionId);
          } catch (error) {
            turnInputLifecycle.noteTurnStartFailed(command.sessionId);
            throw error;
          }
        }
        return {
          kind: "message.received",
          requestId: command.requestId,
          sessionId: command.sessionId,
          messageId: command.requestId,
          text: "dev Codex turn input probe",
          sendState: turnId ? "guided" : undefined
        };
      }

      if (command.type === "projects.list") {
        if (!deps.projects) throw new Error("项目服务不可用");
        return {
          kind: "projects.snapshot",
          requestId: command.requestId,
          roots: deps.projects.listRoots(),
          projects: deps.projects.listProjects()
        };
      }

      if (command.type === "projects.create") {
        if (!deps.projects) throw new Error("项目服务不可用");
        const project = deps.projects.createProject({
          rootId: command.rootId,
          projectName: command.projectName
        });
        return {
          kind: "project.created",
          requestId: command.requestId,
          project,
          roots: deps.projects.listRoots(),
          projects: deps.projects.listProjects()
        };
      }

      if (command.type === "projects.hide") {
        if (!deps.projects) throw new Error("项目服务不可用");
        const project = deps.projects.hideProject(command.projectPath);
        return {
          kind: "project.visibility.updated",
          requestId: command.requestId,
          project,
          roots: deps.projects.listRoots(),
          projects: deps.projects.listProjects()
        };
      }

      if (command.type === "projects.unhide") {
        if (!deps.projects) throw new Error("项目服务不可用");
        const project = deps.projects.unhideProject(command.projectPath);
        return {
          kind: "project.visibility.updated",
          requestId: command.requestId,
          project,
          roots: deps.projects.listRoots(),
          projects: deps.projects.listProjects()
        };
      }

      if (command.type === "codex.accountUsage.refresh") {
        if (!deps.accountUsage) throw new Error("账号用量服务不可用");
        return {
          kind: "codex.accountUsage",
          requestId: command.requestId,
          usage: await deps.accountUsage()
        };
      }

      if (command.type === "session.runtimeConfig.read") {
        if (!deps.runtimeConfig) throw new Error("运行配置服务不可用");
        await ensureRuntimeConfigBaseline(command.sessionId);
        return { kind: "runtime.config", requestId: command.requestId, config: deps.runtimeConfig.get(command.sessionId) };
      }

      if (command.type === "session.runtimeConfig.update") {
        if (!deps.runtimeConfig) throw new Error("运行配置服务不可用");
        const snapshot = command.config.model !== null && deps.models ? await deps.models() : undefined;
        return {
          kind: "runtime.config",
          requestId: command.requestId,
          config: deps.runtimeConfig.update(command.sessionId, command.config, snapshot ? { models: snapshot.models } : undefined)
        };
      }

      if (command.type === "session.create") {
        const attachmentIds = command.attachmentIds ?? [];
        const createText = guidedText(command);
        const clientUserMessageId = createClientMessageId(command);
        const draftAttachmentInput = await buildNewSessionDraftTurnInput({
          text: createText,
          attachmentIds
        });
        if (deps.sessions.createThread) {
          const createdThread = await deps.sessions.createThread({
            projectPath: command.projectPath,
            text: createText
          });
          let attachments: StoredSessionAttachment[] = [];
          if (attachmentIds.length > 0) {
            if (!deps.mediaAssets || !deps.sessionAttachments) {
              throw new Error("附件服务不可用");
            }
            deps.mediaAssets.assignNewSessionDraftAssets(attachmentIds, createdThread.threadId);
            attachments = storeAttachmentStatuses(createdThread.threadId, draftAttachmentInput.statuses);
          }
          if (command.runtimeConfig && deps.runtimeConfig) {
            deps.runtimeConfig.update(createdThread.threadId, command.runtimeConfig);
          }
          const launch = async (): Promise<void> => {
            const started = await startSessionTurn(createdThread.threadId, { inputItems: draftAttachmentInput.inputItems, clientUserMessageId }, true);
            if (started !== null) {
              onBackgroundTurnStarted?.(started);
            }
          };
          void launch().catch((error) => {
            onBackgroundFailure?.({
              requestId: command.requestId,
              sessionId: createdThread.threadId,
              clientMessageId: createClientMessageId(command) ?? command.requestId,
              message: error instanceof Error ? error.message : "Codex 指令发送失败"
            });
          });
          return {
            kind: "session.created",
            requestId: command.requestId,
            ...(clientUserMessageId ? { clientMessageId: clientUserMessageId } : {}),
            threadId: createdThread.threadId,
            status: "running",
            projectPath: command.projectPath,
            text: command.text,
            ...(command.attachmentIds && command.attachmentIds.length > 0 ? { attachmentIds: command.attachmentIds } : {}),
            ...(attachments.length > 0 ? { attachments } : {})
          };
        }
        const created = await deps.sessions.createSession({
          projectPath: command.projectPath,
          text: createText,
          inputItems: draftAttachmentInput.inputItems,
          runtimeConfig: command.runtimeConfig,
          clientUserMessageId
        });
        let attachments: StoredSessionAttachment[] = [];
        if (attachmentIds.length > 0) {
          if (!deps.mediaAssets || !deps.sessionAttachments) {
            throw new Error("附件服务不可用");
          }
          deps.mediaAssets.assignNewSessionDraftAssets(attachmentIds, created.threadId);
          attachments = storeAttachmentStatuses(created.threadId, draftAttachmentInput.statuses);
        }
        if (command.runtimeConfig && deps.runtimeConfig) {
          deps.runtimeConfig.update(created.threadId, command.runtimeConfig);
        }
        turnInputLifecycle.noteTurnStartedFromStartResponse(created.threadId, created.turnId, undefined);
        return {
          kind: "session.created",
          requestId: command.requestId,
          ...(clientUserMessageId ? { clientMessageId: clientUserMessageId } : {}),
          threadId: created.threadId,
          turnId: created.turnId,
          status: created.status,
          projectPath: command.projectPath,
          text: command.text,
          ...(command.attachmentIds && command.attachmentIds.length > 0 ? { attachmentIds: command.attachmentIds } : {}),
          ...(attachments.length > 0 ? { attachments } : {})
        };
      }

      if (command.type === "session.read") {
        return {
          kind: "session.detail",
          requestId: command.requestId,
          detail: await readSessionDetailForCommand(command.sessionId)
        };
      }

      if (command.type === "session.sync.enable") {
        return {
          kind: "session.sync.enabled",
          requestId: command.requestId,
          detail: await readSessionDetailForCommand(command.sessionId),
          activeDetail: command.activeDetail !== false
        };
      }

      if (command.type === "session.sync.disable") {
        return { kind: "session.sync.disabled", requestId: command.requestId, sessionId: command.sessionId };
      }

      if (command.type === "session.sync.unsubscribe") {
        return { kind: "session.sync.unsubscribed", requestId: command.requestId, sessionId: command.sessionId };
      }

      if (command.type === "session.rename") {
        if (!deps.sessions.renameSession) throw new Error("当前 Codex 通道不支持修改会话标题");
        await deps.sessions.renameSession({ threadId: command.sessionId, title: command.title });
        return { kind: "session.renamed", requestId: command.requestId, sessionId: command.sessionId, title: command.title };
      }

      if (command.type === "session.sendText") {
        if (command.guidance?.mode !== "steer-now" && !turnInputLifecycle.canStartNewTurn(command.sessionId)) {
          await refreshCachedActiveTurnBeforeOrdinarySend(command.sessionId);
        }
        const turnId = turnInputLifecycle.activeTurnId(command.sessionId);
        const wantsSteerNow = command.guidance?.mode === "steer-now";
        if (wantsSteerNow && !turnId) {
          throw new Error("当前会话没有运行中的 Codex turn");
        }
        const shouldSteerNow = shouldAcknowledgeSendTextAsGuided(command, turnId);
        if (!turnInputLifecycle.canStartNewTurn(command.sessionId) && !shouldSteerNow) {
          if (command.attachmentIds && command.attachmentIds.length > 0) {
            throw new Error("附件不能排队发送。请移除附件后加入队列，或使用立即干预发送附件。");
          }
          return queueOrdinaryInputForNextTurn(command);
        }
        const attachmentInput = await buildTurnInputWithAttachments(command);
        const launch = async (): Promise<void> => {
          if (shouldSteerNow) {
            await steerActiveTurnWithExpectedRetry({ sessionId: command.sessionId, turnId: turnId!, inputItems: attachmentInput.inputItems, clientUserMessageId: command.clientMessageId });
            return;
          }
          const started = await startSessionTurn(
            command.sessionId,
            { inputItems: attachmentInput.inputItems, clientUserMessageId: command.clientMessageId },
            command.skipPreflightResume === true
          );
          if (started !== null) {
            onBackgroundTurnStarted?.(started);
          }
        };
        void launch().catch((error) => {
          onBackgroundFailure?.({
            requestId: command.requestId,
            sessionId: command.sessionId,
            clientMessageId: command.clientMessageId,
            message: error instanceof Error ? error.message : "Codex 指令发送失败"
          });
        });
        return {
          kind: "message.received",
          requestId: command.requestId,
          sessionId: command.sessionId,
          messageId: command.clientMessageId,
          text: command.text,
          ...(command.attachmentIds && command.attachmentIds.length > 0 ? { attachmentIds: command.attachmentIds } : {}),
          ...(attachmentInput.attachments.length > 0 ? { attachments: attachmentInput.attachments } : {}),
          ...(shouldSteerNow ? { sendState: "guided" as const } : {})
        };
      }

      if (command.type === "session.steer") {
        const turnId = turnInputLifecycle.activeTurnId(command.sessionId);
        if (!turnId) throw new Error("当前会话没有运行中的 Codex turn");
        const text = guidedText(command);
        const launch = async (): Promise<void> => {
          await steerActiveTurnWithExpectedRetry({ sessionId: command.sessionId, turnId, text, clientUserMessageId: command.clientMessageId });
        };
        void launch().catch((error) => {
          onBackgroundFailure?.({
            requestId: command.requestId,
            sessionId: command.sessionId,
            clientMessageId: command.clientMessageId,
            message: error instanceof Error ? error.message : "Codex 指令发送失败"
          });
        });
        return { kind: "message.received", requestId: command.requestId, sessionId: command.sessionId, messageId: command.clientMessageId, text: command.text, sendState: "guided" };
      }

      if (command.type === "session.context.compact") {
        if (!deps.sessions.compactContext) {
          throw new Error("当前 Codex 通道不支持压缩上下文");
        }
        await deps.sessions.compactContext({ threadId: command.sessionId });
        return { kind: "session.context.compacted", requestId: command.requestId, sessionId: command.sessionId };
      }

      if (command.type === "session.inputQueue.enqueue") {
        if (!deps.queue) throw new Error("输入队列服务不可用");
        validateSelectedCapabilities(command.guidance);
        deps.queue.enqueue({
          sessionId: command.sessionId,
          clientMessageId: command.clientMessageId,
          text: command.text,
          guidance: command.guidance
        });
        return { kind: "input.queue.updated", requestId: command.requestId, sessionId: command.sessionId, items: deps.queue.list(command.sessionId) };
      }

      if (command.type === "session.inputQueue.cancel") {
        if (!deps.queue) throw new Error("输入队列服务不可用");
        deps.queue.cancel(command.sessionId, command.queueItemId);
        return { kind: "input.queue.updated", requestId: command.requestId, sessionId: command.sessionId, items: deps.queue.list(command.sessionId) };
      }

      if (command.type === "session.inputQueue.retry") {
        if (!deps.queue) throw new Error("输入队列服务不可用");
        deps.queue.retry(command.sessionId, command.queueItemId);
        return { kind: "input.queue.updated", requestId: command.requestId, sessionId: command.sessionId, items: deps.queue.list(command.sessionId) };
      }

      if (command.type === "session.attachments.send") {
        const turnId = turnInputLifecycle.activeTurnId(command.sessionId);
        const attachmentInput = await buildTurnInputWithAttachments({
          sessionId: command.sessionId,
          clientMessageId: command.clientMessageId,
          text: "请查看这些附件。",
          attachmentIds: command.attachmentIds
        });
        const launch = async (): Promise<void> => {
          await steerActiveTurnOrStart({ sessionId: command.sessionId, turnId, inputItems: attachmentInput.inputItems, clientUserMessageId: command.clientMessageId });
        };
        void launch().catch((error) => {
          onBackgroundFailure?.({
            requestId: command.requestId,
            sessionId: command.sessionId,
            clientMessageId: command.clientMessageId,
            message: error instanceof Error ? error.message : "Codex 指令发送失败"
          });
        });
        return {
          kind: "message.received",
          requestId: command.requestId,
          sessionId: command.sessionId,
          messageId: command.clientMessageId,
          text: "请查看这些附件。",
          attachmentIds: command.attachmentIds,
          ...(attachmentInput.attachments.length > 0 ? { attachments: attachmentInput.attachments } : {}),
          ...(turnId ? { sendState: "guided" as const } : {})
        };
      }

      if (command.type === "localWeb.open") {
        if (!deps.localWebSessions) throw new Error("本地 Web 会话服务不可用");
        const target = classifyLocalWebTarget(command.targetUrl);
        if (!target.allowed) throw new Error("只能打开桌面端本机开发链接");
        const id = "local-web-" + nanoid(12);
        const now = new Date().toISOString();
        const session = deps.localWebSessions.insert({
          id,
          sessionId: command.sessionId,
          targetUrl: target.normalizedUrl,
          proxyUrl: `/local-web/${id}/`,
          status: "active",
          createdAt: now,
          updatedAt: now,
          error: ""
        });
        return { kind: "local.web.session.updated", requestId: command.requestId, session };
      }

      if (command.type === "localWeb.close") {
        if (!deps.localWebSessions) throw new Error("本地 Web 会话服务不可用");
        const existing = deps.localWebSessions.get(command.localWebSessionId);
        if (!existing) throw new Error("本地 Web 会话不存在或已关闭");
        const updatedAt = new Date().toISOString();
        deps.localWebSessions.updateStatus({
          id: command.localWebSessionId,
          status: "closed",
          updatedAt,
          error: ""
        });
        return {
          kind: "local.web.session.updated",
          requestId: command.requestId,
          session: { ...existing, status: "closed", updatedAt, error: "" }
        };
      }

      if (command.type === "capture.screenshot") {
        if (!deps.capture) throw new Error("截图服务不可用");
        const asset = command.target === "localWeb"
          ? await deps.capture.captureLocalWebScreenshot({
            sessionId: command.sessionId,
            localWebSessionId: command.localWebSessionId ?? "",
            deviceId: "mobile"
          })
          : await deps.capture.captureScreenScreenshot({
            sessionId: command.sessionId,
            deviceId: "mobile",
            userConfirmed: command.userConfirmed
          });
        return {
          kind: "session.artifact.created",
          requestId: command.requestId,
          sessionId: command.sessionId,
          asset,
          attachment: storeArtifactAttachment(asset)
        };
      }

      if (command.type === "session.interrupt") {
        if (command.targetKind === "startup") {
          await deps.sessions.interruptTurn({ threadId: command.sessionId, turnId: "" });
          return null;
        }
        const turnId = await activeTurnIdForInterrupt(command.sessionId, command.turnId);
        if (!turnId) throw new Error("当前会话没有可中断的 Codex turn");
        await deps.sessions.interruptTurn({ threadId: command.sessionId, turnId });
        turnInputLifecycle.markInterruptRequested(command.sessionId, turnId);
        return null;
      }

      if (command.type === "approval.respond") {
        await deps.sessions.respondToApproval(command.approvalId, command.actionId, command.answers, command.sessionId);
      }
      return null;
    }
  };
}

function unwrapIpcResponse(response: unknown): unknown {
  const record = asRecord(response);
  if (record.resultType === "error") {
    const error = typeof record.error === "string" ? record.error : "desktop-follower-request-failed";
    throw new Error(error);
  }
  if (record.result !== undefined) return record.result;
  return response;
}

function isThreadNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("thread not found");
}

function isThreadNotLoadedError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("thread not loaded");
}

function isMissingThreadOrTurnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("thread not found") ||
    message.includes("turn not found") ||
    message.includes("no active turn to steer");
}

function activeTurnIdFromMismatchError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/expected active turn id [`'"]?([^`'"]+)[`'"]? but found [`'"]?([^`'"]+)[`'"]?/i);
  return match?.[2] ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function desktopStateForThread(desktopFollower: CodexDesktopFollowerBridge | null, threadId: string): Record<string, unknown> | null {
  return desktopFollower?.getConversationState(threadId) ?? null;
}

function isTerminalTurn(turn: SessionTurn): boolean {
  return turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted";
}

function needsLocalTimingHydration(detail: SessionDetail): boolean {
  for (const turn of detail.turns) {
    if (isTerminalTurn(turn) && turn.completedAt === null) return true;
  }
  return false;
}

function latestItemUpdatedAt(turn: SessionTurn): string | null {
  let latestMs = 0;
  let latestIso: string | null = null;
  for (const item of turn.items) {
    const parsed = Date.parse(item.updatedAt);
    if (Number.isFinite(parsed) && parsed > latestMs) {
      latestMs = parsed;
      latestIso = item.updatedAt;
    }
  }
  return latestIso;
}

function localCompletedAt(turn: SessionTurn): string | null {
  if (turn.completedAt !== null) return turn.completedAt;
  if (!isTerminalTurn(turn)) return null;
  const latest = latestItemUpdatedAt(turn);
  if (latest === null) return null;
  if (turn.startedAt !== null && Date.parse(latest) <= Date.parse(turn.startedAt)) return null;
  return latest;
}

function hydrateDesktopDetailTiming(desktopDetail: SessionDetail, localDetail: SessionDetail): SessionDetail {
  const localTurnsById = new Map<string, SessionTurn>();
  for (const localTurn of localDetail.turns) {
    localTurnsById.set(localTurn.id, localTurn);
  }
  return {
    ...desktopDetail,
    turns: desktopDetail.turns.map((desktopTurn) => {
      if (!isTerminalTurn(desktopTurn) || desktopTurn.completedAt !== null) return desktopTurn;
      const localTurn = localTurnsById.get(desktopTurn.id);
      if (!localTurn) return desktopTurn;
      const completedAt = localCompletedAt(localTurn);
      if (completedAt === null) return desktopTurn;
      return {
        ...desktopTurn,
        startedAt: desktopTurn.startedAt ?? localTurn.startedAt,
        completedAt
      };
    })
  };
}

class DetailReadFallbackTimeoutError extends Error {
  constructor() {
    super("Codex shared detail read timed out before fallback");
  }
}

async function withDetailReadFallbackTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DetailReadFallbackTimeoutError());
    }, timeoutMs);

    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function readSessionDetailWithFreshRuntime(
  createFreshRuntime: () => Promise<CodexRuntimeHandle>,
  threadId: string
): Promise<SessionDetail> {
  const runtime = await createFreshRuntime();
  try {
    return await runtime.sessions.readSessionDetail(threadId);
  } finally {
    await runtime.stop();
  }
}

export interface FollowerAwareSessionOptions {
  detailReadFallbackTimeoutMs?: number;
}

export function createFollowerAwareSessions(
  localSessions: CommandRouterSessions,
  desktopFollower: CodexDesktopFollowerBridge | null,
  createFreshRuntime?: () => Promise<CodexRuntimeHandle>,
  options: FollowerAwareSessionOptions = {}
): CommandRouterSessions {
  const detailReadFallbackTimeoutMs = options.detailReadFallbackTimeoutMs ?? DEFAULT_DETAIL_READ_FALLBACK_TIMEOUT_MS;
  const detailWithLocalPendingApproval = (threadId: string, detail: SessionDetail): SessionDetail => {
    const approval = localSessions.readPendingApproval?.(threadId) ?? null;
    if (!approval) return detail;
    return { ...detail, session: sessionWithApprovalPendingState(detail.session, approval), approval };
  };
  const readLocalDetail = async (threadId: string): Promise<SessionDetail> => {
    if (createFreshRuntime) {
      return detailWithLocalPendingApproval(threadId, await readSessionDetailWithFreshRuntime(createFreshRuntime, threadId));
    }
    return localSessions.readSessionDetail(threadId);
  };

  return {
    ...(localSessions.createThread ? { createThread: (input: { projectPath: string | null; text: string }) => localSessions.createThread!(input) } : {}),
    createSession: (input) => localSessions.createSession(input),
    async readSessionDetail(threadId: string): Promise<SessionDetail> {
      const desktopState = desktopStateForThread(desktopFollower, threadId);
      if (desktopState) {
        const desktopDetail = sessionDetailFromDesktopConversationState(desktopState);
        if (!needsLocalTimingHydration(desktopDetail)) return desktopDetail;
        try {
          const localDetail = await withDetailReadFallbackTimeout(
            readLocalDetail(threadId),
            detailReadFallbackTimeoutMs
          );
          return hydrateDesktopDetailTiming(desktopDetail, localDetail);
        } catch {
          return desktopDetail;
        }
      }
      if (createFreshRuntime) {
        return detailWithLocalPendingApproval(threadId, await readSessionDetailWithFreshRuntime(createFreshRuntime, threadId));
      }
      return localSessions.readSessionDetail(threadId);
    },
    async startTurn(input: { threadId: string } & CodexTurnInputSource): Promise<unknown> {
      if (desktopStateForThread(desktopFollower, input.threadId)) {
        try {
          return unwrapIpcResponse(await desktopFollower?.startTurn(input));
        } catch (error) {
          if (!isThreadNotFoundError(error)) throw error;
          return localSessions.startTurn(input);
        }
      }
      return localSessions.startTurn(input);
    },
    async steerTurn(input: { threadId: string; turnId: string } & CodexTurnInputSource): Promise<unknown> {
      if (desktopStateForThread(desktopFollower, input.threadId)) {
        try {
          return unwrapIpcResponse(await desktopFollower?.steerTurn(input));
        } catch (error) {
          if (!isThreadNotFoundError(error)) throw error;
          return localSessions.steerTurn(input);
        }
      }
      return localSessions.steerTurn(input);
    },
    async interruptTurn(input: { threadId: string; turnId: string }): Promise<unknown> {
      if (desktopStateForThread(desktopFollower, input.threadId)) {
        return unwrapIpcResponse(await desktopFollower?.interruptTurn(input));
      }
      return localSessions.interruptTurn(input);
    },
    async compactContext(input: { threadId: string }): Promise<unknown> {
      if (desktopStateForThread(desktopFollower, input.threadId)) {
        return unwrapIpcResponse(await desktopFollower?.compactContext(input));
      }
      if (localSessions.compactContext) {
        return localSessions.compactContext(input);
      }
      if (desktopFollower) {
        try {
          return unwrapIpcResponse(await desktopFollower.compactContext(input));
        } catch {
          throw new Error("当前 Codex 通道不支持压缩上下文");
        }
      }
      throw new Error("当前 Codex 通道不支持压缩上下文");
    },
    async renameSession(input: { threadId: string; title: string }): Promise<unknown> {
      if (desktopStateForThread(desktopFollower, input.threadId)) {
        return { skipped: true, reason: "desktop-owned-session" };
      }
      if (!localSessions.renameSession) throw new Error("当前 Codex 通道不支持修改会话标题");
      return localSessions.renameSession(input);
    },
    recordApprovalRequest(input: { id: string; method: CodexServerRequestMethod; params: Record<string, unknown> }): void {
      localSessions.recordApprovalRequest?.(input);
    },
    readPendingApproval(threadId: string): TimelineItem["approval"] | null {
      return localSessions.readPendingApproval?.(threadId) ?? null;
    },
    forgetApprovalRequest(approvalId: string): void {
      localSessions.forgetApprovalRequest?.(approvalId);
    },
    async respondToApproval(approvalId: string, actionId: string, answers?: CodexApprovalAnswers, threadId?: string): Promise<unknown> {
      const desktopState = threadId ? desktopStateForThread(desktopFollower, threadId) : null;
      if (threadId && desktopState) {
        return unwrapIpcResponse(await desktopFollower?.respondToApproval({
          threadId,
          approvalId,
          actionId,
          answers: answers as Record<string, unknown> | undefined
        }));
      }
      return localSessions.respondToApproval(approvalId, actionId, answers, threadId);
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown>, fieldName: string): string {
  const value = record[fieldName];
  return typeof value === "string" ? value : "";
}

function stringOrNumberField(record: Record<string, unknown>, fieldName: string): string {
  const value = record[fieldName];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function optionalStringField(record: Record<string, unknown>, fieldName: string): string | null {
  const value = stringField(record, fieldName);
  return value.length > 0 ? value : null;
}

function firstApprovalAnswerText(answers: CodexApprovalAnswers | undefined, fieldId: string): string {
  if (!answers) return "";
  const field = answers[fieldId];
  if (!field) return "";
  for (const answer of field.answers) {
    const trimmed = answer.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function approvalDeclineReasonFromAnswers(answers: CodexApprovalAnswers | undefined): string {
  const preferred = firstApprovalAnswerText(answers, "reason") ||
    firstApprovalAnswerText(answers, "declineReason") ||
    firstApprovalAnswerText(answers, "adjustment") ||
    firstApprovalAnswerText(answers, "answer");
  if (preferred.length > 0) return preferred;
  if (!answers) return "";
  for (const key of Object.keys(answers)) {
    const value = firstApprovalAnswerText(answers, key);
    if (value.length > 0) return value;
  }
  return "";
}

function sessionIdFromParams(params: Record<string, unknown>): string {
  return stringField(params, "threadId") || stringField(params, "sessionId") || stringField(params, "conversationId");
}

function turnIdFromParams(params: Record<string, unknown>): string {
  const turn = asRecord(params.turn);
  return stringField(params, "turnId") || stringField(turn, "id") || stringField(turn, "turnId");
}

function requestIdFromParams(params: Record<string, unknown>): string {
  const direct = stringOrNumberField(params, "requestId") ||
    stringOrNumberField(params, "serverRequestId") ||
    stringOrNumberField(params, "id");
  if (direct.length > 0) return direct;
  const request = asRecord(params.request);
  const nestedRequest = stringOrNumberField(request, "requestId") ||
    stringOrNumberField(request, "serverRequestId") ||
    stringOrNumberField(request, "id");
  if (nestedRequest.length > 0) return nestedRequest;
  const serverRequest = asRecord(params.serverRequest);
  return stringOrNumberField(serverRequest, "requestId") ||
    stringOrNumberField(serverRequest, "serverRequestId") ||
    stringOrNumberField(serverRequest, "id");
}

function statusLabelFromParams(params: Record<string, unknown>): string {
  const status = params.status;
  if (typeof status === "string") return status;
  const statusRecord = asRecord(status);
  return stringField(statusRecord, "type");
}

function projectNameFromPath(projectPath: string | null): string | null {
  if (!projectPath) return null;
  const parts = projectPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : projectPath;
}

function sendReceivedMessage(socket: { send: (value: string) => void }, input: { messageId: string; sessionId: string; text: string; sendState?: "guided"; assetIds?: string[] }): void {
  send(socket, {
    type: "message.updated",
    message: {
      id: input.messageId,
      sessionId: input.sessionId,
      role: "user",
      text: input.text,
      rawText: input.text,
      createdAt: new Date().toISOString(),
      sendState: input.sendState ?? "received",
      clientMessageId: input.messageId,
      canWithdraw: false,
      ...(input.assetIds && input.assetIds.length > 0 ? { assetIds: input.assetIds } : {})
    }
  });
}

function sendMessagesSnapshot(socket: { send: (value: string) => void }, sessionId: string, messages: SessionMessage[]): void {
  send(socket, {
    type: "messages.snapshot",
    sessionId,
    messages
  });
}

function sendMediaSnapshots(socket: { send: (value: string) => void }, context: AppContext, sessionId: string): void {
  send(socket, {
    type: "session.assets.updated",
    sessionId,
    assets: context.mediaAssets.listSessionAssets(sessionId)
  });
  send(socket, {
    type: "session.attachments.updated",
    sessionId,
    attachments: context.repositories.sessionAttachments.listBySession(sessionId)
  });
}

function sendApprovalSnapshot(socket: { send: (value: string) => void }, detail: SessionDetail): void {
  send(socket, {
    type: "approval.updated",
    sessionId: detail.session.id,
    approval: detail.approval ?? null
  });
}

function sendCreatedArtifactEvents(
  socket: { send: (value: string) => void },
  artifacts: CodexGeneratedImageArtifact[],
  createdAssetIds: string[]
): void {
  for (const artifact of artifacts) {
    if (!createdAssetIds.includes(artifact.asset.id)) continue;
    send(socket, { type: "session.artifact.created", sessionId: artifact.asset.sessionId, asset: artifact.asset });
  }
}

function broadcastCreatedArtifactEvents(
  state: SharedCodexRuntimeState,
  artifacts: CodexGeneratedImageArtifact[],
  createdAssetIds: string[]
): void {
  for (const artifact of artifacts) {
    if (!createdAssetIds.includes(artifact.asset.id)) continue;
    broadcastSharedRuntimeEvent(state, {
      type: "session.artifact.created",
      sessionId: artifact.asset.sessionId,
      asset: artifact.asset
    });
  }
}

function rolloutPathForDetail(detail: SessionDetail): string | null {
  if (detail.rolloutPath && detail.rolloutPath.length > 0) return detail.rolloutPath;
  const metadata = readCodexThreadMetadataFromStateDb([detail.session.id]).get(detail.session.id) ?? null;
  return metadata?.rolloutPath ?? null;
}

async function syncCodexGeneratedImagesForDetail(
  context: AppContext,
  detail: SessionDetail
): Promise<CodexGeneratedImageArtifactSyncResult> {
  const rolloutPath = rolloutPathForDetail(detail);
  if (rolloutPath === null || rolloutPath.length === 0) {
    return { artifacts: [], createdAssetIds: [] };
  }
  return context.codexGeneratedImages.syncFromRollout({
    sessionId: detail.session.id,
    rolloutPath
  });
}

function detailWithCodexImageArtifacts(
  detail: SessionDetail,
  artifacts: CodexGeneratedImageArtifact[]
): SessionDetail {
  if (artifacts.length === 0 || detail.turns.length === 0) return detail;
  const turns: SessionTurn[] = detail.turns.map((turn) => ({
    ...turn,
    items: turn.items.map((item) => ({
      ...item,
      planSteps: [...item.planSteps],
      assetIds: [...(item.assetIds ?? [])]
    }))
  }));
  for (const artifact of artifacts) {
    if (hasTimelineAssetId(turns, artifact.asset.id)) continue;
    const turnIndex = turnIndexForArtifact(turns, artifact.createdAt);
    if (turnIndex < 0) continue;
    const turn = turns[turnIndex];
    const outputItem = codexImageGenerationOutputItem(turn, artifact);
    if (outputItem) {
      outputItem.assetIds = [...(outputItem.assetIds ?? []), artifact.asset.id];
      if (safeTimeMs(artifact.createdAt) > safeTimeMs(outputItem.updatedAt)) {
        outputItem.updatedAt = artifact.createdAt;
      }
      outputItem.status = "completed";
      outputItem.isStreaming = false;
    } else {
      turn.items.push(codexImageGenerationTimelineItem(turn, artifact));
    }
    turn.items.sort((left, right) => safeTimeMs(left.createdAt) - safeTimeMs(right.createdAt));
  }
  return { ...detail, turns };
}

type UserAttachmentAssetGroup = {
  createdAt: string;
  createdAtMs: number;
  assetIds: string[];
};

type UserTimelineItemTarget = {
  turnIndex: number;
  itemIndex: number;
  createdAtMs: number;
};

function detailWithUserAttachmentAssetRefs(context: AppContext, detail: SessionDetail): SessionDetail {
  if (detail.turns.length === 0) return detail;
  const groups = userAttachmentAssetGroups(context.repositories.sessionAttachments.listBySession(detail.session.id));
  if (groups.length === 0) return detail;
  const targets = userTimelineItemTargets(detail.turns);
  if (targets.length === 0) return detail;

  const turns: SessionTurn[] = detail.turns.map((turn) => ({
    ...turn,
    items: turn.items.map((item) => ({
      ...item,
      planSteps: [...item.planSteps],
      assetIds: item.assetIds ? [...item.assetIds] : undefined
    }))
  }));
  const usedTargetIndexes = new Set<number>();
  for (const group of groups) {
    const targetIndex = userAttachmentTargetIndex(targets, usedTargetIndexes, group, groups.length);
    if (targetIndex < 0) continue;
    usedTargetIndexes.add(targetIndex);
    const target = targets[targetIndex];
    const item = turns[target.turnIndex].items[target.itemIndex];
    item.assetIds = mergedAssetIds(item.assetIds, group.assetIds);
  }
  return { ...detail, turns };
}

function userAttachmentAssetGroups(attachments: StoredSessionAttachment[]): UserAttachmentAssetGroup[] {
  const chronological = attachments
    .filter((attachment) => attachment.role === "userUpload" && attachment.codexInputStatus !== "pending")
    .slice()
    .reverse();
  const groups: UserAttachmentAssetGroup[] = [];
  for (const attachment of chronological) {
    let group = groups.length > 0 ? groups[groups.length - 1] : undefined;
    if (!group || group.createdAt !== attachment.createdAt) {
      group = {
        createdAt: attachment.createdAt,
        createdAtMs: safeTimeMs(attachment.createdAt),
        assetIds: []
      };
      groups.push(group);
    }
    if (!group.assetIds.includes(attachment.assetId)) group.assetIds.push(attachment.assetId);
  }
  return groups.filter((group) => group.assetIds.length > 0);
}

function userTimelineItemTargets(turns: SessionTurn[]): UserTimelineItemTarget[] {
  const targets: UserTimelineItemTarget[] = [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];
    for (let itemIndex = 0; itemIndex < turn.items.length; itemIndex++) {
      const item = turn.items[itemIndex];
      if (item.kind !== "userMessage") continue;
      targets.push({
        turnIndex,
        itemIndex,
        createdAtMs: safeTimeMs(item.createdAt)
      });
    }
  }
  return targets;
}

function userAttachmentTargetIndex(
  targets: UserTimelineItemTarget[],
  usedTargetIndexes: Set<number>,
  group: UserAttachmentAssetGroup,
  groupCount: number
): number {
  let bestIndex = -1;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let index = 0; index < targets.length; index++) {
    if (usedTargetIndexes.has(index)) continue;
    const delta = Math.abs(targets[index].createdAtMs - group.createdAtMs);
    if (delta > USER_ATTACHMENT_MESSAGE_MATCH_WINDOW_MS) continue;
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  }
  if (bestIndex >= 0) return bestIndex;
  if (groupCount === 1 && targets.length === 1 && !usedTargetIndexes.has(0)) return 0;
  return -1;
}

function mergedAssetIds(existing: string[] | undefined, incoming: string[]): string[] {
  const merged = existing ? [...existing] : [];
  for (const assetId of incoming) {
    if (!merged.includes(assetId)) merged.push(assetId);
  }
  return merged;
}

function hasTimelineAssetId(turns: SessionTurn[], assetId: string): boolean {
  for (const turn of turns) {
    for (const item of turn.items) {
      if ((item.assetIds ?? []).includes(assetId)) return true;
    }
  }
  return false;
}

function turnIndexForArtifact(turns: SessionTurn[], createdAt: string): number {
  const createdAtMs = Date.parse(createdAt);
  let fallbackIndex = turns.length - 1;
  if (!Number.isFinite(createdAtMs)) return fallbackIndex;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const startedAtMs = turn.startedAt ? Date.parse(turn.startedAt) : Number.NEGATIVE_INFINITY;
    const completedAtMs = turn.completedAt ? Date.parse(turn.completedAt) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(startedAtMs)) continue;
    if (createdAtMs >= startedAtMs - 2000 && createdAtMs <= completedAtMs + 2000) {
      return index;
    }
    if (createdAtMs >= startedAtMs) {
      fallbackIndex = index;
      break;
    }
  }
  return fallbackIndex;
}

function codexImageGenerationOutputItem(turn: SessionTurn, artifact: CodexGeneratedImageArtifact): TimelineItem | null {
  const exact = codexImageGenerationItemByCallId(turn, artifact.callId);
  if (exact) return exact;
  return codexImageGenerationItemByTime(turn, artifact.createdAt);
}

function codexImageGenerationItemByCallId(turn: SessionTurn, callId: string): TimelineItem | null {
  if (callId.length === 0) return null;
  for (const item of turn.items) {
    if (item.kind === "imageGeneration" && item.id === callId) return item;
  }
  return null;
}

function codexImageGenerationItemByTime(turn: SessionTurn, createdAt: string): TimelineItem | null {
  const createdAtMs = safeTimeMs(createdAt);
  let bestRunningByTime: TimelineItem | null = null;
  let bestRunningDelta = Number.POSITIVE_INFINITY;
  let bestAnyByTime: TimelineItem | null = null;
  let bestAnyDelta = Number.POSITIVE_INFINITY;
  let latestRunning: TimelineItem | null = null;
  let latestRunningMs = Number.NEGATIVE_INFINITY;
  let latestAny: TimelineItem | null = null;
  let latestAnyMs = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < turn.items.length; index++) {
    const item = turn.items[index];
    if (item.kind !== "imageGeneration") continue;
    const itemCreatedAtMs = safeTimeMs(item.createdAt);
    if (itemCreatedAtMs >= latestAnyMs) {
      latestAny = item;
      latestAnyMs = itemCreatedAtMs;
    }
    const isRunningOwner = item.status === "running" || item.isStreaming;
    if (isRunningOwner && itemCreatedAtMs >= latestRunningMs) {
      latestRunning = item;
      latestRunningMs = itemCreatedAtMs;
    }
    const delta = Math.abs(itemCreatedAtMs - createdAtMs);
    if (delta <= 2000 && isRunningOwner && delta <= bestRunningDelta) {
      bestRunningByTime = item;
      bestRunningDelta = delta;
    }
    if (delta <= 2000 && delta <= bestAnyDelta) {
      bestAnyByTime = item;
      bestAnyDelta = delta;
    }
  }
  return bestRunningByTime ?? bestAnyByTime ?? latestRunning ?? latestAny;
}

function codexImageGenerationTimelineItem(turn: SessionTurn, artifact: CodexGeneratedImageArtifact): TimelineItem {
  return {
    id: artifact.callId.length > 0 ? artifact.callId : `${artifact.asset.id}:image-generation`,
    sessionId: artifact.asset.sessionId,
    turnId: turn.id,
    kind: "imageGeneration",
    status: "completed",
    title: "imagegen",
    text: "",
    rawText: "",
    createdAt: artifact.createdAt,
    updatedAt: artifact.createdAt,
    isStreaming: false,
    isCollapsedByDefault: false,
    command: null,
    diff: null,
    approval: null,
    planSteps: [],
    assetIds: [artifact.asset.id]
  };
}

function safeTimeMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clientMessageIdForCommand(command: ClientCommand): string | undefined {
  if (command.type === "session.create") {
    return createClientMessageId(command);
  }
  if (command.type === "session.sendText" || command.type === "session.inputQueue.enqueue" ||
    command.type === "session.attachments.send") {
    return command.clientMessageId;
  }
  if (command.type === "session.steer") {
    return command.clientMessageId;
  }
  return undefined;
}

function createClientMessageId(command: Extract<ClientCommand, { type: "session.create" }>): string | undefined {
  return command.clientMessageId && command.clientMessageId.length > 0 ? command.clientMessageId : undefined;
}

function syncRouterWithSessionDetail(router: ReturnType<typeof createCommandRouter>, detail: SessionDetail): void {
  const activeTurnId = activeTurnIdFromSessionDetail(detail);
  if (activeTurnId.length > 0) {
    router.noteTurnStarted(detail.session.id, activeTurnId);
    return;
  }
  if (detail.session.waitsForNextDirection || sessionStatusIndicatesIdle(detail.session.statusLabel)) {
    router.noteTurnCompleted(detail.session.id);
  }
}

function activeTurnIdFromSessionDetail(detail: SessionDetail): string {
  for (let index = detail.turns.length - 1; index >= 0; index--) {
    const turn = detail.turns[index];
    if (turnHasRunningWork(turn)) {
      return turn.id;
    }
  }
  if (sessionStatusIndicatesActiveTurn(detail.session.statusLabel) && detail.turns.length > 0) {
    return detail.turns[detail.turns.length - 1].id;
  }
  return "";
}

function turnHasRunningWork(turn: SessionTurn): boolean {
  if (turn.status === "running") return true;
  for (const item of turn.items) {
    if (item.status === "running" || item.isStreaming) return true;
  }
  return false;
}

function sessionStatusIndicatesActiveTurn(statusLabel: string): boolean {
  const normalized = statusLabel.trim().toLowerCase();
  return normalized === "active" ||
    normalized === "running" ||
    normalized === "inprogress" ||
    normalized === "in_progress" ||
    normalized.includes("approval") ||
    normalized.includes("wait");
}

function sessionStatusIndicatesIdle(statusLabel: string): boolean {
  const normalized = statusLabel.trim().toLowerCase();
  return normalized === "idle" ||
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "ready";
}

function auditSessionIdForCommand(command: ClientCommand, rawCommand: Record<string, unknown>, result: CommandRouterResult | null): string | null {
  if (command.type === "session.create") {
    return result?.kind === "session.created" ? result.threadId : optionalStringField(rawCommand, "sessionId");
  }
  if (command.type === "codex.installedCapabilities.list") return null;
  if (command.type === "codex.models.list") return null;
  if (command.type === "codex.accountUsage.refresh") return null;
  if (command.type === "projects.list") return null;
  if (command.type === "projects.create") return null;
  if (command.type === "projects.hide") return null;
  if (command.type === "projects.unhide") return null;
  if (command.type === "device.unbind") return null;
  if (command.type === "localWeb.close") return null;
  return command.sessionId;
}

function sanitizeAuditFailureDetail(message: string | undefined): string {
  const value = message?.trim() ?? "";
  if (value.length === 0) return "";
  if (/authorization|bearer|token|api[-_\s]?key|codex config|secret/i.test(value)) {
    return "错误详情已脱敏";
  }
  return value.replace(/\s+/g, " ").slice(0, 240);
}

function commandAuditDetail(command: ClientCommand, result: "success" | "failed", failureMessage?: string): string {
  if (result === "success" && command.type === "session.runtimeConfig.update") {
    const config = command.config;
    if (config.permissionMode === "full-access" || config.approvalMode === "full-access-never") {
      return "会话运行权限已切换为 Full Access";
    }
  }
  const base = commandAuditDetails[command.type][result];
  const detail = result === "failed" ? sanitizeAuditFailureDetail(failureMessage) : "";
  return detail.length > 0 ? `${base}：${detail}` : base;
}

function recordCommandAudit(input: { context: AppContext; deviceId: string; command: ClientCommand; rawCommand: Record<string, unknown>; result: "success" | "failed"; routerResult: CommandRouterResult | null; failureMessage?: string }): void {
  input.context.audit.record({
    deviceId: input.deviceId,
    sessionId: auditSessionIdForCommand(input.command, input.rawCommand, input.routerResult),
    actionType: input.command.type,
    result: input.result,
    detail: commandAuditDetail(input.command, input.result, input.failureMessage)
  });
}

async function handleClientMessage(
  socket: { send: (value: string) => void; close?: () => void },
  context: AppContext,
  router: ReturnType<typeof createCommandRouter>,
  subscriber: SharedCodexRuntimeSubscriber,
  deviceId: string,
  raw: string,
  state: SharedCodexRuntimeState,
  sessions: CommandRouterSessions
): Promise<void> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    send(socket, { type: "command.failed", requestId: "invalid", errorCode: "BAD_REQUEST", message: "请求格式错误" });
    return;
  }
  const rawCommand = asRecord(parsedJson);
  const parsed = ClientCommandSchema.safeParse(parsedJson);
  if (!parsed.success) {
    send(socket, { type: "command.failed", requestId: "invalid", errorCode: "BAD_REQUEST", message: "请求格式错误" });
    return;
  }
  if (!context.pairing.isDeviceActive(deviceId)) {
    send(socket, { type: "command.failed", requestId: parsed.data.requestId, errorCode: "AUTH_INVALID", message: "授权失效，请重新配对" });
    socket.close?.();
    return;
  }

  try {
    if (parsed.data.type === "dev.approvalFixture.show") {
      if (!isDevApprovalFixtureEnabled()) {
        throw new Error("测试审批夹具未启用");
      }
      const approval = devApprovalFixture({
        requestId: parsed.data.requestId,
        sessionId: parsed.data.sessionId,
        kind: parsed.data.kind
      });
      clearApprovalFixturesForSession(state, parsed.data.sessionId);
      state.approvalFixtures.set(approval.id, { sessionId: parsed.data.sessionId, approval });
      subscriber.syncedSessionIds.add(parsed.data.sessionId);
      broadcastSessionUpdatedForApprovalState(context, state, parsed.data.sessionId, approval);
      broadcastDevApprovalFixtureEvent(state, {
        type: "approval.updated",
        sessionId: parsed.data.sessionId,
        approval
      });
      recordCommandAudit({ context, deviceId, command: parsed.data, rawCommand, result: "success", routerResult: null });
      return;
    }

    if (parsed.data.type === "approval.respond") {
      const fixture = state.approvalFixtures.get(parsed.data.approvalId);
      if (fixture) {
        state.approvalFixtures.delete(parsed.data.approvalId);
        broadcastSessionUpdatedForApprovalState(context, state, fixture.sessionId, null);
        broadcastDevApprovalFixtureEvent(state, {
          type: "approval.updated",
          sessionId: fixture.sessionId,
          approval: null
        });
        broadcastDevApprovalFixtureEvent(state, approvalFixtureFollowupEvent({
          state,
          sessionId: fixture.sessionId,
          approval: fixture.approval,
          actionId: parsed.data.actionId,
          answers: parsed.data.answers
        }));
        recordCommandAudit({ context, deviceId, command: parsed.data, rawCommand, result: "success", routerResult: null });
        return;
      }
    }

    if (parsed.data.type === "device.unbind") {
      context.pairing.revokeDevice(deviceId);
      recordCommandAudit({ context, deviceId, command: parsed.data, rawCommand, result: "success", routerResult: null });
      socket.close?.();
      return;
    }

    if (parsed.data.type === "session.pin") {
      context.sessions.setPinned(parsed.data.sessionId, parsed.data.isPinned);
      const session = context.sessions.get(parsed.data.sessionId);
      if (!session) throw new Error("会话不存在，无法更新置顶状态");
      recordCommandAudit({ context, deviceId, command: parsed.data, rawCommand, result: "success", routerResult: null });
      send(socket, { type: "session.updated", session });
      return;
    }

    if (parsed.data.type === "session.read" && !subscriber.syncedSessionIds.has(parsed.data.sessionId)) {
      throw new Error("会话尚未开启同步");
    }

    const sendTextSessionWasSynced = parsed.data.type === "session.sendText" &&
      subscriber.syncedSessionIds.has(parsed.data.sessionId);
    const commandForRouter: ClientCommand = parsed.data.type === "session.sendText" && sendTextSessionWasSynced
      ? { ...parsed.data, skipPreflightResume: true }
      : parsed.data;

    if (parsed.data.type === "session.sendText") {
      subscriber.syncedSessionIds.add(parsed.data.sessionId);
      subscriber.activeDetailSessionId = parsed.data.sessionId;
      const hasActiveTurn = router.hasActiveTurn(parsed.data.sessionId);
      const wantsSteerNow = parsed.data.guidance?.mode === "steer-now";
      if ((!hasActiveTurn && !wantsSteerNow) || (hasActiveTurn && wantsSteerNow)) {
        sendReceivedMessage(socket, {
          messageId: parsed.data.clientMessageId,
          sessionId: parsed.data.sessionId,
          text: parsed.data.text,
          assetIds: parsed.data.attachmentIds,
          ...(wantsSteerNow ? { sendState: "guided" as const } : {})
        });
      }
    }

    if (parsed.data.type === "session.context.compact") {
      subscriber.syncedSessionIds.add(parsed.data.sessionId);
      subscriber.activeDetailSessionId = parsed.data.sessionId;
      broadcastSharedRuntimeEvent(state, {
        type: "timeline.item.updated",
        item: contextCompactTimelineItem({
          sessionId: parsed.data.sessionId,
          requestId: parsed.data.requestId,
          status: "running",
          text: "正在压缩上下文"
        })
      });
    }

    const detailInvalidationSessionId = sessionIdForDetailInvalidatingCommand(commandForRouter);
    if (detailInvalidationSessionId) {
      invalidateSessionDetailSnapshot(state, detailInvalidationSessionId);
    }

    const result = await router.handle(commandForRouter, (failure) => {
      const failureEvent = {
        type: "command.failed",
        requestId: failure.requestId,
        errorCode: "CODEX_COMMAND_FAILED",
        message: failure.message,
        ...(failure.clientMessageId ? { clientMessageId: failure.clientMessageId } : {})
      };
      send(socket, failureEvent);
      recordCommandAudit({ context, deviceId, command: parsed.data, rawCommand, result: "failed", routerResult: null, failureMessage: failure.message });
    }, (started) => {
      const event = {
        type: "turn.status.updated",
        sessionId: started.sessionId,
        turnId: started.turnId,
        status: started.status
      };
      const senderReceivesBroadcast = subscriber.syncedSessionIds.has(started.sessionId);
      broadcastSharedRuntimeEvent(state, event);
      if (!senderReceivesBroadcast) {
        send(socket, event);
      }
    });
    recordCommandAudit({ context, deviceId, command: parsed.data, rawCommand, result: "success", routerResult: result });
    if (!result) return;

    if (result.kind === "session.created") {
      const now = new Date().toISOString();
      const session = {
        id: result.threadId,
        toolId: "codex-mac",
        title: result.text.trim().slice(0, 60) || "Codex 会话",
        projectPath: result.projectPath,
        projectName: projectNameFromPath(result.projectPath),
        createdAt: now,
        updatedAt: now,
        isPinned: false,
        needsUserInput: false,
        waitsForNextDirection: false,
        statusLabel: result.status,
        lastMessagePreview: ""
      };
      context.sessions.addSession(session);
      subscriber.syncedSessionIds.add(result.threadId);
      subscriber.activeDetailSessionId = result.threadId;
      send(socket, { type: "session.updated", requestId: result.requestId, session });
      if (result.turnId) {
        send(socket, { type: "turn.status.updated", sessionId: result.threadId, turnId: result.turnId, status: "running" });
      }
      sendReceivedMessage(socket, { messageId: result.clientMessageId ?? result.requestId, sessionId: result.threadId, text: result.text, assetIds: result.attachmentIds });
      if (result.attachments && result.attachments.length > 0) {
        send(socket, { type: "session.assets.updated", sessionId: result.threadId, assets: context.mediaAssets.listSessionAssets(result.threadId) });
        send(socket, { type: "session.attachments.updated", sessionId: result.threadId, attachments: result.attachments });
      }
      return;
    }

    if (result.kind === "session.detail") {
      const imageSync = await syncCodexGeneratedImagesForDetail(context, result.detail);
      const detail = detailWithUserAttachmentAssetRefs(
        context,
        detailWithRuntimeApprovalState(context, state, detailWithCodexImageArtifacts(result.detail, imageSync.artifacts))
      );
      syncRouterWithSessionDetail(router, detail);
      const session = context.sessions.addSession(detail.session);
      send(socket, { type: "session.updated", session });
      sendCreatedArtifactEvents(socket, imageSync.artifacts, imageSync.createdAssetIds);
      send(socket, { type: "thread.detail.snapshot", sessionId: detail.session.id, turns: snapshotTurnsForClient(detail.turns) });
      sendMessagesSnapshot(socket, detail.session.id, detail.messages);
      sendApprovalSnapshot(socket, detail);
      send(socket, { type: "session.inputQueue.updated", sessionId: session.id, items: context.inputQueue.list(session.id) });
      sendMediaSnapshots(socket, context, session.id);
      await startNextQueuedInput({ context, state, sessions, router, sessionId: session.id });
      return;
    }

    if (result.kind === "session.sync.enabled") {
      const imageSync = await syncCodexGeneratedImagesForDetail(context, result.detail);
      const detail = detailWithUserAttachmentAssetRefs(
        context,
        detailWithRuntimeApprovalState(context, state, detailWithCodexImageArtifacts(result.detail, imageSync.artifacts))
      );
      syncRouterWithSessionDetail(router, detail);
      const session = context.sessions.addSession(detail.session);
      subscriber.syncedSessionIds.add(session.id);
      if (result.activeDetail) {
        subscriber.activeDetailSessionId = session.id;
      } else if (subscriber.activeDetailSessionId === session.id) {
        subscriber.activeDetailSessionId = null;
      }
      send(socket, { type: "session.updated", session });
      sendCreatedArtifactEvents(socket, imageSync.artifacts, imageSync.createdAssetIds);
      send(socket, { type: "thread.detail.snapshot", sessionId: session.id, turns: snapshotTurnsForClient(detail.turns) });
      sendMessagesSnapshot(socket, session.id, detail.messages);
      sendApprovalSnapshot(socket, detail);
      send(socket, { type: "session.inputQueue.updated", sessionId: session.id, items: context.inputQueue.list(session.id) });
      sendMediaSnapshots(socket, context, session.id);
      await startNextQueuedInput({ context, state, sessions, router, sessionId: session.id });
      return;
    }

    if (result.kind === "session.sync.disabled") {
      if (subscriber.activeDetailSessionId === result.sessionId) {
        subscriber.activeDetailSessionId = null;
      }
      return;
    }

    if (result.kind === "session.sync.unsubscribed") {
      if (subscriber.activeDetailSessionId === result.sessionId) {
        subscriber.activeDetailSessionId = null;
      }
      subscriber.syncedSessionIds.delete(result.sessionId);
      return;
    }

    if (result.kind === "session.renamed") {
      const session = context.sessions.rename(result.sessionId, result.title);
      if (session) send(socket, { type: "session.updated", session });
      return;
    }

    if (result.kind === "session.context.compacted") {
      broadcastSharedRuntimeEvent(state, {
        type: "timeline.item.completed",
        item: contextCompactTimelineItem({
          sessionId: result.sessionId,
          requestId: result.requestId,
          status: "completed",
          text: "上下文已压缩"
        })
      });
      try {
        await pushFreshDetailSnapshotForSession(context, state, sessions, result.sessionId);
      } catch {
        // The compact command already succeeded; a later sync/read will refresh detail again.
      }
      return;
    }

    if (result.kind === "message.received") {
      if (result.attachments && result.attachments.length > 0) {
        const event = {
          type: "session.attachments.updated",
          sessionId: result.sessionId,
          attachments: result.attachments
        };
        if (subscriber.syncedSessionIds.has(result.sessionId)) {
          broadcastSharedRuntimeEvent(state, event);
        } else {
          send(socket, event);
        }
      }
      if (parsed.data.type === "session.sendText" && result.messageId === parsed.data.clientMessageId) {
        return;
      }
      sendReceivedMessage(socket, { messageId: result.messageId, sessionId: result.sessionId, text: result.text, sendState: result.sendState, assetIds: result.attachmentIds });
      return;
    }

    if (result.kind === "installed.capabilities") {
      send(socket, { type: "codex.installedCapabilities.snapshot", capabilities: result.capabilities });
      return;
    }

    if (result.kind === "codex.models") {
      send(socket, { type: "codex.models.snapshot", requestId: result.requestId, models: result.models, defaultModel: result.defaultModel });
      return;
    }

    if (result.kind === "projects.snapshot") {
      send(socket, {
        type: "projects.snapshot",
        requestId: result.requestId,
        roots: result.roots,
        projects: result.projects
      });
      return;
    }

    if (result.kind === "project.created") {
      broadcastSharedRuntimeEvent(state, {
        type: "project.created",
        requestId: result.requestId,
        project: result.project
      });
      broadcastSharedRuntimeEvent(state, {
        type: "projects.snapshot",
        requestId: result.requestId,
        roots: result.roots,
        projects: result.projects
      });
      return;
    }

    if (result.kind === "project.visibility.updated") {
      broadcastSharedRuntimeEvent(state, {
        type: "project.visibility.updated",
        requestId: result.requestId,
        project: result.project
      });
      broadcastSharedRuntimeEvent(state, {
        type: "projects.snapshot",
        requestId: result.requestId,
        roots: result.roots,
        projects: result.projects
      });
      return;
    }

    if (result.kind === "codex.accountUsage") {
      const event = { type: "codex.accountUsage.snapshot", requestId: result.requestId, usage: result.usage };
      send(socket, event);
      broadcastSharedRuntimeEvent(state, event);
      try {
        await refreshAndBroadcastCodexSessionSnapshot(context, state);
      } catch (error) {
        send(socket, {
          type: "command.failed",
          requestId: "codex-session-list-refresh",
          errorCode: "CODEX_SESSION_LIST_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Codex 会话列表读取失败"
        });
      }
      send(socket, event);
      return;
    }

    if (result.kind === "runtime.config") {
      send(socket, { type: "session.runtimeConfig.updated", requestId: result.requestId, config: result.config });
      return;
    }

    if (result.kind === "input.queue.updated") {
      const event = { type: "session.inputQueue.updated", sessionId: result.sessionId, items: result.items };
      const senderReceivesBroadcast = subscriber.syncedSessionIds.has(result.sessionId);
      broadcastSharedRuntimeEvent(state, event);
      if (!senderReceivesBroadcast) {
        send(socket, event);
      }
      if (parsed.data.type === "session.inputQueue.retry" && router.canStartNewTurn(result.sessionId)) {
        await startNextQueuedInput({ context, state, sessions, router, sessionId: result.sessionId });
      }
      return;
    }

    if (result.kind === "local.web.session.updated") {
      send(socket, { type: "localWeb.session.updated", session: result.session });
      return;
    }

    if (result.kind === "session.artifact.created") {
      send(socket, { type: "session.artifact.created", sessionId: result.sessionId, asset: result.asset });
      send(socket, { type: "session.assets.updated", sessionId: result.sessionId, assets: context.mediaAssets.listSessionAssets(result.sessionId) });
      send(socket, { type: "session.attachments.updated", sessionId: result.sessionId, attachments: context.repositories.sessionAttachments.listBySession(result.sessionId) });
      return;
    }

    if (result.kind === "turn.status") {
      send(socket, { type: "turn.status.updated", sessionId: result.sessionId, turnId: result.turnId, status: result.status });
      await startNextQueuedInput({ context, state, sessions, router, sessionId: result.sessionId });
    }
  } catch (error) {
    const clientMessageId = clientMessageIdForCommand(parsed.data);
    const failureMessage = error instanceof Error ? error.message : "Codex 指令发送失败";
    if (parsed.data.type === "session.context.compact") {
      broadcastSharedRuntimeEvent(state, {
        type: "timeline.item.completed",
        item: contextCompactTimelineItem({
          sessionId: parsed.data.sessionId,
          requestId: parsed.data.requestId,
          status: "failed",
          text: "上下文压缩失败"
        })
      });
    }
    if (parsed.data.type === "projects.create") {
      send(socket, {
        type: "project.create.failed",
        requestId: parsed.data.requestId,
        message: failureMessage
      });
    }
    send(socket, {
      type: "command.failed",
      requestId: parsed.data.requestId,
      errorCode: "CODEX_COMMAND_FAILED",
      message: failureMessage,
      ...(clientMessageId ? { clientMessageId } : {})
    });
    recordCommandAudit({ context, deviceId, command: parsed.data, rawCommand, result: "failed", routerResult: null, failureMessage });
  }
}

interface CodexServerRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface CodexNotificationSource {
  onNotification(method: CodexNotificationMethod, handler: (params: Record<string, unknown>) => void): void;
  onServerRequest?(method: CodexServerRequestMethod, handler: (request: CodexServerRequest) => void): void;
}

type CodexRuntimeHandle = Awaited<ReturnType<AppContext["codex"]["createSessionRuntime"]>>;
type SharedCodexRuntimeHandle = CodexRuntimeHandle & {
  router: ReturnType<typeof createCommandRouter>;
  routerSessions: CommandRouterSessions;
  desktopFollower: CodexDesktopFollowerBridge | null;
};

interface SharedCodexRuntimeState {
  runtimePromise: Promise<SharedCodexRuntimeHandle>;
  subscribers: Set<SharedCodexRuntimeSubscriber>;
  detailReads: SharedDetailReadCoordinator;
  approvalFixtures: Map<string, DevApprovalFixture>;
  approvalFixtureFollowups: Map<string, TimelineItem[]>;
}

interface DevApprovalFixture {
  sessionId: string;
  approval: NonNullable<TimelineItem["approval"]>;
}

interface SharedCodexRuntimeSubscriber {
  sendEvent(event: unknown): void;
  activeDetailSessionId: string | null;
  syncedSessionIds: Set<string>;
}

interface DetailSnapshotCacheEntry {
  detail: SessionDetail;
  cachedAt: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

interface SharedDetailReadCoordinator {
  inFlight: Map<string, Promise<SessionDetail>>;
  snapshots: Map<string, DetailSnapshotCacheEntry>;
  versions: Map<string, number>;
}

const sharedCodexRuntimes = new WeakMap<AppContext, SharedCodexRuntimeState>();

function detailReadVersion(state: SharedCodexRuntimeState, sessionId: string): number {
  return state.detailReads.versions.get(sessionId) ?? 0;
}

function invalidateSessionDetailSnapshot(state: SharedCodexRuntimeState, sessionId: string): void {
  if (sessionId.length === 0) return;
  const cached = state.detailReads.snapshots.get(sessionId);
  if (cached) clearTimeout(cached.cleanupTimer);
  state.detailReads.snapshots.delete(sessionId);
  state.detailReads.inFlight.delete(sessionId);
  state.detailReads.versions.set(sessionId, detailReadVersion(state, sessionId) + 1);
}

function invalidateSessionDetailSnapshotForEvent(state: SharedCodexRuntimeState, event: unknown): void {
  const sessionId = sessionIdFromServerEvent(asRecord(event));
  if (sessionId.length > 0) invalidateSessionDetailSnapshot(state, sessionId);
}

function pruneExpiredDetailSnapshots(state: SharedCodexRuntimeState, now: number): void {
  for (const [sessionId, entry] of state.detailReads.snapshots) {
    if (now - entry.cachedAt > DETAIL_SNAPSHOT_CACHE_TTL_MS) {
      clearTimeout(entry.cleanupTimer);
      state.detailReads.snapshots.delete(sessionId);
    }
  }
}

function cacheSessionDetailSnapshot(
  state: SharedCodexRuntimeState,
  sessionId: string,
  detail: SessionDetail
): void {
  const existing = state.detailReads.snapshots.get(sessionId);
  if (existing) clearTimeout(existing.cleanupTimer);
  const cleanupTimer = setTimeout(() => {
    const entry = state.detailReads.snapshots.get(sessionId);
    if (entry && entry.cleanupTimer === cleanupTimer) {
      state.detailReads.snapshots.delete(sessionId);
    }
  }, DETAIL_SNAPSHOT_CACHE_TTL_MS);
  state.detailReads.snapshots.set(sessionId, { detail, cachedAt: Date.now(), cleanupTimer });
}

function clearDetailReadCoordinator(state: SharedCodexRuntimeState): void {
  for (const entry of state.detailReads.snapshots.values()) {
    clearTimeout(entry.cleanupTimer);
  }
  state.detailReads.snapshots.clear();
  state.detailReads.inFlight.clear();
  state.detailReads.versions.clear();
}

function sessionIdForDetailInvalidatingCommand(command: ClientCommand): string | null {
  if (
    command.type === "session.rename" ||
    command.type === "session.sendText" ||
    command.type === "session.attachments.send" ||
    command.type === "session.steer" ||
    command.type === "session.context.compact" ||
    command.type === "session.interrupt" ||
    command.type === "approval.respond" ||
    command.type === "dev.codexTurnInput.probe"
  ) {
    return command.sessionId;
  }
  return null;
}

function readCoalescedSessionDetail(
  state: SharedCodexRuntimeState,
  sessions: CommandRouterSessions,
  sessionId: string
): Promise<SessionDetail> {
  const cached = state.detailReads.snapshots.get(sessionId);
  const now = Date.now();
  if (cached && now - cached.cachedAt <= DETAIL_SNAPSHOT_CACHE_TTL_MS) {
    return Promise.resolve(cached.detail);
  }
  pruneExpiredDetailSnapshots(state, now);

  const inFlight = state.detailReads.inFlight.get(sessionId);
  if (inFlight) return inFlight;

  const version = detailReadVersion(state, sessionId);
  const detailPromise = sessions.readSessionDetail(sessionId)
    .then((detail) => {
      if (detailReadVersion(state, sessionId) === version) {
        cacheSessionDetailSnapshot(state, sessionId, detail);
      }
      return detail;
    })
    .finally(() => {
      if (state.detailReads.inFlight.get(sessionId) === detailPromise) {
        state.detailReads.inFlight.delete(sessionId);
      }
    });
  state.detailReads.inFlight.set(sessionId, detailPromise);
  return detailPromise;
}

function createCoalescedDetailReadSessions(
  sessions: CommandRouterSessions,
  state: SharedCodexRuntimeState
): CommandRouterSessions {
  const wrapped: CommandRouterSessions = {
    ...(sessions.createThread ? { createThread: (input: { projectPath: string | null; text: string }) => sessions.createThread!(input) } : {}),
    createSession: (input) => {
      return sessions.createSession(input);
    },
    readSessionDetail: (threadId) => {
      return readCoalescedSessionDetail(state, sessions, threadId);
    },
    startTurn: (input) => {
      invalidateSessionDetailSnapshot(state, input.threadId);
      return sessions.startTurn(input);
    },
    steerTurn: (input) => {
      invalidateSessionDetailSnapshot(state, input.threadId);
      return sessions.steerTurn(input);
    },
    interruptTurn: (input) => {
      invalidateSessionDetailSnapshot(state, input.threadId);
      return sessions.interruptTurn(input);
    },
    compactContext: (input) => {
      invalidateSessionDetailSnapshot(state, input.threadId);
      if (!sessions.compactContext) {
        throw new Error("当前 Codex 通道不支持压缩上下文");
      }
      return sessions.compactContext(input);
    },
    recordApprovalRequest: (input) => {
      sessions.recordApprovalRequest?.(input);
    },
    readPendingApproval: (threadId) => {
      return sessions.readPendingApproval?.(threadId) ?? null;
    },
    forgetApprovalRequest: (approvalId) => {
      sessions.forgetApprovalRequest?.(approvalId);
    },
    respondToApproval: (approvalId, actionId, answers, threadId) => {
      if (threadId) invalidateSessionDetailSnapshot(state, threadId);
      return sessions.respondToApproval(approvalId, actionId, answers, threadId);
    }
  };
  const renameSession = sessions.renameSession;
  if (renameSession) {
    wrapped.renameSession = (input) => {
      invalidateSessionDetailSnapshot(state, input.threadId);
      return renameSession(input);
    };
  }
  return wrapped;
}

function broadcastSharedRuntimeEvent(state: SharedCodexRuntimeState, event: unknown): void {
  for (const subscriber of state.subscribers) {
    if (shouldDeliverRuntimeEventToSubscriber(subscriber, event)) {
      subscriber.sendEvent(event);
    }
  }
}

function approvalSessionTitle(approval: NonNullable<TimelineItem["approval"]>): string {
  if (approval.subject.length > 0) return approval.subject;
  if (approval.title.length > 0) return approval.title;
  return "Codex 会话";
}

function approvalSessionPreview(approval: NonNullable<TimelineItem["approval"]>): string {
  if (approval.title.length > 0) return approval.title;
  if (approval.body.length > 0) return approval.body;
  return "等待用户处理";
}

function sessionWithApprovalPendingState(
  session: SessionSummary,
  approval: NonNullable<TimelineItem["approval"]>,
  updatedAt: string = new Date().toISOString()
): SessionSummary {
  return {
    ...session,
    updatedAt,
    needsUserInput: true,
    waitsForNextDirection: false,
    statusLabel: "waiting_for_approval",
    lastMessagePreview: approvalSessionPreview(approval)
  };
}

function sessionUpdatedForApprovalState(
  context: AppContext,
  sessionId: string,
  approval: TimelineItem["approval"] | null
): SessionSummary | null {
  if (sessionId.length === 0) return null;
  const existing = context.sessions.get(sessionId);
  const now = new Date().toISOString();
  if (approval) {
    const createdAt = existing?.createdAt ?? approval.createdAt ?? now;
    const baseSession: SessionSummary = {
      id: sessionId,
      toolId: existing?.toolId ?? "codex-mac",
      title: existing?.title ?? approvalSessionTitle(approval),
      projectPath: existing?.projectPath ?? null,
      projectName: existing?.projectName ?? null,
      createdAt,
      updatedAt: now,
      isPinned: existing?.isPinned ?? false,
      needsUserInput: existing?.needsUserInput ?? false,
      waitsForNextDirection: existing?.waitsForNextDirection ?? false,
      statusLabel: existing?.statusLabel ?? "notLoaded",
      lastMessagePreview: existing?.lastMessagePreview ?? "",
      ...(existing?.contextTokensUsed !== undefined ? { contextTokensUsed: existing.contextTokensUsed } : {}),
      ...(existing?.contextWindowTokens !== undefined ? { contextWindowTokens: existing.contextWindowTokens } : {})
    };
    return context.sessions.addSession(sessionWithApprovalPendingState(baseSession, approval, now));
  }
  if (!existing) return null;
  if (!existing.needsUserInput && !existing.statusLabel.includes("approval") && !existing.statusLabel.includes("wait")) {
    return null;
  }
  const clearedSession: SessionSummary = {
    ...existing,
    updatedAt: now,
    needsUserInput: false,
    waitsForNextDirection: false,
    statusLabel: "running"
  };
  return context.sessions.addSession(clearedSession);
}

function broadcastSessionUpdatedForApprovalState(
  context: AppContext,
  state: SharedCodexRuntimeState,
  sessionId: string,
  approval: TimelineItem["approval"] | null
): void {
  const session = sessionUpdatedForApprovalState(context, sessionId, approval);
  if (!session) return;
  broadcastSharedRuntimeEvent(state, { type: "session.updated", session });
}

function broadcastApprovalSessionStateForEvent(context: AppContext, state: SharedCodexRuntimeState, event: unknown): void {
  const record = asRecord(event);
  if (stringField(record, "type") !== "approval.updated") return;
  const sessionId = stringField(record, "sessionId");
  if (record.approval === undefined) return;
  const approval = record.approval === null ? null : record.approval as TimelineItem["approval"];
  broadcastSessionUpdatedForApprovalState(context, state, sessionId, approval);
}

function broadcastDevApprovalFixtureEvent(state: SharedCodexRuntimeState, event: unknown): void {
  for (const subscriber of state.subscribers) {
    subscriber.sendEvent(event);
  }
}

function approvalFixtureForSession(state: SharedCodexRuntimeState, sessionId: string): DevApprovalFixture | null {
  let latest: DevApprovalFixture | null = null;
  for (const fixture of state.approvalFixtures.values()) {
    if (fixture.sessionId === sessionId) latest = fixture;
  }
  return latest;
}

function clearApprovalFixturesForSession(state: SharedCodexRuntimeState, sessionId: string): void {
  for (const [approvalId, fixture] of state.approvalFixtures.entries()) {
    if (fixture.sessionId === sessionId) {
      state.approvalFixtures.delete(approvalId);
    }
  }
}

function rememberApprovalFixtureFollowup(state: SharedCodexRuntimeState, item: TimelineItem): void {
  const existing = state.approvalFixtureFollowups.get(item.sessionId) ?? [];
  state.approvalFixtureFollowups.set(item.sessionId, [...existing, item].slice(-30));
}

function detailWithApprovalFixtureFollowups(state: SharedCodexRuntimeState, detail: SessionDetail): SessionDetail {
  const followups = state.approvalFixtureFollowups.get(detail.session.id) ?? [];
  if (followups.length === 0) return detail;

  const existingItemIds = new Set<string>();
  for (const turn of detail.turns) {
    for (const item of turn.items) {
      existingItemIds.add(item.id);
    }
  }
  const missingFollowups = followups.filter((item) => !existingItemIds.has(item.id));
  if (missingFollowups.length === 0) return detail;

  const turns: SessionTurn[] = [...detail.turns];
  for (const item of missingFollowups) {
    turns.push({
      id: item.turnId,
      sessionId: item.sessionId,
      status: "completed",
      startedAt: item.createdAt,
      completedAt: item.updatedAt,
      items: [item]
    });
  }
  const latest = missingFollowups[missingFollowups.length - 1];
  return {
    ...detail,
    session: {
      ...detail.session,
      updatedAt: latest.updatedAt,
      lastMessagePreview: latest.text
    },
    turns
  };
}

function detailWithApprovalFixture(state: SharedCodexRuntimeState, detail: SessionDetail): SessionDetail {
  const fixture = approvalFixtureForSession(state, detail.session.id);
  const detailWithApproval = fixture ? { ...detail, approval: fixture.approval } : detail;
  return detailWithApprovalFixtureFollowups(state, detailWithApproval);
}

function detailWithRuntimeApprovalState(context: AppContext, state: SharedCodexRuntimeState, detail: SessionDetail): SessionDetail {
  const detailWithApproval = detailWithApprovalFixture(state, detail);
  if (!detailWithApproval.approval) return detailWithApproval;
  const session = sessionUpdatedForApprovalState(context, detailWithApproval.session.id, detailWithApproval.approval);
  if (!session) {
    return {
      ...detailWithApproval,
      session: sessionWithApprovalPendingState(detailWithApproval.session, detailWithApproval.approval)
    };
  }
  return { ...detailWithApproval, session };
}

function approvalFixtureFollowupEvent(input: {
  state: SharedCodexRuntimeState;
  sessionId: string;
  approval: NonNullable<TimelineItem["approval"]>;
  actionId: string;
  answers?: CodexApprovalAnswers;
}): { type: "timeline.item.updated"; item: TimelineItem } {
  const item = devApprovalFixtureFollowupItem({
    sessionId: input.sessionId,
    approval: input.approval,
    actionId: input.actionId,
    answers: input.answers
  });
  rememberApprovalFixtureFollowup(input.state, item);
  return { type: "timeline.item.updated", item };
}

async function refreshAndBroadcastCodexSessionSnapshot(context: AppContext, state: SharedCodexRuntimeState): Promise<void> {
  const runtime = await context.codex.createSessionRuntime();
  try {
    const codexSessions = await runtime.sessions.listSessionSummaries();
    const sessions = context.sessions.replaceToolSessions("codex-mac", codexSessions);
    broadcastSharedRuntimeEvent(state, { type: "sessions.snapshot", sessions });
  } finally {
    await runtime.stop();
  }
}

function shouldDeliverRuntimeEventToSubscriber(subscriber: SharedCodexRuntimeSubscriber, event: unknown): boolean {
  const record = asRecord(event);
  const type = stringField(record, "type");
  if (type === "session.updated" || type === "sessions.snapshot" || type === "remoteControl.status.updated" || type === "command.failed") {
    return true;
  }
  const sessionId = sessionIdFromServerEvent(record);
  if (sessionId.length === 0) return true;
  if (type === "approval.updated") {
    return subscriber.syncedSessionIds.has(sessionId);
  }
  if (type === "session.inputQueue.updated") {
    return subscriber.syncedSessionIds.has(sessionId);
  }
  return subscriber.activeDetailSessionId === sessionId && subscriber.syncedSessionIds.has(sessionId);
}

function sessionIdFromServerEvent(record: Record<string, unknown>): string {
  const directSessionId = stringField(record, "sessionId");
  if (directSessionId.length > 0) return directSessionId;
  const session = asRecord(record.session);
  const sessionId = stringField(session, "id");
  if (sessionId.length > 0) return sessionId;
  const message = asRecord(record.message);
  const messageSessionId = stringField(message, "sessionId");
  if (messageSessionId.length > 0) return messageSessionId;
  const turn = asRecord(record.turn);
  const turnSessionId = stringField(turn, "sessionId");
  if (turnSessionId.length > 0) return turnSessionId;
  const item = asRecord(record.item);
  return stringField(item, "sessionId");
}

function broadcastDesktopConversationState(context: AppContext, state: SharedCodexRuntimeState, conversationState: Record<string, unknown>): void {
  try {
    const detail = detailWithUserAttachmentAssetRefs(context, sessionDetailFromDesktopConversationState(conversationState));
    invalidateSessionDetailSnapshot(state, detail.session.id);
    const session = context.sessions.addSession(detail.session);
    broadcastSharedRuntimeEvent(state, { type: "session.updated", session });
    broadcastSharedRuntimeEvent(state, { type: "thread.detail.snapshot", sessionId: session.id, turns: snapshotTurnsForClient(detail.turns) });
    broadcastSharedRuntimeEvent(state, { type: "messages.snapshot", sessionId: session.id, messages: detail.messages });
  } catch {
    // Ignore malformed desktop snapshots; the owner will send another state update.
  }
}

function shouldPushFinalDetailToSubscriber(subscriber: SharedCodexRuntimeSubscriber, sessionId: string): boolean {
  return subscriber.syncedSessionIds.has(sessionId);
}

function hasFinalDetailSubscriber(state: SharedCodexRuntimeState, sessionId: string): boolean {
  for (const subscriber of state.subscribers) {
    if (shouldPushFinalDetailToSubscriber(subscriber, sessionId)) {
      return true;
    }
  }
  return false;
}

function sendFinalDetailSnapshot(context: AppContext, state: SharedCodexRuntimeState, detail: SessionDetail): void {
  const nextDetail = detailWithUserAttachmentAssetRefs(context, detailWithRuntimeApprovalState(context, state, detail));
  const sessionId = nextDetail.session.id;
  const events = [
    { type: "session.updated", session: nextDetail.session },
    { type: "thread.detail.snapshot", sessionId, turns: snapshotTurnsForClient(nextDetail.turns) },
    { type: "messages.snapshot", sessionId, messages: nextDetail.messages },
    { type: "approval.updated", sessionId, approval: nextDetail.approval ?? null },
    { type: "session.assets.updated", sessionId, assets: context.mediaAssets.listSessionAssets(sessionId) },
    { type: "session.attachments.updated", sessionId, attachments: context.repositories.sessionAttachments.listBySession(sessionId) }
  ];
  for (const subscriber of state.subscribers) {
    if (!shouldPushFinalDetailToSubscriber(subscriber, sessionId)) {
      continue;
    }
    for (const event of events) {
      subscriber.sendEvent(event);
    }
  }
}

async function pushFreshDetailSnapshotForSession(
  context: AppContext,
  state: SharedCodexRuntimeState,
  sessions: CommandRouterSessions,
  sessionId: string
): Promise<void> {
  invalidateSessionDetailSnapshot(state, sessionId);
  const detail = await sessions.readSessionDetail(sessionId);
  const imageSync = await syncCodexGeneratedImagesForDetail(context, detail);
  const nextDetail = detailWithCodexImageArtifacts(detail, imageSync.artifacts);
  nextDetail.session = context.sessions.addSession(nextDetail.session);
  broadcastCreatedArtifactEvents(state, imageSync.artifacts, imageSync.createdAssetIds);
  sendFinalDetailSnapshot(context, state, nextDetail);
}

function terminalSessionIdsFromRuntimeEvents(events: TimelineRuntimeEvent[]): string[] {
  const sessionIds: string[] = [];
  for (const event of events) {
    if (event.type !== "turn.updated") {
      continue;
    }
    const status = event.turn.status;
    if (status !== "completed" && status !== "failed" && status !== "interrupted") {
      continue;
    }
    if (event.turn.sessionId.length === 0 || sessionIds.includes(event.turn.sessionId)) {
      continue;
    }
    sessionIds.push(event.turn.sessionId);
  }
  return sessionIds;
}

function terminalTurnsFromRuntimeEvents(events: TimelineRuntimeEvent[]): Array<{ sessionId: string; turnId: string }> {
  const turns: Array<{ sessionId: string; turnId: string }> = [];
  for (const event of events) {
    if (event.type !== "turn.updated") {
      continue;
    }
    const status = event.turn.status;
    if (status !== "completed" && status !== "failed" && status !== "interrupted") {
      continue;
    }
    if (event.turn.sessionId.length === 0 || event.turn.id.length === 0) {
      continue;
    }
    const key = `${event.turn.sessionId}:${event.turn.id}`;
    let exists = false;
    for (const turn of turns) {
      if (`${turn.sessionId}:${turn.turnId}` === key) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      turns.push({ sessionId: event.turn.sessionId, turnId: event.turn.id });
    }
  }
  return turns;
}

function finalDetailSessionIdsFromRuntimeEvents(events: TimelineRuntimeEvent[]): string[] {
  const sessionIds = terminalSessionIdsFromRuntimeEvents(events);
  for (const event of events) {
    if (event.type !== "timeline.item.completed" || event.item.kind !== "contextCompaction") {
      continue;
    }
    if (event.item.sessionId.length === 0 || sessionIds.includes(event.item.sessionId)) {
      continue;
    }
    sessionIds.push(event.item.sessionId);
  }
  return sessionIds;
}

async function pushFinalDetailSnapshotsForTerminalTurns(
  context: AppContext,
  state: SharedCodexRuntimeState,
  sessions: CommandRouterSessions,
  events: TimelineRuntimeEvent[]
): Promise<void> {
  const sessionIds = finalDetailSessionIdsFromRuntimeEvents(events);
  for (const sessionId of sessionIds) {
    if (!hasFinalDetailSubscriber(state, sessionId)) {
      continue;
    }
    await pushFreshDetailSnapshotForSession(context, state, sessions, sessionId);
  }
}

async function startNextQueuedInput(input: {
  context: AppContext;
  state: SharedCodexRuntimeState;
  sessions: CommandRouterSessions;
  router: ReturnType<typeof createCommandRouter>;
  sessionId: string;
  terminalTurnId?: string;
}): Promise<void> {
  if (input.terminalTurnId !== undefined) {
    if (!input.router.canDrainQueueAfterTerminal(input.sessionId, input.terminalTurnId)) return;
  } else if (!input.router.canStartNewTurn(input.sessionId)) {
    return;
  }
  const item: SessionInputQueueSendItem | null = input.context.inputQueue.nextQueued(input.sessionId);
  if (!item) return;

  input.context.inputQueue.markSending(input.sessionId, item.id);
  broadcastSharedRuntimeEvent(input.state, {
    type: "session.inputQueue.updated",
    sessionId: input.sessionId,
    items: input.context.inputQueue.list(input.sessionId)
  });

  let startedTurnToBroadcast: { turnId: string; status: string } | null = null;
  try {
    const previousTurnId = input.router.activeTurnId(input.sessionId);
    input.router.noteTurnStartRequested(input.sessionId);
    const started = await input.sessions.startTurn({
      threadId: input.sessionId,
      clientUserMessageId: item.clientMessageId,
      text: buildGuidedInput({
        text: item.text,
        guidance: item.guidance,
        capabilities: listInstalledCodexCapabilities()
      })
    });
    const startedTurn = readStartedTurn(started);
    if (startedTurn !== null) {
      input.router.noteTurnStartedFromStartResponse(input.sessionId, startedTurn.turnId, previousTurnId);
      startedTurnToBroadcast = startedTurn;
    } else {
      input.router.noteTurnStartFailed(input.sessionId);
    }
    input.context.inputQueue.markSent(input.sessionId, item.id);
    input.context.audit.record({
      deviceId: null,
      sessionId: input.sessionId,
      actionType: "session.inputQueue.autoSend",
      result: "success",
      detail: `队列输入已自动发送，queueItemId=${item.id}，textLength=${item.textLength}，mode=${item.guidance.mode}，selectedCapabilityCount=${item.guidance.selectedCapabilityIds.length}`
    });
  } catch (error) {
    if (isIndeterminateCodexTurnRequestTimeout(error)) {
      input.context.inputQueue.markSent(input.sessionId, item.id);
      input.context.audit.record({
        deviceId: null,
        sessionId: input.sessionId,
        actionType: "session.inputQueue.autoSend",
        result: "success",
        detail: `队列输入已交给 Codex 继续执行，queueItemId=${item.id}，textLength=${item.textLength}，mode=${item.guidance.mode}，selectedCapabilityCount=${item.guidance.selectedCapabilityIds.length}`
      });
    } else {
    input.router.noteTurnStartFailed(input.sessionId);
    input.context.inputQueue.markFailed(input.sessionId, item.id);
    input.context.audit.record({
      deviceId: null,
      sessionId: input.sessionId,
      actionType: "session.inputQueue.autoSend",
      result: "failed",
      detail: `队列输入自动发送失败，queueItemId=${item.id}，textLength=${item.textLength}，mode=${item.guidance.mode}，selectedCapabilityCount=${item.guidance.selectedCapabilityIds.length}`
    });
    }
  }

  broadcastSharedRuntimeEvent(input.state, {
    type: "session.inputQueue.updated",
    sessionId: input.sessionId,
    items: input.context.inputQueue.list(input.sessionId)
  });
  if (startedTurnToBroadcast !== null) {
    broadcastSharedRuntimeEvent(input.state, {
      type: "turn.status.updated",
      sessionId: input.sessionId,
      turnId: startedTurnToBroadcast.turnId,
      status: startedTurnToBroadcast.status
    });
  }
}

async function startNextQueuedInputsForTerminalTurns(
  context: AppContext,
  state: SharedCodexRuntimeState,
  sessions: CommandRouterSessions,
  router: ReturnType<typeof createCommandRouter>,
  events: TimelineRuntimeEvent[]
): Promise<void> {
  for (const terminalTurn of terminalTurnsFromRuntimeEvents(events)) {
    await startNextQueuedInput({
      context,
      state,
      sessions,
      router,
      sessionId: terminalTurn.sessionId,
      terminalTurnId: terminalTurn.turnId
    });
  }
}

function desktopTurnStatus(value: unknown): string {
  if (value === "inProgress") return "running";
  return typeof value === "string" ? value : "";
}

function activeTurnIdFromDesktopConversationState(conversationState: Record<string, unknown>): string {
  const turns = asArray(conversationState.turns);
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = asRecord(turns[index]);
    const status = desktopTurnStatus(turn.status);
    if (status !== "running") continue;
    return stringField(turn, "turnId") || stringField(turn, "id");
  }
  return "";
}

function syncRouterWithDesktopConversationState(router: ReturnType<typeof createCommandRouter>, conversationState: Record<string, unknown>): void {
  const sessionId = stringField(conversationState, "id") || stringField(conversationState, "conversationId");
  if (sessionId.length === 0) return;

  const turnId = activeTurnIdFromDesktopConversationState(conversationState);
  if (turnId.length > 0) {
    router.noteTurnStarted(sessionId, turnId);
    return;
  }
  const turns = asArray(conversationState.turns);
  const latestTurn = asRecord(turns[turns.length - 1]);
  const status = desktopTurnStatus(latestTurn.status);
  if (status === "completed" || status === "failed" || status === "interrupted") {
    router.noteTurnCompleted(sessionId);
    return;
  }

  const runtimeStatus = asRecord(conversationState.threadRuntimeStatus);
  if (stringField(runtimeStatus, "type") === "idle") {
    router.noteTurnCompleted(sessionId);
  }
}

function isDesktopFollowerEnabled(): boolean {
  return process.env.CODE_ENABLE_DESKTOP_FOLLOWER === "1";
}

function getSharedCodexRuntime(context: AppContext): SharedCodexRuntimeState {
  const existing = sharedCodexRuntimes.get(context);
  if (existing) return existing;

  const subscribers = new Set<SharedCodexRuntimeSubscriber>();
  let state: SharedCodexRuntimeState;
  const runtimePromise = context.codex.createSessionRuntime()
    .then(async (runtime) => {
      let router: ReturnType<typeof createCommandRouter> | null = null;
      const desktopFollower = isDesktopFollowerEnabled()
        ? await createCodexDesktopFollowerBridge({
          socketPath: context.config.codexIpcSocketPath,
          onConversationStateChanged: (conversationState) => {
            if (router) syncRouterWithDesktopConversationState(router, conversationState);
            broadcastDesktopConversationState(context, state, conversationState);
          }
        }).catch(() => null)
        : null;
      const sessions = createCoalescedDetailReadSessions(
        createFollowerAwareSessions(runtime.sessions, desktopFollower, context.codex.createSessionRuntime),
        state
      );
      const commandRouter = createCommandRouter({
        sessions,
        capabilities: () => listInstalledCodexCapabilities(),
        models: context.codex.listModels,
        projects: context.projects,
        accountUsage: context.codex.readAccountUsage,
        runtimeConfig: context.runtimeConfig,
        runtimeConfigBaseline: context.codex.readRuntimeConfigBaseline,
        queue: context.inputQueue,
        localWebSessions: context.repositories.localWebSessions,
        mediaAssets: context.mediaAssets,
        sessionAttachments: context.repositories.sessionAttachments,
        capture: context.capture
      });
      router = commandRouter;
      bindCodexNotifications(runtime.client, (event) => {
        invalidateSessionDetailSnapshotForEvent(state, event);
        broadcastApprovalSessionStateForEvent(context, state, event);
        broadcastSharedRuntimeEvent(state, event);
      }, commandRouter, (events) => {
        void (async () => {
          await startNextQueuedInputsForTerminalTurns(context, state, sessions, commandRouter, events);
          try {
            await pushFinalDetailSnapshotsForTerminalTurns(context, state, sessions, events);
          } catch {
            // A final snapshot is helpful but must not block queued input delivery.
          }
        })();
      }, context.codex.applyAccountRateLimitsNotification);
      return { ...runtime, router: commandRouter, routerSessions: sessions, desktopFollower };
    })
    .catch((error) => {
      if (sharedCodexRuntimes.get(context) === state) {
        sharedCodexRuntimes.delete(context);
      }
      throw error;
    });
  state = {
    runtimePromise,
    subscribers,
    detailReads: {
      inFlight: new Map(),
      snapshots: new Map(),
      versions: new Map()
    },
    approvalFixtures: new Map(),
    approvalFixtureFollowups: new Map()
  };
  sharedCodexRuntimes.set(context, state);
  return state;
}

async function stopSharedCodexRuntime(context: AppContext): Promise<void> {
  const state = sharedCodexRuntimes.get(context);
  if (!state) return;
  sharedCodexRuntimes.delete(context);
  state.subscribers.clear();
  state.approvalFixtures.clear();
  state.approvalFixtureFollowups.clear();
  clearDetailReadCoordinator(state);
  const runtime = await state.runtimePromise;
  runtime.desktopFollower?.stop();
  await runtime.stop();
}

function legacyEventsFromRuntimeEvent(event: TimelineRuntimeEvent): unknown[] {
  if (event.type === "turn.updated") {
    return [{ type: "turn.status.updated", sessionId: event.turn.sessionId, turnId: event.turn.id, status: event.turn.status }];
  }

  if (event.type !== "timeline.item.started" && event.type !== "timeline.item.updated" && event.type !== "timeline.item.completed") {
    return [];
  }

  const item = event.item;
  if (item.kind === "agentMessage" && item.text.length > 0) {
    return [{
      type: "message.updated",
      message: {
        id: item.id,
        sessionId: item.sessionId,
        role: "assistant",
        text: item.text,
        rawText: item.rawText,
        createdAt: item.createdAt,
        sendState: null,
        clientMessageId: null,
        canWithdraw: false
      }
    }];
  }

  if (item.kind === "plan") {
    return [{ type: "session.plan.updated", sessionId: item.sessionId, steps: item.planSteps }];
  }

  if (item.kind === "commandExecution" && item.command !== null) {
    return [{ type: "session.commandSummary.updated", sessionId: item.sessionId, command: item.command }];
  }

  if (event.type === "timeline.item.completed" && (item.kind === "diffOverview" || item.kind === "fileChange") && item.diff !== null) {
    return [{ type: "session.diffOverview.updated", sessionId: item.sessionId, diff: item.diff }];
  }

  return [];
}

function clientRuntimeEvent(event: TimelineRuntimeEvent): TimelineRuntimeEvent {
  if (event.type === "turn.updated") {
    return { type: "turn.updated", turn: stripDiffPatchesFromTurn(event.turn) };
  }
  if (event.type === "timeline.item.started" || event.type === "timeline.item.updated" || event.type === "timeline.item.completed") {
    return { type: event.type, item: stripDiffPatchesFromItem(event.item) };
  }
  return event;
}

function diagnosticMessageFromNotification(params: Record<string, unknown>, fallback: string): string {
  const direct = stringField(params, "message") ||
    stringField(params, "detail") ||
    stringField(params, "reason") ||
    stringField(params, "description") ||
    stringField(params, "title");
  if (direct.length > 0) return direct;

  const error = asRecord(params.error);
  const errorMessage = stringField(error, "message") || stringField(error, "detail") || stringField(error, "reason");
  if (errorMessage.length > 0) return errorMessage;

  const failure = asRecord(params.failure);
  const failureMessage = stringField(failure, "message") || stringField(failure, "detail") || stringField(failure, "reason");
  return failureMessage.length > 0 ? failureMessage : fallback;
}

function broadcastRuntimeEvents(
  events: TimelineRuntimeEvent[],
  broadcast: (event: unknown) => void,
  router?: ReturnType<typeof createCommandRouter>,
  afterBroadcast?: (events: TimelineRuntimeEvent[]) => void
): void {
  for (const event of events) {
    if (event.type === "turn.updated") {
      if (event.turn.status === "running") {
        router?.noteTurnStarted(event.turn.sessionId, event.turn.id);
      } else if (event.turn.status === "completed" || event.turn.status === "failed" || event.turn.status === "interrupted") {
        router?.noteTurnCompleted(event.turn.sessionId, event.turn.id);
      }
    } else if ((event.type === "timeline.item.started" || event.type === "timeline.item.updated") &&
      (event.item.status === "running" || event.item.isStreaming)) {
      router?.noteTurnStarted(event.item.sessionId, event.item.turnId);
    }
    const clientEvent = clientRuntimeEvent(event);
    broadcast(clientEvent);
    const legacyEvents = legacyEventsFromRuntimeEvent(clientEvent);
    for (const legacyEvent of legacyEvents) {
      broadcast(legacyEvent);
    }
  }
  if (events.length > 0) afterBroadcast?.(events);
}

export function bindCodexNotifications(
  client: CodexNotificationSource,
  broadcast: (event: unknown) => void,
  router?: ReturnType<typeof createCommandRouter>,
  afterBroadcast?: (events: TimelineRuntimeEvent[]) => void,
  applyAccountRateLimitsNotification?: AppContext["codex"]["applyAccountRateLimitsNotification"]
): void {
  const timelineRuntime = new CodexTimelineRuntime();

  client.onNotification("account/rateLimits/updated", (params) => {
    if (!applyAccountRateLimitsNotification) return;
    broadcast({
      type: "codex.accountUsage.snapshot",
      requestId: "account-rateLimits-updated",
      usage: applyAccountRateLimitsNotification(params)
    });
  });

  client.onNotification("thread/status/changed", (params) => {
    const sessionId = sessionIdFromParams(params);
    const turnId = turnIdFromParams(params);
    const status = statusLabelFromParams(params);
    if (sessionId.length > 0 && status.length > 0) {
      broadcast({ type: "turn.status.updated", sessionId, turnId, status });
    }
  });

  const timelineNotificationMethods: CodexNotificationMethod[] = [
    "remoteControl/status/changed",
    "thread/compacted",
    "turn/started",
    "turn/completed",
    "turn/plan/updated",
    "turn/diff/updated",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
    "item/commandExecution/terminalInteraction",
    "item/fileChange/patchUpdated",
    "item/fileChange/outputDelta",
    "item/mcpToolCall/progress"
  ];
  for (const method of timelineNotificationMethods) {
    client.onNotification(method, (params) => {
      broadcastRuntimeEvents(timelineRuntime.applyNotification(method, params), broadcast, router, afterBroadcast);
    });
  }

  const diagnosticNotificationMethods: CodexNotificationMethod[] = ["error", "warning", "guardianWarning", "configWarning"];
  for (const method of diagnosticNotificationMethods) {
    client.onNotification(method, (params) => {
      const events = timelineRuntime.applyNotification(method, params);
      if (events.length > 0) {
        broadcastRuntimeEvents(events, broadcast, router, afterBroadcast);
        return;
      }
      broadcast({
        type: "command.failed",
        requestId: `codex-runtime-${method}`,
        errorCode: "CODEX_RUNTIME_ERROR",
        message: diagnosticMessageFromNotification(params, "Codex 运行时错误")
      });
    });
  }

  client.onNotification("serverRequest/resolved", (params) => {
    const requestId = requestIdFromParams(params);
    if (requestId.length > 0) {
      broadcastRuntimeEvents(timelineRuntime.resolveServerRequest(requestId), broadcast, router, afterBroadcast);
      router?.noteApprovalResolved(requestId);
    }
  });

  const approvalMethods = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "execCommandApproval",
    "applyPatchApproval"
  ] as CodexServerRequestMethod[];
  for (const method of approvalMethods) {
    client.onServerRequest?.(method, (request) => {
      const params = router?.noteApprovalRequest({ id: request.id, method, params: request.params }) ?? request.params;
      broadcastRuntimeEvents(timelineRuntime.applyServerRequest(request.method, request.id, params), broadcast, router, afterBroadcast);
    });
  }
}

export function registerWsServer(app: FastifyInstance, context: AppContext): void {
  app.addHook("onClose", async () => {
    await stopSharedCodexRuntime(context);
  });

  app.get("/ws", { websocket: true }, (socket, request) => {
    const token = request.headers.authorization?.replace("Bearer ", "") ?? "";
    const device = context.pairing.validateToken(token);

    if (!device) {
      send(socket, { type: "command.failed", requestId: "auth", errorCode: "AUTH_INVALID", message: "授权失效，请重新配对" });
      socket.close();
      return;
    }

    let closed = false;
    const sharedRuntime = getSharedCodexRuntime(context);
    const subscriber: SharedCodexRuntimeSubscriber = {
      activeDetailSessionId: null,
      syncedSessionIds: new Set<string>(),
      sendEvent(event: unknown): void {
        if (!closed) send(socket, event);
      }
    };
    sharedRuntime.subscribers.add(subscriber);
    const runtimePromise = sharedRuntime.runtimePromise.then(async (runtime) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        const codexSessions = await runtime.sessions.listSessionSummaries();
        const sessions = context.sessions.replaceToolSessions("codex-mac", codexSessions);
        if (!closed) send(socket, { type: "sessions.snapshot", sessions });
      } catch (error) {
        if (!closed) {
          send(socket, { type: "sessions.snapshot", sessions: context.sessions.list("codex-mac") });
          send(socket, {
            type: "command.failed",
            requestId: "codex-session-list",
            errorCode: "CODEX_SESSION_LIST_UNAVAILABLE",
            message: error instanceof Error ? error.message : "Codex 会话列表读取失败"
          });
        }
      }
      return runtime;
    });
    let commandQueue = Promise.resolve();

    socket.on("close", () => {
      closed = true;
      sharedRuntime.subscribers.delete(subscriber);
    });

    socket.on("message", (message: { toString(encoding?: BufferEncoding): string }) => {
      const raw = message.toString("utf8");
      commandQueue = commandQueue
        .then(async () => {
          const runtime = await runtimePromise;
          await handleClientMessage(socket, context, runtime.router, subscriber, device.id, raw, sharedRuntime, runtime.routerSessions);
        })
        .catch((error) => {
          send(socket, {
            type: "command.failed",
            requestId: "codex-runtime",
            errorCode: "CODEX_RUNTIME_UNAVAILABLE",
            message: error instanceof Error ? error.message : "Codex 官方通道不可用"
          });
        });
    });
  });
}
