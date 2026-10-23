---
name: REA 逆向工程
description: 需要看懂已发布的二进制、Electron/JavaScript 应用、.NET 程序集、Android APK、固件或网站行为时使用；包括反编译、特征追踪、版本对比与重构。仅分析源码仓库的普通架构问题不要触发。
---

# 用 REA 做逆向工程

本插件已把 **REA（Reverse Engineer Anything）** 的本地 MCP 服务器接入本客户端。
它的工具会出现在工具表里，名字形如：

```
plugin_local_rea_rea_<工具名>
```

例如 `plugin_local_rea_rea_binary_overview`、`plugin_local_rea_rea_analyze_javascript_application`。

## 先查目录，再调工具

调 REA 工具前，先用 **`rea_tools`**（本插件注册的离线目录工具）确认工具名与参数：

```
rea_tools {}                          → 全部 170 个工具，按能力域分组
rea_tools { "query": "decompile" }    → 按关键词过滤
rea_tools { "group": "javascript" }   → 只看某个域
rea_tools { "group": "native", "limit": 20 }
```

`rea_tools` 读的是打包在插件里的目录，不联网、不碰文件系统，因此即使 MCP 服务器
还没连上也能用。返回的每条记录都带 `clientTool`（可直接调用的完整工具名）、
`args`（参数名与类型，带 `?` 的是可选）与 `required`。

## 按目标类型选第一个工具

| 目标 | 起手工具 |
| --- | --- |
| 原生可执行文件 / 库 / 分析数据库 | `open_binary`，之后用 `binary_overview`、`analyze_function`、`procedure_pseudo_code` |
| ASAR 或已解包的 JavaScript / Electron 目录 | `analyze_javascript_application` |
| 归档包（ZIP / APK / IPA / MSIX / DMG）成员清点 | `open_binary` + `inspect_artifact` |
| .NET 托管程序集 | `inspect_managed_artifact` |
| Android APK 的类与方法 | `inspect_android_package`，再按需用 `search_android_classes`、`inspect_android_method` |
| 固件镜像 | `inspect_firmware_regions`；要解包用 `extract_firmware`（输出目录必须由调用方指定） |
| 已打开的浏览器页面 | `list_browser_targets` |
| 已打开的 Electron 运行时 | `list_electron_targets` |
| HAR / mitmproxy 抓包 | `inspect_web_network_capture` |
| PE 资源（图标、版本信息等） | `inspect_pe_resources` |
| 显式的 EVM 字节码 | `inspect_evm_interface`（需 `raw` 或 `hex` 编码） |

原生深度分析需要本机已装 Hopper、Ghidra 或 IDA 之一。静态 JavaScript 与 .NET
检查不需要任何分析引擎。**先查目标类型对应的工具是否可用**：用
`binary_session {}` 看 `result.tool_availability`，它会给不可用的原因与补救方式。

## 工作方式

1. **摘要优先**：大目标先要摘要，别一上来拉全量。JavaScript 应用或未知大小的
   ELF 用 `"detail": "summary"`，再用 `inspect_analysis_view` 看保留的证据。
2. **结论必须能追溯到证据**：REA 的返回里带 Evidence ID。区分「观察到的」、
   「推断的」与「未知的」，引用 Evidence ID，保留它给出的限制与覆盖范围。
3. **静态分析不等于执行**：不要暗示静态分析观察到了运行行为。运行时要执行目标，
   只在静态证据答不了、且本机确实具备该运行时环境时才用。
4. **别重复劳动**：同一个分析不要跑第二遍。已有会话、已有证据优先复用；
   被拒绝的调用在输入或阻塞原因改变之前不要重试。
5. **收尾**：原生会话用 `close_binary` 关掉；结论用平实语言讲清，并区分
   「观察到的行为」与「你为实现所做的设计选择」。

## 连接与排障

MCP 服务器在**首次调用时**启动，第一次要等几秒（加载 REA 运行时）。若工具列表里
没有 REA 工具：

- 确认插件 `local.rea` 已启用，且它申请了 `mcp.server.local` 权限。
- 本机必须装好 Node.js；REA 运行时需已就位（`rea-agents` 装在全局或插件数据目录）。
- 先跑命令「REA：检查运行时状态」定位问题；它报「未找到运行时」时，让用户执行「REA：准备运行时（下载 rea-agents）」，然后重载插件。
- 面板「REA 工具箱」会显示声明了哪个服务器与目录里的工具总数。

也可以用 `rea_tools` 兜底：它不依赖 MCP 连接，能告诉你正确的工具名与参数。

## 边界

- REA 在**本地**分析你指定的目标；本插件只负责把调用转过去，不改变 REA 的能力范围。
- 只分析你有权分析的目标。REA 是合法的逆向工程研究工具，使用者自行负责取得授权
  并遵守适用法律。
- 分析大型目标会消耗较多上下文：优先用摘要 + 分页视图，必要时
  `export_evidence_bundle` 把完整记录写到文件。
