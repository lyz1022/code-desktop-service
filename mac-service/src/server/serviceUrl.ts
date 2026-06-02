import os from "node:os";

export interface NetworkInterfaceEntry {
  address: string;
  family: string | number;
  internal: boolean;
}

interface LanIpv4AddressCandidate {
  address: string;
  interfaceName: string;
  order: number;
  score: number;
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

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return octets;
}

function isUsableLanIpv4Address(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) {
    return false;
  }
  const first = octets[0];
  const second = octets[1];
  if (first === 0 || first === 127 || first >= 224) {
    return false;
  }
  if (first === 169 && second === 254) {
    return false;
  }
  return true;
}

function isPrivateIpv4Address(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) {
    return false;
  }
  const first = octets[0];
  const second = octets[1];
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function isLikelyPhysicalInterface(interfaceName: string): boolean {
  return /(^en\d+$|^eth\d+$|ethernet|wi-?fi|wireless|wlan|以太网|无线)/i.test(interfaceName);
}

function isLikelyVirtualInterface(interfaceName: string): boolean {
  return /(virtual|vethernet|hyper-v|vmware|virtualbox|vbox|docker|wsl|vpn|tunnel|tap|tun|utun|tailscale|zerotier|bridge|br-|awdl|llw|bluetooth|wi-?fi direct|本地连接\*|local area connection\*)/i.test(interfaceName);
}

function scoreLanIpv4Address(interfaceName: string, address: string): number {
  let score = 0;
  if (isPrivateIpv4Address(address)) {
    score += 40;
  }
  if (isLikelyPhysicalInterface(interfaceName)) {
    score += 80;
  }
  if (isLikelyVirtualInterface(interfaceName)) {
    score -= 100;
  }
  if (address.endsWith(".1")) {
    score -= 50;
  }
  return score;
}

function findLanIpv4AddressCandidates(networkInterfaces: NodeJS.Dict<NetworkInterfaceEntry[]>): LanIpv4AddressCandidate[] {
  const result: LanIpv4AddressCandidate[] = [];
  const names = Object.keys(networkInterfaces);
  let order = 0;
  for (const name of names) {
    const entries = networkInterfaces[name] ?? [];
    for (const entry of entries) {
      if (!entry.internal && isIpv4Entry(entry) && isUsableLanIpv4Address(entry.address)) {
        result.push({
          address: entry.address,
          interfaceName: name,
          order,
          score: scoreLanIpv4Address(name, entry.address)
        });
        order++;
      }
    }
  }
  result.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.order - right.order;
  });
  return result;
}

function findLanIpv4Addresses(networkInterfaces: NodeJS.Dict<NetworkInterfaceEntry[]>): string[] {
  return findLanIpv4AddressCandidates(networkInterfaces).map((candidate) => candidate.address);
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
