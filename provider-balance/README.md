# 供应商余额看板（local.provider-balance）

把「我的 API 还剩多少钱、配额用了多少、什么时候重置」集中到一个工作面板视图里。

数据来源是九家供应商**官方的余额/配额端点**，不是本地估算。

## 这个插件解决什么问题

PI-Desktop 自己不算钱也不查额度：宿主只统计 token 数（`pi.usage.listTurns`），
官方 `usage-dashboard` 插件也只把这堆 token 画成热力图。**"余额还剩多少" 在
PI-Desktop 生态里是空白**——你只能挨个打开供应商的网页后台看。

pi-agent-desktop（[abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop)）
把这个能力做进了它的 Next.js 服务端（`lib/provider-usage.ts`，410 行实现 +
74 行测试）。本插件把那套端点表与归一化逻辑移植过来，改成 PI-Desktop 插件。

## 支持的供应商

| 供应商 | 端点 | 返回什么 |
|---|---|---|
| DeepSeek | `/user/balance` | 总余额 / 赠金 / 充值余额（CNY 或 USD） |
| OpenRouter | `/api/v1/key` | Key 上限、剩余额度、今日/本周/本月/累计消费 |
| Moonshot AI（国际/国内） | `/v1/users/me/balance` | 可用 / 代金券 / 现金余额 |
| MiniMax（国际/国内） | `token_plan/remains` 或 `account/query_balance` | 按模型的滚动窗口与每周配额；或账户余额 |
| Vercel AI Gateway | `/v1/credits` | 信用余额、累计消费 |
| OpenCode Go | `/zen/go/v1/usage` | 滚动 / 每周 / 每月用量百分比与重置时间 |
| OpenAI Codex | `/backend-api/wham/usage` | 主/次窗口已用百分比、重置时间、credits |

**端点表与上游逐条一致**（`lib/provider-usage.ts:53-63`）。MiniMax 按 token 前缀
（`sk-api-`）在两个端点间分流，也是上游的行为。

## 凭据从哪来（重要）

插件进程**拿不到**宿主的凭据网关：`pi.models.list` 只返回已登录的模型行，
明确不带 key（spec 07-plugins §3 写死 "No secrets"）。所以凭据从本机 pi 的
agent 目录只读解析：

```
~/.pi/agent/auth.json      →  { "<provider>": { type: "api_key", key: "..." } }
                              { "<provider>": { type: "oauth", access: "..." } }
~/.pi/agent/models.json    →  { providers: { "<provider>": { apiKey, baseUrl } } }
```

路径与宿主一致：PI-Desktop 自己在 `packages/agent-runtime/src/native-pi-session.ts:310`
就把 agent 目录定为 `join(homedir(), ".pi", "agent")`（可用 `PI_CODING_AGENT_DIR` 覆盖）。

解析优先级：`auth.json` 的 api_key → `auth.json` 的 OAuth access token →
`models.json` 的 apiKey。

## 安全边界

| 项 | 做法 |
|---|---|
| 读凭据 | 只读 `auth.json` / `models.json`，**从不写回**，不复制到任何位置，不进日志 |
| 出口 | 走宿主的 `pi.net.fetch`，受 `manifest.net.domains` 白名单约束（9 个官方域名） |
| 自定义域名 | 配了非官方 `baseUrl` 的供应商**直接拒绝查询**，不把 key 发到第三方 |
| 缓存 | 快照里只有余额、配额百分比、重置时间；**没有** key / token / 账号标识 / 消息正文 |
| 权限 | 只声明 `ui.view` + `net.fetch`。没有 `fs.*`、`session.read`、agent 工具、剪贴板 |

「自定义域名拒绝」是相对上游**新增**的一道闸：上游在服务端跑，用
`ModelRuntime` 解析凭据并校验 origin；插件进程没有那个运行时，所以这道校验
由插件自己做（`lib/usage.js` 的 `isOfficialOrigin`）。本机常见的聚合网关
（apigoto、longcat、a1888 等）没有公开余额接口，会被列在面板底部说明，而不是静默失败。

## 用法

- **工作面板视图**：右侧工作面板 → 「余额」标签。首屏读缓存，点「刷新」查询。
- **命令面板**：搜「余额看板」→「刷新全部供应商」，完成后弹 toast 报告成功家数。
- 视图底部显示数据新鲜度；超过 5 分钟标注为陈旧。

## 与上游的行为差异（3 处，刻意的）

1. **归一化不抛错**，改成返回 `{ok:false, reason}`。上游在服务端抛异常、由
   Next.js 路由兜成 `query-failed`；插件里抛错会打断整批查询，一家失败不该
   让其他家的结果消失。
2. **新增 origin 闸**（见上）。
3. **新增「本机另有 N 个供应商不在此看板内」的盘点**。本机长期挂着自定义
   供应商时，只看九行「未登录」会让人以为插件坏了。

## 验证

```powershell
cd provider-balance
node test-usage.cjs    # 27 项：归一化（用上游夹具）/ origin 闸 / 凭据解析 / 端到端（假宿主）
node check-view.cjs    # 12 项：视图语法、DOM id、通道对应、权限一致性、边界
```

测试用假的 `pi` 全局加载 `main.js`，覆盖了：无凭据时不发请求、key 只出现在
`Authorization` 头、自定义 origin 被拒绝、429 的 `Retry-After` 原样带回、
一家失败不影响其他家、缓存里不含凭据。

## 已知限制

- **只覆盖九家官方端点**。聚合网关与自建端点没有公开余额接口，查不到。
- 只读 `~/.pi/agent` 下的凭据文件；凭据存在别处（如环境变量、系统钥匙串）时
  读不到，会显示「未登录」。
- 视图收不到 `appearance:changed` 推送（工作面板视图的已知行为），主题靠 5s 轮询对齐。

## 来源与许可

端点表、归一化规则与测试夹具移植自 pi-agent-desktop 的 `lib/provider-usage.ts`
与 `lib/provider-usage-ids.ts`（MIT）。上游注明其查询格式参考
`@narumitw/pi-usage`（MIT, Copyright (c) 2026 narumiruna）。
