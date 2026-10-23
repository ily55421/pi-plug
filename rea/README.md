# REA 逆向工程（local.rea）

把 [REA（Reverse Engineer Anything）](https://github.com/morluto/rea) 接入 PI-Desktop。

装好之后，REA 的 **170 个逆向工程工具**直接进入本客户端的工具表：Agent 能用
`ToolSearch` 发现它们，也能直接调用；右侧工作面板另有一个「REA 工具箱」视图，
可以分组浏览、搜索并抄走调用示例。

## 装完就能用

1. **插件 → 加载本地插件**（或安装 `.piplug`），选本目录。
2. 首次使用前，执行一次命令 **「REA：准备运行时（下载 rea-agents）」**
   （命令面板里搜 `REA`）。它把 `rea-agents@6.4.0` 装进插件自己的数据目录。
   - 已经全局装过的话可跳过：`npm install -g rea-agents@6.4.0`。
3. 重载插件。工具表里出现 `plugin_local_rea_rea_*` 即接入成功。

## 三条命令（命令面板搜 `REA`）

| 命令 | 作用 | 什么时候用 |
| --- | --- | --- |
| **REA：检查运行时状态** | 报告找到哪份 REA、版本、装在哪个路径、走的是哪条候选 | 工具没出现时先跑它，一眼看出是「运行时没装」还是「装了但没被采用」 |
| **REA：准备运行时（下载 rea-agents）** | 把 `rea-agents@6.4.0` 装进插件自己的数据目录 | 状态检查说「未找到运行时」时跑一次，然后重载插件 |
| **REA：复制全部工具名到剪贴板** | 把 170 个可调用名（`plugin_local_rea_rea_*`）写成一行一个 | 想粘到别处（另一个 agent、脚本、文档）时 |

**面板怎么打开**：插件进程**没有**打开停靠视图的 API，所以没有「打开面板」命令。
用 `Mod+J` 切到工作面板，再选「**REA 工具箱**」。

## 怎么用

对 Agent 直接说需求即可，例如：

```text
看一下 D:\apps\example 这个 Electron 应用，搜索功能是怎么实现的，给出证据。
```

也可以先让 Agent 查目录再动手（不依赖 MCP 连接）：

```text
rea_tools { "query": "decompile" }
rea_tools { "group": "javascript" }
rea_tools {}                        → 全部 170 个工具，按能力域分组
```

`rea_tools` 会给出每个工具的**可调用名**（`clientTool`）、参数名与必填项。

## 工具覆盖范围

| 能力域 | 代表工具 |
| --- | --- |
| 原生二进制 | `open_binary`、`binary_overview`、`analyze_function`、`procedure_pseudo_code` |
| JavaScript / Electron | `analyze_javascript_application`、`trace_application_feature`、`compare_source_to_bundle` |
| .NET 托管程序集 | `inspect_managed_artifact`、`inspect_managed_members` |
| Android / 设备 | `inspect_android_package`、`search_android_classes`、`read_adb_logcat` |
| 网站与抓包 | `inspect_web_page`、`inspect_web_network_capture`、`capture_browser_scenario` |
| 固件 / EVM | `inspect_firmware_regions`、`extract_firmware`、`inspect_evm_interface` |
| 证据与对比 | `export_evidence_bundle`、`compare_artifacts`、`verify_reconstruction` |

原生深度分析需要本机装好 Hopper、Ghidra 或 IDA 之一；静态 JavaScript 与 .NET
检查不需要任何分析引擎。

## 为什么用启动器而不是 npx

宿主的 MCP 握手有 **10 秒硬超时**。握手失败的工具**不会**注册进工具表，也就
不会出现在 Agent 的工具列表里。实测：

| 启动方式 | 握手耗时 | 结果 |
| --- | --- | --- |
| `npx -y rea-agents@6.4.0 mcp` | 9–13 秒 | 超时边缘，经常失败 |
| `node launcher.cjs`（本插件） | 4–7 秒 | 稳定通过 |

所以 `launcher.cjs` 不用 npx，而是自己定位一份**已安装**的 REA，用 node 直接
拉起它的 MCP 入口。搜索顺序：

1. `REA_PACKAGE_ROOT` 环境变量
2. 插件数据目录下的运行时（由「准备运行时」命令安装）
3. 全局 `node_modules`（`npm install -g rea-agents`）
4. npx 缓存

找不到时启动器把修复方式写到 stderr，宿主会记进插件审计日志。

## 面板

「REA 工具箱」停靠视图提供：

- **分组筛选**：11 个能力域，带工具计数
- **全文搜索**：匹配工具名、标题、说明、参数名
- **工具详情**：参数名/类型/是否必填、枚举值、只读与破坏性标记
- **调用示例**：每个工具给出一段可直接抄的调用片段
- **复制清单**：一键复制全部 170 个工具的可调用名

面板数据来自随包发布的离线目录（`views/catalog.js`，导出自 REA 6.4.0 的真实
MCP 工具表），所以断网、MCP 未连上时同样能查。

## 权限与数据

| 权限 | 用途 |
| --- | --- |
| `ui.view` | 右侧工作面板的「REA 工具箱」视图 |
| `agent.tool.register` | 注册 `rea_tools` 离线目录查询工具 |
| `agent.prompt.inject` | 注入 `skills/rea-workflow.md` 工作流技能 |
| `mcp.server.local` | 启动 REA 的本地 stdio MCP 服务器 |

本插件**不申请** `fs`、`net`、`clipboard` 权限：

- 目录数据打包在插件内，由视图直接 `<script>` 加载，不走文件读取。
- 插件自身不发起网络请求；唯一联网动作是**你主动触发**的「准备运行时」命令，
  它调用本机 npm 下载 `rea-agents`。
- REA 在本地分析你指定的目标，本插件只负责把工具调用转给它。

## 结构

```text
manifest.json          身份、权限、contributes（含 mcpServers 声明）
main.js                插件进程：rea_tools 工具 + 三条命令
launcher.cjs           MCP stdio 启动器（绕过 npx 超时）
catalog.json           离线工具目录（供 main.js 读取）
skills/rea-workflow.md Agent 工作流技能
views/index.html       工具箱视图
views/panel.css        视图样式
views/panel.js         视图逻辑
views/catalog.js       离线目录（供视图读取）
```

## 排障

| 现象 | 处理 |
| --- | --- |
| 工具表里没有 `plugin_local_rea_rea_*` | 执行「REA：准备运行时」，再重载插件 |
| 提示找不到 Node.js | 先装 Node.js（宿主也只允许已安装的 Node） |
| 原生分析报 provider 不可用 | 装 Hopper / Ghidra / IDA 之一，或改用静态 JS/.NET 检查 |
| 面板能开但工具调用失败 | 用 `rea_tools` 确认工具名与参数拼写 |

## 许可

REA 本体为 MIT 许可，见 [morluto/rea](https://github.com/morluto/rea)。
本插件仅做接入，不含 REA 源码。
