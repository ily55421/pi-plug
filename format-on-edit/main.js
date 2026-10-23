/**
 * 本插件除 agent extension 外不贡献任何东西，因此主进程侧是空模块。
 *
 * 保留它是为了让 manifest 的 `main` 字段有实体文件可加载。
 *
 * 注意：这里**不能**写格式化逻辑。所有判定与执行都在 extension/ 下，
 * 跑在 agent sidecar（能拿到会话 cwd 与 exec）；main.js 跑在插件进程，
 * 两者不是同一个信任域。
 */

exports.activate = function activate() {
  // 有意为空。
};
