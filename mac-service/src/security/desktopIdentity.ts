import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

export interface DesktopIdentity {
  id: string;
  createdAt: string;
}

const DESKTOP_IDENTITY_FILE = "desktop-identity.json";

function isValidDesktopId(value: string): boolean {
  return /^desktop-[A-Za-z0-9_-]{12,}$/.test(value);
}

function readDesktopIdentity(filePath: string): DesktopIdentity | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DesktopIdentity>;
    if (typeof parsed.id === "string" && isValidDesktopId(parsed.id)) {
      return {
        id: parsed.id,
        createdAt: typeof parsed.createdAt === "string" && parsed.createdAt.length > 0
          ? parsed.createdAt
          : new Date().toISOString()
      };
    }
  } catch {
    return null;
  }
  return null;
}

function writeDesktopIdentity(filePath: string, identity: DesktopIdentity): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export function loadOrCreateDesktopIdentity(dataDir: string): DesktopIdentity {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, DESKTOP_IDENTITY_FILE);
  const existing = readDesktopIdentity(filePath);
  if (existing) {
    return existing;
  }
  const identity: DesktopIdentity = {
    id: `desktop-${nanoid(16)}`,
    createdAt: new Date().toISOString()
  };
  writeDesktopIdentity(filePath, identity);
  return identity;
}
