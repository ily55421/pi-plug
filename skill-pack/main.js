/*
 * MCode 技能包 —— 插件进程入口。
 *
 * 本插件是**纯声明式**的：能力全部由 manifest.json 的 contributes.skills
 * 提供，宿主在加载时读取这些 markdown 并编入 Agent 的 Skill 目录。
 * 因此这里不需要注册任何工具、命令或服务。
 *
 * 保留 main.js 是因为 manifest 的 `main` 是必填字段；onLoad/onUnload
 * 留空实现即可，宿主只会调用这两个钩子。
 */

"use strict";

/** 技能是声明式贡献，加载时无需做任何运行时注册。 */
async function onLoad() {}

/** 同理，卸载时也没有需要撤销的运行时注册。 */
async function onUnload() {}

module.exports = { onLoad, onUnload };
