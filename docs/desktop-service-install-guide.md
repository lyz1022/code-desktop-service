---
title: 桌面服务安装与配对说明
---

# 桌面服务安装与配对说明

本文档用于应用内配对提示、AppGallery 审核备注和 GitHub 发布页引用。

公开链接：

- 隐私政策：<https://lyz1022.github.io/code-desktop-service/privacy-policy-zh.html>
- 桌面服务安装说明：<https://lyz1022.github.io/code-desktop-service/desktop-service-install-guide.html>
- GitHub Release：<https://github.com/lyz1022/code-desktop-service/releases>

## 桌面端仓库

```text
https://github.com/lyz1022/code-desktop-service
```

## Windows 快速安装

推荐在 Windows 上使用仓库内的轻量 PowerShell 脚本。它会检查 Node.js 20/22、准备 pnpm、验证 Codex CLI/App Server、安装依赖、构建桌面服务，并在数据目录下生成本地启动脚本。

```powershell
git clone https://github.com/lyz1022/code-desktop-service.git
cd code-desktop-service
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

脚本默认数据目录为：

```text
C:\Users\<you>\Documents\Codex\code-data
```

安装完成后会生成启动脚本：

```text
C:\Users\<you>\Documents\Codex\code-data\start-code-desktop-service.ps1
```

脚本不会静默写入 Windows Root store，也不会注册自启动。证书信任仍需在本机浏览器打开 `https://localhost:37631` 后，从管理页手动安装；Windows 自启动和屏幕截图自动化当前仍属于未支持能力。

服务启动后，Windows 管理页里的“选择文件夹”会打开系统文件夹选择器，用于添加项目根目录；如果当前桌面会话无法弹出窗口，也可以使用手动输入路径作为兜底。

## 推荐安装提示词

用户可以在桌面端 Codex 中输入：

```text
请帮我从 GitHub 仓库 https://github.com/lyz1022/code-desktop-service 安装并启动 code-desktop-service
```

英文提示词：

```text
Please install and start code-desktop-service from the GitHub repository https://github.com/lyz1022/code-desktop-service
```

## 配对步骤

1. 在 Mac 或 Windows 上安装并启动 `code-desktop-service`。
2. 在桌面浏览器打开 `https://localhost:37631`。
3. 如果浏览器提示连接不安全，在管理页右上角点击“安装信任”，按系统提示安装本机信任证书。
4. 确认鸿蒙设备和桌面端处于同一网络。
5. 在鸿蒙应用中点击“扫码配对”，扫描桌面管理页上的二维码。
6. 核对桌面端名称和 TLS 指纹后，点击“确认配对”。

## 审核人员说明

本应用没有云端测试账号。核心功能依赖审核人员在本机安装桌面服务后扫码配对。若审核环境无法安装桌面服务，可通过应用市场开发者联系方式或 GitHub Issues 联系开发者获取演示协助。

## 安全说明

- 每台桌面设备首次运行时生成自己的本地 CA，仓库不携带共享 CA 私钥。
- 桌面管理页只允许在本机 loopback 地址执行“安装信任”操作。
- 移动端配对时会保存桌面端证书身份信息，并在后续连接中校验已配对桌面身份。
