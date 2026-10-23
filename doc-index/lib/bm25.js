/**
 * BM25 中文混合检索引擎
 *
 * 移植自 DSH-SEP 的 vendor/bm25.js（MIT，上游 imkelt/DSH-RAG），
 * 保留其核心分词策略，去掉 TypeScript 类型与宿主耦合：
 *
 *   - 拉丁词按 \p{Letter}\p{Number}+ 切分
 *   - 中文按**单字 + bigram**切分（无需词典即可召回中文）
 *   - 查询含中文时再叠加 Intl.Segmenter 词切分（提高精度）
 *
 * 在此基础上增加两处针对长文档的改进（SEP 原版没有）：
 *   - 单个汉字命中降权（长文档里单字几乎必然命中，是噪声）
 *   - 最低分阈值，过滤只靠单字匹配的无关结果
 *
 * 零依赖、纯函数、可在 Node 与渲染进程两处运行。
 */

const WORD_RE = /[\p{Script=Han}]|[\p{Letter}\p{Number}]+/gu;
const HAN_RE = /^\p{Script=Han}$/u;
const HAN_ANY_RE = /\p{Script=Han}/u;

/** 按「汉字单字 | 拉丁词」切分 */
function tokenizeUnicode(value) {
  return [...String(value ?? "").toLocaleLowerCase().matchAll(WORD_RE)]
    .map((m) => m[0])
    .filter(Boolean);
}

/** 基础分词：拉丁词 + 汉字单字 + 汉字 bigram */
function tokenize(value) {
  const base = tokenizeUnicode(value);
  const han = base.filter((t) => HAN_RE.test(t));
  const bigrams = han.slice(0, -1).map((t, i) => `${t}${han[i + 1] ?? ""}`);
  return [...base, ...bigrams];
}

let segmenter = null;
let segmenterFailed = false;

/** Intl.Segmenter 词切分（不可用时静默降级） */
function tokenizeSegmented(value) {
  if (segmenterFailed) return [];
  try {
    if (!segmenter) segmenter = new Intl.Segmenter(["zh", "en"], { granularity: "word" });
    return [...segmenter.segment(String(value ?? "").normalize("NFKC").toLocaleLowerCase())]
      .filter((item) => item.isWordLike)
      .map((item) => item.segment);
  } catch {
    segmenterFailed = true;
    return [];
  }
}

/** 混合分词：基础 + 词切分，去重 */
function tokenizeHybrid(value) {
  return [...new Set([...tokenize(value), ...tokenizeSegmented(value)])];
}

/** 按查询语言选择分词器 */
function selectTokenizer(query) {
  return HAN_ANY_RE.test(String(query ?? "")) ? tokenizeHybrid : tokenize;
}

/**
 * 把长文本切成有界块。
 *
 * 策略：优先按段落边界切，超长段落再按句子边界切。
 * 每块携带在原文中的字符偏移，用于来源定位。
 *
 * @param {string} text 原文
 * @param {{maxChars?: number}} options
 * @returns {Array<{text: string, start: number, end: number}>}
 */
function chunkText(text, { maxChars = 1200 } = {}) {
  const source = String(text ?? "");
  if (!source.trim()) return [];
  if (source.length <= maxChars) {
    return [{ text: source, start: 0, end: source.length }];
  }

  // 按空行分段，记录每段起始偏移
  const paragraphs = [];
  let cursor = 0;
  for (const piece of source.split(/(\n\s*\n)/)) {
    if (piece) paragraphs.push({ text: piece, start: cursor });
    cursor += piece.length;
  }

  const chunks = [];
  let buffer = "";
  let bufferStart = 0;

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      chunks.push({ text: trimmed, start: bufferStart, end: bufferStart + buffer.length });
    }
    buffer = "";
  };

  for (const para of paragraphs) {
    // 超长段落：按句子边界切
    if (para.text.length > maxChars) {
      flush();
      let sentenceStart = para.start;
      let sentenceBuffer = "";
      for (const sentence of para.text.split(/(?<=[。！？.!?])\s*/)) {
        if (sentenceBuffer.length + sentence.length > maxChars && sentenceBuffer) {
          chunks.push({
            text: sentenceBuffer.trim(),
            start: sentenceStart,
            end: sentenceStart + sentenceBuffer.length,
          });
          sentenceBuffer = "";
          sentenceStart += 1;
        }
        sentenceBuffer += sentence;
      }
      if (sentenceBuffer.trim()) {
        chunks.push({
          text: sentenceBuffer.trim(),
          start: sentenceStart,
          end: sentenceStart + sentenceBuffer.length,
        });
      }
      continue;
    }

    if (buffer.length + para.text.length > maxChars && buffer) {
      flush();
      bufferStart = para.start;
    }
    if (!buffer) bufferStart = para.start;
    buffer += para.text;
  }
  flush();

  return chunks;
}

/**
 * BM25 打分。
 *
 * 单个汉字是弱信号（长文档里几乎必然命中），因此降权；
 * 低于阈值的命中视为噪声，直接丢弃。
 *
 * @param {Array<{id: string, text: string}>} docs 候选文档
 * @param {string} query 查询串
 * @param {number} limit 返回条数上限
 * @param {(s: string) => string[]} tokenizer 分词器
 * @returns {Array<{id: string, score: number}>} 按分数降序
 */
function rankBm25(docs, query, limit, tokenizer) {
  const queryTokens = [...new Set(tokenizer(query))];
  if (!queryTokens.length || !docs.length) return [];

  const isSingleHan = (t) => t.length === 1 && HAN_RE.test(t);
  const weightOf = (t) => (isSingleHan(t) ? 0.15 : 1);

  const docTokens = docs.map((d) => tokenizer(d.text));
  const avgLen = docTokens.reduce((sum, t) => sum + t.length, 0) / docTokens.length || 1;

  const df = new Map();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const k1 = 1.5;
  const b = 0.75;
  const N = docs.length;

  const scored = docs.map((doc, i) => {
    const tokens = docTokens[i];
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    let strongHits = 0;

    for (const qt of queryTokens) {
      const f = tf.get(qt);
      if (!f) continue;
      if (!isSingleHan(qt)) strongHits++;
      const n = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += weightOf(qt) * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * tokens.length) / avgLen)));
    }

    return { id: doc.id, score, strongHits };
  });

  // 只有孤立单字命中的文档视为噪声，丢弃。
  // 不用绝对分数阈值：语料只有 1 篇时 idf 上限仅约 0.29，
  // 任何绝对阈值都会让检索永远为空。
  return scored
    .filter((s) => s.strongHits > 0 && s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit)
    .map(({ id, score }) => ({ id, score }));
}

module.exports = {
  tokenize,
  tokenizeUnicode,
  tokenizeSegmented,
  tokenizeHybrid,
  selectTokenizer,
  rankBm25,
  chunkText,
};
