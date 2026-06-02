import { createAppContext } from "./appContext.js";
import { loadConfig } from "./config.js";
import { startBonjourPublication, type StartedBonjourPublication } from "./server/bonjourPublisher.js";
import { createServer } from "./server/httpServer.js";
import { createServiceUrlCandidates } from "./server/serviceUrl.js";
import { formatAddressInUseMessage, isAddressInUseError } from "./server/serviceStatus.js";
import { startTransportCertificateRefreshLoop, type StartedTransportCertificateRefreshLoop } from "./server/transportCertificateRuntime.js";

const config = loadConfig();
const context = createAppContext(config);
const server = await createServer(context);
let bonjourPublication: StartedBonjourPublication | undefined;
let transportCertificateRefreshLoop: StartedTransportCertificateRefreshLoop | undefined;
let shuttingDown = false;

function currentBonjourInput() {
  const candidateServiceUrls = createServiceUrlCandidates({
    bindHost: context.config.host,
    hostHeader: undefined,
    hostname: "localhost",
    port: boundPort(),
    localHostname: context.localMacName
  });
  return {
    name: context.localMacName,
    port: boundPort(),
    macId: context.localMacId,
    tlsFingerprint: context.transport.fingerprint,
    tlsPublicKeyHash: context.transport.publicKeyHash,
    serviceUrl: candidateServiceUrls[0] ?? "",
    candidateServiceUrls
  };
}

function boundPort(): number {
  const address = server.server.address();
  if (address && typeof address === "object") {
    return address.port;
  }
  return config.port;
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.exitCode = exitCode;
  transportCertificateRefreshLoop?.stop();
  await bonjourPublication?.stop();
  await server.close();
}

process.once("SIGINT", () => {
  void shutdown(0);
});
process.once("SIGTERM", () => {
  void shutdown(0);
});

try {
  await server.listen({ host: config.host, port: config.port });
  bonjourPublication = await startBonjourPublication(currentBonjourInput());
  transportCertificateRefreshLoop = startTransportCertificateRefreshLoop({
    context,
    server: server.server,
    onChanged: async (result) => {
      await bonjourPublication?.update(currentBonjourInput());
      console.info([
        "桌面服务证书已随网络地址变化热更新",
        `fingerprint ${result.previousFingerprint.slice(0, 12)} -> ${result.nextFingerprint.slice(0, 12)}`,
        `spkiPin ${result.previousPublicKeyHash === result.nextPublicKeyHash ? "保持不变" : "已变化"}`
      ].join("；"));
    },
    onError: (error) => {
      console.error("桌面服务证书热更新失败", error);
    }
  });
} catch (error) {
  if (isAddressInUseError(error)) {
    console.error(formatAddressInUseMessage({ host: config.host, port: config.port }));
    await shutdown(1);
    process.exitCode = 1;
  } else {
    await shutdown(1);
    throw error;
  }
}
