/**
 * popup.js — 控制台
 *
 * 状态走 popup ←→ content script 直连（chrome.tabs.sendMessage），
 * 不经过 background，这样 MV3 service worker 休眠也不影响刷新。
 */
'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULTS = window.ZHS_DEFAULTS || {};

/** 倍速红线：平台播放回调里硬编码 >1.8 即判异常，这里三处收口之一 */
const MAX_RATE = window.ZHS_MAX_PLAYBACK_RATE || 1.8;

const CONTENT_FILES = [
  'src/shared/defaults.js',
  'src/shared/web-ai.js',
  'src/content/dom.js',
  'src/content/config.js',
  'src/content/bank.js',
  'src/content/video.js',
  'src/content/playlist.js',
  'src/content/quiz.js',
  'src/content/ai-bridge.js',
  'src/content/main.js',
];

const SITE_RE = /^https?:\/\/([^/]*\.)?zhihuishu\.com\//i;

const STATE_TEXT = {
  idle: '待命',
  playing: '播放中',
  quizzing: '答题中',
  switching: '切换章节',
  done: '已完成',
};

let tab = null;
let pollTimer = null;
let lastPayload = null;
let pendingLogs = [];

// ── 基础工具 ─────────────────────────────────────────────

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function sendMsg(tabId, msg) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    try {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// 与 content 侧共用同一份「合并默认值 → 收紧越界 → 迁移老配置」实现，
// 否则 popup 读到的旧配置会在用户改任意一个开关时被原样写回去，
// 把迁移结果覆盖掉。
const normalizeConfig = window.ZHS_normalizeConfig
  || ((raw) => Object.assign({}, DEFAULTS, raw || {}));
const sanitizeConfig = window.ZHS_sanitizeConfig || ((c) => c);

function readConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get('config', (got) => {
      resolve(normalizeConfig(got && got.config));
    });
  });
}

function patchConfig(patch) {
  return readConfig().then((cfg) => new Promise((resolve) => {
    // patch 是用户此刻的显式选择，只收速率、不做迁移
    chrome.storage.local.set(
      { config: sanitizeConfig(Object.assign(cfg, patch)) },
      () => resolve()
    );
  }));
}

function fmtWatch(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h' + m + 'm';
  if (m > 0) return m + 'm';
  return s + 's';
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// ── 控件绑定 ─────────────────────────────────────────────

// [元素 id, 配置键, 类型]
const BINDINGS = [
  ['mode', 'mode', 'str'],
  ['enabled', 'enabled', 'bool'],
  ['autoNext', 'autoNext', 'bool'],
  ['autoQuiz', 'autoQuiz', 'bool'],
  ['autoPlay', 'autoPlay', 'bool'],
  ['mute', 'mute', 'bool'],
  ['keepFocus', 'keepFocus', 'bool'],
  ['useBank', 'useBank', 'bool'],
  ['bruteForce', 'bruteForce', 'bool'],
  ['learnAnswers', 'learnAnswers', 'bool'],
  ['retryOnWrong', 'retryOnWrong', 'bool'],
  ['abilityAuto', 'abilityAuto', 'bool'],
  ['abilityAutoSubmit', 'abilityAutoSubmit', 'bool'],
  ['verboseLog', 'verboseLog', 'bool'],
  ['askWebAI', 'askWebAI', 'bool'],
  ['webAIFirst', 'webAIFirst', 'bool'],
  ['askNewTab', 'askNewTab', 'bool'],
  ['askCache', 'askCache', 'bool'],
  ['webAIProvider', 'webAIProvider', 'str'],
  ['playbackRate', 'playbackRate', 'num'],
  ['maxChapters', 'maxChapters', 'num'],
  ['maxComboSize', 'maxComboSize', 'num'],
  ['resultWaitMs', 'resultWaitMs', 'num'],
  ['askWaitMs', 'askWaitMs', 'num'],
];

function bindControls() {
  for (const [id, key, type] of BINDINGS) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('change', async () => {
      let v;
      if (type === 'bool') v = el.checked;
      else if (type === 'str') v = el.value;
      else v = Number(el.value);
      await patchConfig({ [key]: v });
      renderSliders();
    });
    if (type === 'num') {
      el.addEventListener('input', renderSliders);
    }
  }
}

function applyConfigToUI(cfg) {
  for (const [id, key, type] of BINDINGS) {
    const el = $(id);
    if (!el) continue;
    if (type === 'bool') el.checked = !!cfg[key];
    else el.value = cfg[key];
  }
  renderSliders();
  renderMode(cfg);
}

/**
 * 模式是**单选** —— 两套答题共用同一个网页端 AI 页，同时跑会互相踩。
 * 所以界面上要把"当前只跑哪一套"说清楚，并且把另一套的入口置灰。
 */
function renderMode(cfg) {
  const ability = (cfg.mode || 'video') === 'ability';
  const hint = $('modeHint');
  if (hint) {
    hint.textContent = ability
      ? '当前只跑「能力提升」：课中弹题探测已停用 —— 两套不能同时用同一个 AI 页。'
      : '当前只跑「视频」：能力提升的整套答题已停用 —— 两套不能同时用同一个 AI 页。';
  }
  // 把属于另一套的开关置灰，避免"看着开着其实不生效"
  for (const id of ['abilityAuto', 'abilityAutoSubmit']) {
    const row = $(id) && $(id).closest('.line');
    if (row) row.style.opacity = ability ? '1' : '0.45';
  }
  for (const id of ['autoQuiz', 'bruteForce']) {
    const row = $(id) && $(id).closest('.line');
    if (row) row.style.opacity = ability ? '0.45' : '1';
  }
}

function renderSliders() {
  const rate = Number($('playbackRate').value);
  $('rateVal').textContent = rate.toFixed(2).replace(/0$/, '') + 'x';

  const max = Number($('maxChapters').value);
  $('maxVal').textContent = max === 0 ? '不限' : max + ' 集';

  $('comboVal').textContent = $('maxComboSize').value;

  const w = Number($('resultWaitMs').value);
  $('waitVal').textContent = (w / 1000).toFixed(1) + 's';

  const aw = Number($('askWaitMs').value);
  $('askWaitVal').textContent = Math.round(aw / 1000) + 's';

  // 关掉 AI 抢答时，把这一段的从属控件压暗，避免误以为还在生效
  const on = $('askWebAI').checked;
  const card = $('askWebAI').closest('.card');
  if (card) card.style.opacity = on ? '1' : '.55';
}

// ── 状态渲染 ─────────────────────────────────────────────

function setDot(cls) {
  const d = $('brandDot');
  d.className = 'dot' + (cls ? ' ' + cls : '');
}

function renderOffline(reason) {
  $('stateBadge').className = 'badge idle';
  $('stateBadge').textContent = '未连接';
  $('stateText').textContent = reason;
  $('bar').style.width = '0%';
  $('pct').textContent = '--';
  setDot('err');
}

function renderOnline(p) {
  if (!p) return renderOffline('页面无响应，试试「重注入脚本」');

  lastPayload = p;
  const st = p.state || 'idle';

  $('stateBadge').className = 'badge ' + st;
  $('stateBadge').textContent = STATE_TEXT[st] || st;

  const t = p.title || '';
  $('stateText').textContent = t ? t.slice(0, 46) : (p.url || '').slice(0, 46);

  const pct = Math.round((p.ratio || 0) * 100);
  $('bar').style.width = pct + '%';
  $('pct').textContent = p.hasVideo ? pct + '%' : '无视频';

  $('chapters').textContent = p.chaptersPlayed || 0;
  $('watch').textContent = fmtWatch(p.watchMs);

  const q = p.quiz || {};
  $('quizTotal').textContent = q.asked || 0;
  $('quizBank').textContent = q.byBank || 0;
  $('quizAI').textContent = q.byAI || 0;
  $('quizBrute').textContent = q.byBrute || 0;
  $('quizFail').textContent = q.failed || 0;

  renderAiPill(p.webAI);

  // 失败现场截图：后台抓到了就挂在这一格上，点一下就能看到
  if (p.shot) {
    lastShot = p.shot;
    const pill = $('aiPill');
    pill.className = (pill.className + ' shot').trim();
    pill.title = '点一下看失败那一刻的页面截图';
  }

  const pl = p.playlist || {};
  $('plDone').textContent = pl.done || 0;
  $('plTotal').textContent = pl.total || 0;
  $('bankSize').textContent = p.bankSize || 0;

  setDot(st === 'quizzing' ? 'quiz' : (st === 'playing' ? 'on' : ''));

  if (Array.isArray(p.logs)) renderLogs(p.logs);
}

/**
 * 网页 AI 那一格的状态。
 * 这里只报「已经发生过什么」，不去猜 AI 站点现在能不能用 ——
 * 猜出来的绿灯比没有灯更坏。
 */
function renderAiPill(ai) {
  const el = $('aiPill');
  if (!el) return;
  el.title = '';
  if (!ai) {
    el.className = 'muted';
    el.textContent = '未接入';
    return;
  }
  if (ai.inflight) {
    // 等待时把"已经等了多久 / 最多等多久"显示出来。
    // 90 秒的预算下一声不吭地干等，很容易被当成又卡死了。
    const waited = Math.round((ai.waitedMs || 0) / 1000);
    const cap = Math.round((ai.timeoutMs || 0) / 1000);
    el.className = 'muted busy';
    el.textContent = cap
      ? ('等待 ' + waited + '/' + cap + 's' + (ai.phase ? ' · ' + ai.phase : ''))
      : '问询中…';
    el.title = '正在等 AI 回包。到点没等到就会自动落回下一级，不会卡住整节课。';
    return;
  }
  if (ai.asked === 0) {
    el.className = 'muted';
    el.textContent = '待命';
    return;
  }
  const okRate = Math.round((ai.answered / Math.max(1, ai.asked)) * 100);
  if (ai.answered === 0) {
    el.className = 'muted err';
    el.textContent = ai.lastError ? ('失败：' + ai.lastError.slice(0, 16)) : '失败';
    return;
  }
  el.className = 'muted on';
  el.textContent = '答对 ' + ai.answered + '/' + ai.asked + ' · ' + okRate + '%' +
    (ai.lastProvider ? ' · ' + ai.lastProvider : '');
}

// ── 失败现场：截图 ───────────────────────────────────────

/**
 * 「字打进去了但发不出去」这类问题，看一眼页面比读十条日志都快。
 * 后台在提交失败时会抓一张 AI 页面的截图，这里把它摊出来。
 * data URL 直接塞进 <img> 在 CSP 下会被拦，所以塞进一个空白页再看。
 */
let lastShot = null;

function showShot(shot) {
  if (!shot) return flash($('btnAiDiag'), '这次没有截图', false);
  try {
    const w = window.open('', '_blank');
    if (!w) return flash($('btnAiDiag'), '弹窗被拦住了', false);
    w.document.title = 'AI 页面截图（失败现场）';
    w.document.body.style.cssText =
      'margin:0;background:#10151d;color:#8b98a8;font:13px/1.7 system-ui,sans-serif';
    const tip = w.document.createElement('div');
    tip.style.cssText = 'padding:10px 14px';
    tip.textContent = '这是提交失败那一刻，AI 标签页的样子。看完把它关掉即可。';
    const img = w.document.createElement('img');
    img.src = shot;
    img.style.cssText = 'display:block;width:100%';
    w.document.body.appendChild(tip);
    w.document.body.appendChild(img);
    return true;
  } catch (e) {
    return flash($('btnAiDiag'), '打不开预览', false);
  }
}

/**
 * 渲染日志区。
 *
 * ⚠ 这里最容易踩的坑是**自动滚到最后一行**：
 * 控制台每秒轮询一次、每次都重新渲染，于是只要你往上翻一点想看前几行，
 * 下一秒就被拽回底部 —— 日志明明在那儿，却永远读不成。
 *
 * 所以规则是：
 *   · 只有当**你本来就在底部**时才跟着滚（这是想要的行为）
 *   · 你已经往上翻了就**保持住原来的位置**（按"离底部多少像素"记住，
 *     这样内容继续变长时读到的还是同一段）
 *   · 内容没变就不动 DOM —— 重设 innerHTML 会把滚动位置一起丢掉，
 *     所以这一步也顺带省掉每秒一次的无谓重排
 *   · 翻上去之后右下角出现「↓ 最新」，点一下回到实时跟随
 */
let lastLogsHtml = '';
let logsFollowing = true;      // 当前是否处于"跟随最新"状态

function renderLogs(logs) {
  const box = $('logs');
  if (!logs.length) {
    if (lastLogsHtml === '') return;      // 没变化就别动它
    lastLogsHtml = '';
    box.textContent = '暂无日志';
    return;
  }
  const verbose = $('verboseLog').checked;
  const lines = logs
    .filter((e) => verbose || e.level !== 'debug')
    .slice(-80)
    .map((e) => {
      const cls = e.level === 'ok' ? 'ok' : (e.level === 'warn' ? 'warn' : (e.level === 'debug' ? 'debug' : ''));
      const tag = e.frame === 'frame' ? '·子框架' : '';
      return `<span class="time">${fmtClock(e.t)}</span> <span class="${cls}">${escapeHtml(e.msg)}${tag}</span>`;
    });
  const html = lines.join('\n') || '暂无日志';

  if (html === lastLogsHtml) return;      // 逐字相同 → 不碰 DOM

  const fromBottom = box.scrollHeight - box.scrollTop;
  const atBottom = fromBottom - box.clientHeight <= 8;
  const follow = atBottom || logsFollowing;

  lastLogsHtml = html;
  box.innerHTML = html;

  if (follow) {
    logsFollowing = true;
    box.scrollTop = box.scrollHeight;
  } else {
    box.scrollTop = Math.max(0, box.scrollHeight - fromBottom);
  }
  updateLogFollow();
}

/** 右下角那个「↓ 最新」的显示/隐藏 */
function updateLogFollow() {
  const hint = $('logFollow');
  if (hint) hint.hidden = logsFollowing;
}

/** 让它回到"跟随最新" */
function followLogs() {
  const box = $('logs');
  logsFollowing = true;
  box.scrollTop = box.scrollHeight;
  updateLogFollow();
}

/** 用户滚动日志区：到底部就恢复跟随，翻上去就停止跟随 */
function onLogsScroll() {
  const box = $('logs');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 8;
  if (atBottom !== logsFollowing) {
    logsFollowing = atBottom;
    updateLogFollow();
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── 刷新循环 ─────────────────────────────────────────────

async function refresh() {
  if (!tab || tab.id == null) {
    renderOffline('没有活动标签页');
    return;
  }
  $('tabUrl').textContent = (tab.url || '').replace(/^https?:\/\//, '').slice(0, 40);

  if (!SITE_RE.test(tab.url || '')) {
    renderOffline('当前标签页不是知到（zhihuishu.com）');
    $('stateText').textContent = '打开知到课程页后会自动接管';
    return;
  }

  const res = await sendMsg(tab.id, { type: 'ZHS_QUERY' });
  if (!res || !res.ok) {
    renderOffline('脚本未注入，点「重注入脚本」');
    return;
  }
  renderOnline(res.payload);
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    refresh().catch(() => {});
  }, 1000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ── 动作 ─────────────────────────────────────────────────

/**
 * 每个按钮"闪一下结果"的定时器。用 WeakMap 存，弹窗关掉就一起没了。
 */
const flashTimers = new WeakMap();

/**
 * 在按钮上闪一下结果。
 *
 * ⚠ 这里有个隐蔽的坑，用户截图里就能直接看到：**按钮的标签被永久改成了错误信息**
 * （那个按钮上写着「AI 没有给出可用答案」，边框还是红的）。
 *
 * 旧写法把"原标签"记在闭包里，于是连续点两次就永久错下去：
 *
 *   点第一次        old₁ = "问一次 AI"
 *   1.4 秒内点第二次 old₂ = **"AI 没有给出可用答案…"**（此刻的标签！）
 *   第一次的定时器到 → 恢复成 "问一次 AI"
 *   第二次的定时器到 → 恢复成 "AI 没有给出可用答案…"      ← 从此一直是错的
 *
 * 两个修法：
 *   ① 原标签记在**元素自己身上**（`dataset.label`），而且只在按钮**空闲**时记
 *      —— 这样外部真的改了标签（比如"高保真点击"那种会变文字的按钮）也不会被覆盖回去；
 *   ② 每次新闪都先清掉上一个定时器，不给两个闪重叠的机会。
 */
function flash(btn, text, ok) {
  if (!btn) return;
  if (!flashTimers.has(btn)) {
    btn.dataset.label = btn.textContent;   // 只在空闲时记，避免记成"上一次的错误信息"
  }
  const prev = flashTimers.get(btn);
  if (prev) clearTimeout(prev);
  btn.textContent = text;
  btn.style.borderColor = ok ? 'var(--ok)' : 'var(--danger)';
  flashTimers.set(btn, setTimeout(() => {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.style.borderColor = '';
    flashTimers.delete(btn);
  }, 1400));
}

/** 把「问一次 AI」的结果整理成人能看的几行 */
function formatAskAI(d) {
  const out = [];
  out.push(d.answer ? '✓ AI 给出了答案' : '✗ AI 没给出答案');
  const st = d.status || {};
  // 先给"为什么" —— 以前这里只有一句"没有给出可用答案"，
  // 用户完全不知道为什么，只能来问。
  if (st.lastError) out.push('  原因：' + st.lastError);
  else if (!d.answer) {
    out.push('  原因：AI 通道没报错 —— 多半是被跳过了（这道题已经问过、'
      + '或者正在问），不是故障');
  }

  out.push('');
  out.push('【问的是这道题】');
  out.push('  ' + String(d.stem || '?').slice(0, 240));
  (d.options || []).forEach((o, i) => {
    out.push('  ' + String.fromCharCode(65 + i) + '. ' + String(o).slice(0, 120));
  });

  out.push('');
  out.push('【AI 通道状态】');
  out.push('  问过 ' + (st.asked || 0) + ' 次 · 答上 ' + (st.answered || 0) +
    ' 次 · 失败 ' + (st.failed || 0) + ' 次');
  if (st.lastProvider) out.push('  最近用的站点：' + st.lastProvider);
  if (st.lastMs) out.push('  最近一次耗时：' + (st.lastMs / 1000).toFixed(1) + 's');
  if (st.inflight) out.push('  此刻正在问：是（等了 ' + Math.round((st.waitedMs || 0) / 1000) + 's）');
  if (st.lastDetail) {
    out.push('  最近一次失败的细节：' + JSON.stringify(st.lastDetail).slice(0, 400));
  }
  return out.join('\n');
}

async function doAction(btn, action) {
  if (!tab || tab.id == null) return flash(btn, '无标签页', false);
  const res = await sendMsg(tab.id, { type: 'ZHS_ACTION', action });
  if (!res) return flash(btn, '脚本未注入', false);
  flash(btn, res.ok ? '已执行' : (res.msg || '失败'), !!res.ok);
  if (res.detail) {
    const box = $('logs');
    // 「试发一条」和「问一次 AI」的 detail 是对象，铺开成可读的多行；其余照旧直接 JSON
    if (action === 'aiSendTest') box.textContent = formatSendTest(res.detail);
    else if (action === 'askAI') box.textContent = formatAskAI(res.detail);
    else box.textContent = JSON.stringify(res.detail, null, 2);
    box.scrollTop = 0;
    if (res.detail.shot) {
      lastShot = res.detail.shot;
      const pill = $('aiPill');
      pill.className = (pill.className + ' shot').trim();
      pill.title = '点一下看失败那一刻的页面截图';
    }
  }  refresh().catch(() => {});
}

/** 把「试发一条」带回来的现场整理成人能看的几行 */
function formatSendTest(d) {
  const out = [];
  out.push(d.ok ? '✓ AI 页面收到了并作答' : '✗ 没发出去');
  if (d.msg) out.push('  说明：' + d.msg);
  if (d.letters) out.push('  答案：' + d.letters);
  out.push('');
  out.push('【这一步走到哪儿了】');
  (d.trail || []).forEach((t) => out.push('  · ' + t));
  if (d.via) out.push('  · 塞字路径：' + d.via);
  out.push('  · 焦点在：' + (d.focusAt || '?'));
  out.push('  · 发送按钮：' + (d.sendButton || '?'));
  if (typeof d.typedChars === 'number') out.push('  · 塞进去 ' + d.typedChars + ' 字，还剩 ' + d.leftChars + ' 字');
  if (d.dom) {
    out.push('');
    if (d.dom.error) {
      out.push('【AI 页面探测失败】');
      out.push('  ' + d.dom.error);
      out.push('  （这通常意味着 debugger 没接上：DevTools 是不是开着？按 F12 关掉再试）');
    } else {
      out.push('【AI 页面上的输入区长什么样】');
      out.push('  地址：' + (d.dom.href || '?'));
      out.push('  焦点：' + (d.dom.active || '(无)'));
      out.push('  可见的输入框：' + (d.dom.editor || []).length + ' 个');
      (d.dom.editor || []).forEach((e) => {
        out.push('    · <' + e.tag + '> ' + (e.cls || e.id || '') +
          ' editable=' + e.editable + ' 尺寸=' + (e.box || []).join('x'));
      });
      out.push('  相关的按钮：' + (d.dom.buttons || []).length + ' 个');
      (d.dom.buttons || []).forEach((b) => {
        out.push('    · <' + b.tag + '> ' + (b.aria || b.cls || '') +
          ' 尺寸=' + (b.box || []).join('x') + ' disabled=' + b.disabled);
      });
      out.push('  停止按钮可见：' + (d.dom.stopVisible ? '是（可能是它一直在挡）' : '否'));
    }
  } else {
    out.push('');
    out.push('【AI 页面探测】没有拿到数据');
    out.push('  可能原因：debugger 没接上（DevTools 开着）、或者权限被回收');
  }

  if (d.dom && d.dom.selectors) {
    // 每个选择器各命中几个 —— 出问题时最想知道的就是"是不是一个都没匹配到"
    out.push('');
    out.push('【选择器命中数】来源：' + (d.dom.selectorSource || '站点表') +
      '  (0 = 这条失配，站点可能改版了)');
    const label = { input: '输入框', send: '发送', answer: '回答', stop: '停止' };
    for (const k of Object.keys(d.dom.selectors)) {
      out.push('  ' + (label[k] || k) + '：');
      (d.dom.selectors[k] || []).forEach((pair) => {
        const s = pair[0];
        const n = pair[1];
        out.push('    ' + (n > 0 ? '✓ ' + n + ' 个' : '· 0 个') + '   ' + s);
      });
    }
  } else {
    // 拿不到命中数时也必须说清楚为什么 —— 不能留一段空白让人猜
    out.push('');
    out.push('【选择器命中数】没拿到');
    out.push('  原因：' + ((d.dom && (d.dom.selectorError || d.dom.error)) ||
      (d.probeDiag && d.probeDiag.error) ||
      '后台没把探测结果带回来'));
    if (d.probeDiag && d.probeDiag.stage) {
      out.push('  卡在：' + d.probeDiag.stage + ' 这一步');
    }
    if (d.panelVersion) out.push('  （后台版本标记：' + d.panelVersion + '）');
    out.push('  若这里三行都没有，说明后台还是旧代码 —— 去 chrome://extensions 点一下扩展卡片上的刷新按钮');
  }
  if (d.shot) {
    out.push('');
    out.push('【已经拍下失败那一刻的页面截图 —— 点上面「失败：…」那一格看】');
  }
  return out.join('\n');
}

async function injectScripts() {
  const btn = $('btnInject');
  if (!tab || tab.id == null) return flash(btn, '无标签页', false);
  if (!SITE_RE.test(tab.url || '')) return flash(btn, '非知到页面', false);

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: CONTENT_FILES,
      injectImmediately: true,
    });
    flash(btn, '已注入', true);
    setTimeout(() => refresh().catch(() => {}), 600);
  } catch (e) {
    flash(btn, '注入失败', false);
  }
}

/**
 * 高保真点击开关。
 *
 * chrome.debugger 只有在 manifest 的 permissions 里声明了 "debugger" 时才存在；
 * 而 Chrome 又不允许把它放进 optional_permissions（会报
 * "Permission 'debugger' cannot be listed as optional"，直接忽略该声明）。
 * 所以默认安装不带这个能力，需要用户手动改一行 manifest 再重载扩展。
 */
function debuggerAvailable() {
  try {
    return !!(chrome.debugger && chrome.debugger.attach);
  } catch (e) {
    return false;
  }
}

async function handleCdpToggle() {
  const btn = $('btnCdp');

  if (!debuggerAvailable()) {
    showNote(
      '高保真点击未启用。\n' +
      'Chrome 不允许把 "debugger" 声明为 optional_permissions，所以需要手动开启：\n' +
      '1. 打开 D:\\DSH\\zhihuishu-auto\\manifest.json\n' +
      '2. 把 permissions 改成 ["storage", "tabs", "scripting", "debugger"]\n' +
      '3. 回到 chrome://extensions 点扩展卡片上的刷新按钮\n' +
      '开启后点击会走 CDP，事件 isTrusted=true；代价是顶部会常驻一条「正在调试此浏览器」的提示条。'
    );
    flash(btn, '需手动开启', false);
    return;
  }

  const cfg = await readConfig();

  if (cfg.highFidelityClick) {
    await patchConfig({ highFidelityClick: false });
    $('btnCdp').textContent = '开启高保真点击';
    flash(btn, '已关闭', true);
    return;
  }

  await patchConfig({ highFidelityClick: true });
  $('btnCdp').textContent = '关闭高保真点击';
  flash(btn, '已开启', true);
}

/** 在日志区顶部显示一段说明 */
function showNote(text) {
  const box = $('logs');
  box.textContent = text;
  box.scrollTop = 0;
}

async function exportBank() {
  const btn = $('btnExport');
  chrome.storage.local.get('bank', (got) => {
    const bank = (got && got.bank) || {};
    const blob = new Blob([JSON.stringify(bank, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zhihuishu-bank-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    flash(btn, '已导出 ' + Object.keys(bank).length + ' 题', true);
  });
}

async function clearBank() {
  const btn = $('btnClearBank');
  chrome.storage.local.set({ bank: {} }, () => {
    flash(btn, '题库已清空', true);
    setTimeout(() => refresh().catch(() => {}), 300);
  });
}

// ── 网页 AI 抢答 ─────────────────────────────────────────

function sendBg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * AI 链路诊断：一次性把「谁家站点表在、开了哪些 AI 标签页、
 * 缓存里有多少条、知到页那边的通道状态」摊在日志区。
 * 这条链路横跨三个上下文（知到页 / background / AI 页），
 * 出问题时最费时间的就是确定断在哪一段。
 */
async function diagnoseAi() {
  const btn = $('btnAiDiag');
  const lines = [];

  const bg = await sendBg({ type: 'ZHS_AI_PROBE' });
  if (!bg || !bg.ok) {
    showNote('background 无响应：' + ((bg && bg.msg) || '未知原因'));
    flash(btn, '后台无响应', false);
    return;
  }

  lines.push('【站点表】' + (bg.scriptsLoaded
    ? bg.providers.map((p) => p.name + '(' + p.id + ')').join(' / ')
    : '未加载！service-worker 里的 importScripts 失败了'));
  lines.push('【CDP】' + (bg.debuggerAvailable ? '可用（高保真输入走这条路）' : '不可用（只能用合成事件）'));
  lines.push('【缓存】' + bg.cacheSize + ' 条已问过的题');
  lines.push('【已打开的 AI 标签页】');
  if (!bg.openTabs.length) {
    lines.push('  （一个都没有 —— 触发时扩展会自己新开一个）');
  } else {
    for (const t of bg.openTabs) {
      lines.push('  · ' + (t.active ? '[当前] ' : '') + (t.url || '') +
        (t.title ? '  « ' + t.title.slice(0, 30) + ' »' : ''));
      // 「脚本活着吗」这条最关键：页面开着但没挂脚本时，
      // 上层看到的是一句很误导人的"AI 页无响应"，实际只要刷新那一页就好
      lines.push('      ' + (t.scriptAlive
        ? '✓ 脚本已注入'
        : '✗ 脚本没挂上 —— 刷一下这个页面（或扩展重载后没刷它）'));
    }
  }

  const local = await sendMsg(tab && tab.id, { type: 'ZHS_ACTION', action: 'probe' });
  if (local && local.detail) {
    const st = local.detail.stats || {};
    lines.push('【页面侧通道】' +
      '已问 ' + (st.asked || 0) +
      ' / 答对 ' + (st.solved || 0) +
      '（题库 ' + (st.byBank || 0) + ' · AI ' + (st.byAI || 0) + ' · 枚举 ' + (st.byBrute || 0) + '）');
    const wa = local.detail.webAI;
    if (wa) {
      lines.push('【知到页看到的】' + JSON.stringify({
        asked: wa.asked, answered: wa.answered, failed: wa.failed,
        lastError: wa.lastError, inflight: wa.inflight,
      }));
    }
  } else {
    lines.push('【页面侧通道】无响应 —— 先点「重注入脚本」');
  }

  lines.push('');
  lines.push('自检顺序：① 打开对应 AI 站点，确认是登录后的对话页；');
  lines.push('② 点「问一次 AI」，看日志里是「字没能进到输入框」还是「等待回复超时」；');
  lines.push('③ 两条都不是，就是答案解析没命中 —— 看「AI 没有给出可用答案」后面跟的原始回包。');

  showNote(lines.join('\n'));
  flash(btn, '已诊断', true);
}

async function clearAiCache() {
  const btn = $('btnClearAiCache');
  const res = await sendBg({ type: 'ZHS_AI_CACHE_CLEAR' });
  if (!res) return flash(btn, '后台无响应', false);
  flash(btn, '已清 ' + (res.cleared || 0) + ' 条', true);
}

// ── 初始化 ───────────────────────────────────────────────

async function init() {
  // 版本号：改过代码之后用它确认扩展本体是否已被 Chrome 重新加载。
  // 带上构建标记更好认 —— 排障时第一件事就是"跑的是不是刚改的那份代码"。
  try {
    const v = chrome.runtime.getManifest().version;
    $('verNum').textContent = v + ' · ' + (window.ZHS_BUILD || '?');
  } catch (e) {
    $('verNum').textContent = '?';
  }

  const cfg = await readConfig();
  applyConfigToUI(cfg);
  bindControls();

  $('btnCdp').textContent = (debuggerAvailable() && cfg.highFidelityClick)
    ? '关闭高保真点击'
    : '高保真点击';

  tab = await queryActiveTab();

  $('btnSolve').addEventListener('click', (e) => doAction(e.currentTarget, 'solve'));
  $('btnNext').addEventListener('click', (e) => doAction(e.currentTarget, 'next'));
  $('btnRescan').addEventListener('click', (e) => doAction(e.currentTarget, 'rescan'));
  $('btnProbe').addEventListener('click', (e) => doAction(e.currentTarget, 'probe'));
  $('btnInject').addEventListener('click', injectScripts);
  $('btnReload').addEventListener('click', () => {
    if (tab && tab.id != null) chrome.tabs.reload(tab.id);
    window.close();
  });
  $('btnExport').addEventListener('click', exportBank);
  $('btnClearBank').addEventListener('click', clearBank);
  $('btnCdp').addEventListener('click', handleCdpToggle);

  // ── 网页 AI 抢答 ──
  $('btnAskAI').addEventListener('click', (e) => doAction(e.currentTarget, 'askAI'));
  $('btnAiSendTest').addEventListener('click', (e) => doAction(e.currentTarget, 'aiSendTest'));
  $('btnDumpQuiz').addEventListener('click', (e) => doAction(e.currentTarget, 'dumpQuiz'));
  $('btnDumpPlaylist').addEventListener('click', (e) => doAction(e.currentTarget, 'dumpPlaylist'));

  // ── 日志区：翻上去看历史时不能被每秒一次的轮询拽回底部 ──
  $('logs').addEventListener('scroll', onLogsScroll);
  $('logFollow').addEventListener('click', followLogs);
  $('btnAiDiag').addEventListener('click', diagnoseAi);
  $('btnClearAiCache').addEventListener('click', clearAiCache);
  $('aiPill').addEventListener('click', () => {
    if (lastShot) showShot(lastShot);
    else diagnoseAi();
  });
  $('btnReloadExt').addEventListener('click', async () => {
    // 改了 manifest / 新增文件 / 改了 background 之后必须重载扩展本体，
    // 只刷新页面是不够的。重载后当前页还得再刷一次才能注入新脚本。
    if (tab && tab.id != null) {
      try { await chrome.tabs.reload(tab.id); } catch (e) { /* noop */ }
    }
    showNote('扩展正在重载…\n\n重载完成后如果页面没有自动刷新，请手动按一次 F5 —— '
      + 'content script 和反检测补丁都是在页面加载时注入的，不刷新不会生效。');
    setTimeout(() => {
      try { chrome.runtime.reload(); } catch (e) { /* noop */ }
    }, 500);
  });

  await refresh();
  startPolling();

  // 给测试用的出口：报告格式化与日志区都是纯逻辑，值得单独钉住 ——
  // 「选择器命中数」那段曾经整段消失、「日志自动滚到底」曾经把阅读位置拽走，
  // 都是因为没人守。
  //
  // ⚠ 这里引用的每个名字都必须真实存在。曾经写了个不存在的 `formatDiag`，
  // 于是 init() 走到这一行就抛 ReferenceError —— **整个控制台全废**：
  // 日志、状态、按钮全都不工作，而错误信息还被 renderOffline 吃掉了。
  window.ZHS_popup = {
    formatSendTest,
    formatAskAI,
    diagnoseAi,
    renderLogs,
    onLogsScroll,
    followLogs,
  };

  window.addEventListener('unload', stopPolling);

  // 配置在别处被改动时同步 UI
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) {
      applyConfigToUI(Object.assign({}, DEFAULTS, changes.config.newValue || {}));
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => {
    renderOffline('初始化异常：' + (e && e.message));
  });
});
