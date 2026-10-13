/**
 * ai-send.test.js — 「字进去了但发不出去」这一环的行为（零依赖，手工假 DOM）
 *
 * 这条链路最脆的一步就是"提交"：点发送按钮、敲回车、换纯键盘序列 ——
 * 每一种都可能在某个站点上失效。用户的原话是要**循环着一直试**，
 * 而不是试一遍就放弃（试一遍就退，表现就是"插件卡死"：弹窗挂着、视频被 hold）。
 *
 * 这个文件不搭真 DOM，而是用手写的假对象把 src/ai/web-ai.js 跑起来，
 * 直接观察它到底点了几次按钮、敲了几次回车。要验证的就是两件事：
 *   ① 一直不成功时会**反复重试**（轮数 > 1）
 *   ② 但受一个独立的 sendDeadline 兜住，不会无限转下去
 *
 * 运行： node tests/ai-send.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    fail++;
    failures.push({ name, err: e });
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message);
  }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '  got=' + sa + ' want=' + sb);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 一个假装是 DOM 的壳 ──────────────────────────────────
//
// src/ai/web-ai.js 用到的 DOM 面很窄：querySelectorAll / activeElement /
// getComputedStyle / getBoundingClientRect / innerText / document.body。
// 手写比引 jsdom 更快也更好控制 —— 这个文件因此保持零依赖。

function makeEl(opts) {
  const el = {
    isConnected: true,
    tagName: opts.tag || 'DIV',
    className: opts.cls || '',
    textContent: opts.text || '',
    innerText: opts.text || '',
    value: opts.value,
    children: opts.children || [],
    disabled: !!opts.disabled,
    attrs: opts.attrs || {},
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains(other) { return other === this; },
    scrollIntoView() {},
    focus() { win.document.activeElement = this; },
    dispatchEvent() { return true; },
    getBoundingClientRect() {
      return { width: 200, height: 32, left: 40, top: 60, right: 240, bottom: 92, x: 40, y: 60 };
    },
    closest(sel) {
      void sel;
      return null;
    },
  };
  el.classList = { contains: () => false, add() {}, remove() {} };
  return el;
}

let win = null;

/**
 * 驱动发出去的消息都记在这儿。
 *
 * ⚠ 每个用例开始前必须用 resetCalls() 清空，**不能写 cdpCalls = []** ——
 * 驱动在加载时就把 sendMessage 抓进了闭包，它引用的永远是下面这个数组对象；
 * 给它换个新数组是换不掉的（这个坑在写这个文件时踩过一次）。
 */
let cdpCalls = [];
function resetCalls() { cdpCalls.length = 0; }

function makeEnv(opts) {
  const o = opts || {};
  const textarea = makeEl({ tag: 'TEXTAREA', value: '', cls: 'chat-input' });
  const sendBtn = makeEl({ tag: 'BUTTON', cls: 'send-btn', attrs: { 'aria-disabled': 'false' } });
  const inputHolder = makeEl({
    cls: 'chat-input-wrap', children: [textarea],
    querySelectorAll() { return [textarea]; },
  });
  void inputHolder;
  const replyList = [];

  const doc = {
    activeElement: null,
    body: { innerText: '' },
    createElement: () => makeEl({}),
    getElementById: () => null,
    querySelectorAll(sel) {
      // 只区分三类：输入框、发送按钮、回答
      if (/textarea|contenteditable/i.test(sel)) return [textarea];
      if (/send|submit|发送/i.test(sel)) return o.noSendButton ? [] : [sendBtn];
      if (/markdown|message|answer|receive/i.test(sel)) return replyList.slice();
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };

  win = {
    document: doc,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Date, Promise, isFinite,
    Function: undefined,   // 用不到，显式挡掉避免手滑
    location: { href: 'https://chat.deepseek.com/a/chat/s/1', pathname: '/a/chat/s/1' },
  };

  win.__ZHS = undefined;
  win.chrome = {
    runtime: {
      id: 'test',
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(msg, cb) {
        // 没有回调的那种（比如测试里手动构造的）不记，只记驱动的真实调用
        if (typeof cb !== 'function') return Promise.resolve({ ok: true });
        cdpCalls.push(msg);
        // 站点行为由 opts 决定：有些站点认按钮，有些只认回车
        if (o.sendOnEnter && msg.type === 'ZHS_CDP_KEY' && msg.key === 'Enter' && !msg.raw) {
          textarea.value = '';
        }
        cb({ ok: true });
        return Promise.resolve({ ok: true });
      },
      lastError: null,
    },
  };

  // 加载共享模块（装的是 window.__ZHS.webAI）
  const shared = fs.readFileSync(path.join(ROOT, 'src/shared/web-ai.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'self', shared)(win, win);

  // dom.js 的等价物：只要 realClick / absolutePoint / textOf 这几个。
  // ⚠ 必须在加载驱动**之前**装好 —— 驱动在加载时就把 realClick 抓进了闭包，
  // 之后再改 win.__ZHS.dom.realClick 是改不动的（这个坑测试里踩过一次）。
  // 所以留一个 `win.__onClick` 钩子：单个用例要自定义点击行为时改钩子，
  // 不用去动那个已经被抓进闭包的函数。
  win.__onClick = null;
  win.__ZHS.dom = {
    realClick(el) {
      el.__clicked = (el.__clicked || 0) + 1;
      if (win.__onClick) return win.__onClick(el);
      if (o.sendOnClick && el === sendBtn) textarea.value = '';
      return true;
    },
    absolutePoint(el) { void el; return { x: 100, y: 100 }; },
    textOf(el) { return (el && (el.innerText || el.textContent)) || ''; },
    isVisible(el) { void el; return true; },
  };

  // config：让 askStableMs 之类有值
  win.__ZHS.config = { get: () => ({ askStableMs: 200, askWaitMs: 30000 }) };

  // 加载被测的驱动。
  //
  // ⚠ chrome 必须当参数显式传进去：`new Function(...)` 抛出来的函数活在
  // **Node 的全局**里，那里的 `chrome` 是 undefined，而驱动里的
  // callBackground 有一句 `if (!chrome ...) return finish(false)` ——
  // 它会安静地什么都不发（这个坑测试里踩过一次，表现是"回车一次都没敲"）。
  const driver = fs.readFileSync(path.join(ROOT, 'src/ai/web-ai.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'self', 'document', 'location', 'chrome', driver)(
    win, win, doc, win.location, win.chrome
  );

  return { textarea, sendBtn, replyList, doc, NS: win.__ZHS };
}

console.log('\n\x1b[1m知到自动助手 — 提交环节（循环重试）\x1b[0m\n');

// ── [1] 一直失败时会反复重试 ─────────────────────────────
(async function main() {
  console.log('\x1b[1m[1] 三路都失效时：循环重试，而不是试一遍就退\x1b[0m');

  {
    resetCalls();
    const { textarea, sendBtn, NS } = makeEnv({});
    textarea.value = '直接说出答案，不用解析。\n题目：测试\nA. 甲\nB. 乙\n答案：B';

    // 模拟一个「点了按钮也不发、敲回车也不发」的站点
    const driver = NS.webAIDriver;
    const t0 = Date.now();
    const res = await driver._test.submit(
      NS.webAI.PROVIDERS[0], textarea,
      Date.now() + 30000,          // 整个等待预算 30s
      textarea.value
    );
    const took = Date.now() - t0;

    check('失败时不会只试一遍就退出', () => {
      const clicks = sendBtn.__clicked || 0;
      const enters = cdpCalls.filter((m) => m.type === 'ZHS_CDP_KEY' && !m.raw).length;
      ok(clicks >= 2, '发送按钮只点了 ' + clicks + ' 次 —— 应当循环重试');
      ok(enters >= 2, '回车只敲了 ' + enters + ' 次 —— 应当循环重试');
    });

    check('重试受独立时限兜住，不会无限转下去', () => {
      eq(res.ok, false, '不该报成功');
      ok(took < 20000, '耗时 ' + took + 'ms —— 提交阶段的时限没生效');
      ok(res.rounds >= 2, '轮数 ' + res.rounds);
    });

    check('失败时留下可诊断的轨迹', () => {
      ok(Array.isArray(res.trail) && res.trail.length > 0, '没有 trail');
      ok(res.trail.some((t) => /focus=/.test(t)), 'trail 里没有焦点信息：' + JSON.stringify(res.trail));
    });
  }

  // ── [2] 成功路径 ───────────────────────────────────────
  console.log('\n\x1b[1m[2] 正常站点：第一轮就成，不浪费时间\x1b[0m');

  {
    resetCalls();
    const { textarea, NS } = makeEnv({ sendOnClick: true });
    textarea.value = '直接说出答案，不用解析。\n题目：测试\nA. 甲\nB. 乙\n答案：B';

    const t0 = Date.now();
    const res = await NS.webAIDriver._test.submit(
      NS.webAI.PROVIDERS[0], textarea, Date.now() + 30000, textarea.value
    );
    const took = Date.now() - t0;

    check('一次点击就判定成功', () => {
      eq(res.ok, true, JSON.stringify(res));
      eq(res.via, 'button', '成功路径：' + res.via);
      ok(took < 3000, '花了 ' + took + 'ms，太慢');
    });

    check('成功后不再补敲回车', () => {
      const enters = cdpCalls.filter((m) => m.type === 'ZHS_CDP_KEY').length;
      eq(enters, 0, '不该再敲回车：' + enters + ' 次');
    });
  }

  // ── [3] 回车能救回来的站点 ─────────────────────────────
  console.log('\n\x1b[1m[3] 按钮无效但回车有效：中间那一路要能救回来\x1b[0m');

  {
    resetCalls();
    const { textarea, sendBtn, NS } = makeEnv({ sendOnEnter: true });
    textarea.value = '直接说出答案，不用解析。\n题目：测试\nA. 甲\nB. 乙\n答案：B';

    const res = await NS.webAIDriver._test.submit(
      NS.webAI.PROVIDERS[0], textarea, Date.now() + 30000, textarea.value
    );

    check('按钮那条路无效时，改用回车并判定成功', () => {
      eq(res.ok, true, JSON.stringify(res));
      ok(/enter/.test(res.via), '成功路径应当是回车：' + res.via);
    });

    check('按钮先试过（顺序是 按钮 → 回车，不是反过来）', () => {
      ok((sendBtn.__clicked || 0) >= 1, '压根没点按钮');
      eq(textarea.value, '', '假站点说发出去了，输入框该被清空');
    });
  }

  // ── [4] 输入框本来就是空的 ─────────────────────────────
  console.log('\n\x1b[1m[4] 输入框是空的：别在那儿空敲回车\x1b[0m');

  {
    resetCalls();
    const { textarea, NS } = makeEnv({});
    textarea.value = '';
    const res = await NS.webAIDriver._test.submit(
      NS.webAI.PROVIDERS[0], textarea, Date.now() + 30000, ''
    );
    check('直接判失败并说明原因，不浪费时间重试', () => {
      eq(res.ok, false);
      eq(res.why, 'empty', JSON.stringify(res));
      eq(cdpCalls.filter((m) => m.type === 'ZHS_CDP_KEY').length, 0, '不该敲回车');
    });
  }

  // ── [6] 塞字：不依赖焦点那条路要真的可用 ─────────────────
  console.log('\n\x1b[1m[6] 塞字优先走不依赖焦点的 DOM 路径\x1b[0m');

  {
    resetCalls();
    const { textarea, NS } = makeEnv({});
    // 焦点故意不放输入框上（模拟"点击被遮挡层接走了"）
    win.document.activeElement = null;

    const via = await NS.webAIDriver._test.typePrompt(textarea, '直接说出答案，不用解析。\n题目：X\nA. 甲\nB. 乙\n答案：B');

    check('焦点不在输入框上时，也能把字塞进去', () => {
      ok(via, '三条路径都失败了：' + via);
      eq(via, 'dom', '应当走 DOM setter 那条（不需要焦点）：' + via);
      ok(textarea.value.length > 10, '输入框还是空的');
    });

    check('走 DOM 路径时不调用 CDP 塞字（省一次往返）', () => {
      const inserts = cdpCalls.filter((m) => m.type === 'ZHS_CDP_TEXT');
      eq(inserts.length, 0, 'DOM 路径成功了还去调 insertText：' + inserts.length + ' 次');
    });
  }

  {
    resetCalls();
    const { textarea, NS } = makeEnv({});
    // 这次焦点是对的，走哪条都行，但也要成功
    win.document.activeElement = textarea;
    const via = await NS.webAIDriver._test.typePrompt(textarea, '短一点的内容，够长就行');
    check('焦点正确时同样成功', () => {
      ok(via, '塞字失败');
      ok(textarea.value.length > 5, 'value=' + JSON.stringify(textarea.value));
    });
  }

  // ── [7] 重新塞字兜底 ───────────────────────────────────
  console.log('\n\x1b[1m[7] 站点把输入回滚了：重新塞一遍再发\x1b[0m');

  {
    resetCalls();
    const { textarea, sendBtn, NS } = makeEnv({});
    textarea.value = '直接说出答案，不用解析。\n题目：测试\nA. 甲\nB. 乙\n答案：B';
    let sends = 0;
    // 站点行为：按钮点了没用；回车只在"第二次被塞过字之后"才认
    win.chrome.runtime.sendMessage = (msg, cb) => {
      if (typeof cb !== 'function') return Promise.resolve({ ok: true });
      cdpCalls.push(msg);
      if (msg.type === 'ZHS_CDP_KEY' && msg.key === 'Enter' && !msg.raw) {
        sends++;
        if (sends >= 2) textarea.value = '';
      }
      cb({ ok: true });
      return Promise.resolve({ ok: true });
    };

    const res = await NS.webAIDriver._test.submit(
      NS.webAI.PROVIDERS[0], textarea, Date.now() + 30000, textarea.value
    );

    check('反复试到最后能成功，而不是早早放弃', () => {
      eq(res.ok, true, JSON.stringify(res));
      ok((sendBtn.__clicked || 0) >= 1, '压根没点按钮');
      ok(sends >= 2, '回车次数 ' + sends);
    });
  }

  // ── [9] 复现用户报的那个故障：消息在视口外 ─────────────
  //
  // 现象：问题明明发出去了、AI 也答了，插件却说"没发出去"。
  // 根因之一是 isVisible 额外要求"元素落在视口内"（r.bottom > 0 && r.top < vh）。
  // 聊得久一点、回答被滚出视野之后，那些消息就被判成"不可见"，
  // 于是 sent() / readReply() 全都数不到东西。
  console.log('\n\x1b[1m[9] 消息滚出视口后仍然要能被数到\x1b[0m');

  {
    resetCalls();
    const { textarea, NS } = makeEnv({ sendOnClick: true });
    // 造两条"在视口上方"的回答：top/bottom 全是负数（已被滚上去）
    const offscreen = [];
    for (let i = 0; i < 2; i++) {
      const el = makeEl({ cls: 'ds-markdown', text: '很长的历史回答 ' + i });
      el.getBoundingClientRect = () => ({
        width: 600, height: 120, left: 0, top: -900 - i * 200,
        right: 600, bottom: -780 - i * 200, x: 0, y: -900,
      });
      offscreen.push(el);
    }
    // 让回答区返回这两条
    win.document.querySelectorAll = (sel) => {
      if (/textarea|contenteditable/i.test(sel)) return [textarea];
      if (/send|submit|发送/i.test(sel)) return [win.__sendBtn || (win.__sendBtn = makeEl({ tag: 'BUTTON', cls: 'send-btn' }))];
      if (/markdown|message|answer|receive/i.test(sel)) return offscreen.slice();
      return [];
    };
    textarea.value = '直接说出答案，不用解析。\n题目：X\nA. 甲\nB. 乙\n答案：B';

    const replies = NS.webAIDriver._test.countReplies(NS.webAI.PROVIDERS[0]);

    check('滚出视口的消息不算"不存在"', () => {
      eq(replies.length, 2, '把视口外的消息滤掉了 —— 这正是"发出去了却说没发出去"的原因');
    });
  }

  // ── [10] 流式渲染时"条数忽增忽减"不能影响判断 ───────────
  console.log('\n\x1b[1m[10] 回答区指纹：最后一条换人 / 变长 都算动过\x1b[0m');

  {
    resetCalls();
    const { textarea, NS } = makeEnv({});
    const p = NS.webAI.PROVIDERS[0];

    const a1 = makeEl({ cls: 'ds-markdown', text: '旧回答' });
    win.document.querySelectorAll = (sel) => {
      if (/textarea|contenteditable/i.test(sel)) return [textarea];
      if (/send|submit|发送/i.test(sel)) return [];
      if (/markdown|message|answer|receive/i.test(sel)) return (win.__replies || []);
      return [];
    };
    win.__replies = [a1];
    const before = NS.webAIDriver._test.replyAnchor(p);

    check('指纹抓到了最后一条回答的内容与长度', () => {
      eq(before.count, 1, 'count');
      eq(before.last, '旧回答', 'last');
      ok(before.node === a1, 'node 应当是那个元素本身');
    });

    // 同样的条数，但最后一条换了节点 ⇒ 来了新回答
    const a2 = makeEl({ cls: 'ds-markdown', text: '新回答' });
    win.__replies = [a1, a2];
    const after = NS.webAIDriver._test.replyAnchor(p);
    check('条数变多时指纹会变', () => {
      ok(after.count > before.count || after.node !== before.node,
        '条数涨了、节点换了，指纹却一样');
    });

    // 流式渲染中途：条数不变，但文字在变长
    const a3 = makeEl({ cls: 'ds-markdown', text: '新回答还在写……' });
    win.__replies = [a1, a3];
    const mid = NS.webAIDriver._test.replyAnchor(p);
    check('回答正在变长时指纹也会变（流式渲染中途）', () => {
      ok(mid.last.length > after.last.length, '文字长度没反映出来');
    });
  }

  // ── [11] 复现用户报的"要点两次" ────────────────────────
  //
  // 现象：第一次点发送只把题目打进了输入框，没发出去；再点一次才发。
  // 根因：站点把我们的字收进自己的状态之前，发送按钮是**禁用**的，
  // 这时候点它等于什么都没发生。修法是「点之前先等按钮变能按」，
  // 而且点完不急着下结论 —— 紧接着在同一轮里补键盘那两路。
  console.log('\n\x1b[1m[11] 按钮一开始是禁用的：不许把这一次点击浪费掉\x1b[0m');

  {
    resetCalls();
    const { textarea, sendBtn, NS } = makeEnv({});
    textarea.value = '直接说出答案，不用解析。\n题目：测试\nA. 甲\nB. 乙\n答案：B';

    // 站点行为：按钮在 500ms 内是 aria-disabled=true（还没把字收进去），
    // 之后才变能按；点它才真的发出去。回车在这家站点无效。
    let unlocked = false;
    setTimeout(() => { unlocked = true; }, 500);
    sendBtn.getAttribute = (k) => (k === 'aria-disabled' ? (unlocked ? 'false' : 'true') : null);
    sendBtn.__clicked = 0;
    win.__onClick = (el) => {
      if (el === sendBtn && unlocked) textarea.value = '';
      return true;
    };

    const t0 = Date.now();
    const res = await NS.webAIDriver._test.submit(
      NS.webAI.PROVIDERS[0], textarea, Date.now() + 30000, textarea.value
    );
    const took = Date.now() - t0;

    check('等按钮变能按之后一次点成就发出去了', () => {
      eq(res.ok, true, JSON.stringify(res));
      ok(/^button/.test(res.via || ''), '应当是按钮那条路成功：' + res.via);
    });

    check('禁用期间那一次点击没有白发（压根不点它）', () => {
      // 只有在"能按"之后才允许点。所以点击数应当很少 —— 一两次，
      // 而不是"每轮都点一次、点到按钮终于自己亮了为止"。
      ok(sendBtn.__clicked <= 3,
        '按钮被点了 ' + sendBtn.__clicked + ' 次 —— 说明禁用期间也在乱点');
    });

    check('全过程明显短于"两轮"（这就是"要点两次"的观感来源）', () => {
      ok(took < 5000, '花了 ' + took + 'ms，太久了');
    });
    win.__onClick = null;
  }

  {
    resetCalls();
    const { textarea, sendBtn, NS } = makeEnv({ sendOnEnter: true });
    textarea.value = '直接说出答案，不用解析。\n题目：测试\nA. 甲\nB. 乙\n答案：B';
    // 这家站点更极端：按钮**永远**是禁用的，但回车能发出去。
    sendBtn.getAttribute = (k) => (k === 'aria-disabled' ? 'true' : null);

    const t0 = Date.now();
    const res = await NS.webAIDriver._test.submit(
      NS.webAI.PROVIDERS[0], textarea, Date.now() + 30000, textarea.value
    );
    const took = Date.now() - t0;

    check('按钮一直禁用时，不能把整轮时间耗在等它上，要接着走回车', () => {
      eq(res.ok, true, JSON.stringify(res));
      ok(/enter/.test(res.via || ''), '应当落到键盘那条路：' + res.via);
    });

    check('等"能按"的那一小会儿不会拖垮整体', () => {
      ok(took < 9000, '花了 ' + took + 'ms');
    });
  }

  // ── [12] 回答没有 .markdown 容器时，靠结构也要读得到 ────
  //
  // 用户实际遇到的：DeepSeek 的回答就是干干净净一行 `答案：B`，
  // **没有** .markdown 之类的容器（那些 class 只在回答里带格式时才出现）。
  // 于是选择器一个都没匹配到 → readReply 永远等不到新回答 →
  // 在"答案其实已经拿到"的状态下报「问题没发出去」。
  console.log('\n\x1b[1m[12] 回答区没有可匹配的 class 时，按结构兜底\x1b[0m');

  {
    resetCalls();
    const { textarea, NS } = makeEnv({});
    const p = NS.webAI.PROVIDERS[0];

    // 造一个"对话那一列"：够高、里面有带文字的末梢块，
    // 但**一个都不匹配** answer/source 选择器（class 全是站点自己的混淆名）
    const column = makeEl({ cls: 'x9f2a' });
    column.getBoundingClientRect = () => ({
      width: 700, height: 620, left: 300, top: 0, right: 1000, bottom: 620, x: 300, y: 0,
    });
    const mk = (text) => {
      const el = makeEl({ cls: 'd41b', text });
      el.children = [];
      el.childNodes = [{ nodeType: 3, nodeValue: text }];
      return el;
    };
    const blocks = [mk('很久以前的回答'), mk('另一个回答'), mk('答案：B')];
    column.querySelectorAll = (sel) => (/div|p|span|article|section|li/.test(sel) ? blocks : []);
    column.contains = (x) => blocks.indexOf(x) !== -1 || x === textarea;
    textarea.parentElement = column;

    // 选择器这条路全断
    win.document.querySelectorAll = (sel) => {
      if (/textarea|contenteditable/i.test(sel)) return [textarea];
      if (/send|submit|发送/i.test(sel)) return [];
      return [];      // ← 回答选择器一个都匹配不到
    };

    const list = NS.webAIDriver._test.countReplies(p, textarea);

    check('选择器全失配时，仍然从结构里把回答捞出来', () => {
      ok(list.length > 0, '一条都没捞到 —— 这就是"答案到了却说没发出去"的原因');
      const texts = list.map((e) => (e.innerText || e.textContent || '').trim());
      ok(texts.some((t) => /^答案：B$/.test(t)), '没捞到最后那条回答：' + JSON.stringify(texts));
    });

    check('指纹读得到最后一条回答的内容（readReply 靠它判断"写完了没"）', () => {
      const a = NS.webAIDriver._test.replyAnchor(p, textarea);
      ok(a.count > 0, 'count=0');
      ok(a.last.length > 0, 'last 是空的');
      eq(a.last, '答案：B', '最后一条应当是那条回答');
    });

    check('结构兜底认得最内层，不会把整列文字当成一条回答', () => {
      const a = NS.webAIDriver._test.replyAnchor(p, textarea);
      ok(a.last.length <= 40, 'last 太长了，说明收的不是末梢块：' + JSON.stringify(a.last));
    });
  }

  // ── [13] 泛化选择器命中了模式开关：不许把发送键挑错 ─────
  //
  // 用户截图里的现场：DeepSeek 的 composer 里「深度思考」「智能搜索」两个
  // 模式开关**也是** `div[role="button"][aria-disabled="false"]`，
  // 而站点表里这条泛化选择器排在 `button[aria-label="Send message"]` **前面**。
  // 旧代码 `findSend = anyVisible(...)` 会返回第一个可见的 —— 也就是模式开关。
  // 点它只是切了个模式，字还在输入框里 —— 表现就是"点了没反应"。
  console.log('\n\x1b[1m[13] 发送键排序：模式开关不许排在发送箭头前面\x1b[0m');

  {
    resetCalls();
    const { textarea, NS } = makeEnv({});
    const p = NS.webAI.PROVIDERS[0];

    // 造两个都命中泛化规则的 div[role=button]，外加真正的发送按钮
    const think = makeEl({ tag: 'DIV', cls: 'e0a1b2c', text: '深度思考' });
    think.attrs = { role: 'button', 'aria-disabled': 'false' };
    const search = makeEl({ tag: 'DIV', cls: 'f1b2c3d', text: '智能搜索' });
    search.attrs = { role: 'button', 'aria-disabled': 'false' };
    const send = makeEl({ tag: 'BUTTON', cls: 'send-btn', text: '' });
    send.attrs = { 'aria-label': 'Send message', 'aria-disabled': 'false' };
    [think, search, send].forEach((el) => { el.children = []; el.childNodes = []; });

    // 顺序很关键：模式开关排在发送键**前面**（真实 DOM 就是这样）
    const all = [think, search, send];
    win.document.querySelectorAll = (sel) => {
      if (/textarea|contenteditable/i.test(sel)) return [textarea];
      if (/role="button"/.test(sel) || /send|submit|button/i.test(sel)) return all;
      return [];
    };

    const desc = NS.webAIDriver._test.findSendCandidates
      ? NS.webAIDriver._test.findSendCandidates(p, textarea)
      : null;
    ok(desc, '没有暴露 findSendCandidates —— 这条测试需要它来验证排序');
    const names = desc.map((el) => {
      const cls = typeof el.className === 'string' ? el.className : '';
      return el.tagName.toLowerCase() + '.' + cls.split(/\s+/)[0];
    });

    check('排序后第一名是发送键，不是模式开关', () => {
      eq(names[0], 'button.send-btn', '排在第一位的是：' + JSON.stringify(names));
    });

    check('模式开关被排到了后面', () => {
      const iSend = names.indexOf('button.send-btn');
      const iThink = names.indexOf('div.e0a1b2c');
      const iSearch = names.indexOf('div.f1b2c3d');
      ok(iSend === 0, '发送键没排第一：' + JSON.stringify(names));
      ok(iThink > iSend || iThink === -1, '「深度思考」不该排在发送键前面：' + JSON.stringify(names));
      ok(iSearch > iSend || iSearch === -1, '「智能搜索」不该排在发送键前面：' + JSON.stringify(names));
    });

    check('「深度思考」「智能搜索」被识别为"不是发送键"', () => {
      desc.forEach((el) => {
        const cls = typeof el.className === 'string' ? el.className : '';
        if (cls === 'send-btn') return;
        ok(names.indexOf(el.tagName.toLowerCase() + '.' + cls.split(/\s+/)[0]) > 0,
          '模式开关混进前排了');
      });
    });
  }

  // ── [14] 整条 handleAsk 走通一遍（这条是最缺的） ─────────
  //
  // 真踩过：`readReply` 的签名里没有 el，而函数体里用了它 ——
  // 发送成功、刚开始等回答的那一刻就抛 `el is not defined`，
  // 用户看到的是「AI 没给出可用答案（在 DeepSeek 上出错: el is not defined）」。
  // 前面十几节全都在单独测 submit / countReplies / 排序……
  // **没有一条把 handleAsk 整条跑通**，所以这种"内部接口对不上"的错谁也拦不住。
  // 这一节就补这个缺口：从进页面到拿到答案，一步不落。
  console.log('\n\x1b[1m[14] handleAsk 整条链路走通，不许中途抛错\x1b[0m');

  {
    resetCalls();
    const { textarea, sendBtn, NS, doc } = makeEnv({});
    const p = NS.webAI.PROVIDERS[0];
    const prompt = '直接说出答案，不用解析。\n题目：测试题？\nA. 甲\nB. 乙\n答案：B';

    // 站点行为：点发送键 → 输入框清空 + 出现一条新回答
    const reply = makeEl({ cls: 'ds-markdown', text: '答案：B' });
    let replies = [];
    // 让输入框是空的（handleAsk 会先自己塞字）——塞字走的是 DOM 路径
    textarea.value = '';

    win.__onClick = (el) => {
      if (el === sendBtn) {
        textarea.value = '';
        replies = [reply];            // 回答出现了
      }
      return true;
    };
    win.document.querySelectorAll = (sel) => {
      if (/textarea|contenteditable/i.test(sel)) return [textarea];
      if (/send|submit|发送/i.test(sel)) return [sendBtn];
      if (/markdown|message|answer|receive/i.test(sel)) return replies;
      return [];
    };
    void prompt;

    const res = await NS.webAIDriver.handleAsk({
      type: 'ZHS_AI_ASK',
      timeoutMs: 12000,
      question: { stem: '测试题？', options: ['甲', '乙'], multi: false },
    });

    check('整条链路没抛错（内部接口对得上）', () => {
      ok(res, 'handleAsk 什么都没返回');
      ok(!/is not defined/.test(res.msg || ''),
        '抛了 ReferenceError：' + res.msg);
      ok(!/上出错/.test(res.msg || ''), '中途抛错：' + res.msg);
    });

    check('拿到了答案并解析成下标', () => {
      eq(res.ok, true, JSON.stringify(res));
      eq(res.answer, [1], '答案不对：' + JSON.stringify(res.answer));
    });

    check('回答是干净一行纯文本时也读得到（没有 .markdown 容器）', () => {
      // 这里 replies 里那条就是纯文本节点，走的是选择器命中的路径；
      // 关键是**读回答那一步没有崩**
      ok(res.raw === undefined || typeof res.raw === 'string', 'raw 字段类型不对');
      ok(res.source, '没说明答案是从哪读出来的');
    });
    void doc;
    win.__onClick = null;
  }

  // ── [15] 连续两次提问：第二问发不出去（用户报的那个） ────
  //
  // 现场：第一问完全正常（回包也读到了），第二问的字进了输入框却发不出去。
  // 根因：上一轮的回答还在流式输出时，composer 上那个按钮是**「停止生成」**
  // 而不是「发送」—— 点它只会把上一条回答掐掉，回车也不发消息。
  // 以前这里只是"等 3 秒"就往下走，而模型还在写，等于白等。
  // 现在会**主动点掉停止键**，让 composer 回到可发送状态。
  console.log('\n\x1b[1m[15] 连续提问：第二问要先停掉上一轮的生成\x1b[0m');

  {
    resetCalls();
    const { textarea, sendBtn, NS } = makeEnv({});
    const p = NS.webAI.PROVIDERS[0];

    // 站点行为：
    //   · 有「停止生成」按钮存在时，发送键点了没用、回车也没用（这就是真实现场）
    //   · 点了停止键之后，发送恢复正常
    // 注意：停掉生成**不会**立刻产生新回答 —— 新回答是"我们发出去之后"才来的。
    // （第一版 mock 把回答挂在停止键上，结果基线里已经有一条回答，
    //   readReply 永远等不到"新的那条"，测出来的是假故障。）
    let generating = true;
    const stopBtn = makeEl({ tag: 'BUTTON', cls: 'stop-btn' });
    stopBtn.attrs = { 'aria-label': '停止生成' };
    stopBtn.children = []; stopBtn.childNodes = [];
    let stopClicks = 0;
    const replies = [];
    // ⚠ 真实站点上生成会**自己结束**（这个 mock 原来永不结束，那是假现场）。
    // 契约也因此改了：**先等它自然答完，等不住才掐** —— 因为"掐断"的代价是
    // 丢掉上一道题的答案（用户现场：「第 6 题还在分析图片，第 7 题已经进了对话框」）。
    setTimeout(() => { generating = false; }, 1200);

    win.__onClick = (el) => {
      if (el === stopBtn) {
        stopClicks++;
        generating = false;
        return true;
      }
      if (el === sendBtn && !generating) {
        textarea.value = '';
        replies.push(makeEl({ cls: 'ds-markdown', text: '答案：C' }));
      }
      return true;
    };

    win.document.querySelectorAll = (sel) => {
      if (/textarea|contenteditable/i.test(sel)) return [textarea];
      if (/aria-label\*="停止"|aria-label\*="stop"/i.test(sel)) return generating ? [stopBtn] : [];
      if (/stop/i.test(sel)) return generating ? [stopBtn] : [];
      if (/send|submit|发送/i.test(sel)) return [sendBtn];
      if (/markdown|message|answer|receive/i.test(sel)) return replies;
      return [];
    };

    const res = await NS.webAIDriver.handleAsk({
      type: 'ZHS_AI_ASK',
      timeoutMs: 12000,
      question: { stem: '第二道题？', options: ['甲', '乙', '丙'], multi: false },
    });

    check('先等它自然答完 —— **不许掐断上一题的回答**', () => {
      eq(stopClicks, 0, '掐断了上一轮：那一道题的答案就丢了（用户报的"3/6 没填上"）');
    });

    check('停掉之后第二问正常发出并读到答案', () => {
      ok(!/is not defined|上出错/.test(res.msg || ''), '抛错了：' + res.msg);
      eq(res.ok, true, JSON.stringify(res));
      eq(res.answer, [2], '答案不对：' + JSON.stringify(res.answer));
    });

    check('轨迹里留下了"先等它答完"的记录', () => {
      const t = (res.trail || []).join(' | ');
      ok(/先等它答完|已自然答完/.test(t),
        '轨迹里没有这件事的记录：' + t.slice(0, 200));
    });
    win.__onClick = null;
  }

  // ── [16] 上一问的文字残留在输入框里：下一问必须从干净状态开始 ──
  //
  // 用户报的「二次提问依旧没发出去」，截图里的现场就是：composer 还带着
  // 「取消 / 发送」两个按钮（说明里面还有字），而下一问又往里塞新的 ——
  // 两段题目连在一起，点发送发出去的是一团垃圾，或者站点干脆不接受。
  // 用户给的修法很直接：**让每一次提问都从干净的输入框开始，和第一次一模一样**。
  console.log('\n\x1b[1m[16] 输入框里的残留要先清掉，再问下一题\x1b[0m');

  {
    resetCalls();
    const { textarea, sendBtn, NS } = makeEnv({});
    const p = NS.webAI.PROVIDERS[0];

    // 上一问没发出去，留下的残渣
    textarea.value = '直接说出答案，不用解析。\n题目：上一道题？\nA. 甲\nB. 乙\n答案：B';

    // ── 把 mock 做得更真一点 ──
    //
    // 真实的 composer 是受控组件：**直接写 value 是不生效的**，
    // 我们的字只能靠"真键盘"（CDP insertText）进去，而 insertText 是
    // 在光标处**插入**，不是替换。所以"没清空就开始打字"必然拼起来。
    // （第一版 mock 直接赋值，等于替我们把输入框重写了 —— 那样测不出任何东西，
    //   这条测试当时是假通过的。）
    let locked = false;          // 受控组件：非空写入一律被拒
    let value = textarea.value;
    Object.defineProperty(textarea, 'value', {
      configurable: true,
      get: () => value,
      set: (v) => {
        // 清空是允许的（站点自己也会清）；塞内容只能走"真键盘"
        if (v === '' || !locked) value = v;
      },
    });
    locked = true;
    textarea.dispatchEvent = () => true;

    const realSendMessage = win.chrome.runtime.sendMessage;
    win.chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.type === 'ZHS_CDP_TEXT') {
        value += msg.text;                       // 光标处插入
        if (typeof cb === 'function') cb({ ok: true });
        return Promise.resolve({ ok: true });
      }
      return realSendMessage.call(win.chrome.runtime, msg, cb);
    };

    let sentText = null;
    const replies = [];
    win.__onClick = (el) => {
      if (el === sendBtn) {
        sentText = value;                        // 记下"真的发出去的是什么"
        value = '';
        replies.push(makeEl({ cls: 'ds-markdown', text: '答案：C' }));
      }
      return true;
    };
    win.document.querySelectorAll = (sel) => {
      if (/textarea|contenteditable/i.test(sel)) return [textarea];
      if (/send|submit|发送/i.test(sel)) return [sendBtn];
      if (/markdown|message|answer|receive/i.test(sel)) return replies;
      return [];
    };

    const res = await NS.webAIDriver.handleAsk({
      type: 'ZHS_AI_ASK',
      timeoutMs: 12000,
      question: { stem: '这一道新题？', options: ['甲', '乙', '丙'], multi: false },
    });

    check('发出去的是新题，不是"旧题 + 新题"拼起来的垃圾', () => {
      ok(sentText != null, '压根没发出去');
      ok(!/上一道题/.test(sentText), '残留的旧题还在里面：' + JSON.stringify(sentText));
      ok(/这一道新题/.test(sentText), '新题不在里面：' + JSON.stringify(sentText));
    });

    check('清干净之后这一问正常拿到答案', () => {
      eq(res.ok, true, JSON.stringify(res));
      eq(res.answer, [2], '答案不对：' + JSON.stringify(res.answer));
    });
    win.__onClick = null;
  }

  // ── [17] 会话页的发送箭头：任何选择器都不命中时按位置找 ──
  //
  // 用户报的「第二次提问发不出去」最可能的答案：落地页的 composer 和
  // 会话页的 composer 往往是**两套标记**。会话页那个箭头经常是
  // `div[role="button"]`，但**没有 aria-disabled、没有 aria-label、
  // class 里也没有 send** —— 站点表里那六条选择器一条都不命中，
  // 候选列表是空的，"点发送"这一步压根没发生。
  // 现在按位置兜底：composer 里、输入框右半边、文档顺序最后一个可点元素。
  console.log('\n\x1b[1m[17] 发送键认不出来时，按位置找（会话页那套标记）\x1b[0m');

  {
    resetCalls();
    const { textarea, sendBtn, NS } = makeEnv({});
    const p = NS.webAI.PROVIDERS[0];

    // 造一个"会话页 composer"：输入框 + 左边两个模式开关 + 右边一个匿名箭头
    const composer = makeEl({ cls: 'chat-input-wrap' });
    composer.getBoundingClientRect = () => ({
      width: 800, height: 120, left: 200, top: 600, right: 1000, bottom: 720, x: 200, y: 600,
    });
    const pill1 = makeEl({ tag: 'DIV', cls: 'mode-pill', text: '深度思考' });
    const pill2 = makeEl({ tag: 'DIV', cls: 'mode-pill', text: '智能搜索' });
    // 匿名箭头：没有 aria-disabled、没有 aria-label、class 里也没有 send
    const arrow = makeEl({ tag: 'DIV', cls: 'f3a91c', text: '' });
    [pill1, pill2, arrow].forEach((el) => {
      el.attrs = { role: 'button' };
      el.children = []; el.childNodes = [];
    });
    // 位置：开关在左，箭头在右
    pill1.getBoundingClientRect = () => ({ width: 70, height: 28, left: 220, top: 660, right: 290, bottom: 688, x: 220, y: 660 });
    pill2.getBoundingClientRect = () => ({ width: 70, height: 28, left: 300, top: 660, right: 370, bottom: 688, x: 300, y: 660 });
    arrow.getBoundingClientRect = () => ({ width: 36, height: 36, left: 940, top: 655, right: 976, bottom: 691, x: 940, y: 655 });
    textarea.getBoundingClientRect = () => ({ width: 700, height: 50, left: 220, top: 600, right: 920, bottom: 650, x: 220, y: 600 });
    textarea.parentElement = composer;
    // ⚠ 这里要**忠实**：站点表里那六条选择器在会话页这套标记上一条都不命中，
    // 只有"按位置找"那条兜底路径才看得见那个箭头。
    // （第一版让 composer.querySelectorAll 泛匹配，等于替兜底路径把活干了 ——
    //   把兜底关掉测试照样绿，是假通过。）
    composer.querySelectorAll = (sel) => {
      // composerBoxOf 用它认"这就是 composer 那个盒子"
      if (sel === 'button,[role="button"],a') return [pill1, pill2, arrow];
      // 位置兜底用的那条查询
      if (sel === 'button,[role="button"],a,[class*="icon"],svg,i') return [pill1, pill2, arrow];
      return [];
    };

    // 站点表里的六条选择器一条都不命中
    win.document.querySelectorAll = (sel) => {
      if (/textarea|contenteditable/i.test(sel)) return [textarea];
      if (/send|submit|发送/i.test(sel)) return [];
      if (/markdown|message|answer|receive/i.test(sel)) return [];
      return [];
    };

    const cands = NS.webAIDriver._test.findSendCandidates(p, textarea);
    check('候选里必须有那个匿名箭头（靠位置找出来的）', () => {
      ok(cands.indexOf(arrow) !== -1,
        '匿名箭头没进候选 —— 这就是"第二次发不出去"的根源');
    });

    check('左边的模式开关不许排在箭头前面', () => {
      const ia = cands.indexOf(arrow);
      ok(ia === 0, '箭头没排第一：' + JSON.stringify(cands.map((e) => e.className)));
      ok(cands.indexOf(pill1) > ia || cands.indexOf(pill1) === -1,
        '「深度思考」排到箭头前面了');
      ok(cands.indexOf(pill2) > ia || cands.indexOf(pill2) === -1,
        '「智能搜索」排到箭头前面了');
    });

    check('点它能把消息发出去', async () => {
      resetCalls();
      textarea.value = '直接说出答案，不用解析。\n题目：测试\nA. 甲\nB. 乙\n答案：B';
      const replies = [];
      win.__onClick = (el) => {
        if (el === arrow) { textarea.value = ''; replies.push(makeEl({ cls: 'x', text: '答案：B' })); }
        return true;
      };
      win.document.querySelectorAll = (sel) => {
        if (/textarea|contenteditable/i.test(sel)) return [textarea];
        if (/markdown|message|answer|receive/i.test(sel)) return replies;
        return [];
      };
      const res = await NS.webAIDriver._test.submit(
        p, textarea, Date.now() + 30000, textarea.value
      );
      win.__onClick = null;
      eq(res.ok, true, JSON.stringify(res));
    });
    void sendBtn;
  }

  // ── [18] 页面上有两个 composer：必须选中底下那个活的 ────
  //
  // 用户给的规律很硬：「只要对话里存在上一条问题，下一条就发不出去」——
  // 空对话（落地页）能发、有一轮对话之后（会话页）永远发不出去。
  // 最符合这条规律的机制：落地页那个 composer 已经不用了，但仍在 DOM 里、
  // 尺寸也不为零；会话页那个在下面。我们按文档顺序取第一个，
  // 于是一直在操作那个"死掉的"输入框 —— 字塞得进去，按钮和回车都不连着东西。
  console.log('\n\x1b[1m[18] 两个 composer 时，要选底下那个活的\x1b[0m');

  {
    resetCalls();
    const { NS } = makeEnv({});
    const p = NS.webAI.PROVIDERS[0];

    // 上面那个：落地页遗留（可见但已经不在用）
    const dead = makeEl({ tag: 'TEXTAREA', cls: 'chat-input' });
    dead.getBoundingClientRect = () => ({ width: 700, height: 50, left: 200, top: 120, right: 900, bottom: 170, x: 200, y: 120 });
    // 下面那个：会话页真正在用的
    const live = makeEl({ tag: 'TEXTAREA', cls: 'chat-input' });
    live.getBoundingClientRect = () => ({ width: 700, height: 50, left: 200, top: 860, right: 900, bottom: 910, x: 200, y: 860 });

    win.document.querySelectorAll = (sel) => {
      if (/textarea|contenteditable/i.test(sel)) return [dead, live];   // 文档顺序：死的在前
      return [];
    };

    const picked = NS.webAIDriver._test.findInput(p);
    check('选中底下那个（会话页在用的），不是上面那个遗留的', () => {
      eq(picked, live, '选错了 composer —— 字塞得进去，但发不出去');
      ok(picked !== dead, '选中了落地页遗留的那个');
    });
  }

  // ── [19] 图像方案：把截图塞进 AI 站点的上传入口 ──────────
  //
  // DOM 读题干这条路在真实页面上磨了十几轮都没稳（多题共存、toast 覆盖、
  // 隐藏模板、标签枚举……），改成**截图给 AI 看**。这是那条路最关键的一步：
  // 能不能把一张图程序化地塞进站点。
  //
  // 不落盘、不走 CDP —— base64 → Blob → File → DataTransfer → input.files。
  console.log('\n\x1b[1m[19] 图片上传入口（图像方案的关键一步）\x1b[0m');

  {
    resetCalls();
    const { NS } = makeEnv({});
    const p = NS.webAI.PROVIDERS[0];
    const doc = win.document;

    check('页面上没有 input[type=file] 时，老实报错而不是崩掉', async () => {
      const saved = doc.querySelectorAll;
      doc.querySelectorAll = () => [];
      let r;
      try {
        r = await NS.webAIDriver._test.attachImage(p, 'data:image/png;base64,AAAA');
      } finally { doc.querySelectorAll = saved; }
      eq(r.ok, false, '没有上传入口却报成功了');
      ok(/没找到上传入口/.test(r.msg), '错误信息没说清：' + r.msg);
    });

    check('有隐藏的 input 时，能把图塞进去并触发 change', async () => {
      // 造一个隐藏的 file input（真站点上它就是隐藏的）
      const input = makeEl({ tag: 'INPUT', cls: '' });
      input.type = 'file';
      if (input.style) input.style.display = 'none';
      // mock 的元素没有真正的 addEventListener，用"派发计数"代替
      let changed = 0;
      input.dispatchEvent = (ev) => { if (ev && ev.type === 'change') changed++; return true; };
      // jsdom 没有 DataTransfer / File 的部分实现，按需补上
      if (typeof win.DataTransfer !== 'function') {
        win.DataTransfer = function () {
          const items = [];
          this.items = { add: (f) => items.push(f) };
          Object.defineProperty(this, 'files', { get: () => items });
        };
      }
      if (typeof win.File !== 'function') {
        win.File = function (parts, name, opts) {
          this.name = name; this.type = (opts && opts.type) || ''; this.size = 1;
        };
      }
      // fetch(dataURL) 在 jsdom 里没有 → 直接给个 blob 实现
      const savedFetch = win.fetch;
      win.fetch = async () => ({ blob: async () => ({ type: 'image/png', size: 2048 }) });

      const saved = doc.querySelectorAll;
      doc.querySelectorAll = (sel) => (/input\[type="?file"?\]/.test(sel) ? [input] : []);
      // input.files 在 jsdom 里是只读的，这里放开
      Object.defineProperty(input, 'files', { value: null, writable: true, configurable: true });

      let r;
      try {
        r = await NS.webAIDriver._test.attachImage(p, 'data:image/png;base64,AAAA');
      } finally {
        doc.querySelectorAll = saved;
        win.fetch = savedFetch;
      }
      eq(r.ok, true, '上传没成功：' + (r && r.msg));
      ok(changed >= 1, '没有派发 change 事件 —— 框架不会知道有图进来了');
    });
  }

  // ── [20] 「还在忙」的状态文字不能当回答 ────────────────
  //
  // 实测（图像方案上线后）：reply 区域里最先冒出来的是「正在分析图片」，
  // 我们的读回包立刻把它当成回复 ⇒ 解析不出答案 ⇒ 3 秒放弃 ⇒ 整卷漏答。
  // 日志原话：「AI 原话：正在分析图片 正在分析图片」。
  console.log('\n\x1b[1m[20] 「正在分析图片」这类状态文字必须被认出来（不能当回答）\x1b[0m');

  {
    const src = require('fs').readFileSync('src/ai/web-ai.js', 'utf8');
    const m = src.match(/const PLACEHOLDER_REPLY_RE = (\/.*\/i);/);
    ok(m, '源码里找不到 PLACEHOLDER_REPLY_RE');
    const RE = eval(m[1]);   // eslint-disable-line no-eval

    const yes = ['正在分析图片', '正在分析图片 正在分析图片', '· 正在思考', 'Thinking', ' 正在生成… '];
    const no = ['答案：A', '答案：B · 我选 B', 'A', ''];
    let bad = 0;
    yes.forEach((t) => { if (!RE.test(t)) { bad++; console.log('    漏认：' + JSON.stringify(t)); } });
    no.forEach((t) => { if (RE.test(t)) { bad++; console.log('    误认：' + JSON.stringify(t)); } });
    eq(bad, 0, '状态文字正则有问题（上面列了具体哪条）');

    ok(/继续等/.test(src), '读到状态文字之后没有"继续等"的处理');
  }

  // ── [8] 结构护栏 ───────────────────────────────────────
  console.log('\n\x1b[1m[8] 结构护栏\x1b[0m');

  {
    const { NS } = makeEnv({});
    check('驱动把 submit 暴露成 _test.submit（只在测试里用）', () => {
      ok(NS.webAIDriver && NS.webAIDriver._test, '没有 _test');
      ok(typeof NS.webAIDriver._test.submit === 'function', '没有 _test.submit');
    });
    check('这个后门只挂在 webAIDriver 上，不进 webAI 公共面', () => {
      eq(typeof NS.webAI.submit, 'undefined', '别把内部函数塞进共享模块的导出');
    });
    check('提交阶段有独立时限（不会把整个等待预算都花在"发"上）', () => {
      const src = fs.readFileSync(path.join(ROOT, 'src/ai/web-ai.js'), 'utf8');
      ok(/sendDeadline/.test(src), '缺少独立的 sendDeadline');
      ok(/sendWindow/.test(src), '缺少 sendWindow');
      // 发送段是**按比例**切的，不是写死一个常数：
      // 以前写死 `Math.min(15000, ...)`，用户把等待调到 180s 也照样 15 秒放弃。
      ok(/Math\.floor\(budget \/ 2\)/.test(src), '发送段应当跟着总预算按比例走');
      ok(/reserveForRead/.test(src), '必须给"读"留出下限');
      ok(/while \(!spent\(\)\)/.test(src), '提交应当是"循环重试"而不是"试一遍就退"');
    });

    check('发送段的窗口随预算变长（不是写死 15 秒）', async () => {
      // 直接量：同一道题，预算 20s 和 120s，发送段的窗口必须不一样
      const { textarea, NS } = makeEnv({});
      const p = NS.webAI.PROVIDERS[0];
      const run = async (budgetMs) => {
        textarea.value = '直接说出答案，不用解析。\n题目：测试\nA. 甲\nB. 乙\n答案：B';
        const r = await NS.webAIDriver._test.submit(
          p, textarea, Date.now() + budgetMs, textarea.value
        );
        return r.sendWindow;
      };
      const short = await run(20000);
      const long = await run(120000);
      ok(short >= 10000, '20s 预算下发送段太短：' + short);
      ok(long > short, '预算从 20s 涨到 120s，发送段却没变长（' + short + ' → ' + long + '）');
      ok(long >= 50000, '120s 预算下发送段还是被掐得太短：' + long);
      ok(long <= 60000, '发送段无上限也不好：' + long);
    });
    check('解题器的卡死自愈开关在 quiz.js 里', () => {
      const src = fs.readFileSync(path.join(ROOT, 'src/content/quiz.js'), 'utf8');
      ok(/SOLVE_STUCK_MS/.test(src), '缺少 solve 的卡死上限');
      ok(/_solvingSince/.test(src), '没有记录本轮开始时间');
    });
    check('后台的 busy 标志会自己过期（service worker 被回收时会卡住）', () => {
      const src = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
      ok(/AI_BUSY_MS/.test(src), '缺少 busy 上限');
      ok(/busySince/.test(src), '没有记录 busy 开始时间');
    });
  }

  await sleep(10);

  console.log('\n' + '─'.repeat(48));
  console.log('  \x1b[32m通过 ' + pass + '\x1b[0m    \x1b[31m失败 ' + fail + '\x1b[0m');
  console.log('─'.repeat(48) + '\n');

  if (fail) {
    failures.forEach((f) => console.log('  ✗ ' + f.name + '\n    ' + (f.err.stack || f.err)));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('\n\x1b[31m测试崩溃：\x1b[0m\n' + ((e && e.stack) || e));
  process.exit(1);
});
