import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServiceConfig } from "../config.js";
import { createAppContext } from "../appContext.js";

export function createTestAppContext(overrides: Partial<Pick<ServiceConfig, "host" | "port" | "projectRoots" | "launchAgentDir" | "startupCommand">> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-mac-service-test-"));
  return createAppContext({
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? 0,
    dataDir,
    codexBin: undefined,
    codexIpcSocketPath: path.join(dataDir, "missing-codex-ipc.sock"),
    projectRoots: overrides.projectRoots ?? [],
    launchAgentDir: overrides.launchAgentDir ?? path.join(dataDir, "LaunchAgents"),
    startupCommand: overrides.startupCommand ?? "pnpm dev"
  });
}
