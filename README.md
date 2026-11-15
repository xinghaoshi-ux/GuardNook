# GuardNook

macOS 与 Windows 双端的 Claude / Codex 网络状态面板：显示当前本机网络环境，按需启用固定出口守护，并在出口不符或链路失效时阻断受保护流量。

## 目录结构

| 路径 | 内容 |
|---|---|
| `guardnook/` | macOS 版（Swift + Node.js 守护服务），需 macOS 15+ |
| `guardnook-windows/` | Windows 版（Electron），开发态复用 `guardnook/Service/claude-guard` |
| `THIRD-PARTY-NOTICES.md` | 第三方组件声明 |

## 构建

**macOS**

```bash
cd guardnook
swift build            # 或 open Package.swift 用 Xcode 打开
```

打包脚本见 `guardnook/Scripts/`。

**Windows**

```bash
cd guardnook-windows
npm install
npm run dev              # 开发运行
npm run package:win      # 生成 NSIS 安装包与 zip
```

## 关于脱敏

本仓库是分享用版本：文本文件中的 IPv4 地址已统一替换为 `<IP>`，包括守护期望的固定出口。首次使用需要在 `guardnook/Service/claude-guard/config.mjs` 的 `EXPECTED_IP` 以及运行期配置里填入实际出口地址，否则守护不会放行任何 Claude 流量。

`127.0.0.1` 与 `0.0.0.0` 属于本机回环与未指定地址，未做替换。

## 许可

见 `guardnook/LICENSE` 与 `THIRD-PARTY-NOTICES.md`。
