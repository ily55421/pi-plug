/**
 * 本插件除 agent extension 外不贡献任何东西，因此主进程侧是空模块。
 *
 * 保留它是为了让 manifest 的 `main` 字段有实体文件可加载：
 * 宿主在加载插件时会读取 main；空模块让「插件本身」与「它的 extension」
 * 的职责分离得更清楚，也避免未来想加视图时再改 manifest。
 *
 * 注意：这里**不能**写业务逻辑。所有判定都在 extension/index.mjs 里，
 * 跑在 agent sidecar；main.js 跑在插件进程，两者不是同一个信任域。
 */

exports.activate = function activate() {
  // 有意为空。
};
