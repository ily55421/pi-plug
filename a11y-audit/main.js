/**
 * A11y Audit —— 插件入口。
 *
 * 形态是**纯插件**，不是 agent extension。理由（已核实源码）：
 * `packages/agent-runtime/src/extensions/runner.ts` 的 `createContext` 里没有
 * `browser` 成员，所以 extension 拿不到 `pi.browser.snapshot()`；
 * 而 `browser.cdp` 是插件进程的能力，因此以普通插件运行，
 * 用 `pi.agent.registerTool` 把能力交给模型。
 *
 * 它做什么：把宿主已经产出的可访问性树（`browser-cdp.ts:72 flattenAxTree`）
 * 交给模型，并做基于角色/名称的启发式审计。
 *
 * 它**不做**什么（能力边界来自 CDP 白名单，`browser-cdp.ts:10-36`）：
 *   - 白名单里没有 `HeapProfiler.*` / `Performance.*` / `Network.*`
 *     → 浏览器性能与内存审计做不了；
 *   - 扁平树里没有 ARIA properties、DOM 顺序、计算样式
 *     → 对比度、焦点顺序、aria-expanded 等一律不检测，并在报告里明说。
 *
 * 权限：`browser.cdp`（读可访问性树）+ `agent.tool.register`（注册工具）。
 */

const { auditTree, renderReport } = require("./lib/audit.cjs");

/** 单次返回给模型的字符上限，避免把上下文打爆。 */
const MAX_REPORT_CHARS = 8000;

/** 注册的工具有几个就登记几个，卸载时精确回收。 */
const REGISTERED_TOOLS = ["a11y_audit"];

/** 把浏览器错误翻译成人能读的话，而不是把栈丢给模型。 */
function explain(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not allowed|allowlist/i.test(message)) {
    return `the browser bridge rejected this CDP method (${message}); the host allowlist does not include it`;
  }
  if (/no (guest|webcontents)|not attached|detached|not ready/i.test(message)) {
    return "no browser panel is open in this workspace, so there is no page to audit; open the browser panel first";
  }
  return message;
}

/**
 * 取当前页面的可访问性树。
 *
 * 用 `snapshot()` 而不是裸 `cdp`：前者已经做了 attach、扁平化与 uid 分配，
 * 与后续 `click({uid})` 之类共享同一套 uid，要定位元素时不会错位。
 */
async function readTree(pi) {
  const snapshot = await pi.browser.snapshot();
  return {
    tree: typeof snapshot?.tree === "string" ? snapshot.tree : "",
    url: typeof snapshot?.url === "string" ? snapshot.url : "",
    title: typeof snapshot?.title === "string" ? snapshot.title : "",
  };
}

/** 一次完整审计，供工具与命令共用。 */
async function audit(pi, options = {}) {
  const page = await readTree(pi);
  if (!page.tree || page.tree === "(empty)") {
    return { ok: true, empty: true, page };
  }
  const result = auditTree(page.tree, { maxFindings: options.maxFindings });
  return { ok: true, empty: false, page, result };
}

async function onLoad(pi) {
  await pi.agent.registerTool({
    name: "a11y_audit",
    description:
      "Audit the page currently open in the workspace browser panel for accessibility problems that the flattened " +
      "accessibility tree can reveal: interactive elements with no accessible name, images without alt text, " +
      'placeholder-only names like "click here", and pages with no headings or no interactive roles at all. ' +
      "Read-only. It cannot check colour contrast, focus order, keyboard reachability, or ARIA state — the tree " +
      "does not carry them, and the report says so explicitly. Use it before shipping a UI change.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        maxFindings: {
          type: "number",
          description: "How many findings to list (default 20, hard cap 60).",
        },
      },
      required: [],
    },
    async execute(input) {
      let outcome;
      try {
        outcome = await audit(pi, { maxFindings: input?.maxFindings });
      } catch (error) {
        return { ok: false, message: `a11y: ${explain(error)}` };
      }

      if (outcome.empty) {
        return {
          ok: true,
          page: { url: outcome.page.url, title: outcome.page.title },
          message:
            "The accessibility tree is empty — the page may not have rendered yet, or the panel is blank. " +
            "Load a page, wait for it to render, then run the audit again.",
          totals: { high: 0, medium: 0, low: 0, total: 0 },
          findings: [],
        };
      }

      const { result } = outcome;
      let message = renderReport(result, { maxDetail: input?.maxFindings ?? 20 });
      if (message.length > MAX_REPORT_CHARS) {
        message = `${message.slice(0, MAX_REPORT_CHARS)}\n… report truncated at ${MAX_REPORT_CHARS} characters.`;
      }

      return {
        ok: true,
        page: { url: outcome.page.url, title: outcome.page.title },
        nodes: result.nodes,
        interactive: result.interactive,
        headings: result.headings,
        totals: result.totals,
        findings: result.findings,
        notCovered: result.notCovered,
        message,
      };
    },
  });

  /** 命令：用户主动跑一次，摘要弹一下。 */
  pi.commands.register("a11yAudit.open", {
    title: "A11y: audit the open page",
    async run() {
      try {
        const outcome = await audit(pi);
        if (outcome.empty) {
          pi.ui.notify("a11y: the browser panel is empty or not rendered yet.");
          return;
        }
        const { totals, nodes } = outcome.result;
        pi.ui.notify(
          `a11y: ${totals.high} high, ${totals.medium} medium, ${totals.low} low across ${nodes} node(s).`,
        );
      } catch (error) {
        pi.ui.notify(`a11y: ${explain(error)}`);
      }
    },
  });
}

async function onUnload(pi) {
  await Promise.allSettled([
    ...REGISTERED_TOOLS.map((name) => pi.agent.unregisterTool(name)),
    pi.commands.unregister("a11yAudit.open"),
  ]);
}

module.exports = {
  onLoad,
  onUnload,
  // 导出给测试直接断言，不依赖宿主环境。
  __test: { explain, readTree, audit, MAX_REPORT_CHARS, REGISTERED_TOOLS },
};
