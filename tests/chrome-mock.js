/**
 * chrome-mock.js — 测试用的 chrome.* API 替身 + jsdom 补丁
 *
 * 关键忠实度要求：真实的 chrome.storage.local.set 只会为**真正发生变化的 key**
 * 触发 onChanged，而且 newValue 是结构化克隆（不是同一个对象引用）。
 * 如果 mock 不还原这一点，配置模块会被别的模块写 storage 时的空变更反复刷回默认值，
 * 测试就会得到现实中不存在的失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * @param {object} store  共享的 storage.local 后备对象
 * @returns {{api:object, dispatchToContent:Function, listenerCount:Function, store:object}}
 */
function makeChromeMock(store) {
  const changeListeners = [];
  const msgListeners = [];

  const api = {
    storage: {
      local: {
        get: (k) => {
          if (k == null) {
            const out = {};
            Object.keys(store).forEach((key) => { out[key] = clone(store[key]); });
            return Promise.resolve(out);
          }
          if (typeof k === 'string') return Promise.resolve({ [k]: clone(store[k]) });
          if (Array.isArray(k)) {
            const out = {};
            k.forEach((key) => { out[key] = clone(store[key]); });
            return Promise.resolve(out);
          }
          return Promise.resolve({});
        },

        set: (obj) => {
          const changes = {};
          for (const key of Object.keys(obj)) {
            const next = obj[key];
            const prev = store[key];
            // 与真实实现对齐：值没变就不播报变更
            if (JSON.stringify(prev) === JSON.stringify(next)) continue;
            changes[key] = { oldValue: clone(prev), newValue: clone(next) };
            store[key] = clone(next);
          }
          if (Object.keys(changes).length) {
            changeListeners.slice().forEach((fn) => {
              try { fn(changes, 'local'); } catch (e) { /* noop */ }
            });
          }
          return Promise.resolve();
        },

        remove: (k) => {
          const keys = Array.isArray(k) ? k : [k];
          const changes = {};
          keys.forEach((key) => {
            if (!(key in store)) return;
            changes[key] = { oldValue: clone(store[key]), newValue: undefined };
            delete store[key];
          });
          if (Object.keys(changes).length) {
            changeListeners.slice().forEach((fn) => {
              try { fn(changes, 'local'); } catch (e) { /* noop */ }
            });
          }
          return Promise.resolve();
        },

        clear: () => {
          Object.keys(store).forEach((k) => { delete store[k]; });
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (fn) => changeListeners.push(fn),
        removeListener: (fn) => {
          const i = changeListeners.indexOf(fn);
          if (i >= 0) changeListeners.splice(i, 1);
        },
      },
    },

    runtime: {
      id: 'test-extension-id',
      lastError: null,
      onMessage: {
        addListener: (fn) => msgListeners.push(fn),
        removeListener: (fn) => {
          const i = msgListeners.indexOf(fn);
          if (i >= 0) msgListeners.splice(i, 1);
        },
      },
      sendMessage: (msg, cb) => {
        if (typeof cb === 'function') cb({ ok: true });
        return Promise.resolve({ ok: true });
      },
    },

    tabs: {
      update: () => Promise.resolve(),
      sendMessage: (id, msg, cb) => { if (cb) cb({ ok: true }); },
    },

    scripting: { executeScript: () => Promise.resolve([]) },
  };

  return {
    api,
    store,
    /** 模拟 popup / background 向 content script 发消息 */
    dispatchToContent(msg) {
      return new Promise((resolve) => {
        let settled = false;
        const reply = (r) => { if (!settled) { settled = true; resolve(r); } };
        let async_ = false;
        for (const fn of msgListeners) {
          const ret = fn(msg, { tab: { id: 1 } }, reply);
          if (ret === true) async_ = true;
        }
        if (!async_) reply(null);
        setTimeout(() => reply(null), 800);
      });
    },
    listenerCount: () => msgListeners.length,
    changeListenerCount: () => changeListeners.length,
  };
}

/**
 * jsdom 里所有元素的 getBoundingClientRect 都是 0，会让 isVisible() 一律判否。
 * 这里按 computed style 伪造一个合理矩形，并补上 jsdom 缺失的 scrollIntoView。
 */
function patchDom(win) {
  const rect = (visible) => ({
    x: visible ? 100 : 0,
    y: visible ? 100 : 0,
    width: visible ? 160 : 0,
    height: visible ? 32 : 0,
    top: visible ? 100 : 0,
    left: visible ? 100 : 0,
    right: visible ? 260 : 0,
    bottom: visible ? 132 : 0,
    toJSON() { return this; },
  });

  win.Element.prototype.getBoundingClientRect = function () {
    let st = null;
    try { st = win.getComputedStyle(this); } catch (e) { st = null; }
    if (st) {
      if (st.display === 'none' || st.visibility === 'hidden') return rect(false);
      const op = st.opacity;
      if (op !== '' && Number(op) < 0.05) return rect(false);
    }
    return rect(true);
  };

  win.Element.prototype.scrollIntoView = function () { /* jsdom 没实现 */ };
}

// manifest 里 content_scripts.js 的顺序，保持一致
const CONTENT_FILES = [
  'src/shared/defaults.js',
  'src/shared/web-ai.js',
  'src/content/dom.js',
  'src/content/config.js',
  'src/content/bank.js',
  'src/content/video.js',
  'src/content/playlist.js',
  'src/content/quiz.js',
  'src/content/ability.js',
  'src/content/ai-bridge.js',
  'src/content/main.js',
];

/** 按 manifest 的顺序注入 content scripts */
function injectContentScripts(win, ROOT) {
  for (const rel of CONTENT_FILES) {
    win.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  }
}

/**
 * 把 shared/ 下的模块加载进一个伪 window（Node 侧的测试用）。
 * shared 模块是 UMD 风格 IIFE：有 window 就挂 window.__ZHS / window.ZHS_*。
 */
function loadShared(rels, ROOT) {
  const vm = require('vm');
  const win = {};
  const ctx = vm.createContext({
    window: win,
    self: win,
    console,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Map,
    Set,
    Date,
  });
  for (const rel of [].concat(rels)) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }
  return win;
}

module.exports = {
  makeChromeMock, patchDom, injectContentScripts, CONTENT_FILES, clone, loadShared,
};
