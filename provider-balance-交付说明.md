# provider-balance 交付说明

依据 `pi-agent-desktop-对PI-Desktop的插件化增强分析.md` 的 P0 结论实现。

## 交付物

| # | 内容 | 路径 | 大小 |
|---|---|---|---|
| 1 | 插件包 | `provider-balance/dist/local.provider-balance-0.1.0.piplug` | 88,250 字节 |
| 2 | 分析文档 | `pi-agent-desktop-对PI-Desktop的插件化增强分析.md` | — |
| 3 | 插件源码 | `provider-balance/`（main.js / lib/usage.js / views/index.html / manifest.json） | — |
| 4 | 离线测试 | `provider-balance/test-usage.cjs`（27 项）、`provider-balance/check-view.cjs`（12 项） | — |

**安装**：插件页 → **安装插件包** → 选 `.piplug`。
**开发迭代**：插件页 → `···` → **加载本地插件** → 选 `E:\code\ai-platform-amd64\pi-plug\provider-balance`。
（升级时不要用卡片上的 Reload 按钮——它会把新权限清单与 registry 记录求交集，静默丢新增项。）

## 做了什么

**问题**：PI-Desktop 生态里没有「我的 API 还剩多少钱」这个能力。宿主只统计 token 数（`pi.usage.listTurns`），官方 `usage-dashboard` 插件也只把这堆 token 画成热力图。用户要知道余额只能挨个开供应商网页后台。

**方案**：把 pi-agent-desktop 的 `lib/provider-usage.ts`（九家供应商的余额/配额端点表 + 归一化逻辑，374 行 + 74 行测试）移植为 PI-Desktop 插件。

### 关键适配：凭据从哪来

pi-agent-desktop 在 Next.js 服务端用 pi SDK 的 `ModelRuntime` 拿凭据。**PI-Desktop 插件拿不到**——`spec/07-plugins/03-plugin-api.md` 写死 "No secrets"，`pi.models.list` 只返回已登录的模型行。

改为直接读 pi 的 agent 目录（`auth.json` + `models.json`）。这不是自创路径：**PI-Desktop 自己就是这么定位凭据的**（`packages/agent-runtime/src/native-pi-session.ts:310` → `join(homedir(), ".pi", "agent")`，可用 `PI_CODING_AGENT_DIR` 覆盖）。本机 `local.trajectory`、`local.token-meter`、官方 `pi.token-insights` 用的是同一取舍。

### 相对上游的三处刻意差异

| # | 差异 | 原因 |
|---|---|---|
| 1 | 归一化不抛错，返回 `{ok:false, reason}` | 上游抛异常由 Next.js 路由兜成 `query-failed`；插件里抛错会打断整批查询，一家失败不该让其他家的结果消失 |
| 2 | 新增 origin 闸（`isOfficialOrigin`） | 上游用 `ModelRuntime` 校验凭据 origin；插件进程没有那个运行时。自定义 `baseUrl` 的供应商直接拒绝查询，不把 key 发到第三方域名 |
| 3 | 新增「本机另有 N 个供应商不在此看板内」盘点 | 本机长期挂聚合网关（实测：apigoto / longcat / a1888）时，只看九行「未登录」会以为插件坏了 |

第 3 条来自实测：本机 `~/.pi/agent/auth.json` 只有 `apigoto`，`models.json` 有 `longcat`/`a1888`/`apigoto`，**九家官方供应商一个凭据都没有**。没有这条盘点，插件在本机就是九行「未登录」，等于没用。

## 验证结果

### 1. 逻辑测试：27 项全通过

```
node test-usage.cjs
```

覆盖：
- **归一化（用上游夹具）**：Codex 双窗口、MiniMax 的 count 语义与 `status===3` 不限量、OpenCode Go 窗口、DeepSeek 金额精度、OpenRouter key limit、Moonshot 失败码、Vercel、空载荷、非法载荷、窗口标签
- **origin 闸**：接受官方、拒绝第三方、拒绝非法 URL、拒绝 undefined；MiniMax 双端点分流
- **凭据解析**：auth.json api_key 优先 → OAuth access → models.json 回退 → 无凭据
- **端到端（假宿主）**：无凭据时不发请求、key 只出现在 `Authorization` 头且不出现在 URL、自定义 origin 被拒绝且不发请求、一家 429 不影响另一家成功且 `Retry-After` 原样带回、非 JSON 响应判 `INVALID_JSON`、`net.fetch` 抛错兜成 `query-failed`、**缓存快照不含凭据**、本机未支持供应商盘点、未知通道、外观读取与降级

### 2. 视图自检：12 项全通过

```
node check-view.cjs
```

覆盖：内联 JS 可解析（13,796 字符）、9 个 DOM id 全部存在、无调试残留、**视图调用的通道与插件进程处理的分支双向一致**（这条查出并修掉了一个死通道 `balance.providers`）、视图不写设置/不联网/不用 XHR/localStorage、manifest 与文件一致、`net.domains` 已声明、每个权限都在使用。

### 3. 宿主官方工具

```
PluginCheck  → passed，6 files would be packaged
               1 warning: net.fetch 需显式授权（预期）
PluginPack   → local.provider-balance-0.1.0.piplug (88,250 bytes, 7 files)
               sha256 309c7e8d6ac6bf4fae59272a224304b2376113c9774750213ce480e2df229413
```

打包内容已核对：`README.md`、`check-view.cjs`、`lib/usage.js`、`main.js`、`manifest.json`、`test-usage.cjs`、`views/index.html`。

### 4. 未验证的部分（如实说明）

- **真实网络查询未跑通**：本机没有任何一家目标供应商的凭据（见上），所以九个端点里没有一个被真正请求过。归一化逻辑用上游夹具验证，请求构造用假宿主验证，但**「拿真 key 打真端点」这条链路没有端到端跑过**。这是环境限制，不是实现缺陷；你装上并在任一目标供应商登录后即可验证。
- **视图在宿主里的实际渲染未验证**：工作面板视图需要 PI-Desktop 加载插件才能看。静态自检覆盖了语法、DOM id、通道一致性，但没有真实渲染截图。
- **`net.domains` 白名单未在真实网关上验证**：假宿主不校验域名。白名单按 `spec/07-plugins/02-plugin-manifest-schema.md` §5.3 的格式填写（裸主机名、无 scheme/port/path），9 条与端点表一一对应。

## 权限

| 权限 | 风险 | 用途 |
|---|---|---|
| `ui.view` | 低 | 工作面板视图 |
| `net.fetch` | **高** | 请求九家供应商的官方端点，受 `net.domains` 白名单约束 |

**没有** `fs.*`、`session.read`、`agent.tool.register`、`clipboard.*`。
读凭据走进程内原生 Node fs（宿主的权限网关不介入原生 Node 调用），这是本机既有插件的共同取舍，已写进 manifest 的 `safetyNotes`。

## 已知限制

1. 只覆盖九家官方端点。聚合网关与自建端点没有公开余额接口。
2. 凭据只从 `~/.pi/agent/{auth.json,models.json}` 读。存在环境变量或系统钥匙串里的读不到，会显示「未登录」。
3. 视图收不到 `appearance:changed` 推送（工作面板视图的已知行为），主题靠 5s 轮询对齐。

## 后续建议（P1，未实现）

分析文档第 2、3 节列了两项 P1：

- **`local.mcp-importer`**：pi-agent-desktop 的 MCP 工具链有 24 个文件、414,832 字节；PI-Desktop 只有 7 来源扫描，缺「从 URL/粘贴 JSON 导入」「连接测试」「OAuth 登录」「导入撤销」。
- **工作区记忆**：切项目恢复上次打开的会话（pi-agent-desktop `lib/workspace-memory.ts`）。PI-Desktop 的 `lastSessionDate()` 只是排序函数，不是恢复。可用 `workspace:changed` + `pi.plugin.setSettings` 实现，无需 `fs.*`。

## 来源与许可

端点表、归一化规则、测试夹具移植自 `abcwyc/pi-agent-desktop` 的 `lib/provider-usage.ts` 与 `lib/provider-usage-ids.ts`（MIT）。上游注明其查询格式参考 `@narumitw/pi-usage`（MIT, Copyright (c) 2026 narumiruna）。
