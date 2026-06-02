# code Desktop Service

[中文文档](./README.zh-CN.md)

`code Desktop Service` is the desktop-side backend for the `code` remote coding client. It runs on the desktop machine, talks to the local Codex desktop/App Server runtime, exposes a local HTTPS and WebSocket API, serves a lightweight web management console, and provides pairing, session, media, project, and certificate-trust services for trusted clients.

The service directory is still named `mac-service` for historical reasons. The current codebase includes a desktop platform layer for macOS and Windows.

## Public Documents

- Privacy Policy: <https://lyz1022.github.io/code-desktop-service/privacy-policy-zh.html>
- English Privacy Policy: <https://lyz1022.github.io/code-desktop-service/privacy-policy-en.html>
- Desktop Service Setup Guide: <https://lyz1022.github.io/code-desktop-service/desktop-service-install-guide.html>
- Releases: <https://github.com/lyz1022/code-desktop-service/releases>

## Features

- Local HTTPS management console at `https://127.0.0.1:37631` by default.
- WebSocket API for paired clients to list projects and sessions, create sessions, send input, steer running turns, handle approvals, and receive live session updates.
- Codex desktop/App Server integration, including CLI discovery, preflight checks, session runtime management, model/config reads, and account usage refresh.
- QR-code pairing flow with short-lived pairing tickets, device authorization, device revocation, and audit logs.
- Per-machine local CA and service certificate generation. The CA private key stays on the user's machine and is never shipped in the repository.
- Optional current-user trust installation from the local management page:
  - macOS: current user's login keychain.
  - Windows: current user's trusted root certificate store.
- Stable service public-key hash for client-side HTTP certificate pinning.
- Bonjour/mDNS service publication with TLS identity metadata.
- Project root management for creating and organizing sessions by desktop project.
- Media asset storage for uploaded files, generated images, local file references, and downloadable session assets.
- Local web preview/proxy session tracking and cleanup from the management page.
- macOS LaunchAgent startup toggle from the management page.
- Windows data-directory, Codex binary discovery, project-root folder picker, and certificate trust installation support. Windows startup and capture automation are currently limited compared with macOS.

## Repository Layout

```text
.
├── mac-service/          # Desktop service source, web UI, tests, and package config
├── packages/protocol/    # Shared protocol schemas used by the service
├── package.json          # pnpm workspace root
├── pnpm-workspace.yaml   # Workspace package list
├── pnpm-lock.yaml        # Locked dependency graph
└── tsconfig.base.json    # Shared TypeScript compiler settings
```

Not included in this repository:

- Mobile app source.
- Build outputs such as `dist/`.
- Temporary probes/logs such as `mac-service/tmp/`.
- `node_modules/`.

## Requirements

- Node.js 20 LTS or 22 LTS is recommended on Windows.
- Node.js 24 may require Visual Studio C++ Build Tools because `better-sqlite3` can fall back to a native rebuild.
- pnpm 9.15.4, as declared by `packageManager`.
- A local Codex desktop/App Server installation or a reachable Codex CLI binary.
- macOS for the most complete feature set. Windows support exists for the desktop platform layer, data directory, Codex binary discovery, and certificate trust installation, but some service-management features are still macOS-first.

Enable pnpm through Corepack if needed:

```bash
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

## Installation

Latest release notes:

```text
https://github.com/lyz1022/code-desktop-service/releases
```

Clone the repository:

```bash
git clone https://github.com/lyz1022/code-desktop-service.git
cd code-desktop-service
```

### Windows Quick Setup

On Windows, run the lightweight PowerShell setup script from the repository root. It checks Node.js, prepares pnpm through Corepack when needed, validates the Codex CLI/App Server binary, installs dependencies, builds `@code/mac-service`, and writes a local start script under the data directory.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-desktop-service.ps1
```

If Codex is not found automatically, pass the Codex CLI installed by Codex Desktop:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-desktop-service.ps1 -CodexBin "C:\Users\<you>\AppData\Local\OpenAI\Codex\bin\<version>\codex.exe"
```

To start the service immediately after setup, add `-Start`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-desktop-service.ps1 -CodexBin "C:\Users\<you>\AppData\Local\OpenAI\Codex\bin\<version>\codex.exe" -Start
```

The default Windows data directory is `C:\Users\<you>\Documents\Codex\code-data`. The generated start script is:

```text
C:\Users\<you>\Documents\Codex\code-data\start-code-desktop-service.ps1
```

This script does not silently install the local CA into the Windows Root store and does not register startup. Certificate trust is still installed from the loopback-only local management page, and Windows startup/capture automation remains unsupported in this phase.

After the service is running on Windows, the management page's `Choose Folder` project-root action opens the Windows system folder picker. If the current desktop session cannot show a dialog, use the manual project-root path input as a fallback.

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Run type checks:

```bash
pnpm -r typecheck
```

Run tests:

```bash
pnpm -r test
```

Build all workspace packages:

```bash
pnpm -r build
```

## Running the Service

Development mode:

```bash
pnpm --filter @code/mac-service dev
```

Production-style run after building:

```bash
pnpm -r build
pnpm --filter @code/mac-service start
```

By default, the service listens on:

```text
https://0.0.0.0:37631
```

For local-only development, bind to loopback:

```bash
CODE_HOST=127.0.0.1 CODE_PORT=37631 pnpm --filter @code/mac-service dev
```

Open the management page:

```text
https://127.0.0.1:37631
```

Before installing the local CA, browsers will show a certificate warning. This is expected. Use the management page's `Install Trust` action from `localhost` or `127.0.0.1` to install the per-machine CA for the current user.

Quick health check before trust installation:

```bash
curl -k https://127.0.0.1:37631/api/health
```

## Configuration

The service is configured with environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `CODE_HOST` | `0.0.0.0` | Bind host for the HTTPS server. Use `127.0.0.1` for local-only access. |
| `CODE_PORT` | `37631` | HTTPS/WebSocket port. |
| `CODE_DATA_DIR` | Platform default | Persistent data directory for SQLite, certificates, and media assets. |
| `CODEX_BIN` | Auto-detected | Explicit path to the Codex CLI/App Server binary. |
| `CODEX_IPC_SOCKET` | unset | Optional Codex IPC socket path. |
| `CODE_PROJECT_ROOTS` | empty | Comma-separated list of allowed project roots. |
| `CODE_LAUNCH_AGENT_DIR` | Platform default | Startup-service directory. On macOS this is normally `~/Library/LaunchAgents`. |
| `CODE_STARTUP_COMMAND` | `pnpm dev` | Command written into the macOS LaunchAgent startup plist. |

Platform default data directories:

- macOS: `~/Library/Application Support/code`
- Windows: `%APPDATA%\code` or `%LOCALAPPDATA%\code`

The lightweight Windows setup script uses `C:\Users\<you>\Documents\Codex\code-data` unless `-DataDir` is supplied.

Example:

```bash
CODE_HOST=127.0.0.1 \
CODE_PORT=37631 \
CODE_PROJECT_ROOTS="$HOME/Projects,$HOME/Work" \
CODEX_BIN="/Applications/Codex.app/Contents/Resources/codex" \
pnpm --filter @code/mac-service dev
```

## Web Management Console

The management page provides:

- Service status, process id, uptime, service URL, certificate mode, and CA fingerprint.
- Local CA trust installation for the current user.
- QR pairing ticket generation and fallback pairing text.
- Paired device list and revocation.
- Codex preflight status.
- Project root selection and management.
- Audit log display.
- Media asset search, grouped display, batch selection, and deletion.
- Local web preview session list and cleanup.
- macOS login-startup toggle.

The trust installation endpoint is intentionally restricted to loopback management requests. A LAN client cannot trigger trust installation even if it knows the endpoint and header.

## Client Pairing and Usage Flow

1. Start the desktop service.
2. Open the management console from the desktop machine.
3. Install local CA trust if you want browsers to stop showing the local certificate warning.
4. Generate a pairing ticket.
5. Scan the QR code or copy the fallback pairing text into a trusted client.
6. The client claims the pairing code and receives an authorization token.
7. The client connects to the WebSocket API with the token.
8. The client can list projects/sessions, start or resume Codex sessions, upload/download assets, and receive live session events.

## HTTP API Overview

Important unauthenticated or management endpoints:

- `GET /` - web management console.
- `GET /web/main.js` - management console script.
- `GET /api/health` - service status, URL candidates, certificate fingerprint, CA fingerprint, and public-key hash.
- `GET /api/codex-preflight` - Codex runtime readiness check.
- `POST /api/pairing-ticket` - create a short-lived pairing ticket.
- `POST /api/pairing-claim` - claim a pairing ticket and receive a device token.
- `POST /api/certificate/trust` - install the local CA for the current user. Requires the management header and a loopback request.
- `GET /api/startup` / `PUT /api/startup` - read or update startup status.
- `GET /api/project-roots` and related project-root routes.
- `GET /api/media-assets` and related media routes.
- `GET /api/local-web-sessions` and related local web routes.

The WebSocket endpoint is:

```text
GET /ws
```

WebSocket commands require a valid paired-device token.

## Technical Design

### Process Model

The service is a Node.js TypeScript application built on Fastify. It serves HTTPS routes and WebSocket connections in the same process, and uses a small repository layer around SQLite for persistent state.

### TLS and Local Trust

On first run, the service creates a local CA under the configured data directory. It then signs a service certificate with that CA. The service certificate includes SANs for:

- `localhost`
- `127.0.0.1`
- `::1`
- hostname and `.local` hostname
- Windows `COMPUTERNAME` and `.local` form when available
- non-internal IPv4 LAN addresses

Existing CA material is validated before reuse. The certificate must be a CA, be within its validity window, include CA key usage, and match its private key. Existing service certificates are also validated before reuse. If SANs change, the service re-signs the service certificate while reusing the service private key when possible. This keeps the SPKI public-key hash stable across local network changes.

Fingerprints are standard SHA-256 hashes over DER certificate bytes. The client-facing `tlsPublicKeyHash` is a base64 SHA-256 hash over the service certificate's SPKI public key.

### Security Boundaries

- CA private keys are generated per machine and never committed to the repository.
- Installing CA trust is never automatic. The user must click the management action.
- Trust installation is allowed only from loopback requests addressed as `localhost`, `127.*`, or `::1`.
- Paired devices use explicit pairing tickets and stored device tokens.
- Audit logs record pairing, trust, startup, project, media, and device-management actions.
- File-reference asset creation checks that the requested file is inside the session's project root.

### Codex Integration

The service discovers a Codex binary using platform-specific candidates or `CODEX_BIN`. It talks to the Codex desktop/App Server protocol to:

- run preflight checks;
- list models;
- read runtime config;
- start and resume sessions;
- stream timeline updates;
- handle approvals and user input;
- read account usage and rate limit updates.

### Storage

Persistent storage lives under `CODE_DATA_DIR`:

- `code-v1.sqlite` stores sessions, devices, pairing/audit data, project roots, runtime config, media metadata, and local web sessions.
- `certs/` stores the local CA, service certificate, service key, and metadata.
- `media-assets/` stores uploaded files, generated images, and file-reference snapshots.

### Platform Layer

The desktop platform abstraction separates OS-specific behavior:

- macOS:
  - data dir under `~/Library/Application Support/code`;
  - LaunchAgent startup management;
  - default Codex app/Homebrew paths;
  - local capture runner.
- Windows:
  - data dir under `%APPDATA%\code` or `%LOCALAPPDATA%\code`;
  - Codex executable candidates such as `codex.exe` and `codex.cmd`;
  - current-user CA trust installation through `certutil.exe`;
  - startup/capture support is currently limited.

## Development

Run service tests:

```bash
pnpm --filter @code/mac-service test
```

Run protocol tests:

```bash
pnpm --filter @code/protocol test
```

Run all checks:

```bash
pnpm -r typecheck
pnpm -r test
```

## Notes

- This repository does not include a license file yet. Add one before encouraging third-party reuse or redistribution.
- The public repository contains service-side source only. It intentionally does not include the mobile app.
