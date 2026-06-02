import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");
const scriptPath = path.join(repoRoot, "scripts", "install-windows-desktop-service.ps1");
const script = fs.readFileSync(scriptPath, "utf8");

describe("Windows desktop service install script", () => {
  it("keeps the lightweight setup flow wired to the documented Windows path", () => {
    expect(script).toContain("param(");
    expect(script).toContain("$env:OS -ne \"Windows_NT\"");
    expect(script).toContain("Node.js 20 LTS or 22 LTS");
    expect(script).toContain("winget install -e --id OpenJS.NodeJS.22");
    expect(script).toContain("Test-NodeCandidate");
    expect(script).toContain('Invoke-Checked "corepack" @("prepare", "pnpm@9.15.4", "--activate")');
    expect(script).toContain('Invoke-Checked "pnpm" @("install", "--frozen-lockfile")');
    expect(script).toContain('Invoke-Checked "pnpm" @("--filter", "@code/mac-service", "build")');
    expect(script).toContain("OpenAI\\Codex\\bin");
    expect(script).toContain("Test-WindowsAppsPath");
    expect(script).toContain("start-code-desktop-service.ps1");
  });

  it("generates a local start script with the required service environment", () => {
    expect(script).toContain("$env:CODE_HOST");
    expect(script).toContain("$env:CODE_PORT");
    expect(script).toContain("$env:CODE_DATA_DIR");
    expect(script).toContain("$env:CODEX_BIN");
    expect(script).toContain('[string]$ServiceHost = "0.0.0.0"');
    expect(script).toContain("Get-LocalManagementHost");
    expect(script).toContain("$quotedNodePath = ConvertTo-SingleQuotedPowerShellString $resolvedNodePath");
    expect(script).toContain("& $quotedNodePath .\\mac-service\\dist\\main.js");
    expect(script).toContain("curl.exe -k https://$managementHost`:$Port/api/health");
    expect(script).toContain("curl.exe -k https://$managementHost`:$Port/api/codex-preflight");
    expect(script).toContain("allow Node.js on private networks");
    expect(script).toContain("allow inbound TCP port $Port");
  });

  it("does not silently install certificate trust or register Windows startup", () => {
    expect(script).not.toMatch(/certutil(?:\.exe)?\s+-addstore/i);
    expect(script).not.toMatch(/Register-ScheduledTask/i);
    expect(script).not.toMatch(/schtasks(?:\.exe)?\s+\/create/i);
    expect(script).not.toMatch(/WScript\.Shell/i);
    expect(script).toContain("This script does not silently change the Windows Root store.");
    expect(script).toContain("Windows startup and screen capture are still unsupported in this phase.");
  });
});
