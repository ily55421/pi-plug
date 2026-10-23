/**
 * 页面标注（local.annotate）— 纯声明式技能包插件。
 *
 * manifest.json 的 contributes.skills 已把 skills/dom-annotate.md 索引给
 * Agent 的 Skill 工具，运行时没有任何事可做：不注册工具、不碰文件、不联网。
 * 保留空生命周期钩子只为满足 manifest 的 main 必填要求。
 */

"use strict";

async function onLoad() {
  // 有意留空：技能内容由宿主按需读取，加载时不需要任何动作。
}

async function onUnload() {
  // 无资源需要释放。
}

module.exports = { onLoad, onUnload };
