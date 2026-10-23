/**
 * A11y Audit —— 可访问性审计的纯逻辑层。
 *
 * 为什么是这个能力：核实 `browser-cdp.ts:10-36` 的 `BROWSER_CDP_ALLOWLIST` 之后确认，
 * 宿主允许的性能/内存类方法（`HeapProfiler.*`、`Performance.*`、`Network.*`）**一个都不在**
 * 白名单里，所以「浏览器性能/内存审计」做不成；但 `Accessibility.getFullAXTree`
 * 在名单里，而宿主与现有插件都没把这套能力交给模型。
 *
 * 输入是宿主 `pi.browser.snapshot()` 已经产出的扁平文本树
 * （`browser-cdp.ts:72 flattenAxTree`），格式为：
 *
 *   - e12 Button "提交"
 *     - e13 Generic
 *   - e14 image "产品图"
 *
 * 每行 `e<uid> <role> "<name>"`，缩进表示层级；`ignored` 节点已被宿主过滤。
 *
 * **能力边界必须诚实**：扁平树里没有 `ignored`、没有 ARIA `properties`、没有 DOM 属性，
 * 所以下面只能做「基于角色与名称」的启发式检查。做不到的项（对比度、焦点顺序、
 * 键盘可达性）一律不冒充检测，明确列在 `notCovered` 里。
 *
 * 这一层不碰 ExtensionAPI，输入是纯文本，因此可以完整单测。
 */

/** 解析后的节点。 */
const LINE_PATTERN = /^(\s*)-\s+(e\d+)\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*$/u;

/**
 * 交互角色：这些元素必须有无障碍名称，否则屏幕阅读器只会读出「按钮」。
 * 取自 ARIA 里最常见的可交互 role，不追求穷举。
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "radiogroup",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "option",
  "treeitem",
]);

/** 图像类角色：缺名称等于图片对屏幕阅读器不存在（除非标了装饰性）。 */
const IMAGE_ROLES = new Set(["image", "img"]);

/** 这些名称等于没写：通用占位词，屏幕阅读器读出来毫无信息量。 */
const MEANINGLESS_NAMES = new Set([
  "click here",
  "click",
  "here",
  "more",
  "read more",
  "link",
  "button",
  "image",
  "img",
  "x",
  "×",
  "→",
  ">",
  "go",
  "submit",
  "提交",
  "点击",
  "点击这里",
  "更多",
  "详情",
  "确定",
]);

/** 单次审计最多返回多少条问题，避免把上下文打爆。 */
const MAX_FINDINGS = 60;

/**
 * 把扁平文本树解析成节点列表。
 *
 * @param {string} tree
 * @returns {Array<{uid: string, role: string, name: string, depth: number, line: number}>}
 */
function parseTree(tree) {
  const text = typeof tree === "string" ? tree : "";
  const nodes = [];

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    const match = LINE_PATTERN.exec(rawLine);
    if (!match) continue;

    const [, indent, uid, role, rawName] = match;
    // 缩进以 2 空格为单位；用长度/2 而不是计数层数，容忍宿主改动缩进宽度。
    const depth = Math.floor(indent.replace(/\t/g, "  ").length / 2);

    let name = "";
    if (typeof rawName === "string" && rawName !== "") {
      // 宿主用 JSON.stringify 包名称，这里还原转义。
      try {
        name = JSON.parse(`"${rawName}"`);
      } catch {
        name = rawName;
      }
    }

    nodes.push({ uid, role: role.toLowerCase(), name, depth, line: rawLine });
  }

  return nodes;
}

/** 名称是否「等于没写」。 */
function isMeaninglessName(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  if (normalized === "") return false; // 空名单独按「缺失」处理
  if (MEANINGLESS_NAMES.has(normalized)) return true;
  // 纯符号/纯数字也算无信息量（例如 "→"、"123"）。
  if (!/[a-zA-Z\u4e00-\u9fff]/.test(normalized)) return true;
  return false;
}

/**
 * 审计一棵扁平可访问性树。
 *
 * @param {string} tree
 * @param {object} [options]
 * @param {number} [options.maxFindings]
 * @returns {object}
 */
function auditTree(tree, options = {}) {
  const maxFindings =
    typeof options.maxFindings === "number" && options.maxFindings > 0
      ? Math.min(options.maxFindings, MAX_FINDINGS)
      : MAX_FINDINGS;

  const nodes = parseTree(tree);
  const findings = [];

  const push = (severity, kind, node, detail) => {
    findings.push({ severity, kind, uid: node.uid, role: node.role, name: node.name, detail });
  };

  for (const node of nodes) {
    const hasName = node.name.trim() !== "";

    // 1) 可交互元素缺名称 —— 屏幕阅读器只会读出角色。
    if (INTERACTIVE_ROLES.has(node.role) && !hasName) {
      push("high", "interactive-without-name", node, `${node.role} has no accessible name; a screen reader announces only the role.`);
      continue;
    }

    // 2) 图像缺名称 —— 除非它明显是装饰性（宿主已过滤 ignored，这里无从判断 alt=""）。
    if (IMAGE_ROLES.has(node.role) && !hasName) {
      push(
        "medium",
        "image-without-name",
        node,
        "image has no accessible name; if it is decorative this is fine, otherwise add alt text.",
      );
      continue;
    }

    // 3) 名称无信息量。
    if (hasName && (INTERACTIVE_ROLES.has(node.role) || IMAGE_ROLES.has(node.role)) && isMeaninglessName(node.name)) {
      push(
        "medium",
        "meaningless-name",
        node,
        `name ${JSON.stringify(node.name)} carries no information out of context.`,
      );
    }
  }

  // 4) 交互元素总数与角色分布 —— 用于判断页面是否「看起来没有可交互内容」。
  const interactive = nodes.filter((node) => INTERACTIVE_ROLES.has(node.role));
  const roleCounts = {};
  for (const node of nodes) roleCounts[node.role] = (roleCounts[node.role] ?? 0) + 1;

  // 5) 整页没有任何标题 —— 屏幕阅读器用户无法靠标题跳读。
  const headings = nodes.filter((node) => /^heading$/u.test(node.role) || /^h[1-6]$/u.test(node.role));
  if (nodes.length > 5 && headings.length === 0) {
    findings.push({
      severity: "medium",
      kind: "no-headings",
      uid: null,
      role: null,
      name: null,
      detail: "no heading roles in the tree; screen reader users cannot navigate by headings.",
    });
  }

  // 6) 可交互元素数量为 0 却节点不少 —— 可能整块内容对辅助技术不可见。
  if (nodes.length > 10 && interactive.length === 0) {
    findings.push({
      severity: "medium",
      kind: "no-interactive-roles",
      uid: null,
      role: null,
      name: null,
      detail: "the tree has content but no interactive roles at all; check whether real controls are hidden from assistive tech.",
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((left, right) => (order[left.severity] ?? 9) - (order[right.severity] ?? 9));

  const shown = findings.slice(0, maxFindings);
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;

  return {
    nodes: nodes.length,
    interactive: interactive.length,
    headings: headings.length,
    roleCounts,
    findings: shown,
    totals: { ...bySeverity, total: findings.length, truncated: findings.length > shown.length },
    notCovered: [
      "color contrast (the tree carries no computed styles)",
      "focus order and keyboard reachability (the tree carries no DOM order or tabindex)",
      "ARIA state such as aria-expanded / aria-invalid (the host flattens names only and drops properties)",
      "whether an image is decorative (the host filters ignored nodes, so alt=\"\" is indistinguishable from missing alt)",
      "live-region announcements and form error associations",
    ],
  };
}

/** 把审计结果渲染成给模型看的短报告。 */
function renderReport(result, options = {}) {
  if (!result || typeof result !== "object") return "a11y: nothing to report.";
  const maxDetail = typeof options.maxDetail === "number" ? options.maxDetail : 20;

  const lines = [
    `Accessibility tree: ${result.nodes} node(s), ${result.interactive} interactive, ${result.headings} heading(s).`,
    `Findings: ${result.totals.high} high, ${result.totals.medium} medium, ${result.totals.low} low.`,
  ];

  if (result.findings.length === 0) {
    lines.push("No name-related problems found in the flattened tree.");
  } else {
    lines.push("");
    for (const finding of result.findings.slice(0, maxDetail)) {
      const where = finding.uid ? `${finding.uid} (${finding.role})` : "page";
      const name = finding.name ? ` ${JSON.stringify(finding.name)}` : "";
      lines.push(`- [${finding.severity}] ${where}${name}: ${finding.detail}`);
    }
    if (result.findings.length > maxDetail) {
      lines.push(`- … ${result.findings.length - maxDetail} more finding(s) not shown.`);
    }
  }

  lines.push(
    "",
    "Not checked (the flattened tree cannot show these): " + result.notCovered.join("; ") + ".",
  );
  return lines.join("\n");
}

module.exports = {
  IMAGE_ROLES,
  INTERACTIVE_ROLES,
  MAX_FINDINGS,
  auditTree,
  isMeaninglessName,
  parseTree,
  renderReport,
};