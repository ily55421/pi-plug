---
name: context-summary-format
description: 用户要求压缩/总结/交接当前会话，或上下文接近上限需要生成摘要时使用。按固定的 Goal/Constraints/Progress/Decisions/Next Steps/Critical Context 结构输出，保证压缩后关键信息不丢。日常的一句话问答不要触发。
---

# 结构化上下文摘要

生成长会话摘要、压缩摘要或交接说明时，固定输出下列结构。**缺失的节写 "none"，不得省略节标题**——空节本身就是信息（说明这一类事实确实没有）。

## 摘要模板

```markdown
## Goal
[用户最终要完成什么，一到两句]

## Constraints & Preferences
- [用户明确提出的要求、禁止项、偏好]

## Progress
### Done
- [x] [已完成并**已验证**的事]

### In Progress
- [ ] [当前正在做、做到哪一步]

### Blocked
- [阻塞项，附原因；没有就写 none]

## Key Decisions
- **[决策]**：[为什么这么定]

## Next Steps
1. [按执行顺序的下一步]

## Critical Context
- [不写就会踩坑的事实：坑、报错、workaround、外部状态、环境差异]

<read-files>
path/to/file1
path/to/file2
</read-files>

<modified-files>
path/to/changed
</modified-files>
```

## 规则

- **自足**：新会话只读这份摘要就能继续工作，不需要回看原始对话。有疑问的地方说明"未确定"，不要含糊带过。
- **Progress 三段必须与实际状态一致**。没验证过的、跑失败的、只写了一半的，**不能**放进 Done；放 In Progress 或 Blocked。
- **Blocked 必须附原因**：不是"卡住了"，而是"卡在 X，因为 Y，需要 Z"。
- **Key Decisions 要带理由**。只写"用了方案 A"没有价值；"用方案 A 而不是 B，因为 B 在 Windows 上不可用"才是决策记录。
- **Critical Context 是防坑清单**：写进去的应该是"下一个人/下一个模型不知道就会重复踩"的东西。不是泛泛的背景介绍。
- 文件标签用**相对路径**，每行一个，按时间序。没有就整块省略或写 none。
- 用户只是要求"总结一下刚才说的"（非压缩/交接场景）时，用同样的结构但可省略文件标签。

## 什么时候该触发

- 用户说"压缩上下文""总结一下我们的进度""准备交接给下一个会话"
- 你自己判断上下文快满了，需要主动压缩
- 长任务中途换阶段，需要一份可续接的状态快照

日常的一句问答、单步任务，**不要**套这个格式——那只是形式主义。

## 反模式

- 把没验证的工作写进 Done（最危险的失真）
- 摘要里出现"上面提到过"这类指代（新会话没有"上面"）
- 只罗列做了什么，不写为什么这么决定
- Critical Context 写成项目背景介绍，而不是具体的坑
