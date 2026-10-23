/**
 * pi.doc-index 离线逻辑测试
 *
 * 用假的 `pi` 全局（含内存文件系统）加载 main.js，测试：
 * BM25 中文检索、分块、增量索引、SHA-256 陈旧检测、边界处理。
 *
 * 运行：node test-doc-index.cjs
 */

const path = require("node:path");
const { mkdtempSync, rmSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const bm25 = require("./lib/bm25.js");

// ---- 虚拟工作区 + 真实数据目录 ----
// 工作区文件留在内存里（不需要碰真实磁盘）；索引文件则写进**真实的**临时数据目录。
// 索引的落盘路径正是 v0.2.1 出错的地方，用内存 fs 假掉它，等于把 bug 一起假掉：
// 旧测试把 pi.fs 的读写都实现成对象存取，于是「网关根本不允许写数据目录」这条
// 真实约束被完全掩盖，53 项全绿却掩盖了索引永远落不了盘的事实。
let files = {};
const dataPath = mkdtempSync(path.join(tmpdir(), "docindex-test-"));

// 可切换的当前项目（用于隔离测试）
let currentWorkspace = { path: "E:\\code\\projA", name: "projA" };

globalThis.pi = {
  plugin: {
    getId: () => "local.doc-index",
    getDataPath: async () => dataPath,
  },
  workspace: {
    get: async () => (currentWorkspace ? structuredClone(currentWorkspace) : null),
  },
  fs: {
    // 宿主网关只覆盖工作区（manifest 中 fs.read 的 root: workspace）。
    readText: async (p) => {
      if (!(p in files)) {
        const error = new Error(`ENOENT: ${p}`);
        error.code = "ENOENT";
        throw error;
      }
      return files[p];
    },
    // 对数据目录的写入必须被拒绝：这是权限模型的真实行为，也是本测试要钉住的回归点。
    // 索引文件只能由插件用 node:fs 写进自己的沙箱（见 main.js 的 readIndex / writeIndex）。
    writeText: async (p) => {
      const error = new Error(`EACCES: 路径不在 fs.read 作用域内（root: workspace）: ${p}`);
      error.code = "EACCES";
      throw error;
    },
    glob: async () => Object.keys(files),
  },
  agent: {
    registerTool: async (def) => registered.set(def.name, def),
    unregisterTool: async (name) => registered.delete(name),
  },
};

let registered = new Map();
const mod = require(path.join(__dirname, "main.js"));

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

async function main() {
  await mod.onLoad();
  const call = (name, args) => registered.get(name).execute(args, {});

  console.log("\n[1] 工具注册");
  check("注册 4 个工具", registered.size === 4, `实际 ${registered.size}`);
  for (const n of ["doc_index", "doc_search", "doc_status", "doc_clear"]) {
    check(`  含 ${n}`, registered.has(n));
  }

  console.log("\n[2] 未索引时的行为");
  let r = await call("doc_search", { query: "任意" });
  check("未索引 → 明确错误", r.ok === false && r.code === "DOC_NOT_INDEXED", JSON.stringify(r));
  r = await call("doc_status", {});
  check("status 报 not_indexed", r.ok && r.status === "not_indexed", JSON.stringify(r));

  console.log("\n[3] 建索引");
  files = {
    "README.md":
      "# 项目说明\n\n本项目使用 pnpm 管理依赖，测试用 node --test 运行。\n\n## 架构\n\n前端框架是 React，状态管理用 Zustand。\n\n## 数据库\n\n主库是 PostgreSQL，缓存层用 Redis。",
    "docs/api.md":
      "# API 文档\n\n所有接口都需要 Bearer token 认证。\n\n## 分页\n\n列表接口支持 cursor 分页，默认每页 20 条。",
    "config.json": '{\n  "port": 3000,\n  "database": "postgresql",\n  "cache": "redis"\n}',
    "image.png": "binary-data-not-really",
  };
  r = await call("doc_index", {});
  check("索引建立成功", r.ok && r.status === "ready", JSON.stringify(r));
  // 非文本文件在 glob 阶段就被扩展名过滤，不会进入 skipped（更早、更省）
  check("非文本文件被排除", r.ok && r.sources === 3, `sources=${r.sources}`);
  // 回归点：索引必须真的落在数据目录里，而不是只存在于某个内存对象中
  check(
    "索引文件真实落盘到插件数据目录",
    readdirSync(dataPath).some((n) => n.endsWith(".json")),
    JSON.stringify(readdirSync(dataPath))
  );
  check(
    "未留下半截临时文件",
    !readdirSync(dataPath).some((n) => n.endsWith(".tmp")),
    JSON.stringify(readdirSync(dataPath))
  );

  console.log("\n[4] 中文检索");
  r = await call("doc_search", { query: "依赖管理" });
  check("中文查询有命中", r.ok && r.hits.length > 0, JSON.stringify(r));
  check(
    "命中 README 的 pnpm 段",
    r.ok && r.hits.some((h) => h.text.includes("pnpm")),
    JSON.stringify(r.hits?.map((h) => h.path))
  );

  r = await call("doc_search", { query: "缓存" });
  check(
    "「缓存」命中 Redis",
    r.ok && r.hits.some((h) => h.text.includes("Redis")),
    JSON.stringify(r.hits?.map((h) => h.text?.slice(0, 40)))
  );

  r = await call("doc_search", { query: "分页" });
  check(
    "「分页」命中 api.md",
    r.ok && r.hits.some((h) => h.path === "docs/api.md"),
    JSON.stringify(r.hits?.map((h) => h.path))
  );

  console.log("\n[5] 英文与混合检索");
  r = await call("doc_search", { query: "PostgreSQL" });
  check(
    "英文查询命中",
    r.ok && r.hits.some((h) => h.text.includes("PostgreSQL")),
    JSON.stringify(r.hits?.map((h) => h.text?.slice(0, 30)))
  );

  r = await call("doc_search", { query: "React Zustand" });
  check("多词查询有命中", r.ok && r.hits.length > 0, JSON.stringify(r));

  r = await call("doc_search", { query: "不存在的词zzzz" });
  check("无关查询返回 not_found", r.ok && r.status === "not_found", JSON.stringify(r));

  console.log("\n[6] 来源定位");
  r = await call("doc_search", { query: "cursor" });
  check("命中带 path", r.ok && r.hits[0]?.path === "docs/api.md", JSON.stringify(r.hits?.[0]));
  check("命中带字符偏移", r.ok && typeof r.hits[0]?.start === "number", JSON.stringify(r.hits?.[0]));
  check("声明 trust 为不可信源", r.ok && r.trust === "untrusted_source_data");

  console.log("\n[7] 上下文预算");
  r = await call("doc_search", { query: "项目", limit: 10 });
  check("返回不超过 limit", r.ok && r.hits.length <= 10, `hits=${r.hits.length}`);
  check("上下文不超过 6000 字符", r.ok && r.contextCharacters <= 6000, `chars=${r.contextCharacters}`);

  console.log("\n[8] SHA-256 陈旧检测");
  files["README.md"] = files["README.md"] + "\n\n新增内容。";
  r = await call("doc_search", { query: "pnpm" });
  check("源文件变化 → DOC_INDEX_STALE", r.ok === false && r.code === "DOC_INDEX_STALE", JSON.stringify(r));
  check("错误信息指出文件", r.ok === false && r.message.includes("README.md"), r.message);

  r = await call("doc_status", {});
  check("status 报 stale", r.ok && r.status === "stale", JSON.stringify(r));
  check("列出 stale 文件", r.ok && r.staleFiles.includes("README.md"), JSON.stringify(r.staleFiles));

  console.log("\n[9] 增量重建");
  r = await call("doc_index", {});
  check("重建成功", r.ok && r.status === "ready", JSON.stringify(r));
  check("generation 递增", r.ok && r.generation >= 2, `generation=${r.generation}`);

  r = await call("doc_search", { query: "新增内容" });
  check("新内容可检索", r.ok && r.hits.length > 0, JSON.stringify(r));

  r = await call("doc_search", { query: "pnpm" });
  check("旧内容仍可检索", r.ok && r.hits.length > 0, JSON.stringify(r));

  console.log("\n[10] 文件删除后的陈旧检测");
  delete files["config.json"];
  r = await call("doc_status", {});
  check("缺失文件计入 stale", r.ok && r.staleFiles.includes("config.json"), JSON.stringify(r.staleFiles));

  console.log("\n[11] 指定路径索引");
  r = await call("doc_index", { paths: ["docs/api.md"] });
  check("仅索引指定文件", r.ok && r.sources === 1, JSON.stringify({ sources: r.sources }));
  r = await call("doc_search", { query: "Bearer" });
  check("指定索引后仍可检索", r.ok && r.hits.length > 0, JSON.stringify(r));

  console.log("\n[12] 清空索引");
  r = await call("doc_clear", {});
  check("清空成功", r.ok && r.status === "cleared", JSON.stringify(r));
  r = await call("doc_search", { query: "pnpm" });
  check("清空后 not_indexed", r.ok === false && r.code === "DOC_NOT_INDEXED", JSON.stringify(r));

  console.log("\n[13] BM25 引擎单元测试");
  const docs = [
    { id: "a", text: "项目用 pnpm 管理依赖" },
    { id: "b", text: "测试用 node --test 运行" },
    { id: "c", text: "缓存层用 Redis" },
  ];
  let ranked = bm25.rankBm25(docs, "依赖", 3, bm25.selectTokenizer("依赖"));
  check("BM25 中文排序正确", ranked.length > 0 && ranked[0].id === "a", JSON.stringify(ranked));

  ranked = bm25.rankBm25(docs, "Redis", 3, bm25.selectTokenizer("Redis"));
  check("BM25 英文排序正确", ranked.length > 0 && ranked[0].id === "c", JSON.stringify(ranked));

  const tokens = bm25.tokenize("项目依赖");
  check("中文 bigram 生成", tokens.includes("项目") && tokens.includes("依赖"), JSON.stringify(tokens));
  check("含单字", tokens.includes("项") && tokens.includes("目"), JSON.stringify(tokens));

  const chunks = bm25.chunkText("段落一。\n\n段落二。\n\n段落三。", { maxChars: 12 });
  check("分块生效", chunks.length >= 2, JSON.stringify(chunks.map((c) => c.text)));
  check("分块带偏移", chunks.every((c) => typeof c.start === "number"), JSON.stringify(chunks));

  const empty = bm25.rankBm25([], "任意", 5, bm25.tokenize);
  check("空文档集返回空", empty.length === 0);

  console.log("\n[14] 项目隔离（防止跨项目串读）");
  // ⚠️ 刻意不重载模块：插件进程是跨工作区共享的单例，
  // 切换项目时模块不会重新求值。重载会掩盖「作用域被缓存」这一真实缺陷。
  // 切到 projB：应看不到 projA 的索引
  currentWorkspace = { path: "E:\\code\\projB", name: "projB" };
  const callB = (n, a) => registered.get(n).execute(a, {});

  let rB = await callB("doc_status", {});
  check("projB 初始未索引", rB.ok && rB.status === "not_indexed", JSON.stringify(rB));
  check("projB 作用域正确", rB.ok && rB.scope?.key === "e:/code/projb", JSON.stringify(rB.scope));

  // projB 用自己的文件集建索引
  files["b-only.md"] = "# B 项目文档\n\nB 项目使用 Django 框架，数据库是 MySQL。";
  let rIdxB = await callB("doc_index", { paths: ["b-only.md"] });
  check("projB 建索引成功", rIdxB.ok && rIdxB.status === "ready", JSON.stringify(rIdxB));

  let rSearchB = await callB("doc_search", { query: "Django" });
  check("projB 能搜到自己的内容", rSearchB.ok && rSearchB.hits.length > 0, JSON.stringify(rSearchB));

  // 关键：projB 不应搜到 projA 的内容
  let rCross = await callB("doc_search", { query: "pnpm" });
  check(
    "projB 搜不到 projA 的 pnpm",
    rCross.ok === false || !rCross.hits?.some((h) => h.text.includes("pnpm")),
    JSON.stringify(rCross.hits?.map((h) => h.text?.slice(0, 40)))
  );

  // 切回 projA：索引应完好（同样不重载模块）
  currentWorkspace = { path: "E:\\code\\projA", name: "projA" };
  const callA = (n, a) => registered.get(n).execute(a, {});

  let rA = await callA("doc_status", {});
  check("projA 作用域正确", rA.ok && rA.scope?.key === "e:/code/proja", JSON.stringify(rA.scope));
  // 注意：前面的 [12] 段清空过 projA 索引，所以这里先重建，再验证 projB 没有污染它
  const rIdxA = await callA("doc_index", { paths: ["docs/api.md"] });
  check("projA 可重建索引", rIdxA.ok && rIdxA.status === "ready", JSON.stringify(rIdxA));
  const rA2 = await callA("doc_search", { query: "Bearer" });
  check("projA 搜到自己的内容", rA2.ok && rA2.hits.length > 0, JSON.stringify(rA2));
  const rA3 = await callA("doc_search", { query: "Django" });
  check(
    "projA 搜不到 projB 的 Django",
    rA3.ok === false || !rA3.hits?.some((h) => h.text.includes("Django")),
    JSON.stringify(rA3.hits?.map((h) => h.text?.slice(0, 40)))
  );

  console.log("\n[15] 无工作区时的降级");
  currentWorkspace = null;
  const callNo = (n, a) => registered.get(n).execute(a, {});
  let rNo = await callNo("doc_status", {});
  check("无工作区 → global 作用域", rNo.ok && rNo.scope?.kind === "global", JSON.stringify(rNo.scope));
  check("无工作区索引独立（为空）", rNo.ok && rNo.status === "not_indexed", JSON.stringify(rNo));

  console.log("\n[16] 卸载清理");
  await mod.onUnload();
  check("卸载后工具全部注销", registered.size === 0, `剩余 ${registered.size}`);


  // 数据目录是真实临时目录，测试结束自行清理，不留在磁盘上
  rmSync(dataPath, { recursive: true, force: true });
  console.log(`\n${"=".repeat(50)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log("=".repeat(50));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("测试脚本异常：", error);
  process.exit(1);
});
