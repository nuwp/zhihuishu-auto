/**
 * service-worker.js — MV3 后台
 *
 * content script 做不了、必须由后台代劳的五件事：
 *   1. 高保真点击 / 高保真文本输入（chrome.debugger → CDP Input.*，isTrusted = true）
 *   2. 关闭标签页自动丢弃（防止后台被内存回收）
 *   3. 徽章状态 + 日志滚动缓存
 *   4. 网页版 AI 抢答的标签页管理：知到页自己开不了别的标签页、
 *      也读不到别的标签页的 DOM —— 只能由后台找/开一个 AI 页并转发问题
 *   5. AI 应答缓存（内存 + chrome.storage.local）：同一道题第二次弹出来
 *      不必再去骚扰 AI 站点
 *
 * 状态查询走 popup ←→ content script 直连，后台不参与，
 * 这样 MV3 service worker 被回收也不会影响主流程。
 */
'use strict';

/**
 * 站点表与解析逻辑跟 content 侧共用同一份实现（src/shared/web-ai.js）。
 *
 * importScripts 是同步的，MV3 的 service worker 本来支持；但后台**不能**因为
 * 加载不到这份文件就整体炸掉 —— 顶层抛异常会让整个 SW 注册失败
 * （Chrome 报 Status code: 15），那是踩过的坑。
 *
 * 两处细节：
 *   - 相对路径 '../shared/web-ai.js' 以扩展根目录为基准解析
 *     （service_worker 入口在 src/background/，所以回退一级再进 shared）。
 *   - 那个文件是 IIFE，会往 window / self 上挂 ZHS_webAI；SW 全局就是 self，
 *     所以挂载点是 self.ZHS_webAI。
 */
const WEB_AI = (() => {
  try {
    if (typeof importScripts === 'function') {
      importScripts('../shared/web-ai.js');
      if (self.ZHS_webAI) return self.ZHS_webAI;
    }
  } catch (e) { /* 加载失败 → 返回 null，下游走兜底站点表 */ }
  return null;
})();

/**
 * chrome.debugger 只在 manifest 的 permissions 里声明了 "debugger" 时才存在。
 * 默认安装刻意不带这个权限 —— 它会触发 Chrome 的「正在调试此浏览器」高危警告，
 * 对只想挂网课的人来说完全没必要。
 *
 * 但正因如此，这里**必须**做存在性判断：
 * 早先直接在顶层写 chrome.debugger.onDetach.addListener(...) ，
 * 在没有该权限时 chrome.debugger 是 undefined，会抛 TypeError，
 * 导致整个 service worker 注册失败（Chrome 报 "Status code: 15"），
 * 后台彻底罢工。现在没有这个权限就整体降级，只失去高保真点击。
 */
const dbg = (() => {
  try {
    if (typeof chrome !== 'undefined' && chrome.debugger && chrome.debugger.onDetach) {
      return chrome.debugger;
    }
  } catch (e) { /* noop */ }
  return null;
})();

const DEBUGGER_ENABLED = !!dbg;

const attached = new Set();
const logRing = [];          // 全局滚动日志（跨标签页）
const MAX_RING = 500;

// ── 消息路由 ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  switch (msg.type) {
    case 'ZHS_HELLO': {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) {
        chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
      }
      reply({ ok: true });
      return true;
    }

    case 'ZHS_LOG': {
      const e = msg.entry || {};
      logRing.push(Object.assign({}, e, {
        tabId: sender.tab && sender.tab.id,
        url: sender.tab && sender.tab.url,
      }));
      if (logRing.length > MAX_RING) logRing.splice(0, logRing.length - MAX_RING);
      reply({ ok: true });
      return true;
    }

    case 'ZHS_STATUS': {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) updateBadge(tabId, msg.payload);
      reply({ ok: true });
      return true;
    }

    case 'ZHS_CDP_CLICK': {
      handleCdpClick(msg, sender)
        .then((r) => reply(r))
        .catch((e) => reply({ ok: false, msg: String(e && e.message || e) }));
      return true;
    }

    case 'ZHS_CDP_PROBE': {
      probeDebuggerPermission()
        .then((r) => reply(r))
        .catch((e) => reply({ ok: false, msg: String(e && e.message || e) }));
      return true;
    }

    case 'ZHS_CDP_DETACH': {
      detachAll()
        .then(() => reply({ ok: true }))
        .catch((e) => reply({ ok: false, msg: String(e && e.message || e) }));
      return true;
    }

    // 高保真文本输入：往当前焦点里塞字。豆包 / DeepSeek 都是 React，
    // 合成 input 事件要撞它们的受控组件状态机，而 CDP 的 insertText
    // 是浏览器层面真正敲进去的，组件状态天然跟得上。
    case 'ZHS_CDP_TEXT': {
      handleCdpText(msg, sender)
        .then((r) => reply(r))
        .catch((e) => reply({ ok: false, msg: String(e && e.message || e) }));
      return true;
    }

    case 'ZHS_CDP_KEY': {
      handleCdpKey(msg, sender)
        .then((r) => reply(r))
        .catch((e) => reply({ ok: false, msg: String(e && e.message || e) }));
      return true;
    }

    // ── 网页版 AI 抢答 ──────────────────────────────────────
    case 'ZHS_AI_ASK': {
      handleAiAsk(msg, sender)
        .then((r) => reply(r))
        .catch((e) => reply({ ok: false, msg: String(e && e.message || e) }));
      return true;   // 异步回复：必须同步返回 true，否则消息通道会被关掉
    }

    case 'ZHS_CAPTURE_REGION': {
      // 图像方案的取景口：知到页报一个矩形（CSS 像素），这里裁一块回去。
      captureRegion(sender && sender.tab && sender.tab.id, msg.rect, msg.dpr)
        .then((r) => reply(r))
        .catch((e) => reply({ ok: false, msg: String((e && e.message) || e) }));
      return true;
    }

    case 'ZHS_AI_PROBE': {
      probeAiTabs()
        .then((r) => reply(r))
        .catch((e) => reply({ ok: false, msg: String(e && e.message || e) }));
      return true;
    }

    case 'ZHS_AI_CANCEL': {
      aiState.cancelledAt = Date.now();
      reply({ ok: true });
      return true;
    }

    case 'ZHS_AI_CACHE_CLEAR': {
      clearAiCache()
        .then((n) => reply({ ok: true, cleared: n }))
        .catch((e) => reply({ ok: false, msg: String(e && e.message || e) }));
      return true;
    }

    case 'ZHS_LOG_DUMP': {
      reply({ ok: true, logs: logRing.slice(-300) });
      return true;
    }

    case 'ZHS_LOG_CLEAR': {
      logRing.length = 0;
      reply({ ok: true });
      return true;
    }

    default:
      return undefined;
  }
});

if (dbg) {
  dbg.onDetach.addListener((source) => {
    if (source && source.tabId != null) attached.delete(source.tabId);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

// ── 徽章 ─────────────────────────────────────────────────

function updateBadge(tabId, p) {
  if (!p) return;
  let text = '';
  let color = '#2b6cb0';
  switch (p.state) {
    case 'playing':
      text = Math.round((p.ratio || 0) * 100) + '%';
      color = '#2f855a';
      break;
    case 'quizzing':
      text = '答';
      color = '#b7791f';
      break;
    case 'switching':
      text = '→';
      color = '#2b6cb0';
      break;
    case 'done':
      text = '✓';
      color = '#4a5568';
      break;
    default:
      text = '';
  }
  try {
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  } catch (e) { /* noop */ }
}

// ── CDP 高保真点击 ───────────────────────────────────────

async function hasDebuggerPermission() {
  if (!DEBUGGER_ENABLED) return false;
  try {
    return !!(await chrome.permissions.contains({ permissions: ['debugger'] }));
  } catch (e) {
    return false;
  }
}

async function probeDebuggerPermission() {
  const has = await hasDebuggerPermission();
  let targets = [];
  if (has) {
    try {
      targets = await dbg.getTargets();
    } catch (e) { targets = []; }
  }
  return {
    ok: true,
    granted: has,
    available: DEBUGGER_ENABLED,
    attachedTabs: targets.filter((t) => t.attached).map((t) => t.tabId),
  };
}

async function ensureAttach(tabId) {
  if (!DEBUGGER_ENABLED) {
    throw new Error('"debugger" 未在 manifest 的 permissions 中声明，高保真点击不可用');
  }
  if (!(await hasDebuggerPermission())) {
    throw new Error('debugger 权限未授予');
  }
  if (attached.has(tabId)) {
    try {
      const targets = await dbg.getTargets();
      if (targets.some((t) => t.tabId === tabId && t.attached)) return;
    } catch (e) { /* 检查失败就重新 attach */ }
    attached.delete(tabId);
  }
  await dbg.attach({ tabId }, '1.3');
  attached.add(tabId);
}

async function handleCdpClick(msg, sender) {
  const tabId = (sender.tab && sender.tab.id) != null ? sender.tab.id : msg.tabId;
  if (tabId == null) throw new Error('缺少 tabId');

  const x = Math.max(0, Math.round(msg.x));
  const y = Math.max(0, Math.round(msg.y));
  const button = msg.button || 'left';
  const clickCount = msg.clickCount || 1;

  await ensureAttach(tabId);

  const cmd = (method, params) => dbg.sendCommand({ tabId }, method, params);

  await cmd('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0, modifiers: 0,
  });
  await sleep(20);

  // 关键：mousePressed 必须带 buttons:1、mouseReleased 带 buttons:0。
  // 这个位掩码表示「此刻哪些键按着」—— 漏掉的话浏览器收到的是一条
  // 「按下但没有任何键处于按下状态」的矛盾报文，整条 press/release 会被丢弃：
  // 页面上能数到 click 计数在涨，但元素的 click 处理器根本不会触发。
  await cmd('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, buttons: 1, clickCount, modifiers: 0,
  });
  await sleep(40);
  await cmd('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, buttons: 0, clickCount, modifiers: 0,
  });

  if (clickCount === 2) {
    await sleep(40);
    await cmd('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, buttons: 1, clickCount: 2, modifiers: 0,
    });
    await cmd('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 2, modifiers: 0,
    });
  }

  return { ok: true, msg: 'CDP 点击 ' + x + ',' + y, isTrusted: true };
}

async function detachAll() {
  if (!DEBUGGER_ENABLED) return;
  for (const tabId of Array.from(attached)) {
    try {
      await dbg.detach({ tabId });
    } catch (e) { /* noop */ }
    attached.delete(tabId);
  }
}

/** 把文本塞进目标标签页里当前的焦点元素 */
async function handleCdpText(msg, sender) {
  const tabId = resolveTabId(msg, sender);
  // trim 掉首尾空白：有些站点把「内容以空白结尾」当成"还没输入完"，
  // 发送按钮会一直不点亮。塞字这一层顺手收干净，比在调用侧到处 trim 靠谱。
  const text = String(msg.text || '').trim();
  await ensureAttach(tabId);
  await dbg.sendCommand({ tabId }, 'Input.insertText', { text });
  return { ok: true, len: text.length, tabId };
}

/**
 * 抓一张 AI 标签页的截图，返回 data URL。
 *
 * 只在排障路径上用：提交失败时拍一张，直接摆在控制台里。
 * 「字打进去了但发不出去」这种问题，看一眼页面比读十条日志都快 ——
 * 能立刻分辨出是按钮没点亮、输入框其实空着、还是被别的弹层挡住了。
 * 拿不到（没有 debugger 权限 / DevTools 占着会话）就安静返回 null，
 * 不影响主流程。
 */
/**
 * 抓一屏，**按给定的矩形裁一块**，返回 dataURL。
 *
 * 这是「图像方案」的取景口：DOM 读题干那条路在真实作业页上磨了十几轮都没稳，
 * 改成截图让 AI 自己看。这里只负责"取景 + 裁剪"，不碰业务。
 *
 * `rect` 用 CSS 像素（和 getBoundingClientRect 同一套坐标）；截图是设备像素，
 * 所以要乘 devicePixelRatio。裁完再缩到宽 900 —— 一屏 PNG 的 base64 能到几兆，
 * 而它要穿过 标签页 → background → AI 页 两次消息传递，太大容易被截断或拖慢。
 */
async function captureRegion(tabId, rect, dpr) {
  if (!DEBUGGER_ENABLED) return { ok: false, msg: '调试通道没开' };
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
    return { ok: false, msg: '裁剪区域无效：' + JSON.stringify(rect) };
  }
  try {
    if (!(await hasDebuggerPermission())) return { ok: false, msg: '没有 debugger 权限' };
    await ensureAttach(tabId);
    const shot = await dbg.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    if (!shot || !shot.data) return { ok: false, msg: '截图失败' };

    // ⚠ 缩放系数**按实测算**，不用 devicePixelRatio 猜。
    //
    // 实测踩到：截图左边被切掉（题干成了「anism emphasizes the importance of?」）——
    // 因为 Page.captureScreenshot 返回的位图尺寸和 CSS 像素之间那个系数，
    // 并不总等于 window.devicePixelRatio（Windows 125% / 150% 缩放下经常对不上）。
    // 乘大了就整体往右裁。现在用「位图宽 ÷ 视口宽（CSS 像素）」直接量出来，
    // 传进来的 devicePixelRatio 只当兜底。
    const bin = atob(shot.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));

    const vw = Number(rect.viewportW) || 0;
    const vh = Number(rect.viewportH) || 0;
    let scale = 1;
    if (vw > 0 && bmp.width > 0) scale = bmp.width / vw;
    else if (vh > 0 && bmp.height > 0) scale = bmp.height / vh;
    else scale = Math.max(1, Math.min(4, Number(dpr) || 1));

    const sx = Math.max(0, Math.round(rect.left * scale));
    const sy = Math.max(0, Math.round(rect.top * scale));
    const sw = Math.max(1, Math.round(rect.width * scale));
    const sh = Math.max(1, Math.round(rect.height * scale));

    // 图比请求的区域小，说明坐标超界了 —— 夹回图内，别裁出空图
    const cx = Math.min(sx, Math.max(0, bmp.width - 1));
    const cy = Math.min(sy, Math.max(0, bmp.height - 1));
    const cw = Math.max(1, Math.min(sw, bmp.width - cx));
    const ch = Math.max(1, Math.min(sh, bmp.height - cy));

    const outW = Math.min(900, cw);
    const k = outW / cw;
    const outH = Math.max(1, Math.round(ch * k));

    const cv = new OffscreenCanvas(outW, outH);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, cx, cy, cw, ch, 0, 0, outW, outH);
    bmp.close();

    const blob = await cv.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    const dataUrl = 'data:image/png;base64,' + btoa(s);

    return {
      ok: true,
      dataUrl,
      msg: '裁出 ' + outW + '×' + outH + '（' + Math.round(blob.size / 1024) + 'KB）',
    };
  } catch (e) {
    return { ok: false, msg: '裁剪失败：' + (e && e.message) };
  }
}

async function captureTab(tabId) {
  if (!DEBUGGER_ENABLED) return null;
  try {
    if (!(await hasDebuggerPermission())) return null;
    await ensureAttach(tabId);
    // 缩到一半再抓：一屏 PNG 的 base64 能到几兆，而它要穿过
    // 标签页 → background → 知到页 两次消息传递，太大容易被截断或拖慢。
    // 这一张只是给人瞄一眼用的，半尺寸绰绰有余。
    const shot = await dbg.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    if (shot && shot.data && shot.data.length < 3 * 1024 * 1024) {
      return 'data:image/png;base64,' + shot.data;
    }
  } catch (e) { /* 拍不到就算了 */ }
  return null;
}

/**
 * 在页面里跑一段代码并取回值。
 *
 * 探针这个能力值得单独写出来：定位站点问题最有效的手段就是**让页面自己说话**，
 * 而不是靠日志里猜。以前每加一个探针都要复制一遍 attach + Runtime.evaluate，
 * 现在统一走这里，失败就安静返回 null（探针永远不该影响主流程）。
 */
async function evaluateInTab(tabId, expression) {
  if (!DEBUGGER_ENABLED) return null;
  try {
    if (!(await hasDebuggerPermission())) return null;
    await ensureAttach(tabId);
    const res = await dbg.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (res && res.exceptionDetails) return null;
    return (res && res.result) ? res.result.value : null;
  } catch (e) {
    return null;
  }
}

/**
 * 内置的候选选择器表 —— 只有在 service worker 里的站点表（WEB_AI）没加载上来时
 * 才会用到。**故意和 web-ai.js 里的表保持同一批关键选择器**，
 * 这样即使 importScripts 失败，"试发一条"照样能报出选择器命中数。
 */
const FALLBACK_SELECTOR_TABLE = {
  gemini: {
    host: /gemini\.google\./i,
    input: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
    send: ['button[aria-label="Send message"]', 'button.send-button', 'button[class*="send"]'],
    answer: ['model-response .response-content', 'model-response', '.response-content', 'message-content'],
    stop: ['button[aria-label*="Stop"]', 'mat-icon[fonticon="stop"]', 'button[class*="stop"]'],
  },
  deepseek: {
    host: /deepseek\.com/i,
    input: ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]', 'textarea'],
    send: ['div[role="button"][aria-disabled="false"]', 'button[aria-label="Send message"]',
      'button[class*="send"]', 'button[type="submit"]'],
    answer: ['.ds-markdown', 'div[class*="markdown"]', 'div[class*="message"]'],
    stop: ['div[role="button"][aria-label*="Stop"]', 'button[aria-label*="停止"]', 'div[class*="stop"]'],
  },
  doubao: {
    host: /doubao\.com/i,
    input: ['textarea[data-testid="chat_input_input"]', 'textarea[placeholder]', 'div[contenteditable="true"]'],
    send: ['button[data-testid="chat_input_send_button"]', 'button[aria-label*="发送"]', 'button[class*="send"]'],
    answer: ['[data-testid="receive_message"]', 'div[class*="message-content"]', 'div[class*="markdown"]'],
    stop: ['button[data-testid="chat_input_stop_button"]', 'div[class*="stop"]'],
  },
  kimi: {
    host: /kimi\./i,
    input: ['div[contenteditable="true"]', 'textarea[placeholder]', 'textarea'],
    send: ['button[class*="send"]', 'button[aria-label*="发送"]'],
    answer: ['.markdown', 'div[class*="markdown"]', 'div[class*="message"]'],
    stop: ['button[class*="stop"]'],
  },
  tongyi: {
    host: /tongyi\.|qianwen\./i,
    input: ['textarea[placeholder]', 'textarea', 'div[contenteditable="true"]'],
    send: ['div[class*="operateBtn"]', 'button[class*="send"]'],
    answer: ['div[class*="markdown-body"]', 'div[class*="markdown"]', 'div[class*="answer"]'],
    stop: ['div[class*="stopBtn"]'],
  },
  yuanbao: {
    host: /yuanbao\.tencent\.com/i,
    input: ['div[contenteditable="true"]', 'textarea[placeholder]', 'textarea'],
    send: ['a[class*="send"]', 'button[class*="send"]'],
    answer: ['div[class*="agent-chat__bubble__content"]', 'div[class*="hyc-content-md"]'],
    stop: ['a[class*="stop"]', 'div[class*="stop"]'],
  },
};

function fallbackSelectorsFor(url) {
  for (const key of Object.keys(FALLBACK_SELECTOR_TABLE)) {
    const row = FALLBACK_SELECTOR_TABLE[key];
    if (row.host.test(String(url || ''))) return row;
  }
  return null;
}

/** 从 URL 猜一个站点 id（站点表没加载时用来兜一下） */
function providerIdHintForUrl(url) {
  const row = fallbackSelectorsFor(url);
  if (!row) return null;
  for (const key of Object.keys(FALLBACK_SELECTOR_TABLE)) {
    if (FALLBACK_SELECTOR_TABLE[key] === row) return { id: key, input: row.input, send: row.send, answer: row.answer, stop: row.stop };
  }
  return null;
}

/**
 * 让 AI 页面自己在控制台里描述一下自己的输入区。
 *
 * 「发不出去」到现在还没定位到根因，靠猜选择器是低效的 —— 与其再猜一轮，
 * 不如让页面把真实结构报回来：输入框是什么标签、发送按钮长什么样、
 * 每个候选选择器各命中几个元素。这些用一段页面内代码几毫秒就能问出来。
 *
 * ⚠ 这个函数**任何一步失败都必须留下原因**。
 * 之前它在缺权限 / attach 失败时直接 `return null`，上层拿到 null 就什么都不显示 ——
 * 于是「试发一条」的报告里整段消失，而用户完全不知道为什么。
 * 现在每一步都返回 `{ error, stage }`，让人一眼看出卡在哪。
 */
async function probeDom(tabId) {
  const diag = { DEBUGGER_ENABLED, tabId };
  if (!DEBUGGER_ENABLED) {
    return { error: 'manifest 里没有 debugger 权限，高保真探测不可用', stage: '权限声明' };
  }
  let granted = false;
  try {
    granted = await hasDebuggerPermission();
  } catch (e) {
    return { error: '查权限时抛错：' + String(e && e.message || e), stage: '查权限' };
  }
  diag.permission = granted;
  if (!granted) return { error: 'debugger 权限没被授予', stage: '权限' };

  try {
    await ensureAttach(tabId);
  } catch (e) {
    return {
      error: '接不上调试会话：' + String(e && e.message || e) +
        '（DevTools 开着的时候必然失败 —— 按 F12 关掉再试）',
      stage: 'attach',
      diag,
    };
  }

  try {
    const text = await evaluateInTab(tabId, PROBE_EXPR);
    if (!text) {
      return { error: '在页面里求值没拿到结果（Runtime.evaluate 返回空）', stage: '求值', diag };
    }
    const out = JSON.parse(text);

    // ── 选择器命中统计 ──
    //
    // 这一段以前整块挂在 `if (WEB_AI)` 里，而 WEB_AI 是 service worker 里
    // importScripts 的产物 —— 它一旦没加载，这一段就**静默消失**，
    // 表现就是用户根本找不到"选择器命中数"。现在两级兜底：
    // 优先用 WEB_AI 的站点表，拿不到就用内置表；两样都没有也要说明原因。
    const provider = (WEB_AI && WEB_AI.providerForUrl(out.href)) || null;
    const table = provider || fallbackSelectorsFor(out.href);
    if (!table) {
      out.selectorError = '认不出这个页面属于哪个站点（地址：' + out.href + '）' +
        (WEB_AI ? '' : '；而且 service worker 里的站点表也没加载上来');
      out.selectorSource = '无';
      return out;
    }

    const groups = {
      input: table.input || [],
      send: table.send || [],
      answer: table.answer || [],
      stop: table.stop || [],
    };
    const selExpr = `(() => {
      const cnt = (s) => { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
      const groups = ${JSON.stringify(groups)};
      const out = {};
      for (const k of Object.keys(groups)) {
        out[k] = groups[k].map((s) => [s, cnt(s)]);
      }
      return JSON.stringify(out);
    })()`;

    const text2 = await evaluateInTab(tabId, selExpr);
    if (text2) {
      out.selectors = JSON.parse(text2);
      out.selectorSource = provider ? '站点表' : '内置兜底表';
    } else {
      out.selectorError = '选择器统计那一段没返回值（页面可能刚导航过）';
    }
    return out;
  } catch (e) {
    return { error: '探测过程抛错：' + String(e && e.message || e), stage: '执行', diag };
  }
}

/** 结构探测那一段页面内代码 */
const PROBE_EXPR = `(() => {
  const q = (s) => { try { return Array.from(document.querySelectorAll(s)); } catch (e) { return []; } };
  const desc = (el) => {
    if (!el) return null;
    const cls = typeof el.className === 'string' ? el.className.split(/\\s+/).slice(0, 3).join('.') : '';
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      cls,
      id: el.id || '',
      aria: el.getAttribute('aria-label') || '',
      role: el.getAttribute('role') || '',
      editable: el.isContentEditable === true,
      box: [Math.round(r.width), Math.round(r.height)],
      display: st.display, visibility: st.visibility, opacity: st.opacity,
      disabled: !!el.disabled,
      text: (el.value != null && el.value !== '') ? String(el.value).slice(0, 40)
        : (el.innerText || el.textContent || '').trim().slice(0, 40),
    };
  };
  const editable = q('[contenteditable="true"], textarea').filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  });
  const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const label = (el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '') +
      (typeof el.className === 'string' ? el.className : '') + (el.innerText || '');
    return /send|submit|发送|stop|停止/i.test(label);
  });
  return JSON.stringify({
    href: location.href,
    active: (document.activeElement && (document.activeElement.tagName.toLowerCase() +
      '.' + (typeof document.activeElement.className === 'string'
        ? document.activeElement.className.split(/\\s+/)[0] : ''))) || '',
    editor: editable.slice(0, 4).map(desc),
    buttons: btns.slice(0, 8).map(desc),
    stopVisible: q('[class*="stop"], [aria-label*="Stop" i], [aria-label*="停止"]').some((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1;
    }),
  });
})()`;

/** 某个标签页当前落在哪个站点上（探测时用来挑选择器表） */
async function providerForTabId(tabId) {
  if (!WEB_AI) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return WEB_AI.providerForUrl(tab && tab.url) ||
      WEB_AI.getProvider('deepseek') || null;
  } catch (e) {
    return null;
  }
}

/** 敲一次真实按键（默认回车，用来提交输入框里的内容） */
async function handleCdpKey(msg, sender) {
  const tabId = resolveTabId(msg, sender);
  const key = msg.key || 'Enter';
  const code = key === 'Enter' ? 'Enter' : key;
  const keyCode = key === 'Enter' ? 13 : 0;
  const text = key === 'Enter' ? '\r' : '';

  await ensureAttach(tabId);
  const cmd = (method, params) => dbg.sendCommand({ tabId }, method, params);

  const down = (type, withText) => cmd('Input.dispatchKeyEvent', {
    type,
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    text: withText ? text : '',
    unmodifiedText: withText ? text : '',
  });

  if (msg.raw) {
    // 纯键盘序列：只发 rawKeyDown（不带 text），中途用 insertText 补一个 \r，
    // 最后再 keyUp。有些站点把"发送"挂在 input 事件或 beforeinput 上，
    // 光派发 keyDown/keyUp 它们收不到东西 —— 这一路是给那种站点兜底的。
    await down('rawKeyDown', false);
    await sleep(30);
    if (text) await cmd('Input.insertText', { text });
    await sleep(30);
    await down('keyUp', false);
    return { ok: true, key, tabId, raw: true };
  }

  // 常规路：keyDown 带 text + keyUp 成对发。
  // text 必须带上 —— 不然浏览器只是"按下了一个键"，不会真往输入框里插东西。
  await down('keyDown', true);
  await sleep(30);
  await down('keyUp', false);
  return { ok: true, key, tabId };
}

/** 优先用消息来源标签页；AI 页发出来的消息自带 sender.tab */
function resolveTabId(msg, sender) {
  if (sender && sender.tab && sender.tab.id != null) return sender.tab.id;
  if (msg && msg.tabId != null) return msg.tabId;
  if (lastAiTabId != null) return lastAiTabId;
  throw new Error('缺少 tabId');
}

// ══════════════════════════════════════════════════════════
//  网页版 AI 抢答：标签页管理 + 应答缓存
// ══════════════════════════════════════════════════════════

const AI_CACHE_KEY = 'aiCache';
const AI_CACHE_MAX = 800;
const AI_CACHE_TTL = 30 * 24 * 3600 * 1000;   // 30 天

/**
 * `aiState.busy` 的硬上限。正常一次问询最多 askWaitMs（≤120s）+ 找标签页，
 * 超过这个数只可能是"它再也不会被复位了"—— 最常见的是 service worker
 * 在等回包的路上被 Chrome 回收，busy 留在了内存里（或者被下一次唤醒重新初始化成 false，
 * 但那要看运气）。既然要赌，就赌一个明确的数。
 */
const AI_BUSY_MS = 180000;

/** 内存缓存；AI 标签页 id 也在这里，好让 ZHS_CDP_TEXT 找到目标 */
const aiState = {
  cache: new Map(),     // questionKey -> { answer, provider, at, reason }
  loaded: false,
  busy: false,
  busySince: 0,
  cancelledAt: 0,
};

let lastAiTabId = null;

/**
 * 把站点表翻译成 chrome.tabs.query 能吃的 url 模式。
 *
 * 只用来「扫出候选标签页」，**不参与判断**：真正的归属判断交给
 * hostMatchesProvider（内部走 providerForUrl 的域名正则）。
 * 直接拿正则去拼 match pattern 试过，`(?:www\.)?` 这种分组拼出来是坏的，
 * 而坏模式会让 tabs.query 直接抛错 —— 不如让 query 拿宽模式、我们自己筛。
 */
function providerTabPatterns(providerId) {
  if (!WEB_AI) {
    return ['*://*.deepseek.com/*', '*://*.doubao.com/*'];
  }
  if (providerId && providerId !== 'auto') {
    const p = WEB_AI.getProvider(providerId);
    if (p) return [p.home + '*'];
  }
  return ['*://*/*'];
}

/** 这个 URL 是否属于目标站点（'auto' = 站点表里的任意一家） */
function hostMatchesProvider(url, providerId) {
  if (!WEB_AI) return /deepseek\.com|doubao\.com/i.test(String(url));
  const p = WEB_AI.providerForUrl(url);
  if (!p) return false;
  return !providerId || providerId === 'auto' || p.id === providerId;
}

async function loadAiCache() {
  if (aiState.loaded) return;
  aiState.loaded = true;
  try {
    const got = await chrome.storage.local.get(AI_CACHE_KEY);
    const raw = (got && got[AI_CACHE_KEY]) || {};
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      if (!v || !Array.isArray(v.answer)) continue;
      if (now - (v.at || 0) > AI_CACHE_TTL) continue;
      aiState.cache.set(k, v);
    }
  } catch (e) { /* 没有就没有 */ }
}

async function flushAiCache() {
  try {
    const obj = {};
    let n = 0;
    // 只留最近的若干条，避免无上限增长
    const entries = Array.from(aiState.cache.entries()).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    for (const [k, v] of entries) {
      if (n++ >= AI_CACHE_MAX) break;
      obj[k] = v;
    }
    aiState.cache = new Map(entries.slice(0, AI_CACHE_MAX));
    await chrome.storage.local.set({ [AI_CACHE_KEY]: obj });
  } catch (e) { /* noop */ }
}

async function clearAiCache() {
  const n = aiState.cache.size;
  aiState.cache.clear();
  try { await chrome.storage.local.set({ [AI_CACHE_KEY]: {} }); } catch (e) { /* noop */ }
  return n;
}

/** 找一个已打开的、属于目标站点的标签页 */
async function findAiTab(providerId) {
  const pats = providerTabPatterns(providerId);
  for (const pat of pats) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: pat });
    } catch (e) {
      continue;
    }
    // 归属判断交给 domain 正则，不靠 match pattern 的宽窄
    tabs = tabs.filter((t) => t && t.id != null && t.url && hostMatchesProvider(t.url, providerId));
    if (!tabs.length) continue;
    // 优先当前窗口里可见的那个：用户能看见 AI 在打字，出问题也好排查
    const active = tabs.find((t) => t.active);
    return active || tabs[0];
  }
  return null;
}

/** AI 站点那一条 content script 的文件列表（懒解析并缓存在这里） */
let aiScriptRefs = null;

/**
 * 补注入 AI 站点那一份 content script。
 *
 * 为什么需要这个：**已打开的 AI 标签页里可能根本没有我们的脚本** ——
 * 扩展装好之前就开着的、扩展重载过而页面没刷新的、标签页被 Chrome
 * 冻结后又唤醒的，都会是这样。manifest 的 content_scripts 只在页面
 * 加载时注入一次，之后不会补。
 *
 * 以前这种情况的表现就是一句很误导人的「AI 页无响应（可能没登录或被卸载）」：
 * 页面明明开着、也登录着，只是没挂监听。现在改成按需补注入，
 * 补完再 ping 一次，实在不行才报错。
 */
async function injectAiScripts(tabId) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return false;

  if (!aiScriptRefs) {
    let entry = null;
    try {
      const manifest = chrome.runtime.getManifest();
      entry = (manifest.content_scripts || []).find(
        (c) => (c.matches || []).some((m) => /doubao|deepseek|kimi|tongyi|qianwen|yuanbao/.test(m))
      );
    } catch (e) { entry = null; }
    if (!entry || !entry.js || !entry.js.length) return false;
    aiScriptRefs = entry.js.slice();
  }

  // 顺序加载：一次一个文件、串起来 await。
  // 不能合并成一次多文件注入 —— 那样顺序不保证，web-ai.js 可能先于 defaults.js 跑。
  for (const file of aiScriptRefs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    } catch (e) {
      return false;
    }
  }
  return true;
}

/** 标签页里我们的脚本是活的吗。超时压得很短：这一问只为判断"有没有人在听" */
async function pingTab(tabId, timeoutMs) {
  const res = await sendToTab(tabId, { type: 'ZHS_AI_PING' }, timeoutMs || 1200);
  return !!(res && res.ok);
}

/**
 * 拿到一个「脚本已经挂好、能收消息」的 AI 标签页。
 *
 * 两条路径：
 *   新开的标签页 —— 等注入（最多 20 秒）
 *   已存在的标签页 —— 先 ping；不应答就补注入再 ping（最多 8 秒）
 */
async function ensureAiTab(providerId) {
  await loadAiCache();

  const existing = await findAiTab(providerId);
  if (existing) {
    lastAiTabId = existing.id;

    if (await pingTab(existing.id)) return { tab: existing, created: false, injected: false };

    // 页面开着但没挂脚本 —— 补一次
    await injectAiScripts(existing.id);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      await sleep(400);
      if (await pingTab(existing.id)) {
        return { tab: existing, created: false, injected: true };
      }
    }
    throw new Error('AI 标签页（' + (existing.url || '') + '）里脚本没挂上，' +
      '补注入也没反应 —— 多半是页面停在被 Chrome 拦住的地址上，手动刷新该页试试');
  }

  const provider = WEB_AI
    ? (providerId && providerId !== 'auto' ? WEB_AI.getProvider(providerId) : WEB_AI.PROVIDERS[0])
    : null;
  const url = (provider && provider.home) || 'https://chat.deepseek.com/';

  // ⚠ 新建时必须 `active: true` —— **把它切到前台**。
  //
  // 原来这里写的是 `active: false`（"安静地开在后台"），结果是**自相矛盾**：
  //   · README 里写明「AI 页必须在前台」，因为后台标签页里消息根本发不出去；
  //   · 可我们偏偏把它建在后台 ⇒ 提问发不出去 ⇒ 读回包读到的是**上一条回答**；
  //   · 于是整张卷子被填成第一题的答案，而且全程不报错（用户报的正是这个）。
  //
  // 顺带解释「我没打开 AI 页，却显示上传成功」：页是插件开的，而且开在后台，
  // 所以人在明面上看不到它。
  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab || tab.id == null) throw new Error('无法创建 AI 标签页');
  lastAiTabId = tab.id;
  console.log('[知到助手] 自动打开了 AI 页面并切到前台：' + url + '（tab ' + tab.id + '）');

  // 新建标签页的注入是异步的，立刻 sendMessage 会吃 "Receiving end does not exist"。
  // 等一会儿 ping 不上就补一次 —— 有些站点首屏慢，脚本可能落在 document_idle 之后。
  const t0 = Date.now();
  let injected = false;
  while (Date.now() - t0 < 20000) {
    await sleep(500);
    if (await pingTab(tab.id)) return { tab, created: true, injected };
    if (!injected && Date.now() - t0 > 6000) {
      injected = await injectAiScripts(tab.id) || injected;
    }
  }
  throw new Error('AI 页面加载超时（' + url + '）');
}

function sendToTab(tabId, msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        void chrome.runtime.lastError;
        finish(res || null);
      });
    } catch (e) {
      return finish(null);
    }
    setTimeout(() => finish(null), timeoutMs || 30000);
  });
}

async function readConfig() {
  try {
    const got = await chrome.storage.local.get('config');
    return (got && got.config) || {};
  } catch (e) {
    return {};
  }
}

/**
 * 主入口：回答一个问题。
 *
 * 顺序：缓存 → 找/开标签页 → 转发 → 缓存答案。
 * 任何一步失败都返回 { ok:false, msg }，由 content 侧退化到组合枚举 ——
 * 这条链路只是「更快」，不能变成「必须成功否则答不了题」。
 */
async function handleAiAsk(msg, sender) {
  const q = (msg && msg.question) || {};
  const cfg = await readConfig();

  if (cfg.askWebAI === false) return { ok: false, msg: '网页 AI 答题已在控制台关闭' };
  if (!q.stem || !Array.isArray(q.options) || q.options.length < 2) {
    return { ok: false, msg: '题目不完整' };
  }

  await loadAiCache();

  const providerId = q.provider || cfg.webAIProvider || 'auto';
  // 缓存键里带上"第几次问"。同一道题的第二次问询会换一句开场白
  // （见 RETRY_LEADS），那在网页端看起来是另一个问题、也可能得到另一个答案，
  // 所以不该跟第一次共用一条缓存。
  const attempt = Math.max(1, Number((msg.question && msg.question.attempt) || 1) || 1);
  const baseKey = WEB_AI
    ? WEB_AI.questionKey(q.stem, q.options.length, q.multi)
    : String(q.stem).slice(0, 80);
  const key = attempt > 1 ? baseKey + '#a' + attempt : baseKey;

  const cached = aiState.cache.get(key);
  // ⚠ 带图的请求**不吃缓存、也不写缓存**。
  //
  // 缓存键是按**题干**算的，而带图这件事本身就意味着题干不可信
  //（正是因为从 DOM 读不准题干，才改成截图给 AI 看）。
  // 题干常常整卷读成同一段乱码（"总题数: 10"）⇒ 十道题共用一条缓存：
  //   第 1 题问完存进去 → 第 2~10 题**缓存命中、直接返回第 1 题的答案**，
  //   连 AI 页面都不会去碰 —— 于是"只有第一题有截图上传"。
  //（这一层原先是漏掉的：ai-bridge 那边关了缓存，后台这层没关。）
  const useCache = msg.noCache !== true && !msg.image;
  if (useCache && cached && Date.now() - (cached.at || 0) < AI_CACHE_TTL) {
    return {
      ok: true,
      answer: cached.answer.slice(),
      provider: cached.provider || providerId,
      reason: cached.reason || '',
      cached: true,
    };
  }

  // ── 独占闸门：**排队**，不是"忙了就拒绝" ──
  //
  // 「视频」和「能力提升」两套答题共用同一个网页端 AI 标签页。旧行为是
  // 一撞上就返回「AI 正在回答上一道题」—— 上层拿到这个就落到题库/枚举，
  // 从外面看完全是"随机失败"。现在后来的**等**前面的走完（有上限），
  // 让"不同时使用同一个 AI 页"靠排队实现，而不是靠调用方自觉。
  if (aiState.busy) {
    const held = Date.now() - aiState.busySince;
    if (held < AI_BUSY_MS) {
      const waitCap = Math.min(60000, Math.max(5000, Number(msg.timeoutMs) || 45000));
      console.warn('[知到助手] AI 通道被占用（已 ' + Math.round(held / 1000) +
        's），排队最多等 ' + Math.round(waitCap / 1000) + 's');
      const until = Date.now() + waitCap;
      while (aiState.busy && Date.now() < until) {
        await sleep(250);
        if (Date.now() - aiState.busySince >= AI_BUSY_MS) break;   // 它自己过期了
      }
      if (aiState.busy) {
        return {
          ok: false,
          msg: 'AI 通道被另一个答题任务占着（等了 ' + Math.round(waitCap / 1000) +
            's 还没轮到）。两个模式共用同一个 AI 页，等它跑完再试，' +
            '或者在控制台把模式切成其中一个。',
          provider: providerId,
        };
      }
    }
  }
  // 上一轮的 busy 没被清掉（service worker 中途被回收就会这样）——
  // 不放闸的话后面每一个问题都会被顶回来，等于永久卡死
  if (aiState.busy) console.warn('[知到助手] AI 忙标志卡了 ' +
    Math.round((Date.now() - aiState.busySince) / 1000) + 's，强制放闸');
  aiState.busy = true;
  aiState.busySince = Date.now();

  const started = Date.now();
  try {
    const timeoutMs = Math.max(8000, Number(msg.timeoutMs) || 45000);

    let found;
    try {
      found = await ensureAiTab(providerId);
    } catch (e) {
      return { ok: false, msg: String(e && e.message || e) };
    }

    // ⚠ AI 页不在前台时，**把它切到前台**，而不是拒绝提问。
    //
    // 这里原先写的是"不在前台就直接 return 失败"（我当时是为了防止
    // "后台标签页发不出去 ⇒ 读到旧回答 ⇒ 每题填成第一题的答案"）。
    // 但那个条件在自动跑的时候**永远不可能满足** —— 作业页和 AI 页
    // 不可能同时在前台，你在看作业页，AI 页就在后台。
    // 实测后果：每一次提问都被这道门拒绝（日志里几十行
    // 「AI 页不在前台 …… 0.0s」），于是**每一题都跳过**。
    //
    // 正确做法：**插件自己把页面切过去**。README 里那条前提
    // （"AI 页必须在前台"）本来就该由插件来满足，而不是推给人。
    if (!found.tab.active) {
      try {
        await chrome.tabs.update(found.tab.id, { active: true });
        await sleep(450);                       // 等它真正切过去
        aiState.lastFocusNote = '自动把 AI 页切到前台：' + (found.tab.title || '');
        console.log('[知到助手] ' + aiState.lastFocusNote);
      } catch (e) {
        return {
          ok: false,
          msg: 'AI 页在后台，而且切不过去：' + (e && e.message) +
            ' —— 请手动把 DeepSeek 标签页切到前面再试',
          needFocus: true,
        };
      }
    }

    const tabId = found.tab.id;
    const askMsg = {
      type: 'ZHS_AI_ASK',
      question: q,
      // 图像方案：带着题目截图一起去。AI 页面侧会先把它塞进上传入口，
      // 再发提示词（而不是靠文字题干 —— 那条路在真实作业页上没稳住）。
      image: msg.image || null,
      timeoutMs,
      // 排障路径要页面侧把诊断信息都带上
      wantShot: msg.wantShot === true,
    };
    let res = await sendToTab(tabId, askMsg, timeoutMs + 12000);

    // 没有回执 = 那一头没有人在听。最常见的原因不是"没登录"，
    // 而是那一页的 content script 压根没挂上（扩展重载过、页面没刷新）。
    // 补注入一次再问，不行才报错。
    if (!res) {
      const injected = await injectAiScripts(tabId);
      if (injected) {
        await sleep(300);
        res = await sendToTab(tabId, askMsg, timeoutMs + 12000);
      }
      if (!res) {
        return {
          ok: false,
          msg: 'AI 页没有应答：脚本没能挂到 ' + (found.tab.url || 'AI 标签页') +
            '（试着手动刷新那个页面）',
          provider: providerId,
          tabId,
        };
      }
    }
    if (!res.ok) {
      // 页面侧失败时拍一张，直接摆在控制台里 —— 「字打进去了但发不出去」
      // 这种问题，看一眼页面比读十条日志都快
      const shot = res.wantShot ? await captureTab(tabId) : null;
      // 顺便让页面自己报一下输入区的真实结构（选择器猜错时全靠它）
      const dom = res.wantShot ? await probeDom(tabId) : null;
      return {
        ok: false,
        msg: res.msg || 'AI 页返回失败',
        raw: res.raw,
        shot,
        dom,
        // 探测本身失败了也要说清楚卡在哪 —— 不然 popup 那边就是一段空白
        probeDiag: dom && dom.error
          ? { error: dom.error, stage: dom.stage || '' }
          : { error: dom ? '' : '探测函数没返回任何东西（后台版本可能还是旧的）', stage: '' },
        // 版本标记：报告里会带上它，一眼就能确认后台是不是新代码
        panelVersion: 'probe-3',
        // 排障信息一路透传到 popup：这几项决定了"发不出去"到底是哪一环断的
        detail: {
          via: res.via,
          typedChars: res.typedChars,
          leftChars: res.leftChars,
          sendButton: res.sendButton,
          focusAt: res.focusAt,
          trail: res.trail,
        },
      };
    }

    // 主世界回来的是字母，落缓存前统一换算成下标 —— 缓存里只存下标，
    // 以后就算答题端换了选项顺序也不会张冠李戴。
    const answer = Array.isArray(res.answer) ? res.answer.slice().sort((a, b) => a - b) : [];
    if (!answer.length) return { ok: false, msg: 'AI 页没给出答案' };

    // 带图的回答**不落缓存** —— 键（题干）不可信，存进去会去污染别的题。
    // 这一模式每题都真去问一次，比"秒出但答错"划算得多。
    if (!msg.image) {
      aiState.cache.set(key, {
        answer,
        provider: res.provider || providerId,
        reason: res.reason || '',
        at: Date.now(),
      });
      if (aiState.cache.size % 5 === 0) void flushAiCache();
    }

    return {
      ok: true,
      answer,
      provider: res.providerName || res.provider || providerId,
      reason: res.reason || '',
      source: res.source || '',
      raw: res.raw || '',
      ms: Date.now() - started,
      createdTab: found.created,
      tabId,
    };
  } finally {
    aiState.busy = false;
    aiState.busySince = 0;
    if (aiState.cache.size >= AI_CACHE_MAX) void flushAiCache();
  }
}

/** 排障用：报告站点表、已打开的 AI 标签页（含脚本是否活着）、缓存量 */
async function probeAiTabs() {
  await loadAiCache();
  const found = [];
  const seen = new Set();
  for (const pat of providerTabPatterns('auto')) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: pat });
    } catch (e) { continue; }
    for (const t of tabs) {
      if (!t || t.id == null || seen.has(t.id)) continue;
      if (!hostMatchesProvider(t.url, 'auto')) continue;
      seen.add(t.id);
      // 「脚本活着吗」是这条链路最容易断的一环，直接在这里 ping 出来
      const alive = await pingTab(t.id, 1500);
      found.push({
        id: t.id,
        url: t.url,
        title: t.title,
        active: !!t.active,
        scriptAlive: alive,
        provider: (WEB_AI && (WEB_AI.providerForUrl(t.url) || {}).id) || null,
      });
    }
  }
  return {
    ok: true,
    providers: WEB_AI ? WEB_AI.PROVIDERS.map((p) => ({ id: p.id, name: p.name, home: p.home })) : [],
    openTabs: found,
    cacheSize: aiState.cache.size,
    debuggerAvailable: DEBUGGER_ENABLED,
    scriptsLoaded: !!WEB_AI,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 生命周期 ─────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#2b6cb0' });
  } catch (e) { /* noop */ }
});
