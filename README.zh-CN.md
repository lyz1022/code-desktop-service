# code 桌面端服务

[English README](./README.md)

`code Desktop Service` 是 `code` 远程编程客户端的桌面端服务端。它运行在桌面电脑上，连接本机 Codex Desktop / App Server 运行时，对外提供本地 HTTPS 与 WebSocket API，同时提供轻量 Web 管理页，用于配对、会话、媒体文件、项目根目录和证书信任管理。

当前服务目录仍然沿用历史名称 `mac-service`。实际代码已经包含 macOS 和 Windows 的桌面平台适配层。

## 公开文档

- 隐私政策：<https://lyz1022.github.io/code-desktop-service/privacy-policy-zh.html>
- English Privacy Policy：<https://lyz1022.github.io/code-desktop-service/privacy-policy-en.html>
- 桌面服务安装与配对说明：<https://lyz1022.github.io/code-desktop-service/desktop-service-install-guide.html>
- GitHub Releases：<https://github.com/lyz1022/code-desktop-service/releases>

## 功能

- 默认在 `https://127.0.0.1:37631` 提供本地 HTTPS 管理页。
- 为已配对客户端提供 WebSocket API：项目和会话列表、新建会话、发送输入、运行中干预、审批处理、实时会话事件同步等。
- 接入 Codex Desktop / App Server：CLI 探测、预检、会话运行时管理、模型/配置读取和账号用量刷新。
- 二维码配对：短期配对票据、设备授权、设备撤销和审计日志。
- 每台机器本地生成 CA，并用本机 CA 签发服务证书。CA 私钥只保存在用户本机，不随仓库分发。
- Web 管理页支持显式安装当前用户信任：
  - macOS：写入当前用户登录钥匙串。
  - Windows：写入当前用户受信任根证书存储。
- 提供稳定的服务端 public key hash，便于客户端做 HTTP 证书 pinning。
- 通过 Bonjour/mDNS 发布服务，并携带 TLS 身份元数据。
- 项目根目录管理，用于按桌面项目组织和创建会话。
- 媒体资产存储：上传文件、生成图片、本机文件引用和会话资产下载。
- 本地 Web 预览/代理会话的展示与清理。
- macOS LaunchAgent 开机登录自启动开关。
- Windows 已支持数据目录、Codex binary 探测、项目根目录系统选择器和证书信任安装；部分服务管理能力仍以 macOS 为主。

## 仓库结构

```text
.
├── mac-service/          # 桌面端服务源码、Web 管理页、测试和包配置
├── packages/protocol/    # 服务端依赖的共享协议/schema
├── package.json          # pnpm workspace 根配置
├── pnpm-workspace.yaml   # workspace 包列表
├── pnpm-lock.yaml        # 锁定依赖版本
└── tsconfig.base.json    # 共享 TypeScript 配置
```

本仓库不包含：

- 移动端应用源码。
- `dist/` 等构建产物。
- `mac-service/tmp/` 等本地探针、临时日志。
- `node_modules/`。

## 环境要求

- Windows 推荐使用 Node.js 20 LTS 或 22 LTS。
- Node.js 24 可能触发 `better-sqlite3` 原生依赖本地编译，需要额外安装 Visual Studio C++ Build Tools。
- pnpm 9.15.4，版本以 `packageManager` 字段为准。
- 本机需要可用的 Codex Desktop / App Server，或可被探测到的 Codex CLI binary。
- macOS 功能最完整。Windows 已有桌面平台适配、数据目录、Codex binary 探测和证书信任安装能力，但部分自启动和捕获能力仍是 macOS-first。

如需启用 pnpm：

```bash
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

## 安装步骤

最新 Release 说明：

```text
https://github.com/lyz1022/code-desktop-service/releases
```

克隆仓库：

```bash
git clone https://github.com/lyz1022/code-desktop-service.git
cd code-desktop-service
```

### Windows 快速安装

Windows 上推荐在仓库根目录运行轻量 PowerShell 安装脚本。脚本会检查 Node.js、通过 Corepack 准备 pnpm、验证 Codex CLI/App Server binary、安装依赖、构建 `@code/mac-service`，并在数据目录下生成本地启动脚本。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-desktop-service.ps1
```

如果 Codex CLI 没有被自动发现，可显式传入 Codex Desktop 安装的二进制路径：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-desktop-service.ps1 -CodexBin "C:\Users\<you>\AppData\Local\OpenAI\Codex\bin\<version>\codex.exe"
```

如果希望安装后立即启动服务，可追加 `-Start`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-desktop-service.ps1 -CodexBin "C:\Users\<you>\AppData\Local\OpenAI\Codex\bin\<version>\codex.exe" -Start
```

默认 Windows 数据目录为 `C:\Users\<you>\Documents\Codex\code-data`，生成的启动脚本为：

```text
C:\Users\<you>\Documents\Codex\code-data\start-code-desktop-service.ps1
```

生成的启动脚本默认将服务监听到 `0.0.0.0`，这样已配对移动端才能通过 Windows 电脑的局域网地址连接。请在 Windows 电脑本机通过 `https://localhost:37631` 打开管理页；如果移动端配对超时，请在 Windows Defender 防火墙中允许 Node.js 使用专用网络，或放行入站 TCP 端口 `37631`。

该脚本不会静默写入 Windows Root store，也不会注册自启动。证书信任仍需从本机 loopback 管理页手动安装；Windows 自启动和屏幕截图自动化当前仍未支持。

服务在 Windows 上启动后，管理页的“选择文件夹”项目根目录入口会打开 Windows 系统文件夹选择器。如果当前桌面会话无法弹出窗口，可以继续使用手动路径输入作为兜底。

移动端通过 Windows 项目根目录新建项目时，服务端会在创建文件夹前校验项目名。包含 Windows 保留字符（`< > " | ? *`）、以 `.` 结尾，或使用 `CON`、`PRN`、`AUX`、`NUL`、`CONIN$`、`CONOUT$`、`COM1`-`COM9`、`LPT1`-`LPT9` 等保留设备名的项目名会被拒绝；`con.txt` 这类带扩展名的保留设备名也会被拒绝。

安装依赖：

```bash
pnpm install --frozen-lockfile
```

运行类型检查：

```bash
pnpm -r typecheck
```

运行测试：

```bash
pnpm -r test
```

构建全部 workspace 包：

```bash
pnpm -r build
```

## 启动服务

开发模式：

```bash
pnpm --filter @code/mac-service dev
```

构建后的启动方式：

```bash
pnpm -r build
pnpm --filter @code/mac-service start
```

默认监听地址：

```text
https://0.0.0.0:37631
```

如果只想本机访问，可以绑定 loopback：

```bash
CODE_HOST=127.0.0.1 CODE_PORT=37631 pnpm --filter @code/mac-service dev
```

打开 Web 管理页：

```text
https://127.0.0.1:37631
```

安装本机 CA 信任前，浏览器会提示证书不受信任，这是预期行为。请在桌面电脑本机通过 `localhost` 或 `127.0.0.1` 打开管理页，并点击 `安装信任`，将本机生成的 CA 安装到当前用户信任存储。

安装信任前可以用下面命令检查服务健康状态：

```bash
curl -k https://127.0.0.1:37631/api/health
```

## 配置项

服务通过环境变量配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODE_HOST` | `0.0.0.0` | HTTPS 服务绑定地址。如只允许本机访问，使用 `127.0.0.1`。 |
| `CODE_PORT` | `37631` | HTTPS/WebSocket 端口。 |
| `CODE_DATA_DIR` | 平台默认目录 | SQLite、证书和媒体资产的持久化数据目录。 |
| `CODEX_BIN` | 自动探测 | 显式指定 Codex CLI/App Server binary 路径。 |
| `CODEX_IPC_SOCKET` | 未设置 | 可选 Codex IPC socket 路径。 |
| `CODE_PROJECT_ROOTS` | 空 | 允许管理的项目根目录，多个目录用英文逗号分隔。 |
| `CODE_LAUNCH_AGENT_DIR` | 平台默认目录 | 自启动服务目录。macOS 通常是 `~/Library/LaunchAgents`。 |
| `CODE_STARTUP_COMMAND` | `pnpm dev` | 写入 macOS LaunchAgent plist 的启动命令。 |

平台默认数据目录：

- macOS：`~/Library/Application Support/code`
- Windows：`%APPDATA%\code` 或 `%LOCALAPPDATA%\code`

轻量 Windows 安装脚本默认使用 `C:\Users\<you>\Documents\Codex\code-data`，除非显式传入 `-DataDir`。

示例：

```bash
CODE_HOST=127.0.0.1 \
CODE_PORT=37631 \
CODE_PROJECT_ROOTS="$HOME/Projects,$HOME/Work" \
CODEX_BIN="/Applications/Codex.app/Contents/Resources/codex" \
pnpm --filter @code/mac-service dev
```

## Web 管理页使用方法

管理页包含：

- 服务状态、进程 ID、运行时间、服务地址、证书模式和 CA 指纹。
- 当前用户本机 CA 信任安装。
- 二维码配对票据生成和备用配对文本。
- 已配对设备列表与撤销授权。
- Codex 预检状态。
- 项目根目录选择与管理。
- 审计日志展示。
- 媒体资产搜索、按项目分组展示、批量选择和删除。
- 本地 Web 预览会话列表与清理。
- macOS 登录后自启动开关。

安装信任接口只允许本机 loopback 管理请求调用。局域网远程设备即使知道接口和 header，也不能触发当前机器安装信任证书。

## 客户端配对和使用流程

1. 启动桌面端服务。
2. 在桌面电脑本机打开 Web 管理页。
3. 如果希望浏览器不再提示本地证书不受信任，点击安装本机 CA 信任。
4. 生成配对票据。
5. 使用可信客户端扫描二维码，或复制备用配对文本。
6. 客户端 claim 配对码并获得授权 token。
7. 客户端带 token 连接 WebSocket API。
8. 客户端即可读取项目/会话、创建或恢复 Codex 会话、上传/下载资产，并接收实时会话事件。

## HTTP API 概览

主要的管理和公开端点：

- `GET /`：Web 管理页。
- `GET /web/main.js`：Web 管理页脚本。
- `GET /api/health`：服务状态、候选服务地址、证书指纹、CA 指纹和 public key hash。
- `GET /api/codex-preflight`：Codex 运行时预检。
- `POST /api/pairing-ticket`：创建短期配对票据。
- `POST /api/pairing-claim`：claim 配对票据并获得设备 token。
- `POST /api/certificate/trust`：为当前用户安装本机 CA。需要管理 header，并且必须是 loopback 请求。
- `GET /api/startup` / `PUT /api/startup`：读取或修改自启动状态。
- `GET /api/project-roots` 及相关项目根目录接口。
- `GET /api/media-assets` 及相关媒体资产接口。
- `GET /api/local-web-sessions` 及相关本地 Web 会话接口。

WebSocket 端点：

```text
GET /ws
```

WebSocket 命令需要有效的已配对设备 token。

## 技术原理

### 进程模型

服务端是基于 Fastify 的 Node.js TypeScript 应用。HTTPS 路由和 WebSocket 连接运行在同一个进程中，持久化状态通过一层 repository 封装写入 SQLite。

### TLS 和本机信任

首次运行时，服务会在配置的数据目录下生成本机 CA，然后用该 CA 签发桌面服务证书。服务证书的 SAN 会覆盖：

- `localhost`
- `127.0.0.1`
- `::1`
- 主机名和 `.local` 主机名
- Windows `COMPUTERNAME` 和对应 `.local` 名称
- 非 internal 的局域网 IPv4 地址

已有 CA 材料在复用前会被校验：必须是 CA、仍在有效期内、具备 CA key usage，并且证书公钥和私钥匹配。已有服务证书同样会校验。SAN 变化时，服务会尽量复用已有服务私钥重新签发证书，使 SPKI public key hash 在本地网络变化后仍保持稳定。

证书指纹使用标准 DER certificate SHA-256。对客户端暴露的 `tlsPublicKeyHash` 是服务证书 SPKI public key 的 base64 SHA-256。

### 安全边界

- CA 私钥每台机器独立生成，不进入仓库。
- 安装 CA 信任不会自动执行，必须由用户在本机管理页明确点击。
- 安装信任只允许 `localhost`、`127.*` 或 `::1` 的 loopback 管理请求。
- 客户端必须通过配对票据获得设备 token。
- 审计日志会记录配对、证书信任、自启动、项目、媒体和设备管理操作。
- 本机文件引用资产会校验路径必须位于会话项目根目录内。

### Codex 集成

服务端会通过平台默认候选路径或 `CODEX_BIN` 查找 Codex binary，并通过 Codex Desktop / App Server 协议完成：

- 运行时预检；
- 模型列表读取；
- 运行配置读取；
- 会话创建和恢复；
- timeline 实时同步；
- 审批和用户输入处理；
- 账号用量与 rate limit 更新。

### 存储

持久化数据位于 `CODE_DATA_DIR`：

- `code-v1.sqlite`：保存会话、设备、配对/审计数据、项目根目录、运行配置、媒体元数据和本地 Web 会话。
- `certs/`：保存本机 CA、服务证书、服务私钥和证书元数据。
- `media-assets/`：保存上传文件、生成图片和本机文件引用快照。

### 平台适配层

桌面平台适配层隔离 OS 差异：

- macOS：
  - 数据目录为 `~/Library/Application Support/code`；
  - 支持 LaunchAgent 自启动管理；
  - 默认探测 Codex App / Homebrew 路径；
  - 支持本地捕获 runner。
- Windows：
  - 数据目录为 `%APPDATA%\code` 或 `%LOCALAPPDATA%\code`；
  - 默认探测 `codex.exe`、`codex.cmd`、`codex`；
  - 通过 `certutil.exe` 支持当前用户 CA 信任安装；
  - 自启动和捕获能力目前仍有限。

## 开发

运行服务端测试：

```bash
pnpm --filter @code/mac-service test
```

运行协议包测试：

```bash
pnpm --filter @code/protocol test
```

运行全部检查：

```bash
pnpm -r typecheck
pnpm -r test
```

## 说明

- 本仓库目前尚未包含 license 文件。如准备让第三方复用或再分发，建议先补充明确 license。
- 本公开仓库只包含服务端源码，不包含移动端应用源码。
