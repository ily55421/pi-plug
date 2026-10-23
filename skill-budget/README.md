# Skill Budget —— 技能广告预算

> `local.skill-budget` v0.2.0 · 只申请一项权限：`agent.extension`

PI-Desktop 把每个技能的 **id + 名称 + 完整 description** 原样拼进系统提示。`skill` 的描述可以长到几百字，几十个技能叠起来就是一笔持续开销——而且**宿主按设计不做去重**。

证据：`packages/agent-runtime/src/plugin-skills-prompt.ts` 里只有一个 `map`，没有按 id 去重，也没有近重复检测。所以同一个技能从两个来源装进来时，两条会同时出现在提示里。

这个插件做两件事：**先说清成本，再让你决定要不要动手**。

---

## 提供的东西

| 类型 | 名称 | 说明 |
|---|---|---|
| 工具 | `skill_budget_audit` | 只读审计：技能数、估算 token 占比、最占位的条目、同 id 重复、近重复簇 |
| 命令 | `/skill-budget` | 手动触发一次摘要（不依赖模型去调工具） |
| 事件 | `before_agent_start` | **可选**按 id 去重技能段，默认关闭 |

---

## 报告长什么样

```
Skills advertised: 15
Skills section: ~221 tokens (881 chars), about 97.8% of the whole system prompt (~226 tokens).
Descriptions alone: ~165 tokens.
(Token counts are estimates, not tokenizer-exact.)

Heaviest entries (top 3):
- p/s0: ~14 tokens
- p/s1: ~14 tokens
- p/s2: ~14 tokens

Near-duplicate clusters (different ids, near-identical descriptions):
- keep p/s0; 9 other(s): p/s1, p/s2, … (cluster similarity ≥ 0.912): ~126 tokens reclaimable
Collapsing a cluster keeps one entry; which one is a human decision, so this plugin never does it automatically.

Total reclaimable by collapsing duplicates: ~126 tokens.
```

三点刻意的设计：

1. **token 数标为估算**。宿主没把分词器暴露给插件，声称精确就是编数字。估算规则：CJK 1 字符 ≈ 1 token，其余 4 字符 ≈ 1 token。报告里始终带 `estimate` 标注。
2. **近重复按簇报告，不按配对**。模板化文案（同一句式只改个数字）会让两两比较组合爆炸——15 条能生成 19 对，把「可回收量」算成实际的好几倍。用并查集收敛成簇后，一个 N 条的簇只报「保留 1 条、可省 N-1 条」，簇内相似度取最小值（最保守的那个）。
3. **审计不返回技能全文**。审计工具本身不该吃上下文，只回成本与可疑项。

---

## 去重：默认关闭，且只做无可争议的那种

`before_agent_start` 的结果会被宿主采纳，可以替换系统提示。但**改写系统提示是侵入性操作**，所以：

- **默认不动作**。需要 `pluginSettings.dedupeSkillsSection === true`（严格等于 `true`）才生效。
- **只合并同一个 id**。同一技能被广告两次，合并成一条、保留第一次出现。这在任何解释下都是错的，删掉没有歧义。
- **不动近重复**。不同 id 的两条相似描述，可能是两个插件各自维护的版本；删哪条是人的判断，不该由插件静默决定。这部分只出现在报告里。
- 没有重复、或没有技能段时返回 `undefined`，宿主原样使用提示。

---

## 已知边界

1. **阈值不可配**。`agent.extension` 的 ctx 不暴露插件设置（`runner.ts:713` 的 `createContext` 里没有 settings 字段），所以 `dedupeSkillsSection` 也只能靠显式注入。默认关闭是这个限制下唯一诚实的选择。`core.mjs` 的审计与去重逻辑已完整实现并被测试覆盖，接上设置通道即可配置。
2. **近重复阈值固定 0.9**（bigram Dice 系数）。模板化文案中，单个数字与双位数的差异会把相似度压到 0.912 左右——刚好过线；差异更大的会落在阈值之外。这是有意保守：宁可少报，不虚报。
3. **只解析 `# Skills` 段**。若宿主改了技能段的标题或行格式（`- \`<id>\` — <name>: <desc>`），解析会返回 `found: false` 并明确说明「没有可审计的内容」，而不是给出错误的数字。
4. **命令可达性未端到端验证**。`registerCommand` 已按契约注册，但「在输入框敲 `/skill-budget` 能命中」取决于宿主命令解析与扩展加载时机，未在真实应用里手测。

---

## 测试

```powershell
node --test tests/core.test.mjs tests/extension.test.mjs
```

- `tests/core.test.mjs`（28 项）：解析（含 CRLF / 无描述 / 无段落 / 非法输入）、token 估算、同 id 重复、近重复簇收敛、阈值可调与非法阈值回落、去重行为、CRLF 保留。
- `tests/extension.test.mjs`（14 项）：注册面、默认不改写、开启后改写、无重复不动作、会话隔离、异常退化为不改写、工具与命令的返回形状、清理。

样例系统提示按宿主 `plugin-skills-prompt.ts` 的**真实输出**渲染，不是自造的简化格式——否则解析器只会对自造格式成立。

**经宿主同款 loader 实测**（jiti + 与 `loader.ts` 相同的参数）：

```
A 仅近重复 → 不改写 ✓（近重复属人的判断）
B 同 id 重复 → 已改写 ✓   去重后同一 id 出现次数: 1，其余段落保留: true
C 无设置   → 不改写 ✓
```

`PluginCheck` 通过，唯一提示是 `[permission.high-risk] agent.extension` 需显式授权（预期）。

---

## 与其它插件的关系

- 与 `pi.skill-lock`（技能来源与哈希校验）完全不重叠：那个管「技能从哪来、有没有被改」，这个管「技能广告占了多少钱」。
- 与 `local.mcode-skill-pack` 互补：技能包里技能越多，越需要这个插件看清成本。
