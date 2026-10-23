---
name: x-link-reader
description: 用户分享 x.com 或 twitter.com 链接并询问内容，或网页抓取 x.com 失败/反爬时使用。通过 FxTwitter API 读取推文结构化数据，无需密钥。
---

# X/Twitter 链接阅读（移植自 MiniMax Code x-link-reader 技能）

x.com 直接抓取会命中反爬页面。改用开源 [FxTwitter](https://github.com/FixTweet/FxTweet) API 获取结构化 JSON，免费无需认证。

## 用法

把域名替换为 `api.fxtwitter.com`，其余路径保持不变，以文本形式抓取（响应是 JSON）：

```text
原始:  https://x.com/<user>/status/<id>
代理:  https://api.fxtwitter.com/<user>/status/<id>

原始:  https://twitter.com/<user>/status/<id>
代理:  https://api.fxtwitter.com/<user>/status/<id>
```

## 响应要点（tweet 对象）

- `text`：推文全文（注意 URL 转义）
- `author`：`name` / `screen_name` / `followers` / `avatar_url`
- `created_at`：发布时间
- `replies` / `retweets` / `likes` / `views`：互动数据
- `replying_to`：所回复用户（非回复为 null）
- `quoted_status_result`：引用推文（如有，结构同本对象）
- `media.photos[]` / `media.videos[]`：媒体 URL 列表

## 流程

1. 识别链接形态：`x.com|twitter.com/*/status/*`（推文）或 `x.com/<user>`（主页）。
2. 域名替换后抓取 JSON；推文接口失败时可试 `api.fxtwitter.com/<user>`。
3. 用中文转述：作者、时间、正文、关键互动数、媒体说明；引用推文一并说明。
4. 图片/视频链接原样给出 URL，不描述不存在的画面内容。

## 边界

- 转述而非逐字翻译；用户要原文时给原文。
- API 失败时明确说明失败原因，不要伪造内容。
