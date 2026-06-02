import os from "node:os";

export interface NetworkInterfaceEntry {
  address: string;
  family: string | number;
  internal: boolean;
}

export interface CreateServiceUrlInput {
  bindHost: string;
  hostHeader: string | undefined;
  hostname: string;
  port: number;
  networkInterfaces?: NodeJS.Dict<NetworkInterfaceEntry[]>;
  localHostname?: string;
}

function extractHost(hostHeader: string | undefined, hostname: string): string {
  const rawHost = hostHeader && hostHeader.length > 0 ? hostHeader : hostname;
  if (rawHost.startsWith("[")) {
    const end = rawHost.indexOf("]");
    return end >= 0 ? rawHost.slice(1, end) : rawHost;
  }
  const colonIndex = rawHost.indexOf(":");
  return colonIndex >= 0 ? rawHost.slice(0, colonIndex) : rawHost;
}

function extractPort(hostHeader: string | undefined, fallbackPort: number): number {
  if (!hostHeader || hostHeader.length === 0) {
    return fallbackPort;
  }
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    if (end >= 0 && hostHeader.length > end + 2 && hostHeader[end + 1] === ":") {
      const parsed = Number(hostHeader.slice(end + 2));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackPort;
    }
    return fallbackPort;
  }
  const colonIndex = hostHeader.lastIndexOf(":");
  if (colonIndex < 0 || hostHeader.indexOf(":") !== colonIndex) {
    return fallbackPort;
  }
  const parsed = Number(hostHeader.slice(colonIndex + 1));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackPort;
}

function isAllInterfaceHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "";
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isReachableRequestHost(host: string): boolean {
  return !isLoopbackHost(host) && !isAllInterfaceHost(host);
}

function isReachableBindHost(host: string): boolean {
  return !isLoopbackHost(host) && !isAllInterfaceHost(host);
}

function isIpv4Entry(entry: NetworkInterfaceEntry): boolean {
  return entry.family === "IPv4" || entry.family === 4;
}

function findLanIpv4Addresses(networkInterfaces: NodeJS.Dict<NetworkInterfaceEntry[]>): string[] {
  const result: string[] = [];
  const names = Object.keys(networkInterfaces);
  for (const name of names) {
    const entries = networkInterfaces[name] ?? [];
    for (const entry of entries) {
      if (!entry.internal && isIpv4Entry(entry) && entry.address.length > 0) {
        result.push(entry.address);
      }
    }
  }
  return result;
}

function findLanIpv4Address(networkInterfaces: NodeJS.Dict<NetworkInterfaceEntry[]>): string {
  return findLanIpv4Addresses(networkInterfaces)[0] ?? "";
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function formatServiceUrl(host: string, port: number): string {
  if (port === 443) {
    return `https://${formatHost(host)}`;
  }
  return `https://${formatHost(host)}:${port}`;
}

function normalizedLocalHostname(hostname: string): string {
  const trimmed = hostname.trim().replace(/\.$/, "");
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.toLowerCase().endsWith(".local")) {
    return trimmed;
  }
  return `${trimmed}.local`;
}

function pushUnique(values: string[], value: string): void {
  if (value.length === 0 || values.includes(value)) {
    return;
  }
  values.push(value);
}

export function createServiceUrl(input: CreateServiceUrlInput): string {
  const requestHost = extractHost(input.hostHeader, input.hostname);
  const port = extractPort(input.hostHeader, input.port);
  let host = requestHost;

  if (!isReachableRequestHost(requestHost)) {
    if (isAllInterfaceHost(input.bindHost)) {
      const lanAddress = findLanIpv4Address(input.networkInterfaces ?? os.networkInterfaces());
      if (lanAddress.length > 0) {
        host = lanAddress;
      }
    } else if (isReachableBindHost(input.bindHost)) {
      host = input.bindHost;
    }
  }

  return formatServiceUrl(host, port);
}

export function createServiceUrlCandidates(input: CreateServiceUrlInput): string[] {
  const requestHost = extractHost(input.hostHeader, input.hostname);
  const port = extractPort(input.hostHeader, input.port);
  const networkInterfaces = input.networkInterfaces ?? os.networkInterfaces();
  const result: string[] = [];

  pushUnique(result, createServiceUrl({ ...input, networkInterfaces }));

  const localHostname = normalizedLocalHostname(input.localHostname ?? os.hostname());
  if (!isLoopbackHost(input.bindHost) && localHostname.length > 0) {
    pushUnique(result, formatServiceUrl(localHostname, port));
  }

  if (isReachableRequestHost(requestHost)) {
    pushUnique(result, formatServiceUrl(requestHost, port));
  }

  if (isAllInterfaceHost(input.bindHost)) {
    const lanAddresses = findLanIpv4Addresses(networkInterfaces);
    for (const address of lanAddresses) {
      pushUnique(result, formatServiceUrl(address, port));
    }
  }

  return result;
}
