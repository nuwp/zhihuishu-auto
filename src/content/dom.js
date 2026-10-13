/**
 * dom.js — DOM 探测 / 拟真点击 / 文本归一化 工具集
 *
 * 挂载到 window.__ZHS.dom，供其余 content 模块使用。
 * 不依赖任何框架，纯 DOM API。
 */
(function () {
  'use strict';

  const NS = (window.__ZHS = window.__ZHS || {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 随机区间延时，避免机械节奏 */
  const jitter = (base, spread = 0.35) =>
    sleep(Math.round(base * (1 + (Math.random() * 2 - 1) * spread)));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const st = window.getComputedStyle(el);
    if (!st) return false;
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (Number(st.opacity) < 0.05) return false;
    if (st.pointerEvents === 'none') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return true;
  }

  /** 元素是否真的落在视口内（用于判断是否需要滚动） */
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  }

  /**
   * 全角 → 半角。
   * U+FF01..U+FF5E 与 ASCII 0x21..0x7E 一一对应，整体偏移 0xFEE0；
   * 其余是中文标点的等价映射。
   */
  function toHalfWidth(input) {
    return String(input)
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ')
      .replace(/\u3001/g, ',')   // 、
      .replace(/\u3002/g, '.')   // 。
      .replace(/[\u201c\u201d\u301d\u301e]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\u300a/g, '<').replace(/\u300b/g, '>')      // 《》
      .replace(/\u3010/g, '[').replace(/\u3011/g, ']')      // 【】
      .replace(/[\u2014\u2015\u2500]/g, '-')                // — ― ─
      .replace(/\u2026/g, '...')                            // …
      .replace(/\u00b7/g, '.');                             // ·
  }

  /** 文本归一化：统一全半角 / 去空白 / 剥离题号，用于题库键 */
  function normalize(text) {
    if (!text) return '';
    return toHalfWidth(text)
      .replace(/\s+/g, '')
      .replace(/^[（(]\d+[）)]\s*/, '')       // 题号 (1) （1）
      .replace(/^\d+\s*[、.,:：]\s*/, '')     // 题号 1、 1. 1: 1，
      .trim()
      .toLowerCase();
  }

  /** 稳定的 32 位字符串哈希，用于题库键 */
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /** 元素在 DOM 中的深度，用于「取最内层」这种消歧 */
  function depth(el) {
    let d = 0;
    let n = el;
    while (n && n.parentElement) {
      d++;
      n = n.parentElement;
    }
    return d;
  }

  /** 元素中心相对「顶层视口」的坐标（跨 iframe 累加各层偏移） */
  function absolutePoint(el) {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    let w = window;
    let guard = 0;
    while (w !== w.parent && guard++ < 12) {
      let fe = null;
      try { fe = w.frameElement; } catch (e) { break; } // 跨域：拿不到就放弃累加
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      try { w = w.parent; } catch (e) { break; }
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  /**
   * 把点击请求交给 background 走 CDP，并在回调里拿到真实结果。
   *
   * 之前这是「发完就返回 true」的fire-and-forget，导致 CDP 失败时静默失效：
   * realClick 以为点过了，就不再派发合成事件，结果什么都没发生。
   * 最典型的失败场景是 DevTools 已经占着调试会话 ——
   * chrome.debugger.attach() 会直接抛 "Another debugger is already attached"。
   *
   * @param {Element} el
   * @param {object}  opts
   * @param {(ok:boolean, detail?:string) => void} [done] 结果回调
   */
  function cdpClick(el, opts, done) {
    const p = absolutePoint(el);
    if (!p) {
      if (done) done(false, 'no-point');
      return false;
    }
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) {
        if (done) done(false, 'no-runtime');
        return false;
      }
      chrome.runtime.sendMessage({
        type: 'ZHS_CDP_CLICK',
        x: p.x,
        y: p.y,
        button: (opts && opts.button) || 'left',
        clickCount: (opts && opts.doubleClick) ? 2 : 1,
      }, (res) => {
        const err = chrome.runtime.lastError;
        const ok = !err && !!(res && res.ok);
        if (done) done(ok, err ? err.message : (res && res.msg));
      });
      return true;
    } catch (e) {
      if (done) done(false, String(e && e.message));
      return false;
    }
  }

  /**
   * 拟真点击：派发完整的指针事件序列。
   * 大多数 Vue/React 站点监听原生 click，dispatchEvent 的 MouseEvent 即可触发；
   * 完整序列（pointerover→down→up→click）能覆盖监听 mousedown/mouseup 的组件。
   *
   * 注意：isTrusted 仍为 false。若目标站点校验 isTrusted，
   * 请开启 "高保真点击（chrome.debugger）"，由 background 走 CDP Input.dispatchMouseEvent。
   */
  /**
   * 页面现在是不是"在前台看得到"。
   *
   * 保留下来是为了排障时能一眼看到页面状态（日志/诊断里有用），
   * **不要再拿它来决定走哪条点击路径** —— 试过，两头不讨好：
   * 后台跳过 CDP 改走合成事件，结果站点校验 `isTrusted` 直接把合成事件忽略，
   * 等于把"可能无效"换成了"必然被识破"。点法的事交给调用方换着试。
   */
  function pageInBackground() {
    try {
      if (typeof document === 'undefined') return false;
      if (document.visibilityState === 'hidden') return true;
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) return true;
    } catch (e) { /* 拿不到就当在前台 */ }
    return false;
  }

  function realClick(el, options) {
    if (!el || !el.isConnected) return false;
    const opts = options || {};
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch (e) {
      try { el.scrollIntoView(); } catch (e2) { /* noop */ }
    }

    // ⚠ 这里**不再**按"页面在不在前台"来决定走哪条路。
    //
    // 试过一版：后台就跳过 CDP 直接走合成事件。结果是"点了还是没反应"——
    // 因为智慧树那种站点会校验 `isTrusted`，合成事件（dispatchEvent）
    // **恒为 false**，站点直接忽略。等于把"CDP 在后台可能无效"换成了
    // "合成事件必然被识破"，两头不讨好。
    //
    // 现在改成：照配置走 CDP，点完没反应时由调用方**换另一种点法再试一次**
    //（见 main.js 切章节那段）。谁能用取决于页面状态，用日志分不出来，
    // 那就两条都试，而不是赌一条。
    const wantCdp = !opts.forceSynthetic
      && (opts.forceCdp || (NS.config && NS.config.get().highFidelityClick));
    if (wantCdp) {
      // CDP 通道可能整个失效 —— 最典型的是 DevTools 已经占着调试会话
      // （chrome.debugger.attach 会抛 "Another debugger is already attached"）。
      // 那种情况下必须退回合成事件：虽然会被平台识破，但总好过整条流程原地卡死
      // —— 之前这里静默失败，表现就是「点击计数在涨、选项却一个都选不中」。
      // 走 NS.dom.cdpClick 而不是直接抓函数名：晚一层绑定才换得掉。
      // （直接引用会在模块加载时被闭包抓住，测试里替换不掉 ——
      //   那样"后台不走 CDP"这条断言其实什么都没验。）
      const sendCdp = NS.dom.cdpClick || cdpClick;
      const sent = sendCdp(el, opts, (ok, detail) => {
        if (ok) return;
        if (typeof NS.onCdpFallback === 'function') {
          try { NS.onCdpFallback(detail); } catch (e) { /* noop */ }
        }
        dispatchSyntheticClick(el, opts);
      });
      if (sent) return true;
    }

    return dispatchSyntheticClick(el, opts);
  }

  /**
   * 合成事件序列：pointerover → mousedown → mouseup → click。
   * 大多数 Vue/React 站点监听原生 click，dispatchEvent 的 MouseEvent 即可触发；
   * 完整序列能覆盖监听 mousedown/mouseup 的组件。
   * isTrusted 恒为 false，会被智慧树那种检测识破，所以只作 CDP 不可用时的兜底。
   */
  function dispatchSyntheticClick(el, opts) {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);

    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    };

    const fire = (type, extra) => {
      let ev;
      const init = Object.assign({}, base, extra || {});
      try {
        if (type.indexOf('pointer') === 0) {
          ev = new PointerEvent(type, Object.assign({
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            width: 1,
            height: 1,
            pressure: type === 'pointerdown' ? 0.5 : 0,
          }, init));
        } else {
          ev = new MouseEvent(type, init);
        }
      } catch (e) {
        ev = new Event(type, { bubbles: true, cancelable: true });
      }
      try {
        el.dispatchEvent(ev);
      } catch (e) { /* noop */ }
    };

    fire('pointerover');
    fire('mouseover');
    fire('pointermove');
    fire('mousemove');
    fire('pointerdown');
    fire('mousedown');
    fire('pointerup', { buttons: 0 });
    fire('mouseup', { buttons: 0 });
    fire('click', { buttons: 0 });

    if (opts && opts.doubleClick) {
      fire('dblclick', { buttons: 0, detail: 2 });
    }
    return true;
  }

  /** 派发一次原生 input/change，用于必须走表单逻辑的控件 */
  function fireInput(el) {
    if (!el) return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 只读快照：把一组节点的可读文本拼起来 */
  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  /** 排除掉明显是外壳的元素，返回「最内层」的那批 */
  function innermost(list) {
    return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
  }

  /** 轮询等待条件成立 */
  async function waitFor(fn, timeoutMs, stepMs) {
    const t0 = Date.now();
    const step = stepMs || 200;
    while (Date.now() - t0 < (timeoutMs || 5000)) {
      let v;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  /**
   * 选项行该点哪里。
   *
   * ⚠ 这一条对应「插件没法自动选择选项」。
   *
   * 知到的选项是**满宽的一行**：`<li class="subject_node_item">` 里面是
   * `<span class="tag">A</span><span>对</span>`，单选框在最左边。
   * 而 `realClick` 走的是元素**几何中心** —— 落点在右边一大片空白上，
   * 点下去什么都不会发生。行看着能点（选中时整行会变色），
   * 但"能点"和"点中心"是两件事。
   *
   * 所以按优先级找一个更小的目标：
   *   ① 原生 input / label —— 站点用原生控件的，点它最准
   *   ② 圆圈类元素（radio / check / circle / tag / icon）—— 站点自己画的单选框
   *   ③ 行内第一段有文字的末梢节点 —— 文字区一般贴着左边，不会落到空白里
   *   ④ 兜底：整行
   */
  function clickTargetIn(el) {
    if (!el) return el;
    const q = (sel) => { try { return el.querySelector(sel); } catch (e) { return null; } };

    const native = q('input[type="radio"],input[type="checkbox"],label');
    if (native && isVisible(native)) return native;

    const circle = q('[class*="radio"],[class*="checkbox"],[class*="check"],' +
      '[class*="circle"],[class*="tag"],[class*="icon"]');
    if (circle && isVisible(circle)) return circle;

    let leaves;
    try { leaves = el.querySelectorAll('span,p,em,strong,b,i'); } catch (e) { leaves = []; }
    for (const leaf of leaves) {
      if (leaf.children && leaf.children.length) continue;
      if (!isVisible(leaf)) continue;
      if (textOf(leaf)) return leaf;
    }
    return el;
  }

  /**
   * 一个元素"看起来变了没有"的指纹。
   *
   * 用来判断**刚才那一下点击到底生效了没有** —— 不依赖任何 class 名，
   * 所以站点换一种画法也照样能用。选中态常常只体现在
   * class / style / 内层节点上，这三样任一变化就说明点着了。
   */
  function signatureOf(el) {
    if (!el) return '';
    const cls = typeof el.className === 'string' ? el.className : '';
    const style = (el.getAttribute && el.getAttribute('style')) || '';
    const aria = (el.getAttribute && (
      (el.getAttribute('aria-checked') || '') + (el.getAttribute('aria-selected') || '')
    )) || '';
    let len = 0;
    try { len = el.innerHTML ? el.innerHTML.length : 0; } catch (e) { len = 0; }
    return cls + '|' + style + '|' + aria + '|' + len;
  }

  NS.dom = {
    sleep,
    jitter,
    isVisible,
    inViewport,
    normalize,
    toHalfWidth,
    hash,
    depth,
    // 页面在后台时会把这条路径整条跳过 —— 见 pageInBackground 的注释。
    pageInBackground,
    realClick,
    dispatchSyntheticClick,
    absolutePoint,
    cdpClick,
    fireInput,
    textOf,
    innermost,
    waitFor,
    clickTargetIn,
    signatureOf,
  };
})();
