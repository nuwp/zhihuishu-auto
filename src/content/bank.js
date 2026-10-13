/**
 * bank.js — 题库（正确答案记忆） + 已试组合记忆
 *
 * bank  : 题目归一化文本哈希 -> { answer:[下标...], stem, hits, updatedAt }
 * tried : 运行时记忆「这道题已经试过哪些组合」，防止答错重播后重复枚举
 *
 * 存储：chrome.storage.local.bank（持久） / 内存（会话级）
 */
(function () {
  'use strict';

  const NS = (window.__ZHS = window.__ZHS || {});
  const { normalize, hash } = NS.dom;

  const BANK_KEY = 'bank';
  const MAX_BANK = 5000;

  let bank = {};
  let loaded = false;
  let dirty = false;
  let flushTimer = null;

  /**
   * 存储被外部改了（控制台点「清空题库」、别的标签页导入……）⇒ 内存那份也得跟着换。
   *
   * ⚠ 少了这一条，「清空题库」这个按钮**根本无效**：
   *   控制台点一下 → 它只清了 chrome.storage
   *   → 但内容脚本内存里的 `bank` 原封不动（`loaded` 还是 true，load() 直接返回旧的）
   *   → 于是你看到题库还在用
   *   → 而**下一次答对题目时 record() 会把内存那份整个写回存储**，
   *     清空就被彻底撤销了（连存储里的空都被盖回去）。
   *
   * 监听 onChanged 是最省事的修法：不管谁改的、从哪个上下文改的，都能收到。
   */
  try {
    if (chrome && chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes || !changes[BANK_KEY]) return;
        bank = (changes[BANK_KEY].newValue) || {};
        loaded = true;
        dirty = false;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      });
    }
  } catch (e) { /* 拿不到 storage 就算了，不影响主流程 */ }

  /** 题目身份键：题干哈希 + 选项数量 + 题型，避免同题干不同选项数组撞库 */
  function keyOf(stem, optionCount, multi) {
    const n = normalize(stem);
    return hash(n) + '-' + optionCount + '-' + (multi ? 'm' : 's');
  }

  async function load() {
    if (loaded) return bank;
    try {
      const got = await chrome.storage.local.get(BANK_KEY);
      bank = (got && got[BANK_KEY]) || {};
    } catch (e) {
      bank = {};
    }
    loaded = true;
    return bank;
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      if (!dirty) return;
      dirty = false;
      await flush();
    }, 800);
  }

  async function flush() {
    try {
      const keys = Object.keys(bank);
      if (keys.length > MAX_BANK) {
        // 容量保护：淘汰命中次数最少、最久未更新的记录
        keys
          .sort((a, b) => {
            const A = bank[a];
            const B = bank[b];
            return (A.hits || 0) - (B.hits || 0) || (A.updatedAt || 0) - (B.updatedAt || 0);
          })
          .slice(0, keys.length - MAX_BANK)
          .forEach((k) => delete bank[k]);
      }
      await chrome.storage.local.set({ [BANK_KEY]: bank });
    } catch (e) { /* noop */ }
  }

  /** 查库 */
  function lookup(stem, optionCount, multi) {
    const k = keyOf(stem, optionCount, multi);
    const hit = bank[k];
    if (!hit || !Array.isArray(hit.answer) || !hit.answer.length) return null;
    // 选项数量变了（题目被改过）就丢弃
    if (hit.answer.some((i) => i < 0 || i >= optionCount)) return null;
    return { key: k, answer: hit.answer.slice(), hits: hit.hits || 0 };
  }

  /** 记库 */
  function remember(stem, optionCount, multi, answer) {
    const k = keyOf(stem, optionCount, multi);
    const prev = bank[k];
    bank[k] = {
      answer: answer.slice().sort((a, b) => a - b),
      stem: String(stem).slice(0, 200),
      hits: (prev && prev.hits ? prev.hits : 0) + 1,
      updatedAt: Date.now(),
    };
    scheduleFlush();
    return k;
  }

  function recordHit(key) {
    const rec = bank[key];
    if (!rec) return;
    rec.hits = (rec.hits || 0) + 1;
    rec.updatedAt = Date.now();
    scheduleFlush();
  }

  function size() {
    return Object.keys(bank).length;
  }

  function dump() {
    return Object.entries(bank).map(([k, v]) => ({
      key: k,
      stem: v.stem,
      answer: v.answer,
      hits: v.hits || 0,
      updatedAt: v.updatedAt || 0,
    }));
  }

  async function clear() {
    bank = {};
    try { await chrome.storage.local.set({ [BANK_KEY]: {} }); } catch (e) { /* noop */ }
  }

  async function importBank(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    let n = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (!v || !Array.isArray(v.answer)) continue;
      bank[k] = {
        answer: v.answer.slice(),
        stem: String(v.stem || '').slice(0, 200),
        hits: Number(v.hits) || 0,
        updatedAt: Number(v.updatedAt) || Date.now(),
      };
      n++;
    }
    await flush();
    return n;
  }

  // ── 运行时「已试组合」记忆（会话级，不持久化） ──
  const tried = new Map(); // questionKey -> Set<comboString>

  function comboTag(idxArray) {
    return idxArray.slice().sort((a, b) => a - b).join(',');
  }

  function markTried(key, idxArray) {
    if (!tried.has(key)) tried.set(key, new Set());
    tried.get(key).add(comboTag(idxArray));
  }

  function hasTried(key, idxArray) {
    const s = tried.get(key);
    return !!s && s.has(comboTag(idxArray));
  }

  function clearTried(key) {
    if (key) tried.delete(key);
    else tried.clear();
  }

  function triedCount(key) {
    const s = tried.get(key);
    return s ? s.size : 0;
  }

  NS.bank = {
    load,
    flush,
    lookup,
    remember,
    recordHit,
    size,
    dump,
    clear,
    importBank,
    keyOf,
    comboTag,
    markTried,
    hasTried,
    clearTried,
    triedCount,
  };
})();
