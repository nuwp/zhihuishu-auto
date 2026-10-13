/**
 * config.js — 配置读取/写入/变更广播
 *
 * 配置存 chrome.storage.local.config（profile 级，全标签页共享）。
 * content script 启动时读一次，之后靠 storage.onChanged 实时同步。
 */
(function () {
  'use strict';

  const NS = (window.__ZHS = window.__ZHS || {});
  const KEY = 'config';

  const DEFAULTS = NS.DEFAULTS || window.ZHS_DEFAULTS || {};
  const MAX_RATE = NS.MAX_PLAYBACK_RATE || window.ZHS_MAX_PLAYBACK_RATE || 1.8;
  // 越界收口与老配置迁移都放在 shared 里，content 与 popup 共用同一份实现
  const normalize = NS.normalizeConfig || window.ZHS_normalizeConfig
    || ((raw) => Object.assign({}, DEFAULTS, raw || {}));
  const sanitizeRate = NS.sanitizeConfig || window.ZHS_sanitizeConfig || ((c) => c);

  let cache = Object.assign({}, DEFAULTS);
  const listeners = new Set();

  async function load() {
    try {
      const got = await chrome.storage.local.get(KEY);
      cache = normalize(got && got[KEY]);
    } catch (e) {
      cache = normalize(null);
    }
    return cache;
  }

  function get() {
    return cache;
  }

  async function set(patch) {
    // 这里只收紧越界值，不做 migrate —— set 是用户此刻的显式选择，
    // 主动关掉高保真点击这种决定必须被尊重，不能被迁移逻辑又扳回去
    cache = sanitizeRate(Object.assign({}, cache, patch || {}));
    try {
      await chrome.storage.local.set({ [KEY]: cache });
    } catch (e) { /* noop */ }
    listeners.forEach((fn) => {
      try { fn(cache); } catch (e) { /* noop */ }
    });
    return cache;
  }

  async function reset() {
    cache = normalize(null);
    try {
      await chrome.storage.local.set({ [KEY]: cache });
    } catch (e) { /* noop */ }
    listeners.forEach((fn) => {
      try { fn(cache); } catch (e) { /* noop */ }
    });
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      cache = normalize(changes[KEY].newValue);
      listeners.forEach((fn) => {
        try { fn(cache); } catch (e) { /* noop */ }
      });
    });
  } catch (e) { /* noop */ }

  NS.config = { DEFAULTS, load, get, set, reset, onChange };
})();
