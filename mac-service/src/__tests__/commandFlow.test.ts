import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestAppContext } from "./helpers.js";
import { createCodexIpcClient, startCodexIpcRouter, type CodexIpcRouterHandle } from "../codex/codexIpcBridge.js";
import type { CodexServerRequestMethod } from "../codex/codexAppServerProtocol.js";
import { createCodexSessionManager, type SessionDetail } from "../codex/codexSessionManager.js";
import { createCodexGeneratedImageArtifactService } from "../domain/codexGeneratedImageArtifactService.js";
import { createCaptureService } from "../domain/captureService.js";
import type { CodexTurnInputItem } from "../domain/codexTurnInputBuilder.js";
import type { InstalledCodexCapability } from "../domain/installedCodexCapabilities.js";
import { createSessionInputQueueService } from "../domain/sessionInputQueueService.js";
import { createServer } from "../server/httpServer.js";
import { bindCodexNotifications, ClientCommandSchema, createCommandRouter, createFollowerAwareSessions } from "../server/wsServer.js";

type TestServer = Awaited<ReturnType<typeof createServer>> & {
  injectWS(path: string, upgradeContext?: { headers?: Record<string, string> }): Promise<TestWebSocket>;
};

type TestContext = ReturnType<typeof createTestAppContext>;
type TestRuntime = Awaited<ReturnType<TestContext["codex"]["createSessionRuntime"]>>;
type TestRuntimeSessions = TestRuntime["sessions"];
type TestRuntimeSessionsWithCompact = Omit<TestRuntimeSessions, "createThread"> & {
  createThread?: TestRuntimeSessions["createThread"];
  compactContext?: (input: { threadId: string }) => Promise<unknown>;
};

type TestWebSocket = {
  send(value: string): void;
  terminate(): void;
  on?(event: "message", handler: (value: { toString(encoding?: BufferEncoding): string }) => void): void;
  __collectedMessages?: unknown[];
};

type AuditRow = {
  device_id: string | null;
  session_id: string | null;
  action_type: string;
  result: string;
  detail: string;
};

const DESKTOP_FOLLOWER_ENV = "CODE_ENABLE_DESKTOP_FOLLOWER";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function turnInputText(input: { text?: string; inputItems?: CodexTurnInputItem[] }): string {
  const item = input.inputItems?.find((candidate) => candidate.type === "text");
  if (item?.type === "text") return item.text;
  return input.text ?? "";
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createNoopNotificationClient() {
  return {
    initialize: async () => ({}),
    request: async () => ({}),
    respond: () => undefined,
    onNotification: () => undefined,
    onServerRequest: () => undefined,
    close: () => undefined
  };
}

function sessionDetail(sessionId: string): SessionDetail {
  return {
    session: {
      id: sessionId,
      toolId: "codex-mac",
      title: "会话详情",
      projectPath: null,
      projectName: null,
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      isPinned: false,
      needsUserInput: false,
      waitsForNextDirection: false,
      statusLabel: "notLoaded",
      lastMessagePreview: "详情"
    },
    messages: [],
    turns: []
  };
}

function sessionDetailWithContextUsage(sessionId: string, contextTokensUsed: number): SessionDetail {
  const detail = sessionDetail(sessionId);
  detail.session.contextTokensUsed = contextTokensUsed;
  detail.session.contextWindowTokens = 200000;
  detail.session.updatedAt = new Date("2026-05-17T09:00:00.000Z").toISOString();
  return detail;
}

function createRuntime(sessionOverrides: Partial<TestRuntimeSessionsWithCompact>): TestRuntime {
  const sessions: TestRuntimeSessionsWithCompact = {
    createSession: async () => ({ threadId: "thread-1", turnId: "turn-1", status: "running" }),
    resumeSession: async () => ({}),
    readSession: async () => ({}),
    readRawThread: async () => ({}),
    readSessionDetail: async () => sessionDetail("thread-1"),
    listSessions: async () => ({}),
    listSessionSummaries: async () => [],
    startTurn: async () => ({ turnId: "turn-started", status: "running" }),
    steerTurn: async () => ({}),
    interruptTurn: async () => ({}),
    compactContext: async () => ({}),
    renameSession: async () => ({}),
    recordApprovalRequest: () => undefined,
    readPendingApproval: () => null,
    forgetApprovalRequest: () => undefined,
    respondToApproval: async () => undefined,
  };
  Object.assign(sessions, sessionOverrides);
  return {
    client: createNoopNotificationClient(),
    sessions: sessions as TestRuntimeSessions,
    stop: async () => undefined
  };
}

async function openAuthedWs(context: TestContext, server: TestServer, deviceName = "Mate 60 Pro"): Promise<{ deviceId: string; authToken: string; ws: TestWebSocket }> {
  const code = context.pairing.createPairingCode("Mac");
  const claimed = context.pairing.claimPairingCode(code.value, deviceName);
  const ws = await server.injectWS("/ws", { headers: { authorization: `Bearer ${claimed.authToken}` } });
  collectWsMessages(ws);
  return { deviceId: claimed.device.id, authToken: claimed.authToken, ws };
}

async function waitForAuditRows(context: TestContext, count: number): Promise<AuditRow[]> {
  for (let index = 0; index < 50; index++) {
    const rows = context.audit.list(50) as AuditRow[];
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return context.audit.list(50) as AuditRow[];
}

function sendCommand(ws: TestWebSocket, command: Record<string, unknown>): void {
  ws.send(JSON.stringify(command));
}

function collectWsMessages(ws: TestWebSocket): unknown[] {
  if (ws.__collectedMessages) return ws.__collectedMessages;
  const messages: unknown[] = [];
  ws.__collectedMessages = messages;
  ws.on?.("message", (value) => {
    messages.push(JSON.parse(value.toString("utf8")) as unknown);
  });
  return messages;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function waitForWsMessage(messages: unknown[], predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (let index = 0; index < 100; index++) {
    for (const message of messages) {
      const record = asRecord(message);
      if (predicate(record)) return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for websocket message");
}

async function hasWsMessage(messages: unknown[], predicate: (message: Record<string, unknown>) => boolean): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (const message of messages) {
    const record = message !== null && typeof message === "object" ? message as Record<string, unknown> : {};
    if (predicate(record)) return true;
  }
  return false;
}

async function hasNewWsMessage(messages: unknown[], startIndex: number, predicate: (message: Record<string, unknown>) => boolean): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index];
    const record = message !== null && typeof message === "object" ? message as Record<string, unknown> : {};
    if (predicate(record)) return true;
  }
  return false;
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("command flow", () => {
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("keeps failed message and appends a received retry message", () => {
    const failed = { id: "m1", text: "继续", sendState: "failed" };
    const retry = { id: "m2", text: "继续执行", sendState: "received" };

    expect([failed, retry]).toEqual([
      { id: "m1", text: "继续", sendState: "failed" },
      { id: "m2", text: "继续执行", sendState: "received" }
    ]);
  });

  it("echoes the create request id on the created session update", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        createSession: async () => ({ threadId: "thread-created", turnId: "turn-created", status: "running" })
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);

    sendCommand(ws, {
      type: "session.create",
      requestId: "create-session-match",
      toolId: "codex-mac",
      projectPath: null,
      text: "创建后进入详情"
    });
    const update = await waitForWsMessage(messages, (message) => {
      const session = asRecord(message.session);
      return message.type === "session.updated" &&
        message.requestId === "create-session-match" &&
        session.id === "thread-created";
    });

    expect(update.requestId).toBe("create-session-match");
    ws.terminate();
  });

  it("publishes a created session before the first turn start finishes", async () => {
    const context = createTestAppContext();
    let resolveStartTurn = (_value: { turnId: string; status: string }): void => {
      throw new Error("start turn resolver was not captured");
    };
    let startTurnSettled = false;
    let startedText = "";
    let startedClientUserMessageId = "";
    let skippedPreflightResume = false;
    const runtime = createRuntime({
      listSessionSummaries: async () => [],
      createSession: async () => {
        throw new Error("session.create should not wait for the combined createSession path");
      },
      startTurn: async (input) => {
        startedText = turnInputText(input);
        startedClientUserMessageId = input.clientUserMessageId ?? "";
        skippedPreflightResume = asRecord(input).skipPreflightResume === true;
        const result = await new Promise<{ turnId: string; status: string }>((resolve) => {
          resolveStartTurn = resolve;
        });
        startTurnSettled = true;
        return result;
      }
    });
    Object.assign(runtime.sessions, {
      createThread: async (input: { projectPath: string | null; text: string }) => ({
        threadId: "thread-fast-create",
        projectPath: input.projectPath
      })
    });
    context.codex.createSessionRuntime = async () => runtime;
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);

    sendCommand(ws, {
      type: "session.create",
      requestId: "fast-create",
      clientMessageId: "client-create-1",
      toolId: "codex-mac",
      projectPath: null,
      text: "快速创建"
    });

    const update = await waitForWsMessage(messages, (message) => {
      const session = asRecord(message.session);
      return message.type === "session.updated" &&
        message.requestId === "fast-create" &&
        session.id === "thread-fast-create";
    });
    const received = await waitForWsMessage(messages, (message) => {
      const receivedMessage = asRecord(message.message);
      return message.type === "message.updated" &&
        receivedMessage.sessionId === "thread-fast-create" &&
        receivedMessage.id === "client-create-1" &&
        receivedMessage.clientMessageId === "client-create-1" &&
        receivedMessage.sendState === "received";
    });

    expect(update.requestId).toBe("fast-create");
    expect(received.type).toBe("message.updated");
    expect(startedText).toBe("快速创建");
    expect(startedClientUserMessageId).toBe("client-create-1");
    expect(skippedPreflightResume).toBe(true);
    expect(startTurnSettled).toBe(false);

    resolveStartTurn({ turnId: "turn-fast-create", status: "running" });
    await waitForCondition(() => startTurnSettled);
    await waitForWsMessage(messages, (message) => message.type === "turn.status.updated" &&
      message.sessionId === "thread-fast-create" &&
      message.turnId === "turn-fast-create" &&
      message.status === "running");
    ws.terminate();
  });

  it("parses approval response commands", () => {
    const parsed = ClientCommandSchema.parse({
      type: "approval.respond",
      requestId: "req-1",
      sessionId: "session-1",
      approvalId: "approval-1",
      actionId: "decline",
      answers: {
        reason: { answers: ["请改成只读方案"] }
      }
    });
    expect(parsed.type).toBe("approval.respond");
    if (parsed.type === "approval.respond") {
      expect(parsed.actionId).toBe("decline");
      expect(parsed.answers?.reason.answers[0]).toBe("请改成只读方案");
    }
  });

  it("keeps command approval pending after accept until Codex resolves the server request", async () => {
    const responses: Array<{ id: string; result: unknown }> = [];
    const sessions = createCodexSessionManager({
      request: async () => ({}),
      respond: (id, result) => {
        responses.push({ id, result });
      }
    });
    sessions.recordApprovalRequest({
      id: "approval-accept",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-approval",
        turnId: "turn-approval",
        command: "printf approval"
      }
    });

    await sessions.respondToApproval("approval-accept", "accept");

    expect(responses).toEqual([
      { id: "approval-accept", result: { decision: "accept" } }
    ]);
    expect(sessions.readPendingApproval("thread-approval")).toMatchObject({
      id: "approval-accept",
      kind: "command",
      body: "$ printf approval"
    });

    sessions.forgetApprovalRequest("approval-accept");

    expect(sessions.readPendingApproval("thread-approval")).toBeNull();
  });

  it("maps command approval decline without reason to the official decision without local output", async () => {
    const responses: Array<{ id: string; result: unknown }> = [];
    const requests: string[] = [];
    const sessions = createCodexSessionManager({
      request: async (method) => {
        requests.push(method);
        return {};
      },
      respond: (id, result) => {
        responses.push({ id, result });
      }
    });
    sessions.recordApprovalRequest({
      id: "approval-decline",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-approval",
        turnId: "turn-approval",
        command: "rm generated.tmp"
      }
    });

    await sessions.respondToApproval("approval-decline", "decline");

    expect(responses).toEqual([
      { id: "approval-decline", result: { decision: "decline" } }
    ]);
    expect(requests).toEqual([]);
    expect(sessions.readPendingApproval("thread-approval")).toMatchObject({
      id: "approval-decline"
    });
  });

  it("forwards command approval decline reasons only through the official approval response", async () => {
    const events: string[] = [];
    const sessions = createCodexSessionManager({
      request: async (method, params) => {
        const record = asRecord(params);
        const input = Array.isArray(record.input) ? asRecord(record.input[0]) : {};
        events.push(`request:${method}:${String(input.text ?? "")}`);
        return {};
      },
      respond: (id, result) => {
        events.push(`respond:${id}:${JSON.stringify(result)}`);
      }
    }, {
      readThreadMetadata: async () => new Map([
        ["thread-approval", { title: "审批会话", firstUserMessage: null }]
      ])
    });
    sessions.recordApprovalRequest({
      id: "approval-decline-reason",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-approval",
        turnId: "turn-approval",
        command: "rm generated.tmp"
      }
    });

    await sessions.respondToApproval("approval-decline-reason", "decline", {
      reason: { answers: ["请改成只读检查"] }
    });

    expect(events).toEqual([
      "respond:approval-decline-reason:{\"decision\":\"decline\"}"
    ]);
    expect(sessions.readPendingApproval("thread-approval")).toMatchObject({
      id: "approval-decline-reason"
    });
  });

  it("maps command approval cancel to official cancel without synthetic assistant output", async () => {
    const responses: Array<{ id: string; result: unknown }> = [];
    const requests: string[] = [];
    const sessions = createCodexSessionManager({
      request: async (method) => {
        requests.push(method);
        return {};
      },
      respond: (id, result) => {
        responses.push({ id, result });
      }
    });
    sessions.recordApprovalRequest({
      id: "approval-cancel",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-approval",
        turnId: "turn-approval",
        command: "touch should-not-run"
      }
    });

    await sessions.respondToApproval("approval-cancel", "cancel");

    expect(responses).toEqual([
      { id: "approval-cancel", result: { decision: "cancel" } }
    ]);
    expect(requests).toEqual([]);
    expect(sessions.readPendingApproval("thread-approval")).toMatchObject({
      id: "approval-cancel"
    });
  });

  it("parses session rename and unsubscribe commands", () => {
    const renamed = ClientCommandSchema.parse({
      type: "session.rename",
      requestId: "rename-1",
      sessionId: "session-1",
      title: "新的会话标题"
    });
    const unsubscribed = ClientCommandSchema.parse({
      type: "session.sync.unsubscribe",
      requestId: "unsubscribe-1",
      sessionId: "session-1"
    });

    expect(renamed.type).toBe("session.rename");
    if (renamed.type === "session.rename") {
      expect(renamed.title).toBe("新的会话标题");
    }
    expect(unsubscribed.type).toBe("session.sync.unsubscribe");
  });

  it("records approval requests with the active turn id when Codex omits it", () => {
    let recordedParams: Record<string, unknown> = {};
    const router = createCommandRouter({
      sessions: createRuntime({
        recordApprovalRequest: (input) => {
          recordedParams = input.params;
        }
      }).sessions
    });

    router.noteTurnStarted("thread-1", "turn-active");
    const params = router.noteApprovalRequest({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        command: "pnpm test"
      }
    });

    expect(recordedParams).toEqual({
      threadId: "thread-1",
      command: "pnpm test",
      turnId: "turn-active"
    });
    expect(params).toEqual(recordedParams);
  });

  it("records approval requests with the active session id when Codex omits it", () => {
    let recordedParams: Record<string, unknown> = {};
    const router = createCommandRouter({
      sessions: createRuntime({
        recordApprovalRequest: (input) => {
          recordedParams = input.params;
        }
      }).sessions
    });

    router.noteTurnStarted("thread-1", "turn-active");
    const params = router.noteApprovalRequest({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        turnId: "turn-active",
        command: "pnpm test"
      }
    });

    expect(recordedParams).toEqual({
      threadId: "thread-1",
      turnId: "turn-active",
      command: "pnpm test"
    });
    expect(params).toEqual(recordedParams);
  });

  it("records approval requests against the only active session when Codex omits session and turn ids", () => {
    let recordedParams: Record<string, unknown> = {};
    const router = createCommandRouter({
      sessions: createRuntime({
        recordApprovalRequest: (input) => {
          recordedParams = input.params;
        }
      }).sessions
    });

    router.noteTurnStarted("thread-1", "turn-active");
    const params = router.noteApprovalRequest({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "pnpm test"
      }
    });

    expect(recordedParams).toEqual({
      threadId: "thread-1",
      command: "pnpm test",
      turnId: "turn-active"
    });
    expect(params).toEqual(recordedParams);
  });

  it("gates dev approval fixtures and clears them through mobile approval responses", async () => {
    const previous = process.env.CODE_ENABLE_APPROVAL_TEST_FIXTURES;
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [{
          id: "thread-fixture",
          toolId: "codex-mac",
          title: "审批夹具会话",
          projectPath: null,
          projectName: null,
          createdAt: "2026-05-10T00:00:00.000Z",
          updatedAt: "2026-05-10T00:00:00.000Z",
          isPinned: false,
          needsUserInput: false,
          waitsForNextDirection: false,
          statusLabel: "notLoaded",
          lastMessagePreview: ""
        }],
        readSessionDetail: async (threadId: string) => sessionDetail(threadId)
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    try {
      restoreEnv("CODE_ENABLE_APPROVAL_TEST_FIXTURES", undefined);
      sendCommand(ws, {
        type: "dev.approvalFixture.show",
        requestId: "fixture-disabled",
        sessionId: "thread-fixture",
        kind: "permission"
      });
      await waitForWsMessage(messages, (message) => message.type === "command.failed" && message.requestId === "fixture-disabled");

      process.env.CODE_ENABLE_APPROVAL_TEST_FIXTURES = "1";
      sendCommand(ws, {
        type: "dev.approvalFixture.show",
        requestId: "fixture-permission",
        sessionId: "thread-fixture",
        kind: "permission"
      });
      const shown = await waitForWsMessage(messages, (message) => message.type === "approval.updated" &&
        message.sessionId === "thread-fixture" &&
        asRecord(message.approval).kind === "permission");
      const approval = asRecord(shown.approval);
      expect(approval.id).toBe("dev-approval-permission-fixture-permission");
      const fixturePendingSession = await waitForWsMessage(messages, (message) => message.type === "session.updated" &&
        asRecord(message.session).id === "thread-fixture" &&
        asRecord(message.session).needsUserInput === true);
      expect(fixturePendingSession.session).toMatchObject({
        id: "thread-fixture",
        needsUserInput: true,
        waitsForNextDirection: false,
        statusLabel: "waiting_for_approval"
      });

      sendCommand(ws, {
        type: "dev.approvalFixture.show",
        requestId: "fixture-command",
        sessionId: "thread-fixture",
        kind: "command"
      });
      const commandShown = await waitForWsMessage(messages, (message) => message.type === "approval.updated" &&
        message.sessionId === "thread-fixture" &&
        asRecord(message.approval).kind === "command");
      const commandApproval = asRecord(commandShown.approval);
      expect(commandApproval.actions).toEqual([
        expect.objectContaining({ id: "accept", label: "同意" }),
        expect.objectContaining({ id: "acceptWithExecpolicyAmendment", label: "以后同意同类命令" }),
        expect.objectContaining({ id: "decline", label: "不执行，继续对话" })
      ]);
      expect(commandApproval.actions).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "cancel" })
      ]));

      sendCommand(ws, {
        type: "approval.respond",
        requestId: "fixture-command-respond",
        sessionId: "thread-fixture",
        approvalId: "dev-approval-command-fixture-command",
        actionId: "decline",
        answers: {
          reason: { answers: ["请换成只读检查"] }
        }
      });
      await waitForWsMessage(messages, (message) => message.type === "approval.updated" &&
        message.sessionId === "thread-fixture" &&
        message.approval === null);
      const fixtureClearedSession = await waitForWsMessage(messages, (message) => message.type === "session.updated" &&
        asRecord(message.session).id === "thread-fixture" &&
        asRecord(message.session).needsUserInput === false &&
        asRecord(message.session).statusLabel === "running");
      expect(fixtureClearedSession.session).toMatchObject({
        id: "thread-fixture",
        needsUserInput: false,
        waitsForNextDirection: false
      });
      const commandFollowup = await waitForWsMessage(messages, (message) => message.type === "timeline.item.updated" &&
        asRecord(message.item).sessionId === "thread-fixture" &&
        String(asRecord(message.item).text).includes("请换成只读检查"));
      expect(asRecord(commandFollowup.item)).toEqual(expect.objectContaining({
        kind: "agentMessage",
        status: "completed"
      }));
      sendCommand(ws, { type: "session.read", requestId: "fixture-read-after-followup", sessionId: "thread-fixture" });
      const detailAfterFollowup = await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" &&
        message.sessionId === "thread-fixture" &&
        JSON.stringify(message).includes("请换成只读检查"));
      expect(JSON.stringify(detailAfterFollowup)).toContain("已收到命令审核决定：跳过");

      sendCommand(ws, {
        type: "dev.approvalFixture.show",
        requestId: "fixture-mcp",
        sessionId: "thread-fixture",
        kind: "mcp_elicitation"
      });
      const replaced = await waitForWsMessage(messages, (message) => message.type === "approval.updated" &&
        message.sessionId === "thread-fixture" &&
        asRecord(message.approval).kind === "mcp_elicitation");
      const replacedApproval = asRecord(replaced.approval);
      expect(replacedApproval.id).toBe("dev-approval-mcp_elicitation-fixture-mcp");
      expect(replacedApproval.inputFields).toBeUndefined();
      expect(replacedApproval.actions).toEqual([
        expect.objectContaining({ id: "accept", label: "提供请求的信息" }),
        expect.objectContaining({ id: "decline", label: "不提供，但继续" }),
        expect.objectContaining({ id: "cancel", label: "取消请求", decisionType: "cancel" })
      ]);

      sendCommand(ws, {
        type: "approval.respond",
        requestId: "fixture-respond",
        sessionId: "thread-fixture",
        approvalId: "dev-approval-mcp_elicitation-fixture-mcp",
        actionId: "decline"
      });
      await waitForWsMessage(messages, (message) => message.type === "approval.updated" &&
        message.sessionId === "thread-fixture" &&
        message.approval === null);
    } finally {
      restoreEnv("CODE_ENABLE_APPROVAL_TEST_FIXTURES", previous);
      ws.terminate();
    }
  });

  it("parses local web and capture commands", () => {
    expect(ClientCommandSchema.parse({
      type: "projects.list",
      requestId: "projects-1"
    }).type).toBe("projects.list");

    expect(ClientCommandSchema.parse({
      type: "projects.create",
      requestId: "projects-create-1",
      rootId: "root-dev",
      projectName: "Mobile Created"
    }).type).toBe("projects.create");

    expect(ClientCommandSchema.parse({
      type: "projects.hide",
      requestId: "projects-hide-1",
      projectPath: "/repo/old"
    }).type).toBe("projects.hide");

    expect(ClientCommandSchema.parse({
      type: "codex.accountUsage.refresh",
      requestId: "usage-1"
    }).type).toBe("codex.accountUsage.refresh");

    expect(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-attachments-1",
      sessionId: "thread-1",
      clientMessageId: "client-1",
      text: "看附件",
      attachmentIds: ["asset-1"]
    }).type).toBe("session.sendText");

    expect(ClientCommandSchema.parse({
      type: "session.attachments.send",
      requestId: "attachments-1",
      sessionId: "thread-1",
      clientMessageId: "client-attachments-1",
      attachmentIds: ["asset-1"]
    }).type).toBe("session.attachments.send");

    expect(() => ClientCommandSchema.parse({
      type: "session.inputQueue.enqueue",
      requestId: "queue-attachments-1",
      sessionId: "thread-1",
      clientMessageId: "client-queued-attachments-1",
      text: "下一轮再看附件",
      guidance: { mode: "queued", selectedCapabilityIds: [] },
      attachmentIds: ["asset-1"]
    })).toThrow();

    expect(ClientCommandSchema.parse({
      type: "localWeb.open",
      requestId: "local-web-1",
      sessionId: "thread-1",
      targetUrl: "http://127.0.0.1:5173"
    }).type).toBe("localWeb.open");

    expect(ClientCommandSchema.parse({
      type: "localWeb.close",
      requestId: "local-web-close-1",
      localWebSessionId: "local-web-1"
    }).type).toBe("localWeb.close");

    expect(ClientCommandSchema.parse({
      type: "capture.screenshot",
      requestId: "capture-1",
      sessionId: "thread-1",
      target: "screen",
      localWebSessionId: null,
      userConfirmed: true
    }).type).toBe("capture.screenshot");
  });

  it("routes project list, create, hide and unhide through WebSocket with audits", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-ws-project-root-"));
    const context = createTestAppContext({ projectRoots: [root] });
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => []
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "projects.list", requestId: "projects-list-1" });
    const listed = await waitForWsMessage(messages, (message) =>
      message.type === "projects.snapshot" && message.requestId === "projects-list-1");
    expect((listed.roots as Array<Record<string, unknown>>)[0]).toMatchObject({
      path: root,
      isDefault: true,
      isAvailable: true
    });

    const rootId = (listed.roots as Array<Record<string, unknown>>)[0].id;
    sendCommand(ws, {
      type: "projects.create",
      requestId: "projects-create-1",
      rootId,
      projectName: "Mobile Created"
    });
    const created = await waitForWsMessage(messages, (message) =>
      message.type === "project.created" && message.requestId === "projects-create-1");
    expect(created.project).toMatchObject({
      projectPath: path.join(root, "Mobile Created"),
      projectName: "Mobile Created",
      isHidden: false,
      createdByMobile: true
    });
    expect(fs.existsSync(path.join(root, "Mobile Created"))).toBe(true);

    sendCommand(ws, {
      type: "projects.hide",
      requestId: "projects-hide-1",
      projectPath: path.join(root, "Mobile Created")
    });
    const hidden = await waitForWsMessage(messages, (message) =>
      message.type === "project.visibility.updated" && message.requestId === "projects-hide-1");
    expect(hidden.project).toMatchObject({ isHidden: true });
    expect(fs.existsSync(path.join(root, "Mobile Created"))).toBe(true);

    sendCommand(ws, {
      type: "projects.unhide",
      requestId: "projects-unhide-1",
      projectPath: path.join(root, "Mobile Created")
    });
    const restored = await waitForWsMessage(messages, (message) =>
      message.type === "project.visibility.updated" && message.requestId === "projects-unhide-1");
    expect(restored.project).toMatchObject({ isHidden: false });

    const logs = await waitForAuditRows(context, 4);
    expect(logs.some((entry) => entry.action_type === "projects.list" && entry.result === "success")).toBe(true);
    expect(logs.some((entry) => entry.action_type === "projects.create" && entry.result === "success")).toBe(true);
    expect(logs.some((entry) => entry.action_type === "projects.hide" && entry.result === "success")).toBe(true);
    expect(logs.some((entry) => entry.action_type === "projects.unhide" && entry.result === "success")).toBe(true);
    ws.terminate();
  });

  it("emits project create failures without overwriting folders", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-ws-project-root-"));
    fs.mkdirSync(path.join(root, "Existing"));
    const context = createTestAppContext({ projectRoots: [root] });
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => []
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "projects.list", requestId: "projects-list-duplicate" });
    const listed = await waitForWsMessage(messages, (message) =>
      message.type === "projects.snapshot" && message.requestId === "projects-list-duplicate");
    const rootId = (listed.roots as Array<Record<string, unknown>>)[0].id;

    sendCommand(ws, {
      type: "projects.create",
      requestId: "projects-create-duplicate",
      rootId,
      projectName: "Existing"
    });
    const failed = await waitForWsMessage(messages, (message) =>
      message.type === "project.create.failed" && message.requestId === "projects-create-duplicate");
    expect(failed.message).toBe("同名项目已存在");
    const logs = await waitForAuditRows(context, 2);
    expect(logs.some((entry) => entry.action_type === "projects.create" && entry.result === "failed")).toBe(true);
    ws.terminate();
  });

  it("routes codex account usage refresh through WebSocket and audits unsupported usage", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => []
    });
    context.codex.readAccountUsage = async () => ({
      status: "unsupported",
      accountLabel: "user@example.com",
      accountStatusText: "当前通道暂不支持读取精确用量",
      refreshedAt: "2026-05-18T08:00:00.000Z",
      limitId: "",
      limitName: "",
      primary: null,
      secondary: null,
      credits: null,
      planType: "",
      rateLimitReachedType: "",
      rateLimits: [],
      fiveHour: null,
      weekly: null,
      message: "当前通道暂不支持读取精确用量"
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "codex.accountUsage.refresh", requestId: "usage-1" });
    const usage = await waitForWsMessage(messages, (message) =>
      message.type === "codex.accountUsage.snapshot" && message.requestId === "usage-1");
    expect(usage.usage).toMatchObject({
      status: "unsupported",
      accountStatusText: "当前通道暂不支持读取精确用量",
      fiveHour: null,
      weekly: null
    });
    const logs = await waitForAuditRows(context, 1);
    expect(logs.some((entry) => entry.action_type === "codex.accountUsage.refresh" && entry.result === "success")).toBe(true);
    ws.terminate();
  });

  it("broadcasts account usage refresh snapshots to every connected client", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => []
    });
    context.codex.readAccountUsage = async () => ({
      status: "available",
      accountLabel: "user@example.com",
      accountStatusText: "已登录",
      refreshedAt: "2026-05-22T12:41:00.000Z",
      limitId: "codex",
      limitName: "",
      primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: "2026-05-22T16:14:33.000Z" },
      secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: "2026-05-26T23:04:20.000Z" },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      planType: "prolite",
      rateLimitReachedType: "",
      rateLimits: [],
      fiveHour: null,
      weekly: null,
      message: ""
    });
    server = await createServer(context);
    await server.ready();
    const first = await openAuthedWs(context, server as TestServer, "Harmony phone");
    const second = await openAuthedWs(context, server as TestServer, "Harmony tablet");
    const firstMessages = collectWsMessages(first.ws);
    const secondMessages = collectWsMessages(second.ws);
    await waitForWsMessage(firstMessages, (message) => message.type === "sessions.snapshot");
    await waitForWsMessage(secondMessages, (message) => message.type === "sessions.snapshot");

    sendCommand(first.ws, { type: "codex.accountUsage.refresh", requestId: "usage-broadcast" });
    const firstUsage = await waitForWsMessage(firstMessages, (message) =>
      message.type === "codex.accountUsage.snapshot" && message.requestId === "usage-broadcast");
    const secondUsage = await waitForWsMessage(secondMessages, (message) =>
      message.type === "codex.accountUsage.snapshot" && message.requestId === "usage-broadcast");

    expect(firstUsage.usage).toMatchObject({ status: "available", accountStatusText: "已登录" });
    expect(secondUsage.usage).toMatchObject({ status: "available", accountStatusText: "已登录" });
    first.ws.terminate();
    second.ws.terminate();
  });

  it("refreshes the Codex session snapshot after account usage refresh", async () => {
    const context = createTestAppContext();
    let runtimeCreates = 0;
    context.codex.createSessionRuntime = async () => {
      runtimeCreates += 1;
      const runtimeIndex = runtimeCreates;
      return createRuntime({
        listSessionSummaries: async () => runtimeIndex === 1 ? [{
          id: "old-account-session",
          toolId: "codex-mac",
          title: "旧账号会话",
          projectPath: null,
          projectName: null,
          createdAt: "2026-05-22T10:00:00.000Z",
          updatedAt: "2026-05-22T10:00:00.000Z",
          isPinned: false,
          needsUserInput: false,
          waitsForNextDirection: false,
          statusLabel: "idle",
          lastMessagePreview: ""
        }] : [{
          id: "new-account-session",
          toolId: "codex-mac",
          title: "切换账号后的新会话",
          projectPath: "/Users/liuyongzhe/DevEcoStudioProjects/Code",
          projectName: "Code",
          createdAt: "2026-05-22T12:20:00.000Z",
          updatedAt: "2026-05-22T12:21:00.000Z",
          isPinned: false,
          needsUserInput: false,
          waitsForNextDirection: false,
          statusLabel: "idle",
          lastMessagePreview: ""
        }]
      });
    };
    context.codex.readAccountUsage = async () => ({
      status: "unsupported",
      accountLabel: "user@example.com",
      accountStatusText: "已登录",
      refreshedAt: "2026-05-22T12:21:00.000Z",
      limitId: "",
      limitName: "",
      primary: null,
      secondary: null,
      credits: null,
      planType: "",
      rateLimitReachedType: "",
      rateLimits: [],
      fiveHour: null,
      weekly: null,
      message: "当前通道暂不支持读取精确用量"
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);

    const initialSnapshot = await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");
    expect((initialSnapshot.sessions as Array<{ id: string }>).map((session) => session.id)).toEqual(["old-account-session"]);

    sendCommand(ws, { type: "codex.accountUsage.refresh", requestId: "usage-refreshes-sessions" });
    await waitForWsMessage(messages, (message) =>
      message.type === "codex.accountUsage.snapshot" && message.requestId === "usage-refreshes-sessions");
    const refreshedSnapshot = await waitForWsMessage(messages, (message) =>
      message.type === "sessions.snapshot" &&
      (message.sessions as Array<{ id: string }>).some((session) => session.id === "new-account-session"));

    expect((refreshedSnapshot.sessions as Array<{ id: string }>).map((session) => session.id)).toEqual(["new-account-session"]);
    expect(context.sessions.list("codex-mac").map((session) => session.id)).toEqual(["new-account-session"]);
    expect(runtimeCreates).toBe(2);
    ws.terminate();
  });

  it("sends text attachments into Codex input and records attachment status", async () => {
    const context = createTestAppContext();
    const content = Buffer.from("请重点检查这个函数的边界条件。", "utf8");
    const prepared = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-1",
      fileName: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: content.length
    });
    await context.mediaAssets.storeUploadedContent(prepared.asset.id, content, content.length);

    const sentInputs: unknown[] = [];
    const expectedFilePath = context.mediaAssets.listCodexAttachmentAssets("thread-1", [prepared.asset.id])[0].absolutePath;
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-1", turnId: "turn-1", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-1"),
        startTurn: async (input) => {
          sentInputs.push(input.inputItems ?? input.text);
          return { turnId: "turn-attachment", status: "running" };
        },
        steerTurn: async () => ({}),
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      },
      mediaAssets: context.mediaAssets,
      sessionAttachments: context.repositories.sessionAttachments
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-attachments-1",
      sessionId: "thread-1",
      clientMessageId: "client-1",
      text: "看附件",
      attachmentIds: [prepared.asset.id]
    }));

    for (let index = 0; index < 100 && sentInputs.length === 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(sentInputs).toHaveLength(1);
    expect(sentInputs[0]).toEqual([
      { type: "text", text: "看附件", text_elements: [] },
      { type: "mention", name: "notes.md", path: expectedFilePath }
    ]);
    expect(JSON.stringify(sentInputs[0])).not.toContain("[附件文本片段:");
    expect(result?.kind).toBe("message.received");
    if (result?.kind !== "message.received") {
      throw new Error("attachment send did not return a received message");
    }
    const attachments = result.attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].assetId).toBe(prepared.asset.id);
    expect(attachments[0].codexInputStatus).toBe("sent");
    expect(context.repositories.sessionAttachments.listBySession("thread-1")).toMatchObject([{
      assetId: prepared.asset.id,
      role: "userUpload",
      codexInputStatus: "sent"
    }]);
  });

  it("sends attachment-only commands as a Codex turn when the session is idle", async () => {
    const context = createTestAppContext();
    const content = Buffer.from("export function add(a: number, b: number) { return a + b; }", "utf8");
    const prepared = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-1",
      fileName: "math.ts",
      mimeType: "application/typescript",
      sizeBytes: content.length
    });
    await context.mediaAssets.storeUploadedContent(prepared.asset.id, content, content.length);

    const sentInputs: unknown[] = [];
    const expectedFilePath = context.mediaAssets.listCodexAttachmentAssets("thread-1", [prepared.asset.id])[0].absolutePath;
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-1", turnId: "turn-1", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-1"),
        startTurn: async (input) => {
          sentInputs.push(input.inputItems ?? input.text);
          return { turnId: "turn-attachment-only", status: "running" };
        },
        steerTurn: async () => ({}),
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      },
      mediaAssets: context.mediaAssets,
      sessionAttachments: context.repositories.sessionAttachments
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.attachments.send",
      requestId: "attachments-1",
      sessionId: "thread-1",
      clientMessageId: "client-attachments-1",
      attachmentIds: [prepared.asset.id]
    }));

    for (let index = 0; index < 100 && sentInputs.length === 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(sentInputs).toHaveLength(1);
    expect(sentInputs[0]).toEqual([
      { type: "text", text: "请查看这些附件。", text_elements: [] },
      { type: "mention", name: "math.ts", path: expectedFilePath }
    ]);
    expect(JSON.stringify(sentInputs[0])).not.toContain("[附件文本片段:");
    expect(result).toMatchObject({
      kind: "message.received",
      requestId: "attachments-1",
      sessionId: "thread-1",
      messageId: "client-attachments-1"
    });
  });

  it("sends image draft attachments as localImage input when creating a session", async () => {
    const createInputs: unknown[] = [];
    const context = createTestAppContext();
    const prepared = context.mediaAssets.prepareMobileUpload({
      sessionId: "draft-new-session-image-1",
      fileName: "draft.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.length
    });
    await context.mediaAssets.storeUploadedContent(prepared.asset.id, PNG_BYTES, PNG_BYTES.length);
    const expectedImagePath = context.mediaAssets.listNewSessionDraftAttachmentAssets([prepared.asset.id])[0].absolutePath;

    const router = createCommandRouter({
      sessions: createRuntime({
        createSession: async (input) => {
          createInputs.push(input.inputItems ?? input.text);
          return { threadId: "thread-image-create", turnId: "turn-image-create", status: "running" };
        }
      }).sessions,
      mediaAssets: context.mediaAssets,
      sessionAttachments: context.repositories.sessionAttachments,
      runtimeConfig: context.runtimeConfig
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.create",
      requestId: "create-image-1",
      toolId: "codex-mac",
      projectPath: null,
      text: "请描述图片",
      attachmentIds: [prepared.asset.id]
    }));

    expect(result).toMatchObject({
      kind: "session.created",
      requestId: "create-image-1",
      threadId: "thread-image-create",
      text: "请描述图片"
    });
    expect(createInputs[0]).toEqual([
      { type: "text", text: "请描述图片", text_elements: [] },
      { type: "localImage", path: expectedImagePath }
    ]);
    expect(context.repositories.sessionAttachments.listBySession("thread-image-create")).toMatchObject([{
      assetId: prepared.asset.id,
      role: "userUpload",
      codexInputStatus: "sent"
    }]);
  });

  it("sends idle image attachments as localImage input when starting a turn", async () => {
    const startInputs: unknown[] = [];
    const context = createTestAppContext();
    const prepared = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-image-send",
      fileName: "idle.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.length
    });
    await context.mediaAssets.storeUploadedContent(prepared.asset.id, PNG_BYTES, PNG_BYTES.length);
    const expectedImagePath = context.mediaAssets.listCodexAttachmentAssets("thread-image-send", [prepared.asset.id])[0].absolutePath;

    const router = createCommandRouter({
      sessions: createRuntime({
        readSessionDetail: async () => sessionDetail("thread-image-send"),
        startTurn: async (input) => {
          startInputs.push(input.inputItems ?? input.text);
          return { turnId: "turn-image-start", status: "running" };
        }
      }).sessions,
      mediaAssets: context.mediaAssets,
      sessionAttachments: context.repositories.sessionAttachments
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-image-1",
      sessionId: "thread-image-send",
      clientMessageId: "client-image-1",
      text: "看图",
      attachmentIds: [prepared.asset.id]
    }));

    await waitForCondition(() => startInputs.length === 1);
    expect(result).toMatchObject({
      kind: "message.received",
      requestId: "send-image-1",
      sessionId: "thread-image-send",
      messageId: "client-image-1",
      text: "看图"
    });
    expect(startInputs[0]).toEqual([
      { type: "text", text: "看图", text_elements: [] },
      { type: "localImage", path: expectedImagePath }
    ]);
    expect(context.repositories.sessionAttachments.listBySession("thread-image-send")[0].codexInputStatus).toBe("sent");
  });

  it("sends steer-now image attachments as localImage input and acknowledges guided", async () => {
    const startInputs: unknown[] = [];
    const steerInputs: unknown[] = [];
    const context = createTestAppContext();
    const prepared = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-image-steer",
      fileName: "steer.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.length
    });
    await context.mediaAssets.storeUploadedContent(prepared.asset.id, PNG_BYTES, PNG_BYTES.length);
    const expectedImagePath = context.mediaAssets.listCodexAttachmentAssets("thread-image-steer", [prepared.asset.id])[0].absolutePath;

    const router = createCommandRouter({
      sessions: createRuntime({
        readSessionDetail: async () => sessionDetail("thread-image-steer"),
        startTurn: async (input) => {
          startInputs.push(input.inputItems ?? input.text);
          return { turnId: "turn-image-start-unexpected", status: "running" };
        },
        steerTurn: async (input) => {
          steerInputs.push(input.inputItems ?? input.text);
          return {};
        }
      }).sessions,
      mediaAssets: context.mediaAssets,
      sessionAttachments: context.repositories.sessionAttachments
    });
    router.noteTurnStarted("thread-image-steer", "turn-image-active");

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "steer-image-1",
      sessionId: "thread-image-steer",
      clientMessageId: "client-image-steer-1",
      text: "立刻看图",
      guidance: { mode: "steer-now", selectedCapabilityIds: [] },
      attachmentIds: [prepared.asset.id]
    }));

    await waitForCondition(() => steerInputs.length === 1);
    expect(result).toMatchObject({
      kind: "message.received",
      requestId: "steer-image-1",
      sessionId: "thread-image-steer",
      messageId: "client-image-steer-1",
      text: "立刻看图",
      sendState: "guided"
    });
    expect(startInputs).toEqual([]);
    expect(steerInputs[0]).toEqual([
      { type: "text", text: "立刻看图", text_elements: [] },
      { type: "localImage", path: expectedImagePath }
    ]);
    expect(context.repositories.sessionAttachments.listBySession("thread-image-steer")[0].codexInputStatus).toBe("sent");
  });

  it("sends steer-now file attachments as mention input and acknowledges guided", async () => {
    const steerInputs: unknown[] = [];
    const context = createTestAppContext();
    const content = Buffer.from("steer now file reference payload", "utf8");
    const prepared = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-file-steer",
      fileName: "steer-notes.md",
      mimeType: "text/markdown",
      sizeBytes: content.length
    });
    await context.mediaAssets.storeUploadedContent(prepared.asset.id, content, content.length);
    const expectedFilePath = context.mediaAssets.listCodexAttachmentAssets("thread-file-steer", [prepared.asset.id])[0].absolutePath;

    const router = createCommandRouter({
      sessions: createRuntime({
        readSessionDetail: async () => sessionDetail("thread-file-steer"),
        steerTurn: async (input) => {
          steerInputs.push(input.inputItems ?? input.text);
          return {};
        }
      }).sessions,
      mediaAssets: context.mediaAssets,
      sessionAttachments: context.repositories.sessionAttachments
    });
    router.noteTurnStarted("thread-file-steer", "turn-file-active");

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "steer-file-1",
      sessionId: "thread-file-steer",
      clientMessageId: "client-file-steer-1",
      text: "立刻看文件",
      guidance: { mode: "steer-now", selectedCapabilityIds: [] },
      attachmentIds: [prepared.asset.id]
    }));

    await waitForCondition(() => steerInputs.length === 1);
    expect(result).toMatchObject({
      kind: "message.received",
      requestId: "steer-file-1",
      sessionId: "thread-file-steer",
      messageId: "client-file-steer-1",
      text: "立刻看文件",
      sendState: "guided"
    });
    expect(steerInputs[0]).toEqual([
      { type: "text", text: "立刻看文件", text_elements: [] },
      { type: "mention", name: "steer-notes.md", path: expectedFilePath }
    ]);
    expect(context.repositories.sessionAttachments.listBySession("thread-file-steer")[0].codexInputStatus).toBe("sent");
  });

  it("sends attachment-only images as structured input through start or steer based on active turn", async () => {
    const startInputs: unknown[] = [];
    const steerInputs: unknown[] = [];
    const context = createTestAppContext();
    const idleImage = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-image-attachments",
      fileName: "idle-attachment.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.length
    });
    const activeImage = context.mediaAssets.prepareMobileUpload({
      sessionId: "thread-image-attachments",
      fileName: "active-attachment.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.length
    });
    await context.mediaAssets.storeUploadedContent(idleImage.asset.id, PNG_BYTES, PNG_BYTES.length);
    await context.mediaAssets.storeUploadedContent(activeImage.asset.id, PNG_BYTES, PNG_BYTES.length);
    const idleImagePath = context.mediaAssets.listCodexAttachmentAssets("thread-image-attachments", [idleImage.asset.id])[0].absolutePath;
    const activeImagePath = context.mediaAssets.listCodexAttachmentAssets("thread-image-attachments", [activeImage.asset.id])[0].absolutePath;

    const router = createCommandRouter({
      sessions: createRuntime({
        readSessionDetail: async () => sessionDetail("thread-image-attachments"),
        startTurn: async (input) => {
          startInputs.push(input.inputItems ?? input.text);
          return { turnId: "turn-image-attachments-start", status: "running" };
        },
        steerTurn: async (input) => {
          steerInputs.push(input.inputItems ?? input.text);
          return {};
        }
      }).sessions,
      mediaAssets: context.mediaAssets,
      sessionAttachments: context.repositories.sessionAttachments
    });

    const idleResult = await router.handle(ClientCommandSchema.parse({
      type: "session.attachments.send",
      requestId: "attachments-image-idle",
      sessionId: "thread-image-attachments",
      clientMessageId: "client-attachments-image-idle",
      attachmentIds: [idleImage.asset.id]
    }));
    await waitForCondition(() => startInputs.length === 1);
    expect(idleResult).toMatchObject({
      kind: "message.received",
      requestId: "attachments-image-idle",
      text: "请查看这些附件。"
    });
    expect(startInputs[0]).toEqual([
      { type: "text", text: "请查看这些附件。", text_elements: [] },
      { type: "localImage", path: idleImagePath }
    ]);

    router.noteTurnStarted("thread-image-attachments", "turn-image-attachments-active");
    const activeResult = await router.handle(ClientCommandSchema.parse({
      type: "session.attachments.send",
      requestId: "attachments-image-active",
      sessionId: "thread-image-attachments",
      clientMessageId: "client-attachments-image-active",
      attachmentIds: [activeImage.asset.id]
    }));
    await waitForCondition(() => steerInputs.length === 1);
    expect(activeResult).toMatchObject({
      kind: "message.received",
      requestId: "attachments-image-active",
      text: "请查看这些附件。",
      sendState: "guided"
    });
    expect(steerInputs[0]).toEqual([
      { type: "text", text: "请查看这些附件。", text_elements: [] },
      { type: "localImage", path: activeImagePath }
    ]);
    expect(context.repositories.sessionAttachments.listBySession("thread-image-attachments").map((attachment) => attachment.codexInputStatus)).toEqual(["sent", "sent"]);
  });

  it("captures a local web screenshot through the command router and records an artifact attachment", async () => {
    const context = createTestAppContext();
    context.repositories.localWebSessions.insert({
      id: "local-web-1",
      sessionId: "thread-1",
      targetUrl: "http://127.0.0.1:5173/",
      proxyUrl: "/local-web/local-web-1/",
      status: "active",
      createdAt: "2026-05-16T09:30:00.000Z",
      updatedAt: "2026-05-16T09:30:00.000Z",
      error: ""
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-1", turnId: "turn-1", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-1"),
        startTurn: async () => ({}),
        steerTurn: async () => ({}),
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      },
      capture: createCaptureService({
        mediaAssetRepository: context.repositories.mediaAssets,
        localWebSessionRepository: context.repositories.localWebSessions,
        storageDir: path.join(context.config.dataDir, "media-assets"),
        now: () => new Date("2026-05-16T09:31:00.000Z"),
        idGenerator: () => "asset-capture-router-1",
        captureRunner: {
          captureLocalWebScreenshot: async () => png
        }
      }),
      sessionAttachments: context.repositories.sessionAttachments
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "capture.screenshot",
      requestId: "capture-1",
      sessionId: "thread-1",
      target: "localWeb",
      localWebSessionId: "local-web-1",
      userConfirmed: true
    }));

    expect(result?.kind).toBe("session.artifact.created");
    if (result?.kind !== "session.artifact.created") {
      throw new Error("screenshot command did not create an artifact");
    }
    expect(result.asset).toMatchObject({
      id: "asset-capture-router-1",
      sessionId: "thread-1",
      source: "localWebCapture",
      kind: "screenshot",
      status: "available",
      url: "/api/assets/asset-capture-router-1/content"
    });
    expect(result.attachment).toMatchObject({
      assetId: "asset-capture-router-1",
      role: "macArtifact",
      codexInputStatus: "notRequired"
    });
    const content = await context.mediaAssets.readAssetContent("asset-capture-router-1");
    expect(content.content.equals(png)).toBe(true);
  });

  it("creates and closes local web sessions through the command router", async () => {
    const context = createTestAppContext();
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-1", turnId: "turn-1", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-1"),
        startTurn: async () => ({}),
        steerTurn: async () => ({}),
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      },
      localWebSessions: context.repositories.localWebSessions
    });

    const opened = await router.handle(ClientCommandSchema.parse({
      type: "localWeb.open",
      requestId: "local-web-open-1",
      sessionId: "thread-1",
      targetUrl: "http://127.0.0.1:5173"
    }));

    expect(opened?.kind).toBe("local.web.session.updated");
    if (opened?.kind !== "local.web.session.updated") {
      throw new Error("local web session was not opened");
    }
    expect(opened.session.status).toBe("active");
    expect(context.repositories.localWebSessions.get(opened.session.id)?.targetUrl).toBe("http://127.0.0.1:5173/");

    const closed = await router.handle(ClientCommandSchema.parse({
      type: "localWeb.close",
      requestId: "local-web-close-1",
      localWebSessionId: opened.session.id
    }));

    expect(closed?.kind).toBe("local.web.session.updated");
    if (closed?.kind !== "local.web.session.updated") {
      throw new Error("local web session was not closed");
    }
    expect(closed.session.status).toBe("closed");
    expect(context.repositories.localWebSessions.get(opened.session.id)?.status).toBe("closed");
  });

  it("rejects non-local web targets through the command router", async () => {
    const context = createTestAppContext();
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-1", turnId: "turn-1", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-1"),
        startTurn: async () => ({}),
        steerTurn: async () => ({}),
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      },
      localWebSessions: context.repositories.localWebSessions
    });

    await expect(router.handle(ClientCommandSchema.parse({
      type: "localWeb.open",
      requestId: "local-web-open-2",
      sessionId: "thread-1",
      targetUrl: "https://example.com"
    }))).rejects.toThrow("只能打开桌面端本机开发链接");
  });

  it("renames sessions through the command router", async () => {
    const calls: string[] = [];
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-1", turnId: "turn-1", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-1"),
        startTurn: async () => ({}),
        steerTurn: async () => ({}),
        interruptTurn: async () => ({}),
        renameSession: async (input) => {
          calls.push(`${input.threadId}:${input.title}`);
        },
        respondToApproval: async () => undefined
      }
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.rename",
      requestId: "rename-1",
      sessionId: "thread-1",
      title: "移动端改名"
    }));

    expect(calls).toEqual(["thread-1:移动端改名"]);
    expect(result).toEqual({ kind: "session.renamed", requestId: "rename-1", sessionId: "thread-1", title: "移动端改名" });
  });

  it("returns installed capability snapshots through the command router", async () => {
    const capabilities: InstalledCodexCapability[] = [{
      id: "skill:codex-home:frontend-design",
      kind: "skill",
      name: "frontend-design",
      description: "Build polished frontends",
      source: "codex-home",
      isAvailable: true
    }];
    const router = createCommandRouter({
      sessions: createRuntime({}).sessions,
      capabilities: () => capabilities
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "codex.installedCapabilities.list",
      requestId: "capabilities-1"
    }));

    expect(result).toEqual({
      kind: "installed.capabilities",
      requestId: "capabilities-1",
      capabilities
    });
  });

  it("passes runtime config from session.create into session creation", async () => {
    const context = createTestAppContext();
    const createInputs: Record<string, unknown>[] = [];
    const router = createCommandRouter({
      sessions: createRuntime({
        createSession: async (input) => {
          createInputs.push(input as unknown as Record<string, unknown>);
          return { threadId: "thread-runtime-create", turnId: "turn-runtime-create", status: "running" };
        }
      }).sessions,
      runtimeConfig: context.runtimeConfig
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.create",
      requestId: "create-runtime-1",
      toolId: "codex-mac",
      projectPath: "/repo/code",
      text: "使用高级配置新建会话",
      runtimeConfig: {
        model: "gpt-5.5",
        effort: "high",
        permissionMode: "workspace",
        approvalMode: "on-request",
        approvalsReviewer: "auto_review"
      }
    }));

    expect(result).toMatchObject({
      kind: "session.created",
      requestId: "create-runtime-1",
      threadId: "thread-runtime-create"
    });
    expect(createInputs).toEqual([
      expect.objectContaining({
        projectPath: "/repo/code",
        runtimeConfig: {
          model: "gpt-5.5",
          effort: "high",
          permissionMode: "workspace",
          approvalMode: "on-request",
          approvalsReviewer: "auto_review"
        }
      })
    ]);
    expect(context.runtimeConfig.get("thread-runtime-create")).toMatchObject({
      sessionId: "thread-runtime-create",
      model: "gpt-5.5",
      effort: "high",
      permissionMode: "workspace",
      approvalMode: "on-request",
      approvalsReviewer: "auto_review"
    });
  });

  it("sends draft attachments with the first turn when creating a session", async () => {
    const context = createTestAppContext();
    const content = Buffer.from("V2 API24 new session attachment smoke", "utf8");
    const prepared = context.mediaAssets.prepareMobileUpload({
      sessionId: "draft-new-session-1",
      fileName: "v2-new-session.md",
      mimeType: "text/markdown",
      sizeBytes: content.length
    });
    await context.mediaAssets.storeUploadedContent(prepared.asset.id, content, content.length);
    const createInputs: Record<string, unknown>[] = [];
    const router = createCommandRouter({
      sessions: createRuntime({
        createSession: async (input) => {
          createInputs.push(input as unknown as Record<string, unknown>);
          return { threadId: "thread-new-session-attachment", turnId: "turn-new-session-attachment", status: "running" };
        }
      }).sessions,
      mediaAssets: context.mediaAssets,
      sessionAttachments: context.repositories.sessionAttachments,
      runtimeConfig: context.runtimeConfig
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.create",
      requestId: "create-with-attachment-1",
      toolId: "codex-mac",
      projectPath: null,
      text: "请阅读新会话附件",
      attachmentIds: [prepared.asset.id],
      runtimeConfig: {
        model: "gpt-5.5",
        effort: "high",
        permissionMode: "workspace",
        approvalMode: "on-request",
        approvalsReviewer: "auto_review"
      }
    }));

    expect(result).toMatchObject({
      kind: "session.created",
      requestId: "create-with-attachment-1",
      threadId: "thread-new-session-attachment"
    });
    expect(createInputs).toHaveLength(1);
    const expectedFilePath = context.mediaAssets.listCodexAttachmentAssets(
      "thread-new-session-attachment",
      [prepared.asset.id]
    )[0].absolutePath;
    expect(createInputs[0].inputItems).toEqual([
      { type: "text", text: "请阅读新会话附件", text_elements: [] },
      { type: "mention", name: "v2-new-session.md", path: expectedFilePath }
    ]);
    expect(JSON.stringify(createInputs[0].inputItems)).not.toContain("[附件文本片段:");
    expect(createInputs[0].runtimeConfig).toMatchObject({
      model: "gpt-5.5",
      effort: "high"
    });
    expect(context.repositories.mediaAssets.get(prepared.asset.id)?.sessionId).toBe("thread-new-session-attachment");
    expect(context.repositories.sessionAttachments.listBySession("thread-new-session-attachment")).toMatchObject([{
      assetId: prepared.asset.id,
      role: "userUpload",
      codexInputStatus: "sent"
    }]);
    expect(context.repositories.sessionAttachments.listBySession("draft-new-session-1")).toEqual([]);
  });

  it("lists models and updates session runtime config through WebSocket", async () => {
    const context = createTestAppContext();
    context.runtimeConfig.saveCodexSessionConfig("thread-1", {
      model: "gpt-5.4",
      effort: "medium",
      permissionMode: "readonly",
      approvalMode: "manual"
    }, "codex-session");
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => []
    });
    context.codex.listModels = async () => ({
      defaultModel: "gpt-5.5",
      models: [{
        id: "gpt-5.5",
        label: "GPT-5.5",
        isDefault: true,
        hidden: false,
        isAvailable: true,
        supportedEfforts: ["low", "medium", "high", "xhigh"]
      }]
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "codex.models.list", requestId: "models-1" });
    await waitForWsMessage(messages, (message) =>
      message.type === "codex.models.snapshot" && message.requestId === "models-1");

    sendCommand(ws, {
      type: "session.runtimeConfig.read",
      requestId: "runtime-read-1",
      sessionId: "thread-1"
    });
    const original = await waitForWsMessage(messages, (message) =>
      message.type === "session.runtimeConfig.updated" && message.requestId === "runtime-read-1");
    expect(original.config).toMatchObject({
      sessionId: "thread-1",
      model: "gpt-5.4",
      effort: "medium",
      permissionMode: "readonly",
      approvalMode: "manual"
    });

    sendCommand(ws, {
      type: "session.runtimeConfig.update",
      requestId: "runtime-1",
      sessionId: "thread-1",
      config: {
        model: "gpt-5.5",
        effort: "high",
        permissionMode: "workspace",
        approvalMode: "on-request",
        approvalsReviewer: "auto_review"
      }
    });
    const updated = await waitForWsMessage(messages, (message) =>
      message.type === "session.runtimeConfig.updated" &&
      message.requestId === "runtime-1" &&
      (message.config as Record<string, unknown> | undefined)?.sessionId === "thread-1");
    expect(updated.config).toMatchObject({
      sessionId: "thread-1",
      model: "gpt-5.5",
      effort: "high",
      permissionMode: "workspace",
      approvalMode: "on-request",
      approvalsReviewer: "auto_review"
    });
    ws.terminate();
  });

  it("loads and stores codex runtime baseline when reading an unmodified session config", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => []
    });
    context.codex.readRuntimeConfigBaseline = async () => ({
      model: "gpt-5.4",
      effort: "medium",
      permissionMode: "workspace",
      approvalMode: "on-request"
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.runtimeConfig.read",
      requestId: "runtime-baseline-1",
      sessionId: "thread-baseline"
    });

    const baseline = await waitForWsMessage(messages, (message) =>
      message.type === "session.runtimeConfig.updated" &&
      message.requestId === "runtime-baseline-1");
    expect(baseline.config).toMatchObject({
      sessionId: "thread-baseline",
      model: "gpt-5.4",
      effort: "medium",
      permissionMode: "workspace",
      approvalMode: "on-request"
    });
    expect(context.runtimeConfig.get("thread-baseline")).toMatchObject({
      sessionId: "thread-baseline",
      model: "gpt-5.4",
      effort: "medium",
      permissionMode: "workspace",
      approvalMode: "on-request"
    });
    ws.terminate();
  });

  it("sends media asset and attachment snapshots when enabling session sync", async () => {
    const context = createTestAppContext();
    const now = "2026-05-16T09:00:00.000Z";
    context.repositories.mediaAssets.insert({
      id: "asset-sync-1",
      sessionId: "thread-1",
      source: "mobileUpload",
      kind: "text",
      fileName: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      sha256: "abc",
      status: "available",
      relativePath: "thread-1/asset-sync-1/notes.txt",
      createdAt: now,
      expiresAt: null,
      error: ""
    });
    context.repositories.sessionAttachments.insert({
      id: "attachment-asset-sync-1",
      sessionId: "thread-1",
      assetId: "asset-sync-1",
      role: "userUpload",
      codexInputStatus: "pending",
      codexInputMessage: "附件已上传，待发送给 Codex",
      createdAt: now
    });
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [],
      readSessionDetail: async () => sessionDetail("thread-1")
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "sync-media-1",
      sessionId: "thread-1",
      activeDetail: true
    });

    const assets = await waitForWsMessage(messages, (message) =>
      message.type === "session.assets.updated" && message.sessionId === "thread-1");
    const attachments = await waitForWsMessage(messages, (message) =>
      message.type === "session.attachments.updated" && message.sessionId === "thread-1");
    expect(assets.assets).toMatchObject([{
      id: "asset-sync-1",
      url: "/api/assets/asset-sync-1/content"
    }]);
    expect(attachments.attachments).toMatchObject([{
      assetId: "asset-sync-1",
      codexInputStatus: "pending"
    }]);
    ws.terminate();
  });

  it("adds stored user attachment ids to canonical detail user messages", async () => {
    const context = createTestAppContext();
    const now = "2026-05-16T09:00:00.000Z";
    context.repositories.mediaAssets.insert({
      id: "asset-canonical-doc-1",
      sessionId: "thread-attachment-tags",
      source: "mobileUpload",
      kind: "document",
      fileName: "notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 128,
      sha256: "pdf",
      status: "available",
      relativePath: "thread-attachment-tags/asset-canonical-doc-1/notes.pdf",
      createdAt: now,
      expiresAt: null,
      error: ""
    });
    context.repositories.sessionAttachments.insert({
      id: "attachment-asset-canonical-doc-1",
      sessionId: "thread-attachment-tags",
      assetId: "asset-canonical-doc-1",
      role: "userUpload",
      codexInputStatus: "sent",
      codexInputMessage: "已通过 Codex 文件引用通道发送",
      createdAt: now
    });
    const detail = sessionDetail("thread-attachment-tags");
    detail.turns = [{
      id: "turn-attachment-tags",
      sessionId: "thread-attachment-tags",
      status: "completed",
      startedAt: "2026-05-16T09:00:01.000Z",
      completedAt: "2026-05-16T09:00:12.000Z",
      items: [{
        id: "user-attachment-tags",
        sessionId: "thread-attachment-tags",
        turnId: "turn-attachment-tags",
        kind: "userMessage",
        status: "completed",
        title: "user",
        text: "PDF attachment payload smoke. Reply ok.",
        rawText: "PDF attachment payload smoke. Reply ok.",
        createdAt: "2026-05-16T09:00:01.000Z",
        updatedAt: "2026-05-16T09:00:01.000Z",
        isStreaming: false,
        isCollapsedByDefault: false,
        command: null,
        diff: null,
        approval: null,
        planSteps: []
      }, {
        id: "assistant-attachment-tags",
        sessionId: "thread-attachment-tags",
        turnId: "turn-attachment-tags",
        kind: "agentMessage",
        status: "completed",
        title: "assistant",
        text: "ok",
        rawText: "ok",
        createdAt: "2026-05-16T09:00:12.000Z",
        updatedAt: "2026-05-16T09:00:12.000Z",
        isStreaming: false,
        isCollapsedByDefault: false,
        command: null,
        diff: null,
        approval: null,
        planSteps: []
      }]
    }];
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [],
      readSessionDetail: async () => detail
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "sync-attachment-tags",
      sessionId: "thread-attachment-tags",
      activeDetail: true
    });

    const snapshot = await waitForWsMessage(messages, (message) =>
      message.type === "thread.detail.snapshot" && message.sessionId === "thread-attachment-tags");
    const turns = snapshot.turns as Array<{ items: Array<{ kind: string; assetIds?: string[] }> }>;
    expect(turns[0].items[0]).toMatchObject({
      kind: "userMessage",
      assetIds: ["asset-canonical-doc-1"]
    });
    ws.terminate();
  });

  it("syncs Codex imagegen output into media snapshots and image generation items", async () => {
    const context = createTestAppContext();
    const generatedImagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-ws-generated-images-"));
    const generatedSessionDir = path.join(generatedImagesRoot, "thread-1");
    fs.mkdirSync(generatedSessionDir, { recursive: true });
    const imagePath = path.join(generatedSessionDir, "ig_ws.png");
    fs.writeFileSync(imagePath, PNG_BYTES);
    const rolloutPath = path.join(generatedImagesRoot, "rollout.jsonl");
    fs.writeFileSync(rolloutPath, JSON.stringify({
      timestamp: "2026-05-18T12:32:55.366Z",
      type: "image_generation_end",
      payload: {
        type: "image_generation_end",
        call_id: "ig_ws",
        saved_path: imagePath
      }
    }) + "\n");
    context.codexGeneratedImages = createCodexGeneratedImageArtifactService({
      mediaAssetRepository: context.repositories.mediaAssets,
      sessionAttachmentRepository: context.repositories.sessionAttachments,
      storageDir: path.join(context.config.dataDir, "media-assets"),
      generatedImagesRoot
    });
    const detail = sessionDetail("thread-1");
    detail.rolloutPath = rolloutPath;
    detail.turns = [{
      id: "turn-1",
      sessionId: "thread-1",
      status: "completed",
      startedAt: "2026-05-18T12:30:39.064Z",
      completedAt: "2026-05-18T12:32:56.375Z",
      items: [{
        id: "ig_ws",
        sessionId: "thread-1",
        turnId: "turn-1",
        kind: "imageGeneration",
        status: "running",
        title: "imagegen",
        text: "",
        rawText: "",
        createdAt: "2026-05-18T12:32:55.366Z",
        updatedAt: "2026-05-18T12:32:55.366Z",
        isStreaming: true,
        isCollapsedByDefault: false,
        command: null,
        diff: null,
        approval: null,
        planSteps: [],
        assetIds: []
      }]
    }];
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [],
      readSessionDetail: async () => detail
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "sync-imagegen-1",
      sessionId: "thread-1",
      activeDetail: true
    });

    const snapshot = await waitForWsMessage(messages, (message) =>
      message.type === "thread.detail.snapshot" && message.sessionId === "thread-1");
    const assets = await waitForWsMessage(messages, (message) =>
      message.type === "session.assets.updated" && message.sessionId === "thread-1");
    const attachments = await waitForWsMessage(messages, (message) =>
      message.type === "session.attachments.updated" && message.sessionId === "thread-1");

    expect(assets.assets).toMatchObject([{
      source: "codexEvent",
      kind: "image",
      fileName: "ig_ws.png",
      url: expect.stringContaining("/api/assets/")
    }]);
    expect(attachments.attachments).toMatchObject([{
      role: "codexArtifact",
      codexInputStatus: "notRequired"
    }]);
    const assetList = assets.assets as Array<{ id: string }>;
    const turns = snapshot.turns as Array<{ items: Array<{ id: string; kind: string; status?: string; title?: string; assetIds?: string[] }> }>;
    expect(turns[0].items[0]).toMatchObject({
      id: "ig_ws",
      kind: "imageGeneration",
      status: "completed",
      title: "imagegen",
      assetIds: [assetList[0].id]
    });
    ws.terminate();
  });

  it("binds Codex image artifacts to the recent running image generation item when call id is missing from canonical items", async () => {
    const context = createTestAppContext();
    const generatedImagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-ws-generated-images-"));
    const generatedSessionDir = path.join(generatedImagesRoot, "thread-running-fallback");
    fs.mkdirSync(generatedSessionDir, { recursive: true });
    const imagePath = path.join(generatedSessionDir, "ig_running_fallback.png");
    fs.writeFileSync(imagePath, PNG_BYTES);
    const rolloutPath = path.join(generatedImagesRoot, "rollout.jsonl");
    fs.writeFileSync(rolloutPath, JSON.stringify({
      timestamp: "2026-05-18T12:32:55.366Z",
      type: "image_generation_end",
      payload: {
        type: "image_generation_end",
        call_id: "ig_running_fallback",
        saved_path: imagePath
      }
    }) + "\n");
    context.codexGeneratedImages = createCodexGeneratedImageArtifactService({
      mediaAssetRepository: context.repositories.mediaAssets,
      sessionAttachmentRepository: context.repositories.sessionAttachments,
      storageDir: path.join(context.config.dataDir, "media-assets"),
      generatedImagesRoot
    });
    const detail = sessionDetail("thread-running-fallback");
    detail.rolloutPath = rolloutPath;
    detail.turns = [{
      id: "turn-1",
      sessionId: "thread-running-fallback",
      status: "completed",
      startedAt: "2026-05-18T12:30:39.064Z",
      completedAt: "2026-05-18T12:32:56.375Z",
      items: [
        {
          id: "pending-imagegen-owner",
          sessionId: "thread-running-fallback",
          turnId: "turn-1",
          kind: "imageGeneration",
          status: "running",
          title: "imagegen",
          text: "",
          rawText: "",
          createdAt: "2026-05-18T12:32:54.366Z",
          updatedAt: "2026-05-18T12:32:54.366Z",
          isStreaming: true,
          isCollapsedByDefault: false,
          command: null,
          diff: null,
          approval: null,
          planSteps: [],
          assetIds: []
        },
        {
          id: "completed-imagegen-nearby",
          sessionId: "thread-running-fallback",
          turnId: "turn-1",
          kind: "imageGeneration",
          status: "completed",
          title: "imagegen",
          text: "",
          rawText: "",
          createdAt: "2026-05-18T12:32:55.000Z",
          updatedAt: "2026-05-18T12:32:55.000Z",
          isStreaming: false,
          isCollapsedByDefault: false,
          command: null,
          diff: null,
          approval: null,
          planSteps: [],
          assetIds: []
        }
      ]
    }];
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [],
      readSessionDetail: async () => detail
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "sync-imagegen-running-fallback",
      sessionId: "thread-running-fallback",
      activeDetail: true
    });

    const snapshot = await waitForWsMessage(messages, (message) =>
      message.type === "thread.detail.snapshot" && message.sessionId === "thread-running-fallback");
    const assets = await waitForWsMessage(messages, (message) =>
      message.type === "session.assets.updated" && message.sessionId === "thread-running-fallback");

    const assetList = assets.assets as Array<{ id: string }>;
    const turns = snapshot.turns as Array<{ items: Array<{ id: string; kind: string; status?: string; assetIds?: string[] }> }>;
    expect(turns[0].items[0]).toMatchObject({
      id: "pending-imagegen-owner",
      kind: "imageGeneration",
      status: "completed",
      assetIds: [assetList[0].id]
    });
    expect(turns[0].items[1]).toMatchObject({
      id: "completed-imagegen-nearby",
      kind: "imageGeneration",
      assetIds: []
    });
    ws.terminate();
  });

  it("synthesizes image generation timeline items for Codex image artifacts when no canonical owner exists", async () => {
    const context = createTestAppContext();
    const generatedImagesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "code-ws-generated-images-"));
    const generatedSessionDir = path.join(generatedImagesRoot, "thread-synthetic-imagegen");
    fs.mkdirSync(generatedSessionDir, { recursive: true });
    const imagePath = path.join(generatedSessionDir, "ig_synthetic.png");
    fs.writeFileSync(imagePath, PNG_BYTES);
    const rolloutPath = path.join(generatedImagesRoot, "rollout.jsonl");
    fs.writeFileSync(rolloutPath, JSON.stringify({
      timestamp: "2026-05-18T12:32:55.366Z",
      type: "image_generation_end",
      payload: {
        type: "image_generation_end",
        call_id: "ig_synthetic",
        saved_path: imagePath
      }
    }) + "\n");
    context.codexGeneratedImages = createCodexGeneratedImageArtifactService({
      mediaAssetRepository: context.repositories.mediaAssets,
      sessionAttachmentRepository: context.repositories.sessionAttachments,
      storageDir: path.join(context.config.dataDir, "media-assets"),
      generatedImagesRoot
    });
    const detail = sessionDetail("thread-synthetic-imagegen");
    detail.rolloutPath = rolloutPath;
    detail.turns = [{
      id: "turn-1",
      sessionId: "thread-synthetic-imagegen",
      status: "completed",
      startedAt: "2026-05-18T12:30:39.064Z",
      completedAt: "2026-05-18T12:32:56.375Z",
      items: []
    }];
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [],
      readSessionDetail: async () => detail
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "sync-imagegen-synthetic",
      sessionId: "thread-synthetic-imagegen",
      activeDetail: true
    });

    const snapshot = await waitForWsMessage(messages, (message) =>
      message.type === "thread.detail.snapshot" && message.sessionId === "thread-synthetic-imagegen");
    const assets = await waitForWsMessage(messages, (message) =>
      message.type === "session.assets.updated" && message.sessionId === "thread-synthetic-imagegen");

    const assetList = assets.assets as Array<{ id: string }>;
    const turns = snapshot.turns as Array<{ items: Array<{ id: string; kind: string; title?: string; assetIds?: string[] }> }>;
    expect(turns[0].items).toHaveLength(1);
    expect(turns[0].items[0]).toMatchObject({
      id: "ig_synthetic",
      kind: "imageGeneration",
      title: "imagegen",
      assetIds: [assetList[0].id]
    });
    expect(turns[0].items[0].kind).not.toBe("agentMessage");
    ws.terminate();
  });

  it("audits high-risk runtime config changes", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => []
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.runtimeConfig.update",
      requestId: "runtime-risk-1",
      sessionId: "thread-risk",
      config: {
        model: null,
        effort: "xhigh",
        permissionMode: "full-access",
        approvalMode: "full-access-never"
      }
    });
    await waitForWsMessage(messages, (message) => message.type === "session.runtimeConfig.updated");
    const logs = context.audit.list() as AuditRow[];
    expect(logs.some((entry) => entry.detail.includes("会话运行权限已切换为 Full Access"))).toBe(true);
    ws.terminate();
  });

  it("injects saved runtime config when sending an idle turn through WebSocket", async () => {
    const context = createTestAppContext();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const turnStartParams: Record<string, unknown>[] = [];
    context.codex.createSessionRuntime = async () => ({
      client: createNoopNotificationClient(),
      sessions: createCodexSessionManager({
        request: async (method, params = {}) => {
          calls.push({ method, params });
          if (method === "thread/list") return { data: [] };
          if (method === "turn/start") {
            turnStartParams.push(params);
            return { turnId: "turn-runtime", status: "running" };
          }
          return {};
        },
        respond: () => undefined
      }, {
        runtimeConfigForSession: context.runtimeConfig.get,
        codexRuntimeCapabilities: { supportsPermissionsProfile: true }
      }),
      stop: async () => undefined
    });
    context.runtimeConfig.saveCodexSessionConfig("thread-runtime", {
      model: "gpt-5.4",
      effort: "medium",
      permissionMode: "readonly",
      approvalMode: "manual"
    }, "codex-session");
    context.runtimeConfig.update("thread-runtime", {
      model: "gpt-5.5",
      effort: "high",
      permissionMode: "workspace",
      approvalMode: "on-request",
      approvalsReviewer: "auto_review"
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "send-runtime",
      sessionId: "thread-runtime",
      clientMessageId: "message-runtime",
      text: "继续"
    });
    await waitForWsMessage(messages, (message) =>
      message.type === "message.updated" &&
      (message.message as Record<string, unknown> | undefined)?.clientMessageId === "message-runtime");
    for (let index = 0; index < 300 && turnStartParams.length === 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(calls.map((call) => call.method)).toContain("turn/start");
    expect(turnStartParams[0]).toMatchObject({
      threadId: "thread-runtime",
      model: "gpt-5.5",
      effort: "high",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      permissions: { type: "profile", id: ":workspace" }
    });
    ws.terminate();
  });

  it("injects saved runtime config when auto-sending queued input", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const turnStartParams: Record<string, unknown>[] = [];
    const client = {
      initialize: async () => ({}),
      request: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "thread/list") return { data: [] };
        if (method === "turn/start") {
          turnStartParams.push(params);
          return { turnId: "turn-queued-runtime", status: "running" };
        }
        if (method === "thread/read") return { thread: { id: "thread-queued-runtime", turns: [] } };
        return {};
      },
      respond: () => undefined,
      onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
        notificationHandlers.set(method, handler);
      },
      onServerRequest: () => undefined,
      close: () => undefined
    };
    context.codex.createSessionRuntime = async () => ({
      client,
      sessions: createCodexSessionManager(client, {
        runtimeConfigForSession: context.runtimeConfig.get,
        codexRuntimeCapabilities: { supportsPermissionsProfile: true }
      }),
      stop: async () => undefined
    });
    context.runtimeConfig.update("thread-queued-runtime", {
      model: "gpt-5.5",
      effort: "high",
      permissionMode: "workspace",
      approvalMode: "on-request",
      approvalsReviewer: "auto_review"
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.inputQueue.enqueue",
      requestId: "queue-runtime",
      sessionId: "thread-queued-runtime",
      clientMessageId: "message-queued-runtime",
      text: "下一轮执行",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    await waitForWsMessage(messages, (message) => message.type === "session.inputQueue.updated" &&
      message.sessionId === "thread-queued-runtime");

    notificationHandlers.get("turn/completed")?.({
      threadId: "thread-queued-runtime",
      turnId: "turn-current",
      completedAt: "2026-05-14T00:00:00.000Z"
    });
    for (let index = 0; index < 300 && turnStartParams.length === 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(calls.map((call) => call.method)).toContain("turn/start");
    expect(turnStartParams[0]).toMatchObject({
      threadId: "thread-queued-runtime",
      model: "gpt-5.5",
      effort: "high",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      permissions: { type: "profile", id: ":workspace" }
    });
    ws.terminate();
  });

  it("wraps guided send text for Codex while keeping mobile echo raw", async () => {
    const sentTexts: string[] = [];
    const capabilities: InstalledCodexCapability[] = [{
      id: "skill:codex-home:frontend-design",
      kind: "skill",
      name: "frontend-design",
      description: "Build polished frontends",
      source: "codex-home",
      isAvailable: true
    }];
    const router = createCommandRouter({
      sessions: createRuntime({
        startTurn: async (input) => {
          sentTexts.push(turnInputText(input));
          return { turnId: "turn-guided", status: "running" };
        }
      }).sessions,
      capabilities: () => capabilities
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-guided",
      sessionId: "thread-guided",
      clientMessageId: "message-guided",
      text: "实现一个控制台页面",
      guidance: {
        mode: "guided",
        selectedCapabilityIds: ["skill:codex-home:frontend-design"]
      }
    }));

    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toContain("<mobile-input-guidance>");
    expect(sentTexts[0]).toContain("Selected skill for this turn: frontend-design");
    expect(sentTexts[0]).not.toContain("Installed skill");
    expect(sentTexts[0]).toContain("实现一个控制台页面");
    expect(result).toEqual({
      kind: "message.received",
      requestId: "send-guided",
      sessionId: "thread-guided",
      messageId: "message-guided",
      text: "实现一个控制台页面"
    });
  });

  it("command-prefixes selected imagegen sends for Codex while keeping mobile echo raw", async () => {
    const sentTexts: string[] = [];
    const capabilities: InstalledCodexCapability[] = [{
      id: "skill:codex-system:imagegen",
      kind: "skill",
      name: "imagegen",
      description: "Generate images",
      source: "codex-system",
      isAvailable: true
    }];
    const router = createCommandRouter({
      sessions: createRuntime({
        startTurn: async (input) => {
          sentTexts.push(turnInputText(input));
          return { turnId: "turn-imagegen-guided", status: "running" };
        }
      }).sessions,
      capabilities: () => capabilities
    });

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-imagegen-guided",
      sessionId: "thread-imagegen-guided",
      clientMessageId: "message-imagegen-guided",
      text: "帮我画一只可爱的耶耶",
      guidance: {
        mode: "guided",
        selectedCapabilityIds: ["skill:codex-system:imagegen"]
      }
    }));

    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toContain("Selected skill for this turn: imagegen");
    expect(sentTexts[0]).toContain("Injected command prefix: imagegen");
    expect(sentTexts[0]).toContain("</mobile-input-guidance>\n\nimagegen\n帮我画一只可爱的耶耶");
    expect(result).toEqual({
      kind: "message.received",
      requestId: "send-imagegen-guided",
      sessionId: "thread-imagegen-guided",
      messageId: "message-imagegen-guided",
      text: "帮我画一只可爱的耶耶"
    });
  });

  it("queues normal capability sends while cached active state exists", async () => {
    const startCalls: string[] = [];
    const steerCalls: string[] = [];
    const queue = createSessionInputQueueService();
    const capabilities: InstalledCodexCapability[] = [{
      id: "skill:codex-system:imagegen",
      kind: "skill",
      name: "imagegen",
      description: "Generate images",
      source: "codex-system",
      isAvailable: true
    }];
    const router = createCommandRouter({
      sessions: createRuntime({
        startTurn: async (input) => {
          startCalls.push(turnInputText(input));
          return { turnId: "turn-recovered", status: "running" };
        },
        steerTurn: async (input) => {
          steerCalls.push(turnInputText(input));
          return {};
        }
      }).sessions,
      capabilities: () => capabilities,
      queue
    });
    router.noteTurnStarted("thread-normal-guided", "stale-active-turn");

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-normal-guided",
      sessionId: "thread-normal-guided",
      clientMessageId: "message-normal-guided",
      text: "再生成一张",
      guidance: {
        mode: "guided",
        selectedCapabilityIds: ["skill:codex-system:imagegen"]
      }
    }));

    expect(result).toMatchObject({
      kind: "input.queue.updated",
      requestId: "send-normal-guided",
      sessionId: "thread-normal-guided"
    });
    if (result?.kind !== "input.queue.updated") throw new Error("Expected queued input update");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.text).toBe("再生成一张");
    expect(result.items[0]?.guidance.selectedCapabilityIds).toEqual(["skill:codex-system:imagegen"]);
    expect(steerCalls).toEqual([]);
    expect(startCalls).toEqual([]);
  });

  it("acknowledges explicit steer-now sends as guided when an active turn exists", async () => {
    const startCalls: string[] = [];
    const steerCalls: string[] = [];
    const router = createCommandRouter({
      sessions: createRuntime({
        startTurn: async (input) => {
          startCalls.push(turnInputText(input));
          return { turnId: "unexpected-start", status: "running" };
        },
        steerTurn: async (input) => {
          steerCalls.push(turnInputText(input));
          return {};
        }
      }).sessions
    });
    router.noteTurnStarted("thread-steer-now", "active-turn");

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-steer-now",
      sessionId: "thread-steer-now",
      clientMessageId: "message-steer-now",
      text: "把图片也加入当前处理",
      guidance: {
        mode: "steer-now",
        selectedCapabilityIds: []
      }
    }));

    expect(result).toEqual({
      kind: "message.received",
      requestId: "send-steer-now",
      sessionId: "thread-steer-now",
      messageId: "message-steer-now",
      text: "把图片也加入当前处理",
      sendState: "guided"
    });
    await waitForCondition(() => startCalls.length + steerCalls.length > 0);
    expect(startCalls).toEqual([]);
    expect(steerCalls).toEqual(["把图片也加入当前处理"]);
  });

  it("queues ordinary session.sendText while an active turn is running and starts it only after turn completed", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const startedTexts: string[] = [];
    const startedClientIds: string[] = [];
    const steerCalls: string[] = [];
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-active-plain-send"),
        startTurn: async (input) => {
          startedTexts.push(turnInputText(input));
          return { turnId: `turn-started-${startedTexts.length}`, status: "running" };
        },
        steerTurn: async (input) => {
          steerCalls.push(turnInputText(input));
          return {};
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-active-plain-send", sessionId: "thread-active-plain-send" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-active-plain-send");

    notificationHandlers.get("turn/started")?.({
      threadId: "thread-active-plain-send",
      turn: { id: "turn-active-plain-send", status: "inProgress" }
    });
    await waitForWsMessage(messages, (message) => message.type === "turn.updated" &&
      (message.turn as Record<string, unknown> | undefined)?.id === "turn-active-plain-send");

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "send-active-plain",
      sessionId: "thread-active-plain-send",
      clientMessageId: "message-active-plain",
      text: "普通发送应等待下一轮"
    });

    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-active-plain-send" &&
        Array.isArray(items) &&
        items.length === 1 &&
        items[0]?.status === "queued" &&
        items[0]?.text === "普通发送应等待下一轮";
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startedTexts).toEqual([]);
    expect(steerCalls).toEqual([]);

    notificationHandlers.get("turn/completed")?.({
      threadId: "thread-active-plain-send",
      turn: { id: "turn-active-plain-send", status: "completed" },
      completedAt: "2026-05-21T09:00:05.000Z"
    });

    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-active-plain-send" &&
        Array.isArray(items) &&
        items.length === 1 &&
        items[0]?.status === "sent";
    });
    expect(startedTexts).toEqual(["普通发送应等待下一轮"]);
    expect(steerCalls).toEqual([]);
    ws.terminate();
  });

  it("rejects ordinary session.sendText attachments while an active turn would queue them", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const startCalls: string[] = [];
    const steerCalls: string[] = [];
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-active-attachment-send"),
        startTurn: async (input) => {
          startCalls.push(turnInputText(input));
          return { turnId: `turn-started-${startCalls.length}`, status: "running" };
        },
        steerTurn: async (input) => {
          steerCalls.push(turnInputText(input));
          return {};
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-active-attachment-send", sessionId: "thread-active-attachment-send" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-active-attachment-send");

    notificationHandlers.get("turn/started")?.({
      threadId: "thread-active-attachment-send",
      turn: { id: "turn-active-attachment-send", status: "inProgress" }
    });
    await waitForWsMessage(messages, (message) => message.type === "turn.updated" &&
      (message.turn as Record<string, unknown> | undefined)?.id === "turn-active-attachment-send");

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "send-active-attachment",
      sessionId: "thread-active-attachment-send",
      clientMessageId: "message-active-attachment",
      text: "普通发送附件不能排队",
      attachmentIds: ["asset-1"]
    });

    const failed = await waitForWsMessage(messages, (message) =>
      message.type === "command.failed" && message.requestId === "send-active-attachment");
    expect(failed.message).toBe("附件不能排队发送。请移除附件后加入队列，或使用立即干预发送附件。");
    expect(startCalls).toEqual([]);
    expect(steerCalls).toEqual([]);
    ws.terminate();
  });

  it("does not echo queued input as conversation output before the next turn starts", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const startedTexts: string[] = [];
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-queue-no-echo"),
        startTurn: async (input) => {
          startedTexts.push(turnInputText(input));
          return { turnId: `turn-queue-no-echo-${startedTexts.length}`, status: "running" };
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-queue-no-echo", sessionId: "thread-queue-no-echo" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-queue-no-echo");
    notificationHandlers.get("turn/started")?.({
      threadId: "thread-queue-no-echo",
      turn: { id: "turn-active-no-echo", status: "inProgress" }
    });
    await waitForWsMessage(messages, (message) => message.type === "turn.updated" &&
      (message.turn as Record<string, unknown> | undefined)?.id === "turn-active-no-echo");

    const beforeQueueIndex = messages.length;
    sendCommand(ws, {
      type: "session.sendText",
      requestId: "send-queue-no-echo",
      sessionId: "thread-queue-no-echo",
      clientMessageId: "message-queue-no-echo",
      text: "只应该进入队列"
    });

    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-queue-no-echo" &&
        Array.isArray(items) &&
        items.length === 1 &&
        items[0]?.status === "queued";
    });
    await expect(hasNewWsMessage(messages, beforeQueueIndex, (message) =>
      message.type === "message.updated" &&
      (message.message as Record<string, unknown> | undefined)?.clientMessageId === "message-queue-no-echo"
    )).resolves.toBe(false);
    expect(startedTexts).toEqual([]);

    notificationHandlers.get("turn/completed")?.({
      threadId: "thread-queue-no-echo",
      turn: { id: "turn-active-no-echo", status: "completed" }
    });
    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-queue-no-echo" &&
        Array.isArray(items) &&
        items[0]?.status === "sent";
    });
    expect(startedTexts).toEqual(["只应该进入队列"]);
    ws.terminate();
  });

  it("queues ordinary sends while turn start is pending before Codex confirms the active turn", async () => {
    const queue = createSessionInputQueueService();
    const startCalls: string[] = [];
    const router = createCommandRouter({
      sessions: createRuntime({
        startTurn: async (input) => {
          startCalls.push(turnInputText(input));
          return await new Promise(() => undefined);
        }
      }).sessions,
      queue
    });

    const first = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-pending-start-1",
      sessionId: "thread-pending-start",
      clientMessageId: "message-pending-start-1",
      text: "第一条启动 turn"
    }));
    expect(first?.kind).toBe("message.received");
    await waitForCondition(() => startCalls.length === 1);

    const second = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-pending-start-2",
      sessionId: "thread-pending-start",
      clientMessageId: "message-pending-start-2",
      text: "第二条必须等待当前 turn 真正开始"
    }));

    expect(second?.kind).toBe("input.queue.updated");
    if (second?.kind !== "input.queue.updated") throw new Error("Expected queue update");
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({
      sessionId: "thread-pending-start",
      clientMessageId: "message-pending-start-2",
      text: "第二条必须等待当前 turn 真正开始",
      status: "queued"
    });
    expect(startCalls).toEqual(["第一条启动 turn"]);
  });

  it("does not drain queued input for a late terminal event from an older turn while a newer turn is active", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const startedTexts: string[] = [];
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-late-terminal-no-drain"),
        startTurn: async (input) => {
          startedTexts.push(turnInputText(input));
          return { turnId: "unexpected-queued-start", status: "running" };
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-late-terminal-no-drain", sessionId: "thread-late-terminal-no-drain" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-late-terminal-no-drain");
    notificationHandlers.get("turn/started")?.({
      threadId: "thread-late-terminal-no-drain",
      turn: { id: "turn-old", status: "inProgress" }
    });
    await waitForWsMessage(messages, (message) => message.type === "turn.updated" &&
      (message.turn as Record<string, unknown> | undefined)?.id === "turn-old");

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "send-late-terminal-queued",
      sessionId: "thread-late-terminal-no-drain",
      clientMessageId: "message-late-terminal-queued",
      text: "旧 turn 结束时不应抢跑"
    });
    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-late-terminal-no-drain" &&
        Array.isArray(items) &&
        items[0]?.status === "queued";
    });

    notificationHandlers.get("turn/started")?.({
      threadId: "thread-late-terminal-no-drain",
      turn: { id: "turn-new", status: "inProgress" }
    });
    await waitForWsMessage(messages, (message) => message.type === "turn.updated" &&
      (message.turn as Record<string, unknown> | undefined)?.id === "turn-new");
    const beforeLateTerminal = messages.length;

    notificationHandlers.get("turn/completed")?.({
      threadId: "thread-late-terminal-no-drain",
      turn: { id: "turn-old", status: "completed" }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(startedTexts).toEqual([]);
    expect(await hasNewWsMessage(messages, beforeLateTerminal, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-late-terminal-no-drain" &&
        Array.isArray(items) &&
        items[0]?.status === "sent";
    })).toBe(false);
    ws.terminate();
  });

  it("retries explicit steer-now once when Codex reports a newer active turn id", async () => {
    const steerTurns: string[] = [];
    const startCalls: string[] = [];
    const router = createCommandRouter({
      sessions: createRuntime({
        startTurn: async (input) => {
          startCalls.push(turnInputText(input));
          return { turnId: "unexpected-start", status: "running" };
        },
        steerTurn: async (input) => {
          steerTurns.push(input.turnId);
          if (steerTurns.length === 1) {
            throw new Error("expected active turn id `turn-old` but found `turn-new`");
          }
          return {};
        }
      }).sessions,
      queue: createSessionInputQueueService()
    });
    router.noteTurnStarted("thread-steer-mismatch", "turn-old");

    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-steer-mismatch",
      sessionId: "thread-steer-mismatch",
      clientMessageId: "message-steer-mismatch",
      text: "继续当前 turn",
      guidance: { mode: "steer-now", selectedCapabilityIds: [] }
    }));

    expect(result?.kind).toBe("message.received");
    await waitForCondition(() => steerTurns.length === 2);
    expect(steerTurns).toEqual(["turn-old", "turn-new"]);
    expect(router.activeTurnId("thread-steer-mismatch")).toBe("turn-new");
    expect(startCalls).toEqual([]);
  });

  it("rejects steer-now sends without silently starting a new turn", async () => {
    const startCalls: string[] = [];
    const router = createCommandRouter({
      sessions: createRuntime({
        startTurn: async (input) => {
          startCalls.push(turnInputText(input));
          return { turnId: "unexpected-start", status: "running" };
        }
      }).sessions,
      queue: createSessionInputQueueService()
    });

    await expect(router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "send-steer-no-active",
      sessionId: "thread-steer-no-active",
      clientMessageId: "message-steer-no-active",
      text: "不要新开 turn",
      guidance: { mode: "steer-now", selectedCapabilityIds: [] }
    }))).rejects.toThrow("当前会话没有运行中的 Codex turn");
    expect(startCalls).toEqual([]);
  });

  it("updates input queue through router commands with queued text for mobile queue actions", async () => {
    const queue = createSessionInputQueueService();
    const router = createCommandRouter({
      sessions: createRuntime({}).sessions,
      queue
    });

    const enqueued = await router.handle(ClientCommandSchema.parse({
      type: "session.inputQueue.enqueue",
      requestId: "queue-1",
      sessionId: "thread-queue",
      clientMessageId: "message-queue",
      text: "包含敏感片段的排队输入",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    }));

    expect(enqueued?.kind).toBe("input.queue.updated");
    if (enqueued?.kind !== "input.queue.updated") throw new Error("Expected queue update");
    expect(enqueued.items).toHaveLength(1);
    expect(enqueued.items[0]).toEqual(expect.objectContaining({
      sessionId: "thread-queue",
      clientMessageId: "message-queue",
      text: "包含敏感片段的排队输入",
      textPreview: "包含敏感片段的排队输入",
      textLength: "包含敏感片段的排队输入".length,
      status: "queued",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    }));

    const cancelled = await router.handle(ClientCommandSchema.parse({
      type: "session.inputQueue.cancel",
      requestId: "queue-cancel",
      sessionId: "thread-queue",
      queueItemId: enqueued.items[0].id
    }));
    expect(cancelled).toEqual(expect.objectContaining({
      kind: "input.queue.updated",
      sessionId: "thread-queue"
    }));
    if (cancelled?.kind !== "input.queue.updated") throw new Error("Expected queue update");
    expect(cancelled.items[0].status).toBe("cancelled");

    const failed = queue.enqueue({
      sessionId: "thread-queue",
      clientMessageId: "message-queue-failed",
      text: "失败后重试",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    queue.markSending("thread-queue", failed.id);
    queue.markFailed("thread-queue", failed.id);
    const retried = await router.handle(ClientCommandSchema.parse({
      type: "session.inputQueue.retry",
      requestId: "queue-retry",
      sessionId: "thread-queue",
      queueItemId: failed.id
    }));
    if (retried?.kind !== "input.queue.updated") throw new Error("Expected queue update");
    expect(retried.items[0].status).toBe("cancelled");
    expect(retried.items[1].status).toBe("queued");
    expect(retried.items[1]).toMatchObject({ text: "失败后重试" });
  });

  it("rejects queued input with unavailable selected capabilities before storing it", async () => {
    const queue = createSessionInputQueueService();
    const router = createCommandRouter({
      sessions: createRuntime({}).sessions,
      capabilities: () => [],
      queue
    });

    await expect(router.handle(ClientCommandSchema.parse({
      type: "session.inputQueue.enqueue",
      requestId: "queue-invalid-guidance",
      sessionId: "thread-queue",
      clientMessageId: "message-queue",
      text: "下一轮使用不存在的技能",
      guidance: { mode: "queued", selectedCapabilityIds: ["skill:codex-home:missing"] }
    }))).rejects.toThrow("选择的技能或插件不可用");
    expect(queue.list("thread-queue")).toEqual([]);
  });

  it("updates session pin state through WebSocket commands", async () => {
    const context = createTestAppContext();
    context.sessions.addSession({
      id: "thread-pin",
      toolId: "codex-mac",
      title: "置顶测试",
      projectPath: "/repo/code",
      projectName: "code",
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      isPinned: false,
      needsUserInput: false,
      waitsForNextDirection: false,
      statusLabel: "idle",
      lastMessagePreview: "普通"
    });
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [{
        id: "thread-pin",
        toolId: "codex-mac",
        title: "置顶测试",
        projectPath: "/repo/code",
        projectName: "code",
        createdAt: "2026-05-10T00:00:00.000Z",
        updatedAt: "2026-05-10T00:00:00.000Z",
        isPinned: false,
        needsUserInput: false,
        waitsForNextDirection: false,
        statusLabel: "idle",
        lastMessagePreview: "普通"
      }]
    });
    server = await createServer(context);
    await server.ready();
    const { deviceId, ws } = await openAuthedWs(context, server as TestServer);

    sendCommand(ws, { type: "session.pin", requestId: "r-pin", sessionId: "thread-pin", isPinned: true });
    const rows = await waitForAuditRows(context, 1);

    expect(context.sessions.get("thread-pin")?.isPinned).toBe(true);
    expect(rows[0]).toEqual(expect.objectContaining({
      device_id: deviceId,
      session_id: "thread-pin",
      action_type: "session.pin",
      result: "success"
    }));
    ws.terminate();
  });

  it("maps V1 product commands to Codex official thread and turn methods", async () => {
    const calls: string[] = [];
    const router = createCommandRouter({
      sessions: {
        createSession: async () => {
          calls.push("thread/start");
          calls.push("turn/start");
          return { threadId: "thread-1", turnId: "turn-1", status: "running" };
        },
        readSessionDetail: async () => {
          calls.push("thread/read");
          return {
            session: {
              id: "thread-1",
              toolId: "codex-mac",
              title: "会话详情",
              projectPath: null,
              projectName: null,
              createdAt: "2026-05-10T00:00:00.000Z",
              updatedAt: "2026-05-10T00:00:00.000Z",
              isPinned: false,
              needsUserInput: false,
              waitsForNextDirection: false,
              statusLabel: "notLoaded",
              lastMessagePreview: "详情"
            },
            messages: [],
            turns: []
          };
        },
        startTurn: async () => {
          calls.push("turn/start");
          return {};
        },
        steerTurn: async () => {
          calls.push("turn/steer");
          return {};
        },
        interruptTurn: async () => {
          calls.push("turn/interrupt");
          return {};
        },
        respondToApproval: (_approvalId, _actionId, answers) => {
          calls.push(`approval/respond:${answers?.reason?.answers[0] ?? ""}`);
        }
      }
    });

    await router.handle(ClientCommandSchema.parse({ type: "session.create", requestId: "r1", toolId: "codex-mac", projectPath: null, text: "开始" }));
    await router.handle(ClientCommandSchema.parse({ type: "session.read", requestId: "r-read", sessionId: "thread-1" }));
    await router.handle(ClientCommandSchema.parse({ type: "session.steer", requestId: "r2", sessionId: "thread-1", clientMessageId: "m-steer-r2", text: "改方向" }));
    await router.handle(ClientCommandSchema.parse({ type: "session.interrupt", requestId: "r3", sessionId: "thread-1" }));
    await router.handle(ClientCommandSchema.parse({
      type: "approval.respond",
      requestId: "r4",
      sessionId: "thread-1",
      approvalId: "approval-1",
      actionId: "decline",
      answers: {
        reason: { answers: ["请调整后再继续"] }
      }
    }));

    expect(calls).toEqual(["thread/start", "turn/start", "thread/read", "turn/steer", "turn/interrupt", "approval/respond:请调整后再继续"]);
  });

  it("queues ordinary sends during cached active turns and steers only explicit interventions", async () => {
    const calls: string[] = [];
    const startedClientIds: string[] = [];
    const steeredClientIds: string[] = [];
    const queue = createSessionInputQueueService();
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-1", turnId: "turn-created", status: "running" }),
        readSessionDetail: async () => ({ session: {
          id: "thread-1",
          toolId: "codex-mac",
          title: "会话详情",
          projectPath: null,
          projectName: null,
          createdAt: "2026-05-10T00:00:00.000Z",
          updatedAt: "2026-05-10T00:00:00.000Z",
          isPinned: false,
          needsUserInput: false,
          waitsForNextDirection: false,
          statusLabel: "notLoaded",
          lastMessagePreview: "详情"
        }, messages: [], turns: [] }),
        startTurn: async (input) => {
          calls.push("turn/start");
          startedClientIds.push(input.clientUserMessageId ?? "");
          return { turnId: "turn-new" };
        },
        steerTurn: async (input) => {
          calls.push("turn/steer");
          steeredClientIds.push(input.clientUserMessageId ?? "");
          return {};
        },
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      },
      queue
    });

    router.noteTurnStarted("thread-1", "turn-live");
    const queued = await router.handle(ClientCommandSchema.parse({ type: "session.sendText", requestId: "r1", sessionId: "thread-1", clientMessageId: "m1", text: "继续" }));
    await router.handle(ClientCommandSchema.parse({ type: "session.steer", requestId: "r-steer", sessionId: "thread-1", clientMessageId: "m-steer", text: "补充当前 turn" }));
    await waitForCondition(() => calls.includes("turn/steer"));
    router.noteTurnCompleted("thread-1");
    await router.handle(ClientCommandSchema.parse({ type: "session.sendText", requestId: "r2", sessionId: "thread-1", clientMessageId: "m2", text: "下一步" }));

    expect(queued?.kind).toBe("input.queue.updated");
    expect(calls).toEqual(["turn/steer", "turn/start"]);
    expect(steeredClientIds).toEqual(["m-steer"]);
    expect(startedClientIds).toEqual(["m2"]);
    expect(queue.list("thread-1")[0]?.text).toBe("继续");
  });

  it("does not let late turn start responses replace runtime confirmed active turns", async () => {
    const calls: string[] = [];
    let resolveStart = (_value: { turnId: string; status: string }): void => {
      throw new Error("startTurn resolver was not captured");
    };
    let resolverCaptured = false;
    let startResolved = false;
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-late-start", turnId: "turn-created", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-late-start"),
        startTurn: async () => {
          calls.push("turn/start");
          const result = await new Promise<{ turnId: string; status: string }>((resolve) => {
            resolveStart = resolve;
            resolverCaptured = true;
          });
          startResolved = true;
          return result;
        },
        steerTurn: async (input) => {
          calls.push(`turn/steer:${input.turnId}`);
          return {};
        },
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      }
    });

    await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "r-late-start",
      sessionId: "thread-late-start",
      clientMessageId: "m-late-start",
      text: "开始执行"
    }));
    await waitForCondition(() => resolverCaptured);

    router.noteTurnStarted("thread-late-start", "turn-runtime-confirmed");
    resolveStart({ turnId: "turn-response-late", status: "running" });
    await waitForCondition(() => startResolved);

    await router.handle(ClientCommandSchema.parse({
      type: "session.steer",
      requestId: "r-steer-after-late-start",
      sessionId: "thread-late-start",
      clientMessageId: "m-steer-after-late-start",
      text: "补充当前任务"
    }));

    expect(calls).toEqual(["turn/start", "turn/steer:turn-runtime-confirmed"]);
  });

  it("queues ordinary sends when cached active turn state might be stale", async () => {
    const calls: string[] = [];
    const failures: Array<{ requestId: string; message: string }> = [];
    const queue = createSessionInputQueueService();
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-stale-active", turnId: "turn-created", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-stale-active"),
        startTurn: async (input) => {
          calls.push(`start:${input.threadId}:${turnInputText(input)}`);
          return { turnId: "turn-recovered", status: "running" };
        },
        steerTurn: async (input) => {
          calls.push(`steer:${input.threadId}:${input.turnId}:${turnInputText(input)}`);
          throw new Error("thread not found: thread-stale-active");
        },
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      },
      queue
    });

    router.noteTurnStarted("thread-stale-active", "turn-stale");
    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "r-stale-active-send",
      sessionId: "thread-stale-active",
      clientMessageId: "m-stale-active-send",
      text: "继续"
    }), (failure) => failures.push({ requestId: failure.requestId, message: failure.message }));

    expect(result).toMatchObject({
      kind: "input.queue.updated",
      requestId: "r-stale-active-send",
      sessionId: "thread-stale-active"
    });
    expect(calls).toEqual([]);
    expect(failures).toEqual([]);
    expect(router.hasActiveTurn("thread-stale-active")).toBe(true);
    expect(queue.list("thread-stale-active")[0]?.text).toBe("继续");
  });

  it("starts a new turn when a fresh detail read clears stale cached active state before send", async () => {
    const calls: string[] = [];
    const queue = createSessionInputQueueService();
    const idleDetail = sessionDetail("thread-fresh-idle-send");
    idleDetail.session.statusLabel = "idle";
    idleDetail.session.waitsForNextDirection = true;
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-fresh-idle-send", turnId: "turn-created", status: "running" }),
        readSessionDetail: async () => idleDetail,
        startTurn: async (input) => {
          calls.push(`start:${input.threadId}:${turnInputText(input)}`);
          return { turnId: "turn-after-fresh-idle", status: "running" };
        },
        steerTurn: async (input) => {
          calls.push(`steer:${input.threadId}:${input.turnId}:${turnInputText(input)}`);
          return {};
        },
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      },
      queue
    });

    router.noteTurnStarted("thread-fresh-idle-send", "turn-stale-active");
    const result = await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "r-fresh-idle-send",
      sessionId: "thread-fresh-idle-send",
      clientMessageId: "m-fresh-idle-send",
      text: "第二条应该开启新 turn"
    }));

    expect(result).toEqual({
      kind: "message.received",
      requestId: "r-fresh-idle-send",
      sessionId: "thread-fresh-idle-send",
      messageId: "m-fresh-idle-send",
      text: "第二条应该开启新 turn"
    });
    await waitForCondition(() => calls.length > 0);
    expect(calls).toEqual(["start:thread-fresh-idle-send:第二条应该开启新 turn"]);
    expect(queue.list("thread-fresh-idle-send")).toHaveLength(0);
  });

  it("queues ordinary sends without checking cached stale turn ids", async () => {
    const calls: string[] = [];
    const failures: Array<{ requestId: string; message: string }> = [];
    const queue = createSessionInputQueueService();
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-stale-turn", turnId: "turn-created", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-stale-turn"),
        startTurn: async (input) => {
          calls.push(`start:${input.threadId}:${turnInputText(input)}`);
          return { turnId: "turn-recovered", status: "running" };
        },
        steerTurn: async (input) => {
          calls.push(`steer:${input.threadId}:${input.turnId}:${turnInputText(input)}`);
          throw new Error("turn not found: turn-stale");
        },
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      },
      queue
    });

    router.noteTurnStarted("thread-stale-turn", "turn-stale");
    await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "r-stale-turn-send",
      sessionId: "thread-stale-turn",
      clientMessageId: "m-stale-turn-send",
      text: "继续"
    }), (failure) => failures.push({ requestId: failure.requestId, message: failure.message }));

    expect(calls).toEqual([]);
    expect(failures).toEqual([]);
    expect(queue.list("thread-stale-turn")[0]?.text).toBe("继续");
  });

  it("queues ordinary sends without probing no-active-turn stale state", async () => {
    const calls: string[] = [];
    const failures: Array<{ requestId: string; message: string }> = [];
    const queue = createSessionInputQueueService();
    const router = createCommandRouter({
      sessions: {
        createSession: async () => ({ threadId: "thread-no-active-turn", turnId: "turn-created", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-no-active-turn"),
        startTurn: async (input) => {
          calls.push(`start:${input.threadId}:${turnInputText(input)}`);
          return { turnId: "turn-recovered", status: "running" };
        },
        steerTurn: async (input) => {
          calls.push(`steer:${input.threadId}:${input.turnId}:${turnInputText(input)}`);
          throw new Error("no active turn to steer");
        },
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      },
      queue
    });

    router.noteTurnStarted("thread-no-active-turn", "turn-stale");
    await router.handle(ClientCommandSchema.parse({
      type: "session.sendText",
      requestId: "r-no-active-turn-send",
      sessionId: "thread-no-active-turn",
      clientMessageId: "m-no-active-turn-send",
      text: "再生成一张"
    }), (failure) => failures.push({ requestId: failure.requestId, message: failure.message }));

    expect(calls).toEqual([]);
    expect(failures).toEqual([]);
    expect(router.hasActiveTurn("thread-no-active-turn")).toBe(true);
    expect(queue.list("thread-no-active-turn")[0]?.text).toBe("再生成一张");
  });

  it("routes context compact command to the Codex session manager", async () => {
    const calls: string[] = [];
    const runtime = createRuntime({});
    Object.assign(runtime.sessions, {
      compactContext: async (input: { threadId: string }) => {
        calls.push(`compact:${input.threadId}`);
        return {};
      }
    });
    const router = createCommandRouter({ sessions: runtime.sessions });

    await router.handle(ClientCommandSchema.parse({
      type: "session.context.compact",
      requestId: "r-compact",
      sessionId: "thread-1"
    }));

    expect(calls).toEqual(["compact:thread-1"]);
  });

  it("pushes compact progress and refreshed context usage after mobile context compact", async () => {
    const context = createTestAppContext();
    let compactCalls = 0;
    let detailReadCount = 0;
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [],
      readSessionDetail: async () => {
        detailReadCount++;
        if (detailReadCount === 1) {
          return sessionDetailWithContextUsage("thread-compact", 150000);
        }
        return sessionDetailWithContextUsage("thread-compact", 42000);
      },
      compactContext: async () => {
        compactCalls++;
        return {};
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-compact", sessionId: "thread-compact" });
    await waitForWsMessage(messages, (message) =>
      message.type === "session.updated" &&
      (message.session as Record<string, unknown> | undefined)?.contextTokensUsed === 150000
    );

    sendCommand(ws, { type: "session.context.compact", requestId: "compact-1", sessionId: "thread-compact" });

    const running = await waitForWsMessage(messages, (message) =>
      message.type === "timeline.item.updated" &&
      (message.item as Record<string, unknown> | undefined)?.kind === "contextCompaction" &&
      (message.item as Record<string, unknown> | undefined)?.status === "running"
    );
    expect(running.item).toMatchObject({
      sessionId: "thread-compact",
      kind: "contextCompaction",
      status: "running",
      text: "正在压缩上下文"
    });

    const completed = await waitForWsMessage(messages, (message) =>
      message.type === "timeline.item.completed" &&
      (message.item as Record<string, unknown> | undefined)?.kind === "contextCompaction" &&
      (message.item as Record<string, unknown> | undefined)?.status === "completed"
    );
    expect(completed.item).toMatchObject({
      sessionId: "thread-compact",
      kind: "contextCompaction",
      status: "completed",
      text: "上下文已压缩"
    });

    await waitForWsMessage(messages, (message) =>
      message.type === "session.updated" &&
      (message.session as Record<string, unknown> | undefined)?.id === "thread-compact" &&
      (message.session as Record<string, unknown> | undefined)?.contextTokensUsed === 42000
    );
    expect(compactCalls).toBe(1);
    expect(detailReadCount).toBe(2);
    ws.terminate();
  });

  it("routes desktop-owned session actions through follower-only IPC bridge", async () => {
    const calls: string[] = [];
    const localSessions = createRuntime({
      readSessionDetail: async () => {
        calls.push("local:read");
        return sessionDetail("thread-local");
      },
      startTurn: async () => {
        calls.push("local:start");
        return { turnId: "turn-local", status: "running" };
      },
      renameSession: async (input) => {
        calls.push(`local:rename:${input.threadId}:${input.title}`);
        return {};
      }
    }).sessions;
    const desktopFollower = {
      getConversationState: (threadId: string) => {
        if (threadId !== "thread-desktop") return null;
        return {
          id: "thread-desktop",
          title: "Desktop thread",
          createdAt: 1778600000000,
          updatedAt: 1778600001000,
          threadRuntimeStatus: { type: "idle" },
          cwd: "/Users/me/project",
          turns: [{ id: "turn-follower", status: "running" }]
        };
      },
      startTurn: async (input: { threadId: string; text?: string; inputItems?: CodexTurnInputItem[] }) => {
        calls.push(`follower:start:${input.threadId}:${turnInputText(input)}`);
        return { type: "response", resultType: "success", result: { turnId: "turn-follower", status: "running" } };
      },
      steerTurn: async (input: { threadId: string; turnId: string; text?: string; inputItems?: CodexTurnInputItem[] }) => {
        calls.push(`follower:steer:${input.threadId}:${input.turnId}:${turnInputText(input)}`);
        return { type: "response", resultType: "success", result: { ok: true } };
      },
      interruptTurn: async (input: { threadId: string; turnId: string }) => {
        calls.push(`follower:interrupt:${input.threadId}:${input.turnId}`);
        return { type: "response", resultType: "success", result: { ok: true } };
      },
      respondToApproval: async (input: { threadId: string; approvalId: string; actionId: string; answers?: Record<string, unknown> }) => {
        calls.push(`follower:approval:${input.threadId}:${input.approvalId}:${input.actionId}`);
        return { type: "response", resultType: "success", result: { ok: true } };
      },
      compactContext: async (input: { threadId: string }) => {
        calls.push(`follower:compact:${input.threadId}`);
        return { type: "response", resultType: "success", result: { ok: true } };
      },
      stop: () => undefined
    };
    const sessions = createFollowerAwareSessions(localSessions, desktopFollower);

    await expect(sessions.readSessionDetail("thread-desktop")).resolves.toEqual(expect.objectContaining({
      session: expect.objectContaining({ id: "thread-desktop", title: "Desktop thread" })
    }));
    const compactableSessions = sessions as typeof sessions & {
      compactContext(input: { threadId: string }): Promise<unknown>;
    };
    await expect(sessions.startTurn({ threadId: "thread-desktop", text: "继续" })).resolves.toEqual({ turnId: "turn-follower", status: "running" });
    await sessions.steerTurn({ threadId: "thread-desktop", turnId: "turn-follower", text: "调整" });
    await sessions.interruptTurn({ threadId: "thread-desktop", turnId: "turn-follower" });
    await compactableSessions.compactContext({ threadId: "thread-desktop" });
    await sessions.respondToApproval("approval-1", "approve", undefined, "thread-desktop");
    await sessions.respondToApproval("approval-2", "decline", {
      reason: { answers: ["请改成只读方案"] }
    }, "thread-desktop");
    await sessions.respondToApproval("approval-3", "cancel", {
      reason: { answers: ["请先说明修改范围"] }
    }, "thread-desktop");
    await expect(sessions.renameSession?.({ threadId: "thread-desktop", title: "移动端改名" })).resolves.toEqual({ skipped: true, reason: "desktop-owned-session" });
    await expect(sessions.startTurn({ threadId: "thread-local", text: "本地继续" })).resolves.toEqual({ turnId: "turn-local", status: "running" });

    expect(calls).toEqual([
      "follower:start:thread-desktop:继续",
      "follower:steer:thread-desktop:turn-follower:调整",
      "follower:interrupt:thread-desktop:turn-follower",
      "follower:compact:thread-desktop",
      "follower:approval:thread-desktop:approval-1:approve",
      "follower:approval:thread-desktop:approval-2:decline",
      "follower:approval:thread-desktop:approval-3:cancel",
      "local:start"
    ]);
  });

  it("falls back to local turn start when a stale desktop follower reports thread not found", async () => {
    const calls: string[] = [];
    const localSessions = createRuntime({
      startTurn: async (input) => {
        calls.push(`local:start:${input.threadId}:${turnInputText(input)}`);
        return { turnId: "turn-local-recovered", status: "running" };
      }
    }).sessions;
    const desktopFollower = {
      getConversationState: (threadId: string) => {
        if (threadId !== "thread-stale-desktop") return null;
        return {
          id: "thread-stale-desktop",
          title: "Stale desktop thread",
          createdAt: 1778600000000,
          updatedAt: 1778600001000,
          threadRuntimeStatus: { type: "idle" },
          cwd: "/Users/me/project",
          turns: []
        };
      },
      startTurn: async (input: { threadId: string; text?: string; inputItems?: CodexTurnInputItem[] }) => {
        calls.push(`follower:start:${input.threadId}:${turnInputText(input)}`);
        return { type: "response", resultType: "error", error: "thread not found: thread-stale-desktop" };
      },
      steerTurn: async () => ({ type: "response", resultType: "success", result: { ok: true } }),
      interruptTurn: async () => ({ type: "response", resultType: "success", result: { ok: true } }),
      respondToApproval: async () => ({ type: "response", resultType: "success", result: { ok: true } }),
      compactContext: async () => ({ type: "response", resultType: "success", result: { ok: true } }),
      stop: () => undefined
    };
    const sessions = createFollowerAwareSessions(localSessions, desktopFollower);

    await expect(sessions.startTurn({ threadId: "thread-stale-desktop", text: "继续" })).resolves.toEqual({
      turnId: "turn-local-recovered",
      status: "running"
    });
    expect(calls).toEqual([
      "follower:start:thread-stale-desktop:继续",
      "local:start:thread-stale-desktop:继续"
    ]);
  });

  it("falls back to a fresh runtime when shared session detail reads time out", async () => {
    let fallbackStopped = false;
    const fallbackDetail = sessionDetail("thread-stale-runtime");
    fallbackDetail.session.title = "fresh detail";
    const localSessions = createRuntime({
      readSessionDetail: async () => {
        throw new Error("Codex App Server request timed out: thread/read");
      }
    }).sessions;
    const sessions = createFollowerAwareSessions(localSessions, null, async () => ({
      ...createRuntime({
        readSessionDetail: async () => fallbackDetail
      }),
      stop: async () => {
        fallbackStopped = true;
      }
    }));

    await expect(sessions.readSessionDetail("thread-stale-runtime")).resolves.toEqual(fallbackDetail);
    expect(fallbackStopped).toBe(true);
  });

  it("does not wait for the full app-server timeout before falling back to a fresh detail runtime", async () => {
    let fallbackReads = 0;
    const fallbackDetail = sessionDetail("thread-hanging-runtime");
    fallbackDetail.session.title = "fresh detail";
    const localSessions = createRuntime({
      readSessionDetail: async () => new Promise<never>(() => undefined)
    }).sessions;
    const sessions = createFollowerAwareSessions(localSessions, null, async () => ({
      ...createRuntime({
        readSessionDetail: async () => {
          fallbackReads++;
          return fallbackDetail;
        }
      }),
      stop: async () => undefined
    }), { detailReadFallbackTimeoutMs: 10 });

    const result = await Promise.race([
      sessions.readSessionDetail("thread-hanging-runtime"),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 80))
    ]);

    expect(result).toEqual(fallbackDetail);
    expect(fallbackReads).toBe(1);
  });

  it("keeps pending approvals visible when local detail reads use a fresh runtime", async () => {
    const pendingApproval: NonNullable<SessionDetail["approval"]> = {
      id: "approval-pending",
      kind: "command",
      method: "item/commandExecution/requestApproval",
      subject: "printf mobile_pending_approval",
      title: "是否允许 Codex 运行命令？",
      body: "$ printf mobile_pending_approval",
      actions: [{ id: "accept", label: "同意" }],
      createdAt: "2026-05-24T00:00:00.000Z"
    };
    const freshDetail = sessionDetail("thread-pending-approval");
    freshDetail.session.title = "fresh detail";
    const localSessions = createRuntime({}).sessions as TestRuntimeSessionsWithCompact & {
      readPendingApproval?: (threadId: string) => SessionDetail["approval"] | null;
    };
    localSessions.readPendingApproval = (threadId: string) => threadId === "thread-pending-approval" ? pendingApproval : null;
    const sessions = createFollowerAwareSessions(localSessions, null, async () => ({
      ...createRuntime({
        readSessionDetail: async () => freshDetail
      }),
      stop: async () => undefined
    }));

    const detail = await sessions.readSessionDetail("thread-pending-approval");

    expect(detail.session.title).toBe("fresh detail");
    expect(detail.session.needsUserInput).toBe(true);
    expect(detail.session.waitsForNextDirection).toBe(false);
    expect(detail.session.statusLabel).toBe("waiting_for_approval");
    expect(detail.approval).toEqual(pendingApproval);
  });

  it("keeps shared runtime sends separate from heavy detail reads by using fresh runtimes for local detail", async () => {
    const calls: string[] = [];
    const freshDetail = sessionDetail("thread-heavy-detail");
    freshDetail.session.title = "fresh detail";
    const localSessions = createRuntime({
      readSessionDetail: async () => {
        calls.push("local:read");
        return new Promise<SessionDetail>(() => undefined);
      },
      startTurn: async (input) => {
        calls.push(`local:start:${input.threadId}:${turnInputText(input)}`);
        return { turnId: "turn-shared-runtime", status: "running" };
      }
    }).sessions;
    const sessions = createFollowerAwareSessions(localSessions, null, async () => ({
      ...createRuntime({
        readSessionDetail: async (threadId: string) => {
          calls.push(`fresh:read:${threadId}`);
          return freshDetail;
        }
      }),
      stop: async () => {
        calls.push("fresh:stop");
      }
    }));

    await expect(sessions.readSessionDetail("thread-heavy-detail")).resolves.toEqual(freshDetail);
    await expect(sessions.startTurn({ threadId: "thread-heavy-detail", text: "继续" })).resolves.toEqual({
      turnId: "turn-shared-runtime",
      status: "running"
    });

    expect(calls).toEqual([
      "fresh:read:thread-heavy-detail",
      "fresh:stop",
      "local:start:thread-heavy-detail:继续"
    ]);
  });

  it("mirrors desktop owner state to mobile and sends mobile text through follower IPC", async () => {
    const previousFollowerEnv = process.env[DESKTOP_FOLLOWER_ENV];
    process.env[DESKTOP_FOLLOWER_ENV] = "1";
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccf-")), "ipc.sock");
    let router: CodexIpcRouterHandle | null = await startCodexIpcRouter(socketPath);
    const ownerRequests: unknown[] = [];
    const owner = await createCodexIpcClient({
      socketPath,
      clientType: "codex-desktop-owner",
      requestHandlers: {
        "thread-follower-start-turn": {
          canHandle: async (params) => params.conversationId === "thread-desktop",
          handle: async (request) => {
            ownerRequests.push(request.params);
            return { turnId: "turn-from-owner", status: "running" };
          }
        }
      }
    });
    try {
      const context = createTestAppContext();
      context.config.codexIpcSocketPath = socketPath;
      context.codex.createSessionRuntime = async () =>
        createRuntime({
          listSessionSummaries: async () => [],
          startTurn: async () => {
            throw new Error("local runtime should not start desktop-owned turns");
          }
        });
      server = await createServer(context);
      await server.ready();
      const { ws } = await openAuthedWs(context, server as TestServer);
      const messages = collectWsMessages(ws);
      await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

      owner.sendBroadcast("thread-stream-state-changed", {
        conversationId: "thread-desktop",
        hostId: "local",
        change: {
          type: "snapshot",
          conversationState: {
            id: "thread-desktop",
            title: "Desktop thread",
            createdAt: 1778600000000,
            updatedAt: 1778600001000,
            cwd: "/Users/me/project",
            threadRuntimeStatus: { type: "idle" },
            turns: []
          }
        }
      });
      await waitForWsMessage(messages, (message) => message.type === "session.updated" && (message.session as Record<string, unknown> | undefined)?.id === "thread-desktop");
      await expect(hasWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-desktop")).resolves.toBe(false);

      sendCommand(ws, { type: "session.sync.enable", requestId: "r-sync-desktop", sessionId: "thread-desktop" });
      await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-desktop");

      sendCommand(ws, { type: "session.sendText", requestId: "r-send-desktop", sessionId: "thread-desktop", clientMessageId: "m-send-desktop", text: "移动端继续" });
      await waitForWsMessage(messages, (message) => message.type === "message.updated" && (message.message as Record<string, unknown> | undefined)?.clientMessageId === "m-send-desktop");
      for (let index = 0; index < 100 && ownerRequests.length === 0; index++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(ownerRequests).toEqual([
        expect.objectContaining({
          conversationId: "thread-desktop",
          turnStartParams: expect.objectContaining({
            input: [{ type: "text", text: "移动端继续", text_elements: [] }]
          })
        })
      ]);
      ws.terminate();
    } finally {
      restoreEnv(DESKTOP_FOLLOWER_ENV, previousFollowerEnv);
      owner.close();
      await router?.stop();
      router = null;
    }
  });

  it("forwards attachments to desktop owner follower IPC as structured input", async () => {
    const previousFollowerEnv = process.env[DESKTOP_FOLLOWER_ENV];
    process.env[DESKTOP_FOLLOWER_ENV] = "1";
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cci-")), "ipc.sock");
    let router: CodexIpcRouterHandle | null = await startCodexIpcRouter(socketPath);
    const ownerRequests: unknown[] = [];
    const owner = await createCodexIpcClient({
      socketPath,
      clientType: "codex-desktop-owner",
      requestHandlers: {
        "thread-follower-start-turn": {
          canHandle: async (params) => params.conversationId === "thread-desktop-image",
          handle: async (request) => {
            ownerRequests.push(request.params);
            return { turnId: "turn-from-owner-image", status: "running" };
          }
        }
      }
    });
    try {
      const context = createTestAppContext();
      context.config.codexIpcSocketPath = socketPath;
      const prepared = context.mediaAssets.prepareMobileUpload({
        sessionId: "thread-desktop-image",
        fileName: "desktop-image.png",
        mimeType: "image/png",
        sizeBytes: PNG_BYTES.length
      });
      const textBytes = Buffer.from("desktop owner file reference", "utf8");
      const preparedFile = context.mediaAssets.prepareMobileUpload({
        sessionId: "thread-desktop-image",
        fileName: "desktop-notes.md",
        mimeType: "text/markdown",
        sizeBytes: textBytes.length
      });
      await context.mediaAssets.storeUploadedContent(prepared.asset.id, PNG_BYTES, PNG_BYTES.length);
      await context.mediaAssets.storeUploadedContent(preparedFile.asset.id, textBytes, textBytes.length);
      const expectedAssets = context.mediaAssets.listCodexAttachmentAssets("thread-desktop-image", [
        prepared.asset.id,
        preparedFile.asset.id
      ]);
      const expectedImagePath = expectedAssets[0].absolutePath;
      const expectedFilePath = expectedAssets[1].absolutePath;
      context.codex.createSessionRuntime = async () =>
        createRuntime({
          listSessionSummaries: async () => [],
          startTurn: async () => {
            throw new Error("local runtime should not start desktop-owned turns");
          }
        });
      server = await createServer(context);
      await server.ready();
      const { ws } = await openAuthedWs(context, server as TestServer);
      const messages = collectWsMessages(ws);
      await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

      owner.sendBroadcast("thread-stream-state-changed", {
        conversationId: "thread-desktop-image",
        hostId: "local",
        change: {
          type: "snapshot",
          conversationState: {
            id: "thread-desktop-image",
            title: "Desktop image thread",
            createdAt: 1778600000000,
            updatedAt: 1778600001000,
            cwd: "/Users/me/project",
            threadRuntimeStatus: { type: "idle" },
            turns: []
          }
        }
      });
      await waitForWsMessage(messages, (message) => message.type === "session.updated" &&
        (message.session as Record<string, unknown> | undefined)?.id === "thread-desktop-image");

      sendCommand(ws, {
        type: "session.sendText",
        requestId: "r-send-desktop-image",
        sessionId: "thread-desktop-image",
        clientMessageId: "m-send-desktop-image",
        text: "移动端看图",
        attachmentIds: [prepared.asset.id, preparedFile.asset.id]
      });
      await waitForWsMessage(messages, (message) => message.type === "message.updated" &&
        (message.message as Record<string, unknown> | undefined)?.clientMessageId === "m-send-desktop-image");
      for (let index = 0; index < 100 && ownerRequests.length === 0; index++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(ownerRequests).toEqual([
        expect.objectContaining({
          conversationId: "thread-desktop-image",
          turnStartParams: expect.objectContaining({
            input: [
              { type: "text", text: "移动端看图", text_elements: [] },
              { type: "localImage", path: expectedImagePath },
              { type: "mention", name: "desktop-notes.md", path: expectedFilePath }
            ]
          })
        })
      ]);
      expect(context.repositories.sessionAttachments.listBySession("thread-desktop-image")).toEqual(expect.arrayContaining([expect.objectContaining({
        assetId: prepared.asset.id,
        codexInputStatus: "sent"
      }), expect.objectContaining({
        assetId: preparedFile.asset.id,
        codexInputStatus: "sent"
      })]));
      ws.terminate();
    } finally {
      restoreEnv(DESKTOP_FOLLOWER_ENV, previousFollowerEnv);
      owner.close();
      await router?.stop();
      router = null;
    }
  });

  it("uses explicit steer-now guidance to steer desktop owner running turns", async () => {
    const previousFollowerEnv = process.env[DESKTOP_FOLLOWER_ENV];
    process.env[DESKTOP_FOLLOWER_ENV] = "1";
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccr-")), "ipc.sock");
    let router: CodexIpcRouterHandle | null = await startCodexIpcRouter(socketPath);
    const ownerRequests: unknown[] = [];
    const owner = await createCodexIpcClient({
      socketPath,
      clientType: "codex-desktop-owner",
      requestHandlers: {
        "thread-follower-steer-turn": {
          canHandle: async (params) => params.conversationId === "thread-running",
          handle: async (request) => {
            ownerRequests.push({ method: request.method, params: request.params });
            return { ok: true };
          }
        }
      }
    });
    try {
      const context = createTestAppContext();
      context.config.codexIpcSocketPath = socketPath;
      context.codex.createSessionRuntime = async () =>
        createRuntime({
          listSessionSummaries: async () => [],
          startTurn: async () => {
            throw new Error("local runtime should not start desktop-owned turns");
          }
        });
      server = await createServer(context);
      await server.ready();
      const { ws } = await openAuthedWs(context, server as TestServer);
      const messages = collectWsMessages(ws);
      await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

      owner.sendBroadcast("thread-stream-state-changed", {
        conversationId: "thread-running",
        hostId: "local",
        change: {
          type: "snapshot",
          conversationState: {
            id: "thread-running",
            title: "Desktop running thread",
            createdAt: 1778600000000,
            updatedAt: 1778600001000,
            cwd: "/Users/me/project",
            threadRuntimeStatus: { type: "active" },
            turns: [{
              turnId: "turn-running",
              turnStartedAtMs: 1778600000000,
              status: "inProgress",
              items: []
            }]
          }
        }
      });
      await waitForWsMessage(messages, (message) => message.type === "session.updated" && (message.session as Record<string, unknown> | undefined)?.id === "thread-running");

      sendCommand(ws, {
        type: "session.sendText",
        requestId: "r-steer-running",
        sessionId: "thread-running",
        clientMessageId: "m-steer-running",
        text: "运行中补充",
        guidance: { mode: "steer-now", selectedCapabilityIds: [] }
      });
      await waitForWsMessage(messages, (message) => message.type === "message.updated" && (message.message as Record<string, unknown> | undefined)?.clientMessageId === "m-steer-running");
      for (let index = 0; index < 100 && ownerRequests.length === 0; index++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(ownerRequests).toEqual([
        {
          method: "thread-follower-steer-turn",
          params: expect.objectContaining({
            conversationId: "thread-running",
            turnId: "turn-running",
            expectedTurnId: "turn-running",
            input: [{ type: "text", text: "运行中补充", text_elements: [] }]
          })
        }
      ]);
      ws.terminate();
    } finally {
      restoreEnv(DESKTOP_FOLLOWER_ENV, previousFollowerEnv);
      owner.close();
      await router?.stop();
      router = null;
    }
  });

  it("keeps desktop follower disabled by default for WebSocket sessions", async () => {
    const previousFollowerEnv = process.env[DESKTOP_FOLLOWER_ENV];
    delete process.env[DESKTOP_FOLLOWER_ENV];
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccd-")), "ipc.sock");
    let router: CodexIpcRouterHandle | null = await startCodexIpcRouter(socketPath);
    const ownerRequests: unknown[] = [];
    const owner = await createCodexIpcClient({
      socketPath,
      clientType: "codex-desktop-owner",
      requestHandlers: {
        "thread-follower-start-turn": {
          canHandle: async (params) => params.conversationId === "thread-desktop",
          handle: async (request) => {
            ownerRequests.push(request.params);
            return { turnId: "turn-from-owner", status: "running" };
          }
        }
      }
    });
    let ws: TestWebSocket | null = null;
    try {
      const context = createTestAppContext();
      const localStarts: unknown[] = [];
      context.config.codexIpcSocketPath = socketPath;
      context.codex.createSessionRuntime = async () =>
        createRuntime({
          listSessionSummaries: async () => [],
          startTurn: async (input) => {
            localStarts.push(input);
            return { turnId: "turn-local", status: "running" };
          }
        });
      server = await createServer(context);
      await server.ready();
      const opened = await openAuthedWs(context, server as TestServer);
      ws = opened.ws;
      const messages = collectWsMessages(ws);
      await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

      owner.sendBroadcast("thread-stream-state-changed", {
        conversationId: "thread-desktop",
        hostId: "local",
        change: {
          type: "snapshot",
          conversationState: {
            id: "thread-desktop",
            title: "Desktop thread",
            createdAt: 1778600000000,
            updatedAt: 1778600001000,
            cwd: "/Users/me/project",
            threadRuntimeStatus: { type: "idle" },
            turns: []
          }
        }
      });

      await expect(hasWsMessage(messages, (message) =>
        message.type === "session.updated" &&
        (message.session as Record<string, unknown> | undefined)?.id === "thread-desktop"
      )).resolves.toBe(false);

      sendCommand(ws, { type: "session.sendText", requestId: "r-send-default", sessionId: "thread-desktop", clientMessageId: "m-send-default", text: "移动端继续" });
      await waitForWsMessage(messages, (message) => message.type === "message.updated" &&
        (message.message as Record<string, unknown> | undefined)?.clientMessageId === "m-send-default");

      expect(localStarts.map((input) => {
        const record = input as { threadId: string; text?: string; inputItems?: CodexTurnInputItem[] };
        return { threadId: record.threadId, text: turnInputText(record) };
      })).toEqual([
        { threadId: "thread-desktop", text: "移动端继续" }
      ]);
      expect(ownerRequests).toEqual([]);
    } finally {
      restoreEnv(DESKTOP_FOLLOWER_ENV, previousFollowerEnv);
      ws?.terminate();
      owner.close();
      await router?.stop();
      router = null;
    }
  });

  it("sends the latest Codex list snapshot without cached sessions missing from the runtime list", async () => {
    const context = createTestAppContext();
    context.sessions.addSession({
      id: "archived-on-mac",
      toolId: "codex-mac",
      title: "runtime-cache-persist-smoke",
      projectPath: null,
      projectName: null,
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      isPinned: false,
      needsUserInput: true,
      waitsForNextDirection: false,
      statusLabel: "waiting",
      lastMessagePreview: ""
    });
    context.sessions.addSession({
      id: "other-tool",
      toolId: "other-mac",
      title: "其他工具缓存",
      projectPath: null,
      projectName: null,
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z",
      isPinned: false,
      needsUserInput: false,
      waitsForNextDirection: false,
      statusLabel: "idle",
      lastMessagePreview: ""
    });
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [{
        id: "still-on-mac",
        toolId: "codex-mac",
        title: "仍在 Codex 列表",
        projectPath: null,
        projectName: null,
        createdAt: "2026-05-10T00:00:00.000Z",
        updatedAt: "2026-05-10T00:01:00.000Z",
        isPinned: false,
        needsUserInput: false,
        waitsForNextDirection: false,
        statusLabel: "idle",
        lastMessagePreview: ""
      }]
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);

    const snapshot = await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    expect((snapshot.sessions as Array<{ id: string }>).map((session) => session.id)).toEqual(["still-on-mac"]);
    expect(context.sessions.list("codex-mac").map((session) => session.id)).toEqual(["still-on-mac"]);
    expect(context.sessions.list("other-mac").map((session) => session.id)).toEqual(["other-tool"]);
    ws.terminate();
  });

  it("records sanitized audit rows for successful WebSocket client commands", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        createSession: async () => ({ threadId: "thread-created", turnId: "turn-created", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-created"),
        startTurn: async () => ({ turnId: "turn-started", status: "running" }),
        steerTurn: async () => ({}),
        interruptTurn: async () => ({}),
        respondToApproval: async () => undefined
      });
    server = await createServer(context);
    await server.ready();
    const { deviceId, authToken, ws } = await openAuthedWs(context, server as TestServer);
    const secretText = "用户输入全文 token=abc Authorization: Bearer hidden codex config";

    sendCommand(ws, { type: "session.create", requestId: "r-create", toolId: "codex-mac", projectPath: null, text: secretText });
    await waitForAuditRows(context, 1);
    sendCommand(ws, { type: "session.read", requestId: "r-read", sessionId: "thread-created" });
    await waitForAuditRows(context, 2);
    sendCommand(ws, { type: "session.sendText", requestId: "r-send", sessionId: "thread-created", clientMessageId: "m-send", text: secretText });
    await waitForAuditRows(context, 3);
    sendCommand(ws, { type: "session.steer", requestId: "r-steer", sessionId: "thread-created", clientMessageId: "m-steer", text: secretText });
    await waitForAuditRows(context, 4);
    sendCommand(ws, { type: "session.interrupt", requestId: "r-interrupt", sessionId: "thread-created" });
    await waitForAuditRows(context, 5);
    sendCommand(ws, { type: "approval.respond", requestId: "r-approval", sessionId: "thread-created", approvalId: "approval-1", actionId: "approve" });
    await waitForAuditRows(context, 6);
    sendCommand(ws, { type: "device.unbind", requestId: "r-unbind" });
    const rows = (await waitForAuditRows(context, 7)).slice().reverse();

    expect(rows.map((row) => ({
      deviceId: row.device_id,
      sessionId: row.session_id,
      actionType: row.action_type,
      result: row.result
    }))).toEqual([
      { deviceId, sessionId: "thread-created", actionType: "session.create", result: "success" },
      { deviceId, sessionId: "thread-created", actionType: "session.read", result: "success" },
      { deviceId, sessionId: "thread-created", actionType: "session.sendText", result: "success" },
      { deviceId, sessionId: "thread-created", actionType: "session.steer", result: "success" },
      { deviceId, sessionId: "thread-created", actionType: "session.interrupt", result: "success" },
      { deviceId, sessionId: "thread-created", actionType: "approval.respond", result: "success" },
      { deviceId, sessionId: null, actionType: "device.unbind", result: "success" }
    ]);
    for (const row of rows) {
      expect(row.detail).not.toContain(secretText);
      expect(row.detail).not.toContain(authToken);
      expect(row.detail).not.toMatch(/authorization|token|codex config/i);
    }
    ws.terminate();
  });

  it("records sanitized audit rows for input queue commands", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () =>
      createRuntime({ listSessionSummaries: async () => [] });
    server = await createServer(context);
    await server.ready();
    const { deviceId, authToken, ws } = await openAuthedWs(context, server as TestServer);
    const secretText = "排队输入全文 token=abc Authorization: Bearer hidden codex config";

    sendCommand(ws, {
      type: "session.inputQueue.enqueue",
      requestId: "queue-audit-enqueue",
      sessionId: "thread-queue-audit",
      clientMessageId: "message-queue-audit",
      text: secretText,
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    await waitForAuditRows(context, 1);
    const queueItemId = context.inputQueue.list("thread-queue-audit")[0]?.id;
    if (!queueItemId) throw new Error("Expected queued item");

    sendCommand(ws, {
      type: "session.inputQueue.cancel",
      requestId: "queue-audit-cancel",
      sessionId: "thread-queue-audit",
      queueItemId
    });
    await waitForAuditRows(context, 2);

    context.inputQueue.markFailed("thread-queue-audit", queueItemId);
    sendCommand(ws, {
      type: "session.inputQueue.retry",
      requestId: "queue-audit-retry",
      sessionId: "thread-queue-audit",
      queueItemId
    });
    const rows = (await waitForAuditRows(context, 4)).slice().reverse();

    expect(rows.map((row) => ({
      deviceId: row.device_id,
      sessionId: row.session_id,
      actionType: row.action_type,
      result: row.result
    }))).toEqual([
      { deviceId, sessionId: "thread-queue-audit", actionType: "session.inputQueue.enqueue", result: "success" },
      { deviceId, sessionId: "thread-queue-audit", actionType: "session.inputQueue.cancel", result: "success" },
      { deviceId, sessionId: "thread-queue-audit", actionType: "session.inputQueue.retry", result: "success" },
      { deviceId: null, sessionId: "thread-queue-audit", actionType: "session.inputQueue.autoSend", result: "success" }
    ]);
    for (const row of rows) {
      expect(row.detail).not.toContain(secretText);
      expect(row.detail).not.toContain(authToken);
      expect(row.detail).not.toMatch(/authorization|token|codex config/i);
    }
    ws.terminate();
  });

  it("rejects commands from an already open socket after its device is revoked", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-revoked")
      });
    server = await createServer(context);
    await server.ready();
    const { deviceId, ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    context.pairing.revokeDevice(deviceId);
    sendCommand(ws, { type: "session.read", requestId: "read-after-revoke", sessionId: "thread-revoked" });

    const failure = await waitForWsMessage(messages, (message) =>
      message.type === "command.failed" && message.requestId === "read-after-revoke"
    );
    const rows = context.audit.list(50) as AuditRow[];
    expect(failure.errorCode).toBe("AUTH_INVALID");
    expect(rows.some((row) => row.action_type === "session.read")).toBe(false);
    ws.terminate();
  });

  it("coalesces repeated detail reads for the same session across active mobile devices", async () => {
    const context = createTestAppContext();
    let detailReadCount = 0;
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          detailReadCount++;
          return sessionDetail("thread-shared-detail");
        }
      });
    server = await createServer(context);
    await server.ready();
    const first = await openAuthedWs(context, server as TestServer, "Mate 60 Pro");
    const second = await openAuthedWs(context, server as TestServer, "MatePad Pro");
    const firstMessages = collectWsMessages(first.ws);
    const secondMessages = collectWsMessages(second.ws);
    await waitForWsMessage(firstMessages, (message) => message.type === "sessions.snapshot");
    await waitForWsMessage(secondMessages, (message) => message.type === "sessions.snapshot");

    sendCommand(first.ws, { type: "session.sync.enable", requestId: "sync-first-shared", sessionId: "thread-shared-detail" });
    sendCommand(second.ws, { type: "session.sync.enable", requestId: "sync-second-shared", sessionId: "thread-shared-detail" });

    await waitForWsMessage(firstMessages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-shared-detail");
    await waitForWsMessage(secondMessages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-shared-detail");
    expect(detailReadCount).toBe(1);
    first.ws.terminate();
    second.ws.terminate();
  });

  it("reuses a recent detail snapshot for repeated reads from one active mobile device", async () => {
    const context = createTestAppContext();
    let detailReadCount = 0;
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          detailReadCount++;
          return sessionDetail("thread-cached-detail");
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-cached-detail", sessionId: "thread-cached-detail" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-cached-detail");
    expect(detailReadCount).toBe(1);

    const messageStartIndex = messages.length;
    sendCommand(ws, { type: "session.read", requestId: "read-cached-detail", sessionId: "thread-cached-detail" });
    expect(await hasNewWsMessage(messages, messageStartIndex, (message) =>
      message.type === "thread.detail.snapshot" && message.sessionId === "thread-cached-detail"
    )).toBe(true);
    expect(detailReadCount).toBe(1);
    ws.terminate();
  });

  it("retries a fresh thread detail read while the Codex thread is not loaded yet", async () => {
    const context = createTestAppContext();
    let detailReadCount = 0;
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          detailReadCount++;
          if (detailReadCount === 1) {
            throw new Error("thread not loaded: thread-fresh-created");
          }
          return sessionDetail("thread-fresh-created");
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-fresh-created", sessionId: "thread-fresh-created" });
    await waitForWsMessage(messages, (message) =>
      message.type === "thread.detail.snapshot" && message.sessionId === "thread-fresh-created");

    expect(detailReadCount).toBe(2);
    expect(await hasWsMessage(messages, (message) =>
      message.type === "command.failed" && message.requestId === "sync-fresh-created"
    )).toBe(false);
    ws.terminate();
  });

  it("broadcasts input queue updates to other synced subscribers", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-queue-broadcast")
      });
    server = await createServer(context);
    await server.ready();
    const first = await openAuthedWs(context, server as TestServer);
    const second = await server.injectWS("/ws", { headers: { authorization: `Bearer ${first.authToken}` } });
    const firstMessages = collectWsMessages(first.ws);
    const secondMessages = collectWsMessages(second);
    await waitForWsMessage(firstMessages, (message) => message.type === "sessions.snapshot");
    await waitForWsMessage(secondMessages, (message) => message.type === "sessions.snapshot");

    sendCommand(first.ws, { type: "session.sync.enable", requestId: "sync-first", sessionId: "thread-queue-broadcast" });
    sendCommand(second, { type: "session.sync.enable", requestId: "sync-second", sessionId: "thread-queue-broadcast" });
    await waitForWsMessage(firstMessages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-queue-broadcast");
    await waitForWsMessage(secondMessages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-queue-broadcast");

    sendCommand(first.ws, {
      type: "session.inputQueue.enqueue",
      requestId: "queue-broadcast",
      sessionId: "thread-queue-broadcast",
      clientMessageId: "message-queue-broadcast",
      text: "同步到另一台设备",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });

    await waitForWsMessage(secondMessages, (message) => message.type === "session.inputQueue.updated" &&
      message.sessionId === "thread-queue-broadcast" &&
      Array.isArray(message.items) &&
      (message.items[0] as Record<string, unknown> | undefined)?.textPreview === "同步到另一台设备");
    first.ws.terminate();
    second.terminate();
  });

  it("broadcasts input queue cancellation from a non-detail connection to synced subscribers", async () => {
    const context = createTestAppContext();
    const queued = context.inputQueue.enqueue({
      sessionId: "thread-queue-cancel-broadcast",
      clientMessageId: "message-queue-cancel-broadcast",
      text: "应被另一条连接取消",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          const detail = sessionDetail("thread-queue-cancel-broadcast");
          detail.turns = [{
            id: "turn-queue-cancel-broadcast",
            sessionId: "thread-queue-cancel-broadcast",
            status: "running",
            startedAt: "2026-05-23T12:00:00.000Z",
            completedAt: null,
            items: []
          }];
          return detail;
        }
      });
    server = await createServer(context);
    await server.ready();
    const synced = await openAuthedWs(context, server as TestServer);
    const nonDetail = await openAuthedWs(context, server as TestServer, "Queue cleanup connection");
    const syncedMessages = collectWsMessages(synced.ws);
    const nonDetailMessages = collectWsMessages(nonDetail.ws);
    await waitForWsMessage(syncedMessages, (message) => message.type === "sessions.snapshot");
    await waitForWsMessage(nonDetailMessages, (message) => message.type === "sessions.snapshot");

    sendCommand(synced.ws, { type: "session.sync.enable", requestId: "sync-cancel-broadcast", sessionId: "thread-queue-cancel-broadcast" });
    await waitForWsMessage(syncedMessages, (message) => message.type === "thread.detail.snapshot" &&
      message.sessionId === "thread-queue-cancel-broadcast");

    sendCommand(nonDetail.ws, {
      type: "session.inputQueue.cancel",
      requestId: "cancel-from-non-detail",
      sessionId: "thread-queue-cancel-broadcast",
      queueItemId: queued.id
    });

    await waitForWsMessage(syncedMessages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-queue-cancel-broadcast" &&
        Array.isArray(items) &&
        items[0]?.id === queued.id &&
        items[0]?.status === "cancelled";
    });
    synced.ws.terminate();
    nonDetail.ws.terminate();
  });

  it("sends existing input queue snapshot when a session is synced", async () => {
    const context = createTestAppContext();
    context.inputQueue.enqueue({
      sessionId: "thread-existing-queue",
      clientMessageId: "message-existing-queue",
      text: "已经存在的队列项",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-existing-queue")
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-existing-queue", sessionId: "thread-existing-queue" });

    await waitForWsMessage(messages, (message) => message.type === "session.inputQueue.updated" &&
      message.sessionId === "thread-existing-queue" &&
      Array.isArray(message.items) &&
      (message.items[0] as Record<string, unknown> | undefined)?.textPreview === "已经存在的队列项");
    ws.terminate();
  });

  it("restores the active turn from synced detail without the desktop follower", async () => {
    const context = createTestAppContext();
    const startedTexts: string[] = [];
    const steeredTurns: string[] = [];
    const detail = sessionDetail("thread-running-from-detail");
    detail.turns = [{
      id: "turn-from-detail",
      sessionId: "thread-running-from-detail",
      status: "running",
      startedAt: "2026-05-13T00:00:00.000Z",
      completedAt: null,
      items: []
    }];
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => detail,
        startTurn: async (input) => {
          startedTexts.push(turnInputText(input));
          return { turnId: "unexpected-start", status: "running" };
        },
        steerTurn: async (input) => {
          steeredTurns.push(`${input.turnId}:${turnInputText(input)}`);
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-running-from-detail", sessionId: "thread-running-from-detail" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-running-from-detail");
    sendCommand(ws, { type: "session.steer", requestId: "steer-running-from-detail", sessionId: "thread-running-from-detail", clientMessageId: "steer-running-from-detail", text: "继续当前 turn" });

    await waitForWsMessage(messages, (message) => message.type === "message.updated" &&
      (message.message as Record<string, unknown> | undefined)?.clientMessageId === "steer-running-from-detail");
    expect(steeredTurns).toEqual(["turn-from-detail:继续当前 turn"]);
    expect(startedTexts).toEqual([]);
    ws.terminate();
  });

  it("acknowledges steer input as guided instead of received", async () => {
    const context = createTestAppContext();
    const detail = sessionDetail("thread-guided-steer");
    detail.turns = [{
      id: "turn-guided-steer",
      sessionId: "thread-guided-steer",
      status: "running",
      startedAt: "2026-05-14T00:00:00.000Z",
      completedAt: null,
      items: []
    }];
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => detail,
        steerTurn: async () => ({})
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-guided-steer", sessionId: "thread-guided-steer" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-guided-steer");
    sendCommand(ws, { type: "session.steer", requestId: "steer-guided-steer", sessionId: "thread-guided-steer", clientMessageId: "steer-guided-steer", text: "把当前轮按这个方向继续" });

    const ack = await waitForWsMessage(messages, (message) => message.type === "message.updated" &&
      (message.message as Record<string, unknown> | undefined)?.clientMessageId === "steer-guided-steer");
    expect((ack.message as Record<string, unknown>).sendState).toBe("guided");
    ws.terminate();
  });

  it("keeps the Codex runtime alive across mobile WebSocket reconnects", async () => {
    const context = createTestAppContext();
    let runtimeStarts = 0;
    let runtimeStops = 0;
    context.codex.createSessionRuntime = async () => {
      runtimeStarts++;
      const runtime = createRuntime({ listSessionSummaries: async () => [] });
      runtime.stop = async () => {
        runtimeStops++;
      };
      return runtime;
    };
    server = await createServer(context);
    await server.ready();

    const first = await openAuthedWs(context, server as TestServer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await server.injectWS("/ws", { headers: { authorization: `Bearer ${first.authToken}` } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runtimeStarts).toBe(1);
    expect(runtimeStops).toBe(0);
    second.terminate();
  });

  it("pushes a final detail snapshot for synced sessions after detail sync is disabled", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    let readCount = 0;
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          readCount++;
          const detail = sessionDetail("thread-final");
          detail.messages = readCount > 1
            ? [{
              id: "assistant-final",
              sessionId: "thread-final",
              role: "assistant",
              text: "最终结果",
              rawText: "最终结果",
              createdAt: "2026-05-13T00:00:05.000Z",
              sendState: null,
              clientMessageId: null,
              canWithdraw: false
            }]
            : [];
          detail.turns = readCount > 1
            ? [{
              id: "turn-final",
              sessionId: "thread-final",
              status: "completed",
              startedAt: "2026-05-13T00:00:00.000Z",
              completedAt: "2026-05-13T00:00:05.000Z",
              items: []
            }]
            : [];
          return detail;
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "r-sync-final", sessionId: "thread-final" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-final");
    sendCommand(ws, { type: "session.sync.disable", requestId: "r-disable-final", sessionId: "thread-final" });
    await waitForAuditRows(context, 2);

    const afterDisableIndex = messages.length;
    notificationHandlers.get("item/agentMessage/delta")?.({
      threadId: "thread-final",
      turnId: "turn-final",
      itemId: "assistant-live",
      delta: "过程片段"
    });
    await expect(hasNewWsMessage(messages, afterDisableIndex, (message) => message.type === "message.updated")).resolves.toBe(false);

    notificationHandlers.get("turn/completed")?.({
      threadId: "thread-final",
      turnId: "turn-final",
      completedAt: "2026-05-13T00:00:05.000Z"
    });

    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" &&
      message.sessionId === "thread-final" &&
      Array.isArray(message.turns) &&
      (message.turns[0] as Record<string, unknown> | undefined)?.status === "completed");
    await waitForWsMessage(messages, (message) => message.type === "messages.snapshot" &&
      message.sessionId === "thread-final" &&
      Array.isArray(message.messages) &&
      (message.messages[0] as Record<string, unknown> | undefined)?.text === "最终结果");
    expect(readCount).toBe(2);
    ws.terminate();
  });

  it("omits per-file patches from detail snapshots sent over websocket", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [],
      readSessionDetail: async () => {
        const detail = sessionDetail("thread-diff-snapshot");
        detail.turns = [{
          id: "turn-diff",
          sessionId: "thread-diff-snapshot",
          status: "completed",
          startedAt: "2026-05-13T00:00:00.000Z",
          completedAt: "2026-05-13T00:00:05.000Z",
          items: [{
            id: "diff-item",
            sessionId: "thread-diff-snapshot",
            turnId: "turn-diff",
            kind: "fileChange",
            status: "completed",
            title: "文件修改",
            text: "文件变更已更新",
            rawText: "",
            createdAt: "2026-05-13T00:00:01.000Z",
            updatedAt: "2026-05-13T00:00:02.000Z",
            isStreaming: false,
            isCollapsedByDefault: true,
            command: null,
            diff: {
              filesChanged: 1,
              insertions: 1,
              deletions: 1,
              files: [{
                path: "README.md",
                status: "modified",
                insertions: 1,
                deletions: 1,
                patch: "@@ -1 +1 @@\n-old\n+new"
              }]
            },
            approval: null,
            planSteps: []
          }]
        }];
        return detail;
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "r-sync-diff", sessionId: "thread-diff-snapshot" });

    const snapshot = await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" &&
      message.sessionId === "thread-diff-snapshot");
    const turns = snapshot.turns as Record<string, unknown>[];
    const items = turns[0]?.items as Record<string, unknown>[];
    const diff = items[0]?.diff as Record<string, unknown>;
    const files = diff.files as Record<string, unknown>[];
    expect(files[0]?.patch).toBe("");
    ws.terminate();
  });

  it("sends a null approval snapshot when detail has no pending approval", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [],
      readSessionDetail: async () => sessionDetail("thread-no-approval")
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "r-sync-no-approval", sessionId: "thread-no-approval" });

    const event = await waitForWsMessage(messages, (message) => message.type === "approval.updated" &&
      message.sessionId === "thread-no-approval");
    expect(event).toMatchObject({ type: "approval.updated", sessionId: "thread-no-approval", approval: null });
    ws.terminate();
  });

  it("keeps per-file patches for final git anchors and the latest reviewable completed snapshot", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () => createRuntime({
      listSessionSummaries: async () => [],
      readSessionDetail: async () => {
        const detail = sessionDetail("thread-diff-final-snapshot");
        detail.turns = [{
          id: "turn-old-progress",
          sessionId: "thread-diff-final-snapshot",
          status: "completed",
          startedAt: "2026-05-13T00:00:00.000Z",
          completedAt: "2026-05-13T00:00:05.000Z",
          items: [{
            id: "diff-old-progress",
            sessionId: "thread-diff-final-snapshot",
            turnId: "turn-old-progress",
            kind: "fileChange",
            status: "completed",
            title: "文件修改",
            text: "文件变更已更新",
            rawText: "",
            createdAt: "2026-05-13T00:00:01.000Z",
            updatedAt: "2026-05-13T00:00:02.000Z",
            isStreaming: false,
            isCollapsedByDefault: true,
            command: null,
            diff: {
              filesChanged: 1,
              insertions: 1,
              deletions: 1,
              files: [{
                path: "OldProgress.ets",
                status: "modified",
                insertions: 1,
                deletions: 1,
                patch: "@@ -1 +1 @@\n-old\n+old-progress"
              }]
            },
            approval: null,
            planSteps: []
          }, {
            id: "agent-old-progress",
            sessionId: "thread-diff-final-snapshot",
            turnId: "turn-old-progress",
            kind: "agentMessage",
            status: "completed",
            title: "",
            text: "继续处理旧轮次。",
            rawText: "继续处理旧轮次。",
            createdAt: "2026-05-13T00:00:05.000Z",
            updatedAt: "2026-05-13T00:00:05.000Z",
            isStreaming: false,
            isCollapsedByDefault: false,
            command: null,
            diff: null,
            approval: null,
            planSteps: []
          }]
        }, {
          id: "turn-diff",
          sessionId: "thread-diff-final-snapshot",
          status: "completed",
          startedAt: "2026-05-13T00:01:00.000Z",
          completedAt: "2026-05-13T00:01:05.000Z",
          items: [{
            id: "diff-item",
            sessionId: "thread-diff-final-snapshot",
            turnId: "turn-diff",
            kind: "fileChange",
            status: "completed",
            title: "文件修改",
            text: "文件变更已更新",
            rawText: "",
            createdAt: "2026-05-13T00:01:01.000Z",
            updatedAt: "2026-05-13T00:01:02.000Z",
            isStreaming: false,
            isCollapsedByDefault: true,
            command: null,
            diff: {
              filesChanged: 1,
              insertions: 1,
              deletions: 1,
              files: [{
                path: "README.md",
                status: "modified",
                insertions: 1,
                deletions: 1,
                patch: "@@ -1 +1 @@\n-old\n+new"
              }]
            },
            approval: null,
            planSteps: []
          }, {
            id: "agent-final",
            sessionId: "thread-diff-final-snapshot",
            turnId: "turn-diff",
            kind: "agentMessage",
            status: "completed",
            title: "",
            text: "完成\n::git-commit{cwd=\"/Users/liuyongzhe/DevEcoStudioProjects/Code\"}",
            rawText: "完成\n::git-commit{cwd=\"/Users/liuyongzhe/DevEcoStudioProjects/Code\"}",
            createdAt: "2026-05-13T00:01:05.000Z",
            updatedAt: "2026-05-13T00:01:05.000Z",
            isStreaming: false,
            isCollapsedByDefault: false,
            command: null,
            diff: null,
            approval: null,
            planSteps: []
          }]
        }, {
          id: "turn-progress",
          sessionId: "thread-diff-final-snapshot",
          status: "completed",
          startedAt: "2026-05-13T00:02:00.000Z",
          completedAt: "2026-05-13T00:02:05.000Z",
          items: [{
            id: "diff-progress",
            sessionId: "thread-diff-final-snapshot",
            turnId: "turn-progress",
            kind: "fileChange",
            status: "completed",
            title: "文件修改",
            text: "文件变更已更新",
            rawText: "",
            createdAt: "2026-05-13T00:02:01.000Z",
            updatedAt: "2026-05-13T00:02:02.000Z",
            isStreaming: false,
            isCollapsedByDefault: true,
            command: null,
            diff: {
              filesChanged: 1,
              insertions: 1,
              deletions: 1,
              files: [{
                path: "Index.ets",
                status: "modified",
                insertions: 1,
                deletions: 1,
                patch: "@@ -1 +1 @@\n-old\n+progress"
              }]
            },
            approval: null,
            planSteps: []
          }, {
            id: "agent-progress",
            sessionId: "thread-diff-final-snapshot",
            turnId: "turn-progress",
            kind: "agentMessage",
            status: "completed",
            title: "",
            text: "继续处理。",
            rawText: "继续处理。",
            createdAt: "2026-05-13T00:02:05.000Z",
            updatedAt: "2026-05-13T00:02:05.000Z",
            isStreaming: false,
            isCollapsedByDefault: false,
            command: null,
            diff: null,
            approval: null,
            planSteps: []
          }]
        }];
        return detail;
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "r-sync-final-diff", sessionId: "thread-diff-final-snapshot" });

    const snapshot = await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" &&
      message.sessionId === "thread-diff-final-snapshot");
    const turns = snapshot.turns as Record<string, unknown>[];
    const oldItems = turns[0]?.items as Record<string, unknown>[];
    const oldDiff = oldItems[0]?.diff as Record<string, unknown>;
    const oldFiles = oldDiff.files as Record<string, unknown>[];
    expect(oldFiles[0]?.patch).toBe("");
    const items = turns[1]?.items as Record<string, unknown>[];
    const diff = items[0]?.diff as Record<string, unknown>;
    const files = diff.files as Record<string, unknown>[];
    expect(files[0]?.patch).toContain("+new");
    const progressItems = turns[2]?.items as Record<string, unknown>[];
    const progressDiff = progressItems[0]?.diff as Record<string, unknown>;
    const progressFiles = progressDiff.files as Record<string, unknown>[];
    expect(progressFiles[0]?.patch).toContain("+progress");
    ws.terminate();
  });

  it("auto-starts only the next queued input after a terminal turn", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const startedTexts: string[] = [];
    const startedClientIds: string[] = [];
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-auto-queue"),
        startTurn: async (input) => {
          startedTexts.push(turnInputText(input));
          startedClientIds.push(input.clientUserMessageId ?? "");
          return { turnId: `turn-auto-${startedTexts.length}`, status: "running" };
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-auto-queue", sessionId: "thread-auto-queue" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-auto-queue");

    sendCommand(ws, {
      type: "session.inputQueue.enqueue",
      requestId: "queue-auto-1",
      sessionId: "thread-auto-queue",
      clientMessageId: "message-auto-1",
      text: "第一条排队输入",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    await waitForWsMessage(messages, (message) => message.type === "session.inputQueue.updated" &&
      message.sessionId === "thread-auto-queue" &&
      Array.isArray(message.items) &&
      message.items.length === 1);

    sendCommand(ws, {
      type: "session.inputQueue.enqueue",
      requestId: "queue-auto-2",
      sessionId: "thread-auto-queue",
      clientMessageId: "message-auto-2",
      text: "第二条排队输入",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    await waitForWsMessage(messages, (message) => message.type === "session.inputQueue.updated" &&
      message.sessionId === "thread-auto-queue" &&
      Array.isArray(message.items) &&
      message.items.length === 2);

    notificationHandlers.get("turn/completed")?.({
      threadId: "thread-auto-queue",
      turnId: "turn-current",
      completedAt: "2026-05-13T00:00:05.000Z"
    });

    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-auto-queue" &&
        Array.isArray(items) &&
        items.length === 2 &&
        items[0]?.status === "sending" &&
        items[1]?.status === "queued" &&
        items[0]?.text === "第一条排队输入";
    });
    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-auto-queue" &&
        Array.isArray(items) &&
        items.length === 2 &&
        items[0]?.status === "sent" &&
        items[1]?.status === "queued";
    });
    await waitForWsMessage(messages, (message) => message.type === "turn.status.updated" &&
      message.sessionId === "thread-auto-queue" &&
      message.turnId === "turn-auto-1" &&
      message.status === "running");
    expect(startedTexts).toEqual(["第一条排队输入"]);
    expect(startedClientIds).toEqual(["message-auto-1"]);
    const auditRows = context.audit.list(20) as AuditRow[];
    expect(auditRows.some((row) => row.session_id === "thread-auto-queue" &&
      row.action_type === "session.inputQueue.autoSend" &&
      row.result === "success" &&
      row.detail.indexOf("第一条排队输入") < 0)).toBe(true);
    ws.terminate();
  });

  it("auto-starts queued input after a synced read confirms a stale active turn is idle", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const startedTexts: string[] = [];
    const idleDetail = sessionDetail("thread-stale-queue-drain");
    idleDetail.session.statusLabel = "idle";
    idleDetail.session.waitsForNextDirection = true;
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => idleDetail,
        startTurn: async (input) => {
          startedTexts.push(turnInputText(input));
          return { turnId: "turn-drained-after-idle-read", status: "running" };
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-stale-queue-drain", sessionId: "thread-stale-queue-drain" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" &&
      message.sessionId === "thread-stale-queue-drain");

    notificationHandlers.get("turn/started")?.({
      threadId: "thread-stale-queue-drain",
      turn: { id: "turn-stale-queue-drain", status: "inProgress" }
    });
    await waitForWsMessage(messages, (message) => message.type === "turn.updated" &&
      (message.turn as Record<string, unknown> | undefined)?.id === "turn-stale-queue-drain");

    sendCommand(ws, {
      type: "session.inputQueue.enqueue",
      requestId: "queue-stale-queue-drain",
      sessionId: "thread-stale-queue-drain",
      clientMessageId: "message-stale-queue-drain",
      text: "空闲后应自动进入下一轮",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-stale-queue-drain" &&
        Array.isArray(items) &&
        items[0]?.status === "queued";
    });
    expect(startedTexts).toEqual([]);

    sendCommand(ws, { type: "session.read", requestId: "read-stale-queue-drain", sessionId: "thread-stale-queue-drain" });
    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-stale-queue-drain" &&
        Array.isArray(items) &&
        items[0]?.status === "sent";
    });
    expect(startedTexts).toEqual(["空闲后应自动进入下一轮"]);
    ws.terminate();
  });

  it("auto-starts queued input even when final detail refresh fails", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const startedTexts: string[] = [];
    let readCount = 0;
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          readCount++;
          if (readCount > 1) {
            throw new Error("final snapshot failed");
          }
          return sessionDetail("thread-auto-after-read-fail");
        },
        startTurn: async (input) => {
          startedTexts.push(turnInputText(input));
          return { turnId: "turn-auto-after-read-fail", status: "running" };
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-read-fail", sessionId: "thread-auto-after-read-fail" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-auto-after-read-fail");
    sendCommand(ws, {
      type: "session.inputQueue.enqueue",
      requestId: "queue-read-fail",
      sessionId: "thread-auto-after-read-fail",
      clientMessageId: "message-read-fail",
      text: "快照失败也要发送",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    await waitForWsMessage(messages, (message) => message.type === "session.inputQueue.updated" &&
      message.sessionId === "thread-auto-after-read-fail" &&
      Array.isArray(message.items) &&
      message.items.length === 1);

    notificationHandlers.get("turn/completed")?.({
      threadId: "thread-auto-after-read-fail",
      turnId: "turn-current",
      completedAt: "2026-05-13T00:00:05.000Z"
    });

    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-auto-after-read-fail" &&
        Array.isArray(items) &&
        items[0]?.status === "sent";
    });
    expect(startedTexts).toEqual(["快照失败也要发送"]);
    ws.terminate();
  });

  it("requests mobile interrupt without starting queued input before terminal event", async () => {
    const context = createTestAppContext();
    const interruptedTurns: string[] = [];
    const startedTexts: string[] = [];
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        createSession: async () => ({ threadId: "thread-interrupt-queue", turnId: "turn-current", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-interrupt-queue"),
        interruptTurn: async (input) => {
          interruptedTurns.push(`${input.threadId}:${input.turnId}`);
          return {};
        },
        startTurn: async (input) => {
          startedTexts.push(turnInputText(input));
          return { turnId: "turn-after-interrupt", status: "running" };
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.create",
      requestId: "r-create-interrupt-queue",
      toolId: "codex-mac",
      projectPath: null,
      text: "启动一条长任务"
    });
    await waitForWsMessage(messages, (message) => message.type === "turn.status.updated" &&
      message.sessionId === "thread-interrupt-queue" &&
      message.turnId === "turn-current" &&
      message.status === "running");

    sendCommand(ws, {
      type: "session.inputQueue.enqueue",
      requestId: "queue-after-interrupt",
      sessionId: "thread-interrupt-queue",
      clientMessageId: "message-after-interrupt",
      text: "终止后继续这一条",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    await waitForWsMessage(messages, (message) => message.type === "session.inputQueue.updated" &&
      message.sessionId === "thread-interrupt-queue" &&
      Array.isArray(message.items) &&
      (message.items[0] as Record<string, unknown> | undefined)?.status === "queued");

    sendCommand(ws, { type: "session.interrupt", requestId: "r-interrupt-queue", sessionId: "thread-interrupt-queue" });
    await waitForCondition(() => interruptedTurns.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(interruptedTurns).toEqual(["thread-interrupt-queue:turn-current"]);
    expect(startedTexts).toEqual([]);
    ws.terminate();
  });

  it("does not auto-start queued input until Codex emits interrupted turn completed after interrupt", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const interruptedTurns: string[] = [];
    const startedTexts: string[] = [];
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        createSession: async () => ({ threadId: "thread-authoritative-interrupt", turnId: "turn-current", status: "running" }),
        readSessionDetail: async () => sessionDetail("thread-authoritative-interrupt"),
        interruptTurn: async (input) => {
          interruptedTurns.push(`${input.threadId}:${input.turnId}`);
          return {};
        },
        startTurn: async (input) => {
          startedTexts.push(turnInputText(input));
          return { turnId: "turn-after-authoritative-interrupt", status: "running" };
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.create",
      requestId: "r-create-authoritative-interrupt",
      toolId: "codex-mac",
      projectPath: null,
      text: "启动一条长任务"
    });
    await waitForWsMessage(messages, (message) => message.type === "turn.status.updated" &&
      message.sessionId === "thread-authoritative-interrupt" &&
      message.turnId === "turn-current" &&
      message.status === "running");

    sendCommand(ws, {
      type: "session.inputQueue.enqueue",
      requestId: "queue-authoritative-interrupt",
      sessionId: "thread-authoritative-interrupt",
      clientMessageId: "message-authoritative-interrupt",
      text: "等真正中断后继续",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    await waitForWsMessage(messages, (message) => message.type === "session.inputQueue.updated" &&
      message.sessionId === "thread-authoritative-interrupt" &&
      Array.isArray(message.items) &&
      (message.items[0] as Record<string, unknown> | undefined)?.status === "queued");

    const beforeInterruptMessages = messages.length;
    sendCommand(ws, { type: "session.interrupt", requestId: "r-authoritative-interrupt", sessionId: "thread-authoritative-interrupt" });
    await waitForCondition(() => interruptedTurns.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(startedTexts).toEqual([]);
    expect(await hasNewWsMessage(messages, beforeInterruptMessages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-authoritative-interrupt" &&
        Array.isArray(items) &&
        items[0]?.status === "sent";
    })).toBe(false);

    notificationHandlers.get("turn/completed")?.({
      threadId: "thread-authoritative-interrupt",
      turn: { id: "turn-current", status: "interrupted" },
      completedAt: "2026-05-21T09:10:05.000Z"
    });

    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-authoritative-interrupt" &&
        Array.isArray(items) &&
        items[0]?.status === "sent";
    });
    expect(interruptedTurns).toEqual(["thread-authoritative-interrupt:turn-current"]);
    expect(startedTexts).toEqual(["等真正中断后继续"]);
    ws.terminate();
  });

  it("starts a failed queued item immediately when retried while idle", async () => {
    const context = createTestAppContext();
    const startedTexts: string[] = [];
    const item = context.inputQueue.enqueue({
      sessionId: "thread-retry-idle",
      clientMessageId: "message-retry-idle",
      text: "失败后立即重试",
      guidance: { mode: "queued", selectedCapabilityIds: [] }
    });
    context.inputQueue.markSending("thread-retry-idle", item.id);
    context.inputQueue.markFailed("thread-retry-idle", item.id);
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-retry-idle"),
        startTurn: async (input) => {
          startedTexts.push(turnInputText(input));
          return { turnId: "turn-retry-idle", status: "running" };
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-retry-idle", sessionId: "thread-retry-idle" });
    await waitForWsMessage(messages, (message) => message.type === "session.inputQueue.updated" &&
      message.sessionId === "thread-retry-idle" &&
      Array.isArray(message.items) &&
      (message.items[0] as Record<string, unknown> | undefined)?.status === "failed");

    sendCommand(ws, {
      type: "session.inputQueue.retry",
      requestId: "retry-idle",
      sessionId: "thread-retry-idle",
      queueItemId: item.id
    });

    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-retry-idle" &&
        Array.isArray(items) &&
        items[0]?.status === "sent";
    });
    expect(startedTexts).toEqual(["失败后立即重试"]);
    ws.terminate();
  });

  it("refreshes a synced session snapshot without opening live detail streaming", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    let readCount = 0;
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          readCount++;
          return sessionDetail("thread-snapshot-only");
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "r-snapshot-only",
      sessionId: "thread-snapshot-only",
      activeDetail: false
    });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-snapshot-only");
    const afterSnapshotIndex = messages.length;

    notificationHandlers.get("item/agentMessage/delta")?.({
      threadId: "thread-snapshot-only",
      turnId: "turn-snapshot-only",
      itemId: "assistant-live",
      delta: "不应实时推送"
    });

    await expect(hasNewWsMessage(messages, afterSnapshotIndex, (message) => message.type === "message.updated")).resolves.toBe(false);
    expect(readCount).toBe(1);
    ws.terminate();
  });

  it("pushes approval requests to synced sessions even when live detail streaming is inactive", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const serverRequestHandlers = new Map<CodexServerRequestMethod, (request: { id: string; method: CodexServerRequestMethod; params: Record<string, unknown> }) => void>();
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-synced-approval")
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: (method: CodexServerRequestMethod, handler: (request: { id: string; method: CodexServerRequestMethod; params: Record<string, unknown> }) => void) => {
          serverRequestHandlers.set(method, handler);
        },
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "r-sync-approval-snapshot",
      sessionId: "thread-synced-approval",
      activeDetail: false
    });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" &&
      message.sessionId === "thread-synced-approval");

    serverRequestHandlers.get("item/commandExecution/requestApproval")?.({
      id: "approval-synced",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-synced-approval",
        command: "touch /tmp/mobile-approval-probe"
      }
    });

    const event = await waitForWsMessage(messages, (message) => message.type === "approval.updated" &&
      message.sessionId === "thread-synced-approval" &&
      message.approval !== null);
    expect(event.approval).toMatchObject({
      id: "approval-synced",
      body: "$ touch /tmp/mobile-approval-probe"
    });
    const pendingSession = await waitForWsMessage(messages, (message) => message.type === "session.updated" &&
      asRecord(message.session).id === "thread-synced-approval" &&
      asRecord(message.session).needsUserInput === true);
    expect(pendingSession.session).toMatchObject({
      id: "thread-synced-approval",
      needsUserInput: true,
      waitsForNextDirection: false,
      statusLabel: "waiting_for_approval"
    });

    notificationHandlers.get("serverRequest/resolved")?.({
      serverRequest: { id: "approval-synced" }
    });
    await waitForWsMessage(messages, (message) => message.type === "approval.updated" &&
      message.sessionId === "thread-synced-approval" &&
      message.approval === null);
    const clearedSession = await waitForWsMessage(messages, (message) => message.type === "session.updated" &&
      asRecord(message.session).id === "thread-synced-approval" &&
      asRecord(message.session).needsUserInput === false &&
      asRecord(message.session).statusLabel === "running");
    expect(clearedSession.session).toMatchObject({
      id: "thread-synced-approval",
      needsUserInput: false,
      waitsForNextDirection: false
    });
    ws.terminate();
  });

  it("keeps sync enable ordered before send text so early Codex deltas are delivered", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return sessionDetail("thread-live-order");
        },
        startTurn: async () => {
          notificationHandlers.get("turn/started")?.({
            threadId: "thread-live-order",
            turn: { id: "turn-live-order", status: "inProgress" }
          });
          notificationHandlers.get("item/agentMessage/delta")?.({
            threadId: "thread-live-order",
            turnId: "turn-live-order",
            itemId: "assistant-live-order",
            delta: "已收到移动端消息"
          });
          return { turnId: "turn-live-order", status: "running" };
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "r-sync-live-order",
      sessionId: "thread-live-order",
      activeDetail: true
    });
    sendCommand(ws, {
      type: "session.sendText",
      requestId: "r-send-live-order",
      sessionId: "thread-live-order",
      clientMessageId: "m-send-live-order",
      text: "移动端继续"
    });

    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-live-order");
    await waitForWsMessage(messages, (message) => {
      const item = message.item as Record<string, unknown> | undefined;
      return message.type === "timeline.item.updated" &&
        item?.sessionId === "thread-live-order" &&
        item?.text === "已收到移动端消息";
    });
    ws.terminate();
  });

  it("uses the mobile-provided turn id when interrupting a session", async () => {
    const context = createTestAppContext();
    const interruptedTurns: string[] = [];
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          throw new Error("readSessionDetail should not be needed when turnId is provided");
        },
        interruptTurn: async (input) => {
          interruptedTurns.push(`${input.threadId}:${input.turnId}`);
          return {};
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.interrupt",
      requestId: "r-interrupt-explicit-turn",
      sessionId: "thread-explicit",
      turnId: "turn-explicit"
    });
    await waitForCondition(() => interruptedTurns.length === 1);

    expect(interruptedTurns).toEqual(["thread-explicit:turn-explicit"]);
    ws.terminate();
  });

  it("forwards mobile startup interrupt with an empty turn id", async () => {
    const context = createTestAppContext();
    const interruptedTurns: string[] = [];
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          throw new Error("readSessionDetail should not be needed for startup interrupt");
        },
        interruptTurn: async (input) => {
          interruptedTurns.push(`${input.threadId}:${input.turnId}`);
          return {};
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.interrupt",
      requestId: "r-startup-interrupt",
      sessionId: "thread-startup",
      targetKind: "startup"
    });
    await waitForCondition(() => interruptedTurns.length === 1);

    expect(interruptedTurns).toEqual(["thread-startup:"]);
    ws.terminate();
  });

  it("keeps the active turn interruptible when a detail snapshot still contains running work", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const interruptedTurns: string[] = [];
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          const detail = sessionDetail("thread-interrupt-live");
          detail.turns = [{
            id: "turn-interrupt-live",
            sessionId: "thread-interrupt-live",
            status: "completed",
            startedAt: "2026-05-17T17:00:00.000Z",
            completedAt: "2026-05-17T17:00:05.000Z",
            items: [{
              id: "turn-interrupt-live:command",
              sessionId: "thread-interrupt-live",
              turnId: "turn-interrupt-live",
              kind: "commandExecution",
              status: "running",
              title: "正在运行 /bin/zsh -lc 'sleep 90'",
              text: "正在运行 /bin/zsh -lc 'sleep 90'",
              rawText: "正在运行 /bin/zsh -lc 'sleep 90'",
              createdAt: "2026-05-17T17:00:01.000Z",
              updatedAt: "2026-05-17T17:00:10.000Z",
              isStreaming: true,
              isCollapsedByDefault: true,
              command: null,
              diff: null,
              approval: null,
              planSteps: []
            }]
          }];
          return detail;
        },
        interruptTurn: async (input) => {
          interruptedTurns.push(`${input.threadId}:${input.turnId}`);
          return {};
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "r-sync-interrupt-live",
      sessionId: "thread-interrupt-live",
      activeDetail: true
    });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-interrupt-live");
    notificationHandlers.get("turn/started")?.({
      threadId: "thread-interrupt-live",
      turn: { id: "turn-interrupt-live", status: "inProgress" }
    });
    await waitForWsMessage(messages, (message) => message.type === "turn.updated" &&
      (message.turn as Record<string, unknown> | undefined)?.id === "turn-interrupt-live");

    sendCommand(ws, {
      type: "session.read",
      requestId: "r-read-interrupt-live",
      sessionId: "thread-interrupt-live"
    });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" &&
      message.sessionId === "thread-interrupt-live" &&
      message.requestId !== "r-sync-interrupt-live");

    sendCommand(ws, { type: "session.interrupt", requestId: "r-interrupt-live", sessionId: "thread-interrupt-live" });
    await waitForCondition(() => interruptedTurns.length === 1);
    expect(interruptedTurns).toEqual(["thread-interrupt-live:turn-interrupt-live"]);
    ws.terminate();
  });

  it("does not clear an active turn from a stale detail snapshot without running items", async () => {
    const context = createTestAppContext();
    const interruptedTurns: string[] = [];
    let readCount = 0;
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          readCount++;
          const detail = sessionDetail("thread-stale-detail");
          if (readCount === 1) {
            detail.turns = [{
              id: "turn-stale-detail",
              sessionId: "thread-stale-detail",
              status: "running",
              startedAt: "2026-05-17T18:00:00.000Z",
              completedAt: null,
              items: []
            }];
          }
          return detail;
        },
        interruptTurn: async (input) => {
          interruptedTurns.push(`${input.threadId}:${input.turnId}`);
          return {};
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "r-sync-stale-detail",
      sessionId: "thread-stale-detail",
      activeDetail: true
    });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-stale-detail");
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const beforeStaleReadIndex = messages.length;
    sendCommand(ws, {
      type: "session.read",
      requestId: "r-read-stale-detail",
      sessionId: "thread-stale-detail"
    });
    for (let index = 0; index < 100; index++) {
      let hasNewSnapshot = false;
      for (let messageIndex = beforeStaleReadIndex; messageIndex < messages.length; messageIndex++) {
        const message = messages[messageIndex] as Record<string, unknown>;
        if (message.type === "thread.detail.snapshot" && message.sessionId === "thread-stale-detail") {
          hasNewSnapshot = true;
          break;
        }
      }
      if (hasNewSnapshot) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(readCount).toBe(2);

    sendCommand(ws, { type: "session.interrupt", requestId: "r-interrupt-stale-detail", sessionId: "thread-stale-detail" });
    await waitForCondition(() => interruptedTurns.length === 1);
    expect(interruptedTurns).toEqual(["thread-stale-detail:turn-stale-detail"]);
    ws.terminate();
  });

  it("clears cached active turns when fresh detail says the thread is idle", async () => {
    const context = createTestAppContext();
    const calls: string[] = [];
    let readCount = 0;
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          readCount++;
          const detail = sessionDetail("thread-idle-detail");
          if (readCount === 1) {
            detail.session.statusLabel = "active";
            detail.turns = [{
              id: "turn-idle-detail",
              sessionId: "thread-idle-detail",
              status: "running",
              startedAt: "2026-05-17T18:00:00.000Z",
              completedAt: null,
              items: []
            }];
          } else {
            detail.session.statusLabel = "idle";
            detail.session.waitsForNextDirection = true;
          }
          return detail;
        },
        startTurn: async () => {
          calls.push("turn/start");
          return { turnId: "turn-after-idle", status: "running" };
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "r-sync-idle-detail",
      sessionId: "thread-idle-detail",
      activeDetail: true
    });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-idle-detail");
    await new Promise((resolve) => setTimeout(resolve, 2100));
    sendCommand(ws, { type: "session.read", requestId: "r-read-idle-detail", sessionId: "thread-idle-detail" });
    await waitForCondition(() => readCount === 2);
    sendCommand(ws, { type: "session.sendText", requestId: "r-send-idle-detail", sessionId: "thread-idle-detail", clientMessageId: "m-idle-detail", text: "下一步" });

    await waitForCondition(() => calls.includes("turn/start"));
    ws.terminate();
  });

  it("skips preflight resume for ordinary sends after the session is already synced", async () => {
    const context = createTestAppContext();
    const startInputs: Record<string, unknown>[] = [];
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          const detail = sessionDetail("thread-synced-send");
          detail.session.statusLabel = "idle";
          detail.session.waitsForNextDirection = true;
          return detail;
        },
        startTurn: async (input) => {
          startInputs.push(asRecord(input));
          return { turnId: "turn-synced-send", status: "running" };
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "r-sync-synced-send",
      sessionId: "thread-synced-send",
      activeDetail: true
    });
    await waitForWsMessage(messages, (message) =>
      message.type === "thread.detail.snapshot" && message.sessionId === "thread-synced-send");

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "r-send-synced-send",
      sessionId: "thread-synced-send",
      clientMessageId: "m-synced-send",
      text: "测试审批功能，发一条审批指令给我"
    });

    await waitForCondition(() => startInputs.length === 1);
    expect(startInputs[0].skipPreflightResume).toBe(true);
    ws.terminate();
  });

  it("queues WebSocket ordinary sends when a preserved active turn exists", async () => {
    const context = createTestAppContext();
    const calls: string[] = [];
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => {
          const detail = sessionDetail("thread-stale-send");
          detail.turns = [{
            id: "turn-stale-send",
            sessionId: "thread-stale-send",
            status: "running",
            startedAt: "2026-05-17T18:30:00.000Z",
            completedAt: null,
            items: []
          }];
          return detail;
        },
        startTurn: async (input) => {
          calls.push(`start:${input.threadId}:${turnInputText(input)}`);
          return { turnId: "turn-stale-send-recovered", status: "running" };
        },
        steerTurn: async (input) => {
          calls.push(`steer:${input.threadId}:${input.turnId}:${turnInputText(input)}`);
          throw new Error("thread not found: thread-stale-send");
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "r-sync-stale-send",
      sessionId: "thread-stale-send",
      activeDetail: true
    });
    await waitForWsMessage(messages, (message) =>
      message.type === "thread.detail.snapshot" && message.sessionId === "thread-stale-send");

    const beforeSendIndex = messages.length;
    sendCommand(ws, {
      type: "session.sendText",
      requestId: "r-send-stale-send",
      sessionId: "thread-stale-send",
      clientMessageId: "m-send-stale-send",
      text: "移动端继续"
    });

    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-stale-send" &&
        Array.isArray(items) &&
        items[0]?.status === "queued" &&
        items[0]?.text === "移动端继续";
    });

    expect(calls).toEqual([]);
    await expect(hasNewWsMessage(messages, beforeSendIndex, (message) =>
      message.type === "command.failed" &&
      message.requestId === "r-send-stale-send")).resolves.toBe(false);
    ws.terminate();
  });

  it("keeps a turn interruptible when only running timeline item events arrive", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const interruptedTurns: string[] = [];
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-item-live"),
        interruptTurn: async (input) => {
          interruptedTurns.push(`${input.threadId}:${input.turnId}`);
          return {};
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sync.enable",
      requestId: "r-sync-item-live",
      sessionId: "thread-item-live",
      activeDetail: true
    });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-item-live");
    notificationHandlers.get("item/commandExecution/outputDelta")?.({
      threadId: "thread-item-live",
      turnId: "turn-item-live",
      itemId: "command-live",
      command: "/bin/zsh -lc 'sleep 120'",
      delta: "running"
    });
    await waitForWsMessage(messages, (message) => message.type === "timeline.item.updated" &&
      (message.item as Record<string, unknown> | undefined)?.turnId === "turn-item-live");

    sendCommand(ws, { type: "session.interrupt", requestId: "r-interrupt-item-live", sessionId: "thread-item-live" });
    await waitForCondition(() => interruptedTurns.length === 1);
    expect(interruptedTurns).toEqual(["thread-item-live:turn-item-live"]);
    ws.terminate();
  });

  it("activates the sending session for live detail events before starting a turn", async () => {
    const context = createTestAppContext();
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    context.codex.createSessionRuntime = async () => ({
      ...createRuntime({
        listSessionSummaries: async () => [],
        startTurn: async () => {
          notificationHandlers.get("turn/started")?.({
            threadId: "thread-direct-send-live",
            turn: { id: "turn-direct-send-live", status: "inProgress" }
          });
          notificationHandlers.get("item/agentMessage/delta")?.({
            threadId: "thread-direct-send-live",
            turnId: "turn-direct-send-live",
            itemId: "assistant-direct-send-live",
            delta: "直接发送后的实时回复"
          });
          return { turnId: "turn-direct-send-live", status: "running" };
        }
      }),
      client: {
        initialize: async () => ({}),
        request: async () => ({}),
        respond: () => undefined,
        onNotification: (method: string, handler: (params: Record<string, unknown>) => void) => {
          notificationHandlers.set(method, handler);
        },
        onServerRequest: () => undefined,
        close: () => undefined
      }
    });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "r-send-direct-live",
      sessionId: "thread-direct-send-live",
      clientMessageId: "m-send-direct-live",
      text: "移动端直接发送"
    });

    await waitForWsMessage(messages, (message) => {
      const item = message.item as Record<string, unknown> | undefined;
      return message.type === "timeline.item.updated" &&
        item?.sessionId === "thread-direct-send-live" &&
        item?.text === "直接发送后的实时回复";
    });
    ws.terminate();
  });

  it("acknowledges sent text before the Codex turn resolves", async () => {
    const context = createTestAppContext();
    const startTurnGate: { resolve: ((value: { turnId: string; status: string }) => void) | null } = { resolve: null };
    let startTurnResolved = false;
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        startTurn: async () => {
          const result = await new Promise<{ turnId: string; status: string }>((resolve) => {
            startTurnGate.resolve = resolve;
          });
          startTurnResolved = true;
          return result;
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");
    const fallbackTimer = setTimeout(() => {
      startTurnGate.resolve?.({ turnId: "turn-slow-ack", status: "running" });
    }, 1200);

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "r-send-slow-ack",
      sessionId: "thread-slow-ack",
      clientMessageId: "m-send-slow-ack",
      text: "移动端立即显示"
    });

    const received = await waitForWsMessage(messages, (message) => {
      const item = message.message as Record<string, unknown> | undefined;
      return message.type === "message.updated" &&
        item?.sessionId === "thread-slow-ack" &&
        item?.clientMessageId === "m-send-slow-ack" &&
        item?.sendState === "received";
    });
    expect(received.type).toBe("message.updated");
    expect(startTurnResolved).toBe(false);
    clearTimeout(fallbackTimer);
    startTurnGate.resolve?.({ turnId: "turn-slow-ack", status: "running" });
    ws.terminate();
  });

  it("queues websocket normal guided sends when active state is cached", async () => {
    const context = createTestAppContext();
    const startCalls: string[] = [];
    const steerCalls: string[] = [];
    const detail = sessionDetail("thread-normal-guided-ws");
    detail.turns = [{
      id: "turn-normal-guided-ws",
      sessionId: "thread-normal-guided-ws",
      status: "running",
      startedAt: "2026-05-18T00:00:00.000Z",
      completedAt: null,
      items: []
    }];
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => detail,
        startTurn: async (input) => {
          startCalls.push(turnInputText(input));
          return { turnId: "turn-recovered-normal-guided-ws", status: "running" };
        },
        steerTurn: async (input) => {
          steerCalls.push(turnInputText(input));
          return {};
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");
    sendCommand(ws, { type: "session.sync.enable", requestId: "sync-normal-guided-ws", sessionId: "thread-normal-guided-ws" });
    await waitForWsMessage(messages, (message) => message.type === "thread.detail.snapshot" && message.sessionId === "thread-normal-guided-ws");

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "send-normal-guided-ws",
      sessionId: "thread-normal-guided-ws",
      clientMessageId: "message-normal-guided-ws",
      text: "再生成一张",
      guidance: { mode: "guided", selectedCapabilityIds: [] }
    });

    await waitForWsMessage(messages, (message) => {
      const items = message.items as Array<Record<string, unknown>> | undefined;
      return message.type === "session.inputQueue.updated" &&
        message.sessionId === "thread-normal-guided-ws" &&
        Array.isArray(items) &&
        items.length === 1 &&
        items[0]?.clientMessageId === "message-normal-guided-ws" &&
        items[0]?.status === "queued";
    });
    await expect(hasWsMessage(messages, (message) => {
      const item = message.message as Record<string, unknown> | undefined;
      return message.type === "message.updated" &&
        item?.clientMessageId === "message-normal-guided-ws";
    })).resolves.toBe(false);
    expect(startCalls).toEqual([]);
    expect(steerCalls).toEqual([]);
    ws.terminate();
  });

  it("does not block later WebSocket commands while a Codex turn is still running", async () => {
    const context = createTestAppContext();
    const startTurnGate: { resolve: ((value: { turnId: string; status: string }) => void) | null } = { resolve: null };
    let startTurnResolved = false;
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        readSessionDetail: async () => sessionDetail("thread-unblocked-read"),
        startTurn: async () => {
          const result = await new Promise<{ turnId: string; status: string }>((resolve) => {
            startTurnGate.resolve = resolve;
          });
          startTurnResolved = true;
          return result;
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "r-send-unblocked-read",
      sessionId: "thread-unblocked-read",
      clientMessageId: "m-send-unblocked-read",
      text: "移动端立即显示并继续同步"
    });
    await waitForWsMessage(messages, (message) => {
      const item = message.message as Record<string, unknown> | undefined;
      return message.type === "message.updated" &&
        item?.sessionId === "thread-unblocked-read" &&
        item?.clientMessageId === "m-send-unblocked-read" &&
        item?.sendState === "received";
    });

    sendCommand(ws, {
      type: "session.read",
      requestId: "r-read-after-running-send",
      sessionId: "thread-unblocked-read"
    });

    const detail = await waitForWsMessage(messages, (message) =>
      message.type === "thread.detail.snapshot" &&
      message.sessionId === "thread-unblocked-read");
    expect(detail.type).toBe("thread.detail.snapshot");
    expect(startTurnResolved).toBe(false);
    startTurnGate.resolve?.({ turnId: "turn-unblocked-read", status: "running" });
    ws.terminate();
  });

  it("includes the client message id when a sendText command fails", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        startTurn: async () => {
          throw new Error("send failed");
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "r-send-failed-client-message",
      sessionId: "thread-failed-client-message",
      clientMessageId: "m-send-failed-client-message",
      text: "移动端继续"
    });

    const failed = await waitForWsMessage(messages, (message) =>
      message.type === "command.failed" &&
      message.requestId === "r-send-failed-client-message");
    expect(failed).toEqual(expect.objectContaining({
      type: "command.failed",
      requestId: "r-send-failed-client-message",
      clientMessageId: "m-send-failed-client-message",
      message: "send failed"
    }));
    const rows = await waitForAuditRows(context, 2);
    expect(rows.some((row) => row.session_id === "thread-failed-client-message" &&
      row.action_type === "session.sendText" &&
      row.result === "failed" &&
      row.detail.includes("send failed"))).toBe(true);
    ws.terminate();
  });

  it("does not mark a send failed when turn start times out after mobile acknowledgement", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        startTurn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error("Codex App Server request timed out: turn/start");
        }
      });
    server = await createServer(context);
    await server.ready();
    const { ws } = await openAuthedWs(context, server as TestServer);
    const messages = collectWsMessages(ws);
    await waitForWsMessage(messages, (message) => message.type === "sessions.snapshot");

    sendCommand(ws, {
      type: "session.sendText",
      requestId: "send-turn-start-timeout",
      sessionId: "thread-timeout",
      clientMessageId: "client-timeout",
      text: "测试审批功能，发一条审批指令给我"
    });

    await waitForWsMessage(messages, (message) => {
      const receivedMessage = asRecord(message.message);
      return message.type === "message.updated" &&
        receivedMessage.clientMessageId === "client-timeout" &&
        receivedMessage.sendState === "received";
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(await hasWsMessage(messages, (message) =>
      message.type === "command.failed" &&
      message.requestId === "send-turn-start-timeout" &&
      message.clientMessageId === "client-timeout"
    )).toBe(false);
    ws.terminate();
  });

  it("records sanitized audit rows for failed WebSocket client commands", async () => {
    const context = createTestAppContext();
    context.codex.createSessionRuntime = async () =>
      createRuntime({
        listSessionSummaries: async () => [],
        createSession: async () => {
          throw new Error("用户输入全文 token=abc Authorization: Bearer hidden codex config");
        },
        readSessionDetail: async () => {
          throw new Error("read failed");
        },
        startTurn: async () => {
          throw new Error("send failed");
        },
        steerTurn: async () => {
          throw new Error("steer failed");
        },
        interruptTurn: async () => {
          throw new Error("interrupt failed");
        },
        respondToApproval: async () => {
          throw new Error("approval failed");
        }
      });
    const originalRevokeDevice = context.pairing.revokeDevice;
    context.pairing.revokeDevice = () => {
      throw new Error("Authorization: Bearer hidden");
    };
    server = await createServer(context);
    await server.ready();
    const { deviceId, authToken, ws } = await openAuthedWs(context, server as TestServer);
    const secretText = "用户输入全文 token=abc Authorization: Bearer hidden codex config";

    sendCommand(ws, { type: "session.create", requestId: "r-create", sessionId: "session-before-create", toolId: "codex-mac", projectPath: null, text: secretText });
    await waitForAuditRows(context, 1);
    sendCommand(ws, { type: "session.read", requestId: "r-read", sessionId: "thread-failed" });
    await waitForAuditRows(context, 2);
    sendCommand(ws, { type: "session.sendText", requestId: "r-send", sessionId: "thread-failed", clientMessageId: "m-send", text: secretText });
    await waitForAuditRows(context, 3);
    sendCommand(ws, { type: "session.steer", requestId: "r-steer", sessionId: "thread-failed", clientMessageId: "m-steer", text: secretText });
    await waitForAuditRows(context, 4);
    sendCommand(ws, { type: "session.interrupt", requestId: "r-interrupt", sessionId: "thread-failed" });
    await waitForAuditRows(context, 5);
    sendCommand(ws, { type: "approval.respond", requestId: "r-approval", sessionId: "thread-failed", approvalId: "approval-1", actionId: "approve" });
    await waitForAuditRows(context, 6);
    sendCommand(ws, { type: "device.unbind", requestId: "r-unbind" });
    const rows = (await waitForAuditRows(context, 7)).slice().reverse();

    const auditSummary = rows.map((row) => ({
      deviceId: row.device_id,
      sessionId: row.session_id,
      actionType: row.action_type,
      result: row.result
    }));
    expect(auditSummary).toEqual(expect.arrayContaining([
      { deviceId, sessionId: "session-before-create", actionType: "session.create", result: "failed" },
      { deviceId, sessionId: "thread-failed", actionType: "session.read", result: "failed" },
      { deviceId, sessionId: "thread-failed", actionType: "session.sendText", result: "success" },
      { deviceId, sessionId: "thread-failed", actionType: "session.sendText", result: "failed" },
      { deviceId, sessionId: "thread-failed", actionType: "session.steer", result: "failed" },
      { deviceId, sessionId: "thread-failed", actionType: "session.interrupt", result: "failed" },
      { deviceId, sessionId: "thread-failed", actionType: "approval.respond", result: "failed" },
      { deviceId, sessionId: null, actionType: "device.unbind", result: "failed" }
    ]));
    for (const row of rows) {
      expect(row.detail).not.toContain(secretText);
      expect(row.detail).not.toContain(authToken);
      expect(row.detail).not.toMatch(/authorization|token|codex config/i);
    }
    context.pairing.revokeDevice = originalRevokeDevice;
    ws.terminate();
  });

  it("maps Codex live output and approval requests to rich events while keeping V1 compatibility", () => {
    const events: unknown[] = [];
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const serverRequestHandlers = new Map<string, (request: { id: string; method: string; params: Record<string, unknown> }) => void>();
    const client = {
      onNotification(method: string, handler: (params: Record<string, unknown>) => void): void {
        notificationHandlers.set(method, handler);
      },
      onServerRequest(method: string, handler: (request: { id: string; method: string; params: Record<string, unknown> }) => void): void {
        serverRequestHandlers.set(method, handler);
      }
    };

    bindCodexNotifications(client, (event) => events.push(event));
    notificationHandlers.get("item/agentMessage/delta")?.({ threadId: "thread-1", turnId: "turn-1", itemId: "assistant-1", delta: "正在处理" });
    serverRequestHandlers.get("item/commandExecution/requestApproval")?.({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        title: "命令审批",
        command: "pnpm test",
        actions: [{ id: "approve", label: "允许" }, { id: "reject", label: "拒绝" }]
      }
    });

    expect(events).toEqual([
      {
        type: "timeline.item.updated",
        item: expect.objectContaining({
          id: "assistant-1",
          sessionId: "thread-1",
          turnId: "turn-1",
          kind: "agentMessage",
          text: "正在处理"
        })
      },
      {
        type: "message.updated",
        message: expect.objectContaining({
          id: "assistant-1",
          sessionId: "thread-1",
          role: "assistant",
          text: "正在处理"
        })
      },
      {
        type: "approval.updated",
        sessionId: "thread-1",
        approval: expect.objectContaining({
          id: "approval-1",
          title: "是否允许 Codex 运行命令？",
          body: "$ pnpm test",
          actions: [
            { id: "approve", label: "同意", style: undefined, decisionType: undefined, requiresSecondConfirm: undefined },
            { id: "reject", label: "不执行，继续对话", style: undefined, decisionType: undefined, requiresSecondConfirm: undefined }
          ]
        })
      }
    ]);
  });

  it("maps legacy execCommandApproval requests to mobile approval events", () => {
    const events: unknown[] = [];
    const serverRequestHandlers = new Map<string, (request: { id: string; method: string; params: Record<string, unknown> }) => void>();
    const client = {
      onNotification(_method: string, _handler: (params: Record<string, unknown>) => void): void {
        // No notifications needed for this regression.
      },
      onServerRequest(method: string, handler: (request: { id: string; method: string; params: Record<string, unknown> }) => void): void {
        serverRequestHandlers.set(method, handler);
      }
    };

    bindCodexNotifications(client, (event) => events.push(event));
    serverRequestHandlers.get("execCommandApproval")?.({
      id: "legacy-approval-1",
      method: "execCommandApproval",
      params: {
        conversationId: "thread-legacy",
        callId: "call-1",
        command: ["touch", "/tmp/probe"],
        cwd: "/tmp",
        reason: "requires escalated permissions"
      }
    });

    expect(events).toEqual([
      {
        type: "approval.updated",
        sessionId: "thread-legacy",
        approval: expect.objectContaining({
          id: "legacy-approval-1",
          title: "命令审批",
          body: "touch /tmp/probe",
          actions: [
            { id: "accept", label: "同意", style: undefined, decisionType: undefined, requiresSecondConfirm: undefined },
            { id: "acceptForSession", label: "本会话中同意此类操作", style: undefined, decisionType: undefined, requiresSecondConfirm: true },
            { id: "decline", label: "不执行，继续对话", style: undefined, decisionType: undefined, requiresSecondConfirm: undefined }
          ]
        })
      }
    ]);
  });

  it("broadcasts empty plan updates so mobile clears stale plan panels", () => {
    const events: unknown[] = [];
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const client = {
      onNotification(method: string, handler: (params: Record<string, unknown>) => void): void {
        notificationHandlers.set(method, handler);
      }
    };

    bindCodexNotifications(client, (event) => events.push(event));
    notificationHandlers.get("turn/plan/updated")?.({
      threadId: "thread-1",
      turnId: "turn-1",
      plan: [
        { id: "p1", title: "将右侧月历改成设备信息栏", status: "pending", detail: "" }
      ]
    });
    notificationHandlers.get("turn/plan/updated")?.({
      threadId: "thread-1",
      turnId: "turn-1",
      plan: []
    });

    expect(events).toContainEqual({
      type: "session.plan.updated",
      sessionId: "thread-1",
      steps: []
    });
  });

  it("clears approval requests when resolved notifications use nested request ids", () => {
    const events: unknown[] = [];
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const serverRequestHandlers = new Map<string, (request: { id: string; method: string; params: Record<string, unknown> }) => void>();
    const client = {
      onNotification(method: string, handler: (params: Record<string, unknown>) => void): void {
        notificationHandlers.set(method, handler);
      },
      onServerRequest(method: string, handler: (request: { id: string; method: string; params: Record<string, unknown> }) => void): void {
        serverRequestHandlers.set(method, handler);
      }
    };

    bindCodexNotifications(client, (event) => events.push(event));
    serverRequestHandlers.get("item/commandExecution/requestApproval")?.({
      id: "approval-nested",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        command: "curl -k https://127.0.0.1:37631/api/health"
      }
    });
    notificationHandlers.get("serverRequest/resolved")?.({
      serverRequest: { id: "approval-nested" }
    });

    expect(events).toEqual([
      {
        type: "approval.updated",
        sessionId: "thread-1",
        approval: expect.objectContaining({
          id: "approval-nested",
          body: "$ curl -k https://127.0.0.1:37631/api/health"
        })
      },
      { type: "approval.updated", sessionId: "thread-1", approval: null }
    ]);
  });

  it("clears approval requests when resolved notifications use numeric request ids", () => {
    const events: unknown[] = [];
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const serverRequestHandlers = new Map<string, (request: { id: string; method: string; params: Record<string, unknown> }) => void>();
    const client = {
      onNotification(method: string, handler: (params: Record<string, unknown>) => void): void {
        notificationHandlers.set(method, handler);
      },
      onServerRequest(method: string, handler: (request: { id: string; method: string; params: Record<string, unknown> }) => void): void {
        serverRequestHandlers.set(method, handler);
      }
    };

    bindCodexNotifications(client, (event) => events.push(event));
    serverRequestHandlers.get("item/commandExecution/requestApproval")?.({
      id: "42",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        command: "curl -k https://127.0.0.1:37631/api/health"
      }
    });
    notificationHandlers.get("serverRequest/resolved")?.({
      serverRequest: { id: 42 }
    });

    expect(events).toEqual([
      {
        type: "approval.updated",
        sessionId: "thread-1",
        approval: expect.objectContaining({
          id: "42",
          body: "$ curl -k https://127.0.0.1:37631/api/health"
        })
      },
      { type: "approval.updated", sessionId: "thread-1", approval: null }
    ]);
  });

  it("broadcasts Codex runtime error notifications to synced mobile timelines", () => {
    const events: unknown[] = [];
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const client = {
      onNotification(method: string, handler: (params: Record<string, unknown>) => void): void {
        notificationHandlers.set(method, handler);
      }
    };

    bindCodexNotifications(client, (event) => events.push(event));
    notificationHandlers.get("error")?.({
      threadId: "thread-1",
      turnId: "turn-1",
      message: "exceeded retry limit, last status: 429 Too Many Requests"
    });

    expect(events).toEqual([
      {
        type: "timeline.item.completed",
        item: expect.objectContaining({
          id: "turn-1:error",
          sessionId: "thread-1",
          turnId: "turn-1",
          kind: "error",
          status: "failed",
          title: "错误",
          text: "exceeded retry limit, last status: 429 Too Many Requests"
        })
      }
    ]);
  });

  it("broadcasts global Codex runtime errors as command failures when no turn is attached", () => {
    const events: unknown[] = [];
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const client = {
      onNotification(method: string, handler: (params: Record<string, unknown>) => void): void {
        notificationHandlers.set(method, handler);
      }
    };

    bindCodexNotifications(client, (event) => events.push(event));
    notificationHandlers.get("error")?.({
      message: "Codex App Server disconnected"
    });

    expect(events).toEqual([
      {
        type: "command.failed",
        requestId: "codex-runtime-error",
        errorCode: "CODEX_RUNTIME_ERROR",
        message: "Codex App Server disconnected"
      }
    ]);
  });

  it("broadcasts Codex account rate limit update notifications as account usage snapshots", () => {
    const events: unknown[] = [];
    const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>();
    const client = {
      onNotification(method: string, handler: (params: Record<string, unknown>) => void): void {
        notificationHandlers.set(method, handler);
      }
    };

    bindCodexNotifications(
      client,
      (event) => events.push(event),
      undefined,
      undefined,
      (params) => ({
        status: "available",
        accountLabel: "",
        accountStatusText: "已登录",
        refreshedAt: "2026-05-18T08:00:00.000Z",
        limitId: "codex",
        limitName: "",
        primary: {
          usedPercent: Number(((params.rateLimits as Record<string, unknown>).primary as Record<string, unknown>).usedPercent),
          windowDurationMins: 60,
          resetsAt: "2026-05-18T12:00:00.000Z"
        },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: "",
        rateLimits: [],
        fiveHour: null,
        weekly: null,
        message: ""
      })
    );
    notificationHandlers.get("account/rateLimits/updated")?.({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 55,
          windowDurationMins: 60,
          resetsAt: 1800000000
        }
      }
    });

    expect(events).toEqual([
      {
        type: "codex.accountUsage.snapshot",
        requestId: "account-rateLimits-updated",
        usage: expect.objectContaining({
          status: "available",
          primary: expect.objectContaining({
            usedPercent: 55
          })
        })
      }
    ]);
  });
});
