/**
 * Skill Budget —— 技能广告成本审计与去重的纯逻辑层。
 *
 * 背景：PI-Desktop 的 `pluginSkillsPrompt`（packages/agent-runtime/src/
 * plugin-skills-prompt.ts）把每个技能的 id + 名称 + 全部 description
 * 原样拼进系统提示，**只做 map，不按 id 去重、不做近重复检测**。
 * 同一技能被两个来源装进来时，两条会同时出现在提示里。
 *
 * 本模块只负责「读」：解析系统提示里的技能段，算清每个技能占多少字符、
 * 有哪些重复与近重复、广告总成本是多少。**不改写任何东西** —— 改写是
 * 入口层的事，且默认关闭。
 *
 * 这一层不碰 ExtensionAPI、不读文件、不联网，因此可以独立单测。
 */

/** 系统提示里技能段的标题行（与宿主 pluginSkillsPrompt 的输出一致）。 */
const SKILLS_HEADING = "# Skills";

/** 技能条目的行格式：`- \`<id>\` — <name>: <description>`。 */
const ENTRY_PATTERN = /^-\s+`([^`]+)`\s+—\s+(.*)$/u;

/** 近重复判定阈值：描述归一化后相似度达到这个值即视为近重复。 */
const NEAR_DUPLICATE_THRESHOLD = 0.9;

/**
 * 把系统提示切成「技能段」与「其余部分」。
 *
 * 宿主把技能段渲染成连续的几行：
 *   # Skills
 *   <空行>
 *   Plugins have taught you …（一段说明）
 *   <空行>
 *   - `id` — Name: desc
 *   - `id` — Name: desc
 *
 * 段落结束的判定：遇到下一个以 `# ` 开头的标题，或条目列表结束后的
 * 第一个非空非条目行。取「保守结束」——宁可少摘几条，也不吞掉后面的段落。
 *
 * @param {string} systemPrompt
 * @returns {{found: boolean, before: string, section: string, entries: Array<{id: string, body: string, raw: string}>, after: string}}
 */
function parseSkillsSection(systemPrompt) {
  const text = typeof systemPrompt === "string" ? systemPrompt : "";
  const lines = text.split(/\r?\n/);

  const start = lines.findIndex((line) => line.trim() === SKILLS_HEADING);
  if (start === -1) {
    return { found: false, before: text, section: "", entries: [], after: "" };
  }

  // 从标题下一行开始往下走，收集条目，直到段落结束。
  const entries = [];
  let lastEntryIndex = start;
  let end = lines.length;

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    // 下一个一级标题 → 技能段到此为止。
    if (/^#\s/.test(trimmed)) {
      end = index;
      break;
    }

    const match = ENTRY_PATTERN.exec(trimmed);
    if (match) {
      entries.push({ id: match[1], body: match[2], raw: line });
      lastEntryIndex = index;
      continue;
    }

    // 条目已经出现过之后，再遇到非空、非条目的行 → 段落结束。
    if (entries.length > 0 && trimmed !== "") {
      end = index;
      break;
    }

    // 条目之前的说明文字与空行属于技能段。
    if (trimmed !== "") lastEntryIndex = index;
  }

  // 技能段的**内容**在最后一个条目处结束；其后的空行属于分隔，
  // 留给 `after`，这样拼回去时与原始文本逐字一致。
  const contentEnd = entries.length > 0 ? lastEntryIndex + 1 : end;
  const sectionEnd = Math.min(contentEnd, end);

  const before = lines.slice(0, start).join("\n");
  const section = lines.slice(start, sectionEnd).join("\n");
  const after = lines.slice(sectionEnd).join("\n");
  return { found: true, before, section, entries, after };
}

/**
 * 估算一段文本的 token 数。
 *
 * 刻意做成**量级估算**而不是假装精确：宿主没有把分词器暴露给插件，
 * 任何「精确 token 数」都是编的。这里用两条经验：
 *   - CJK 字符大致 1 字符 ≈ 1 token；
 *   - 其余以 4 字符 ≈ 1 token 计。
 * 结论里一律标注 `estimate: true`，UI 上也必须这么写。
 */
function estimateTokens(text) {
  const source = typeof text === "string" ? text : "";
  let cjk = 0;
  let other = 0;
  for (const char of source) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
      (code >= 0x3040 && code <= 0x30ff) || // 日文假名
      (code >= 0xac00 && code <= 0xd7af) || // 韩文
      (code >= 0x3000 && code <= 0x303f) // CJK 标点
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/** 描述归一化：小写、压空白、去标点，只用于比较，不用于展示。 */
function normalizeText(text) {
  return (typeof text === "string" ? text : "")
    .toLowerCase()
    .replace(/[`*_~>#]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把文本切成 bigram 集合，用于近似比较。 */
function bigrams(text) {
  const normalized = normalizeText(text).replace(/\s+/g, "");
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  const set = new Set();
  for (let i = 0; i < normalized.length - 1; i += 1) set.add(normalized.slice(i, i + 2));
  return set;
}

/**
 * Dice 系数：2|A∩B| / (|A|+|B|)。
 *
 * 选它而不是编辑距离，因为技能描述是长句，编辑距离对语序和长度太敏感；
 * bigram 的集合相似度对「同一段话的小改动」更稳。
 */
function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * 分析系统提示里的技能广告成本。
 *
 * @param {string} systemPrompt 宿主当前完整系统提示
 * @param {object} [options]
 * @param {number} [options.nearThreshold] 近重复阈值，默认 0.9
 * @returns {object} 审计结论
 */
function auditSkills(systemPrompt, options = {}) {
  const nearThreshold =
    typeof options.nearThreshold === "number" &&
    options.nearThreshold > 0 &&
    options.nearThreshold <= 1
      ? options.nearThreshold
      : NEAR_DUPLICATE_THRESHOLD;

  const parsed = parseSkillsSection(systemPrompt);
  if (!parsed.found) {
    return {
      found: false,
      estimate: true,
      entries: [],
      duplicates: [],
      nearDuplicates: [],
      totals: {
        skills: 0,
        sectionChars: 0,
        sectionTokens: 0,
        descriptionChars: 0,
        descriptionTokens: 0,
        promptChars: typeof systemPrompt === "string" ? systemPrompt.length : 0,
        promptTokens: estimateTokens(systemPrompt),
        sharePercent: 0,
      },
    };
  }

  const entries = parsed.entries.map((entry) => {
    const description = entry.body;
    return {
      id: entry.id,
      body: description,
      chars: entry.raw.length,
      tokens: estimateTokens(entry.raw),
      descriptionChars: description.length,
      descriptionTokens: estimateTokens(description),
    };
  });

  // 完全相同 id 的重复（宿主不按 id 去重，所以这真的会发生）。
  const byId = new Map();
  for (const entry of entries) {
    const list = byId.get(entry.id) ?? [];
    list.push(entry);
    byId.set(entry.id, list);
  }
  const duplicates = [...byId.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([id, list]) => ({
      id,
      count: list.length,
      wastedChars: list.slice(1).reduce((sum, entry) => sum + entry.chars, 0),
      wastedTokens: list.slice(1).reduce((sum, entry) => sum + entry.tokens, 0),
    }));

  // 不同 id 但描述高度相似的（同一条技能被两个插件各装了一份）。
  //
  // 用并查集把「相似」收敛成簇：模板化文案（同一句式只改个数字）会让两两比较
  // 组合爆炸 —— 15 条能生成 19 对，把可回收量算成实际的好几倍。按簇报告才诚实：
  // 一个 N 条的簇，回收的是 N-1 条。簇内相似度记最小值（最保守的那个）。
  const parent = entries.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    // 路径压缩
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  /** 记录每对之间实际算出的相似度，用于簇内取最小值。 */
  const pairScores = new Map();
  const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (entries[i].id === entries[j].id) continue; // 完全重复已单独统计
      const score = similarity(entries[i].body, entries[j].body);
      if (score >= nearThreshold) {
        union(i, j);
        pairScores.set(pairKey(i, j), score);
      }
    }
  }

  // 按簇收集成员。
  const clusters = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const root = find(index);
    const list = clusters.get(root) ?? [];
    list.push(index);
    clusters.set(root, list);
  }

  const nearDuplicates = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    // 簇内取最保守的相似度：只要有一对只勉强够线，就把这个低值报出来。
    let weakest = 1;
    for (let a = 0; a < members.length; a += 1) {
      for (let b = a + 1; b < members.length; b += 1) {
        const score = pairScores.get(pairKey(members[a], members[b]));
        if (score !== undefined && score < weakest) weakest = score;
      }
    }
    const survivor = entries[members[0]];
    const reclaimable = members.slice(1);
    nearDuplicates.push({
      /// 保留这一条（簇内第一条出现者），其余视为可回收。
      keep: survivor.id,
      members: members.map((index) => entries[index].id),
      /// 簇内最多的一条之外的条目数，也就是真正能省下的条数。
      redundantCount: reclaimable.length,
      similarity: Math.round(weakest * 1000) / 1000,
      reclaimableChars: reclaimable.reduce((sum, index) => sum + entries[index].chars, 0),
      reclaimableTokens: reclaimable.reduce((sum, index) => sum + entries[index].tokens, 0),
    });
  }
  nearDuplicates.sort((a, b) => b.reclaimableTokens - a.reclaimableTokens);

  const sectionChars = parsed.section.length;
  const sectionTokens = estimateTokens(parsed.section);
  const descriptionChars = entries.reduce((sum, entry) => sum + entry.descriptionChars, 0);
  const descriptionTokens = entries.reduce((sum, entry) => sum + entry.descriptionTokens, 0);
  const promptChars = typeof systemPrompt === "string" ? systemPrompt.length : 0;
  const promptTokens = estimateTokens(systemPrompt);

  return {
    found: true,
    estimate: true,
    entries,
    duplicates,
    nearDuplicates,
    totals: {
      skills: entries.length,
      sectionChars,
      sectionTokens,
      descriptionChars,
      descriptionTokens,
      promptChars,
      promptTokens,
      sharePercent:
        promptTokens > 0 ? Math.round((sectionTokens / promptTokens) * 1000) / 10 : 0,
    },
    /// 提示词的其余部分，仅供调用方需要时复用；不参与结论。
    rest: { before: parsed.before, after: parsed.after },
  };
}

/**
 * 把审计结论渲染成人读的短报告。
 * 刻意控制长度：这是给模型/用户看的摘要，不是把所有条目倒出来。
 */
function renderReport(report, options = {}) {
  const maxEntries = typeof options.maxEntries === "number" ? options.maxEntries : 8;
  if (!report || !report.found) {
    return "No `# Skills` section found in the current system prompt, so there is nothing to audit.";
  }

  const totals = report.totals;
  const lines = [
    `Skills advertised: ${totals.skills}`,
    `Skills section: ~${totals.sectionTokens} tokens (${totals.sectionChars} chars), about ${totals.sharePercent}% of the whole system prompt (~${totals.promptTokens} tokens).`,
    `Descriptions alone: ~${totals.descriptionTokens} tokens.`,
    "(Token counts are estimates, not tokenizer-exact.)",
  ];

  const heaviest = [...report.entries].sort((a, b) => b.tokens - a.tokens).slice(0, maxEntries);
  if (heaviest.length > 0) {
    lines.push("", `Heaviest entries (top ${heaviest.length}):`);
    for (const entry of heaviest) lines.push(`- ${entry.id}: ~${entry.tokens} tokens`);
  }

  if (report.duplicates.length > 0) {
    lines.push("", "Exact duplicates (same id advertised more than once):");
    for (const dup of report.duplicates) {
      lines.push(`- ${dup.id} ×${dup.count}: ~${dup.wastedTokens} tokens wasted`);
    }
  }

  if (report.nearDuplicates.length > 0) {
    lines.push("", "Near-duplicate clusters (different ids, near-identical descriptions):");
    for (const near of report.nearDuplicates) {
      const others = near.members.filter((id) => id !== near.keep);
      lines.push(
        `- keep ${near.keep}; ${near.redundantCount} other(s): ${others.join(", ")} ` +
          `(cluster similarity ≥ ${near.similarity}): ~${near.reclaimableTokens} tokens reclaimable`,
      );
    }
    lines.push(
      "Collapsing a cluster keeps one entry; which one is a human decision, so this plugin never does it automatically.",
    );
  }

  const reclaimable =
    report.duplicates.reduce((sum, dup) => sum + dup.wastedTokens, 0) +
    report.nearDuplicates.reduce((sum, near) => sum + near.reclaimableTokens, 0);
  if (reclaimable > 0) {
    lines.push("", `Total reclaimable by collapsing duplicates: ~${reclaimable} tokens.`);
  }

  return lines.join("\n");
}

/**
 * 按 id 去重，返回新的系统提示文本。
 *
 * 只合并「同一个 id 被广告了两次」这种无可争议的情况。
 * **不合并近重复**：不同 id 的两条相似描述可能是两个插件各自维护的版本，
 * 删哪条是人的判断，不该由插件静默决定 —— 那部分只出现在审计报告里。
 *
 * @param {string} systemPrompt 原始系统提示
 * @returns {{deduped: string, removed: number}}
 */
function dedupeSkillsSection(systemPrompt) {
  const text = typeof systemPrompt === "string" ? systemPrompt : "";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);

  const start = lines.findIndex((line) => line.trim() === SKILLS_HEADING);
  if (start === -1) return { deduped: text, removed: 0 };

  const seen = new Set();
  const kept = [];
  let removed = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (index <= start) {
      kept.push(lines[index]);
      continue;
    }

    const trimmed = lines[index].trim();

    // 离开技能段之后原样保留。
    const isEntry = ENTRY_PATTERN.test(trimmed);
    const leavingSection = /^#\s/.test(trimmed) || (!isEntry && trimmed !== "" && seen.size > 0);
    if (leavingSection) {
      kept.push(...lines.slice(index));
      break;
    }

    if (!isEntry) {
      kept.push(lines[index]);
      continue;
    }

    const match = ENTRY_PATTERN.exec(trimmed);
    const id = match ? match[1] : "";
    if (seen.has(id)) {
      removed += 1;
      continue;
    }
    seen.add(id);
    kept.push(lines[index]);
  }

  return { deduped: kept.join(newline), removed };
}

export {
  ENTRY_PATTERN,
  NEAR_DUPLICATE_THRESHOLD,
  SKILLS_HEADING,
  auditSkills,
  dedupeSkillsSection,
  estimateTokens,
  normalizeText,
  parseSkillsSection,
  renderReport,
  similarity,
};
