/**
 * 本插件除 agent extension 外不贡献任何东西，因此主进程侧是空模块。
 *
 * 保留它是为了让 manifest 的 `main` 字段有实体文件可加载。
 *
 * 注意：这里**不能**写回写逻辑。所有判定与写入都在 extension/ 下，
 * 跑在 agent sidecar；main.js 跑在插件进程，两者不是同一个信任域。
 */

exports.activate = function activate() {
  // 有意为空。
};
