# GuardNook for Windows

Windows 版保留顶部悬浮面板、按日待办、随手记、应用启动器、北京时间、独立网络探测与 Claude 固定出口守护。基于 Electron 和现有 GuardNook 守护核心，运行组件随包附带，无需另装 Node.js。此版本为首次 Windows 移植版 `0.2.8-win.1`。

## 安装和日常使用

支持 Windows 10 / 11 x64。运行 `*-setup.exe`，可选择安装目录；也可以解压 ZIP 后运行其中的 `GuardNook.exe`。ZIP 必须完整解压，不能只拷贝 EXE。退出应用后再更新或移动安装目录。

面板位于屏幕工作区顶部中央。鼠标停留在收起的小条上自动展开；点击顶部减号收起。托盘菜单提供展开、收起和退出；快捷键为 `Ctrl + Alt + Space`。点击菱形按钮可固定展开。设置中可选择显示器、外观、北京时间和开机自动启动。关闭面板只是收起，托盘“退出”才会结束应用。开机启动使用 Windows 当前用户登录项，不创建管理员服务。

待办可选择日期；未完成的过去待办在下次使用时结转到今天，已完成历史和未来计划保留。随手记自动保存到本机。设置中的导出按钮可备份待办与随手记，导出不含节点密钥。数据默认位于 `%APPDATA%\GuardNook`，目录限定当前用户和 SYSTEM 访问。卸载前请自行备份需要保留的数据。

启动器从当前用户和公共开始菜单读取快捷方式，并枚举 Microsoft Store 应用；支持搜索、添加 EXE / LNK、自建文件夹、重命名和解散文件夹。拖入文件夹即可归类；按名称排序时拖到另一应用上新建文件夹，自定顺序时拖动调整排列。应用卡片的“⋯”也可移动归类。安装或删除软件后点击刷新。Windows 开始菜单查询失败时保留已加载列表，可手动添加应用。

## 配置 Claude 守护

1. 安装并启动 Clash Verge / Mihomo，加载你自己的订阅。启用本机 `external-controller`，默认地址为 `http://127.0.0.1:9090`；若有密钥，在配置页填写。此处是控制接口，不是 HTTP / mixed 代理端口。
2. 在“Claude 守护 → 配置节点”读取节点，选择具体固定节点，填写你自己的实际出口 IPv4。没有内置用户节点、订阅、密钥或默认允许 IP。
3. 若已有 Clash 全局扩展脚本，选择接入 GuardNook **之前**的原始 JS。已有原脚本会保留，不能使用已经生成的守护脚本再次生成。再次保存配置默认沿用原始脚本。
4. 保存配置后点击“显示生成的脚本”，在 Clash 全局扩展脚本中导入 `GuardNook-Clash.js`，保存并重载。脚本含本机网关凭据，不要分享或上传。应用不会自动修改或重载 Clash。
5. 保持 Clash 的“规则”模式并开启 TUN，然后点击“启用保护”。Windows 版默认要求 TUN；固定节点链、规则和实际 IPv4 连续验证通过后，网关才在短租约内放行。动态出口、规则变化、控制接口失联或 TUN 关闭会阻断。手动阻断跨重启保留。
6. “应用启动时开始验证并启用保护”与“开机自动启动”分别设置。前者默认关闭，保存配置本身不会宣称保护已完成。

默认端口：客户端入口 `18901`、私有探测 `18903`、守护网关 `18904`，配置中的面板预留端口 `18791`。Windows 界面通过隔离的进程通信读取本应用的守护状态，不开放额外 HTTP 面板。所有端口配置必须互不相同，网关只监听本机。

Windows 规则覆盖 `Claude.exe`、`claude.exe`、`claude-code.exe`、`Claude Helper.exe` 以及 Claude 目录内的相关进程，加入受保护 UDP 拒绝和 IPv6 API 段拒绝。进程识别以 Mihomo 实际上报为依据，需相关流量进入其内核；其他 VPN、虚拟机、远程 MCP 和绕过 Clash 的连接不能仅靠此应用阻断。域名规则、客户端路径、DNS / 浏览器泄漏证据分别显示，未实测项目保持未知。Windows 版不迁移 Mac 的 ClaudeGuard 服务，也不修改 macOS 的应用数据。

首页 Claude、Codex、IPv4 和 Cloudflare 分别按 Windows 当前系统代理 / PAC / VPN / TUN 环境发起请求，不把节点配置值显示成实测值。匿名 HTTPS 通过不代表账号登录或 API 调用通过。浏览器泄漏和系统 DNS 泄漏未做主动测试。需要在实际 Windows 网络环境验证进程识别、TUN 和路径覆盖。

退出 GuardNook 会停止它管理的网关，已接入 Clash 的保护流量随之失败关闭；重启后按配置重新验证。需要取消接入时，在 Clash 恢复接入前保存的原始脚本并重载。不要直接删除生成的配置而保留 Clash 中的守护分流。

本次构建未使用 Windows 代码签名证书，系统可能显示未知发布者。首次 Windows 移植包已做静态检查、跨平台核心回归与本地 Electron 启动验收，尚未在真实 Windows 电脑完成安装、应用启动、登录启动及 TUN 端到端验收。

## 源码构建

在仓库根目录安装 workspace 依赖后：

```sh
cd apps/guardnook-windows
npm test
npm run dev
npm run package:win
```

`scripts/stage.mjs` 每次打包复制当前 `../guardnook/Service`，排除测试和 fixtures，不复制个人配置。`assets/icon.ico` 来自现有 `../guardnook/Assets/AppIcon.png`。Windows 包内不含原生 Swift / AppKit 模块。开发环境可以在 macOS 上测试界面和核心；开始菜单扫描、Store 应用启动和 Windows 登录项需在 Windows 验收。

使用 MIT 许可证；Electron / Chromium 等运行组件许可证随发行包附带。
