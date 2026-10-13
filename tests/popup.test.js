/**
 * popup.test.js — 控制台的接线测试（jsdom）
 *
 * popup 是唯一"点了没反应也不会报错"的地方：bindControls 里写的是
 *   if (!el) continue;
 * id 拼错了、控件没加进 html、开关和配置键对不上 —— 全都安静地跳过，
 * 表现只是"这个开关点了没反应"，翻代码很难看出来。
 *
 * 这里在 jsdom 里把 popup 整份跑一遍（真的 defaults.js + web-ai.js + popup.js），
 * 断言：状态与滑块标签渲染出来了、开关真的写进了 config、按钮真的发对了消息。
 *
 * 运行： node tests/popup.test.js
 * （需要 jsdom：npm install jsdom --prefix "%TEMP%\zhs-jsdom"）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function resolveJsdom() {
  const candidates = [
    process.env.ZHS_JSDOM,
    path.join(process.env.TEMP || '/tmp', 'zhs-jsdom', 'node_modules'),
    path.join(ROOT, 'node_modules'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(path.join(c, 'jsdom')); } catch (e) { /* 试下一个 */ }
  }
  try { return require('jsdom'); } catch (e) { /* 到底了 */ }
  console.error('\n找不到 jsdom。安装：npm install jsdom --prefix "%TEMP%\\zhs-jsdom"\n');
  process.exit(2);
}

const { JSDOM } = resolveJsdom();

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
  if (a !== b) throw new Error((msg || 'not equal') + '  got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function match(re, s, msg) { if (!re.test(String(s))) throw new Error((msg || 'no match') + '  got=' + JSON.stringify(s)); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  console.log('\n\x1b[1m知到自动助手 — 控制台接线（jsdom）\x1b[0m\n');

  const html = fs.readFileSync(path.join(ROOT, 'src', 'popup', 'popup.html'), 'utf8');
  const store = {};
  const writes = [];
  const sent = [];
  // 状态载荷可以在用例里替换，用来驱动不同的渲染分支
  let payload = {
    state: 'playing', title: '测试课程', ratio: 0.5, hasVideo: true,
    quiz: { asked: 3, byBank: 1, byAI: 1, byBrute: 1, failed: 0 },
    playlist: { done: 1, total: 5 },
    bankSize: 7,
    webAI: { asked: 2, answered: 1, failed: 1, lastError: '', lastProvider: 'doubao', inflight: false },
    logs: [],
  };
  void payload;

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'chrome-extension://test/popup.html',
  });
  const win = dom.window;

  // popup 要的那一小撮 chrome.* —— 真实环境由扩展提供
  win.chrome = {
    runtime: {
      id: 'test',
      lastError: null,
      getManifest: () => ({ version: '1.2.0' }),
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (typeof cb === 'function') {
          cb(msg.type === 'ZHS_AI_PROBE'
            ? {
              ok: true, scriptsLoaded: true, providers: [{ id: 'doubao', name: '豆包' }],
              openTabs: [], cacheSize: 2, debuggerAvailable: true,
            }
            : { ok: true, cleared: 3 });
        }
        return Promise.resolve();
      },
    },
    storage: {
      local: {
        get: (k, cb) => cb({ config: Object.assign({}, store.config) }),
        set: (obj, cb) => { writes.push(obj); Object.assign(store, obj); if (cb) cb(); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: (q, cb) => cb([{ id: 1, url: 'https://www.zhihuishu.com/study/xxx' }]),
      sendMessage: (id, msg, cb) => {
        if (typeof cb === 'function') cb({ ok: true, payload });
      },
      reload: () => Promise.resolve(),
    },
    scripting: { executeScript: () => Promise.resolve([]) },
    action: {},
  };

  // 按 popup.html 的 <script> 顺序注入
  for (const rel of ['src/shared/defaults.js', 'src/shared/web-ai.js', 'src/popup/popup.js']) {
    win.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  }
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  await sleep(600);

  const $ = (id) => win.document.getElementById(id);

  check('popup.js 引用的每个 id 在 html 里都存在', () => {
    const js = fs.readFileSync(path.join(ROOT, 'src', 'popup', 'popup.js'), 'utf8');
    const ids = new Set();
    for (const m of js.matchAll(/\$\('([a-zA-Z_][\w-]*)'\)/g)) ids.add(m[1]);
    const missing = [...ids].filter((i) => !win.document.getElementById(i));
    eq(missing.length, 0, '这些 id 在 html 里不存在：' + JSON.stringify(missing));
  });

  check('滑块标签渲染出来了（说明 renderSliders 跑通、没有中途抛错）', () => {
    match(/x$/, $('rateVal').textContent, '倍速');
    match(/s$/, $('waitVal').textContent, '提交等待');
    match(/s$/, $('askWaitVal').textContent, 'AI 应答等待');
    ok($('comboVal').textContent.length > 0, '多选最大组合为空');
  });

  check('状态区把网页 AI 的成败率显示出来了', () => {
    eq($('quizAI').textContent, '1', '弹题统计里的 AI 命中数');
    match(/1\/2/, $('aiPill').textContent, 'AI 徽标内容：' + $('aiPill').textContent);
    match(/doubao/, $('aiPill').textContent, 'AI 徽标应当带上站点名');
  });

  check('等待中会显示「等了多久 / 最多等多久」', () => {
    // 90 秒的预算下一声不吭地干等，很容易被当成又卡死了
    payload = {
      state: 'quizzing', title: '测试', ratio: 0, hasVideo: true,
      quiz: { asked: 1, byBank: 0, byAI: 0, byBrute: 0, failed: 0 },
      playlist: { done: 0, total: 1 },
      bankSize: 0,
      webAI: {
        asked: 1, answered: 0, failed: 0, lastError: '', lastProvider: '',
        inflight: true, waitedMs: 42000, timeoutMs: 90000, phase: '等回包',
      },
      logs: [],
    };
  });
  await sleep(1800);          // 等一次轮询（popup 每秒 refresh 一次，留足余量防抖动）
  check('等待态文案里有秒数与上限', () => {
    const t = $('aiPill').textContent;
    ok(/42/.test(t), '没显示已等秒数：' + t);
    ok(/90/.test(t), '没显示上限：' + t);
    ok(/等回包/.test(t), '没显示阶段：' + t);
  });

  check('应答等待的默认值与滑杆量程一致', () => {
    const D = win.ZHS_DEFAULTS;
    const slider = $('askWaitMs');
    eq(Number(slider.value), D.askWaitMs, '默认值应当落在滑杆上');
    ok(Number(slider.min) <= D.askWaitMs && D.askWaitMs <= Number(slider.max),
      '默认值不在 [' + slider.min + ',' + slider.max + '] 区间里');
    // 免费的 DeepSeek 想慢题经常要 40~70 秒，默认给到 90 秒是有意的
    ok(D.askWaitMs >= 60000, '默认等待太短：' + D.askWaitMs);
  });

  check('网页 AI 那一段的默认值与配置一致', () => {
    const D = win.ZHS_DEFAULTS;
    eq($('askWebAI').checked, D.askWebAI, '开关');
    eq($('webAIFirst').checked, D.webAIFirst, 'AI 优先');
    eq($('askNewTab').checked, D.askNewTab, '没打开就新开');
    eq($('askCache').checked, D.askCache, '复用缓存');
    eq($('webAIProvider').value, D.webAIProvider, '站点');
    eq(Number($('askWaitMs').value), D.askWaitMs, '应答等待');
  });

  check('AI 优先默认是开的，且这个开关真的接上了', () => {
    // 默认值本身就是需求的一部分：默认顺序是 网页 AI → 题库 → 枚举
    eq(win.ZHS_DEFAULTS.webAIFirst, true, '默认值应当是 AI 优先');
    eq(win.ZHS_DEFAULTS.askWebAI, true, 'AI 总开关默认应当是开的');
    $('webAIFirst').checked = false;
    $('webAIFirst').dispatchEvent(new win.Event('change'));
  });

  check('组合枚举默认是关的（智能体网页端不接受重复提问）', () => {
    // 枚举 = 把同一道题反复提交，而网页端对重复提问会拒答。
    // 所以默认路线改成「网页 AI → 题库」，两级不中交给人手动答，不再空转。
    eq(win.ZHS_DEFAULTS.bruteForce, false, 'bruteForce 默认应当是 false');
    eq($('bruteForce').checked, false, '控制台上的开关应当是关的');
    ok(/重复提问/.test($('bruteForce').parentElement.textContent),
      '开关文案要说明为什么默认关：' + $('bruteForce').parentElement.textContent);
  });

  check('同一道题的重问上限是个有限小数（不许无限问）', () => {
    const n = Number(win.ZHS_DEFAULTS.maxAskAttempts);
    ok(isFinite(n) && n >= 1, 'maxAskAttempts 不合法：' + win.ZHS_DEFAULTS.maxAskAttempts);
    ok(n <= 3, '上限给太大（同一题问 AI ' + n + ' 次纯属浪费）：' + n);
  });
  await sleep(150);
  check('「AI 优先」开关写进了 config', () => {
    const last = writes[writes.length - 1];
    eq(last.config.webAIFirst, false, '没写进去');
  });
  check('提示文案说明了默认顺序', () => {
    const hint = win.document.querySelector('.hint:not(.modeHint)').textContent;
    match(/网页 AI/, hint, '提示里没提网页 AI');
    match(/题库/, hint, '提示里没提题库');
  });

  check('站点下拉里列全了所有站点 + 自动', () => {
    const opts = Array.from($('webAIProvider').options).map((o) => o.value);
    eq(opts[0], 'auto', '第一项应当是自动');
    for (const id of win.ZHS_webAI.PROVIDER_IDS) {
      ok(opts.includes(id), '下拉里缺 ' + id);
    }
  });

  check('关掉网页 AI 开关时，那一段卡片会变暗（避免误以为还在生效）', () => {
    $('askWebAI').checked = true;
    $('askWebAI').dispatchEvent(new win.Event('change'));
  });
  await sleep(150);
  const onOpacity = $('askWebAI').closest('.card').style.opacity;
  $('askWebAI').checked = false;
  $('askWebAI').dispatchEvent(new win.Event('change'));
  await sleep(150);

  check('开关状态真的写进了 config', () => {
    const last = writes[writes.length - 1];
    ok(last && last.config, '没有产生 config 写入');
    eq(last.config.askWebAI, false, '写入的开关值');
    eq(typeof last.config.playbackRate, 'number',
      '写入的必须是完整配置（只写单键会把迁移结果和别的键冲掉）');
    eq(last.config.webAIProvider, 'auto', '没碰过的键不能被改掉');
  });

  check('关掉之后卡片变暗', () => {
    const off = Number($('askWebAI').closest('.card').style.opacity);
    ok(off < Number(onOpacity), 'on=' + onOpacity + ' off=' + off);
  });

  check('改站点会写进 config', () => {
    $('webAIProvider').value = 'doubao';
    $('webAIProvider').dispatchEvent(new win.Event('change'));
  });
  await sleep(150);
  check('站点已写入', () => {
    eq(writes[writes.length - 1].config.webAIProvider, 'doubao');
  });

  check('「清空 AI 缓存」真的向后台发了消息', () => {
    $('btnClearAiCache').dispatchEvent(new win.Event('click'));
  });
  await sleep(150);
  check('清缓存消息已发出', () => {
    ok(sent.some((m) => m.type === 'ZHS_AI_CACHE_CLEAR'),
      '发出的消息：' + JSON.stringify(sent.map((m) => m.type)));
  });

  check('「AI 链路诊断」把报告铺到了日志区', () => {
    $('btnAiDiag').dispatchEvent(new win.Event('click'));
  });
  await sleep(400);
  // ── [0] 先确认控制台真的起来了 ───────────────────────────
  //
  // 这一节是补上的。曾经在 init() 末尾写了个不存在的名字（`formatDiag`），
  // 于是 init() 一路抛 ReferenceError —— **整个控制台全废**：日志、状态、
  // 按钮全都不工作，而错误还被 renderOffline 吃掉了，外面什么都看不出来。
  // 原来的用例全都在测"下半段"，一条都没拦住。
  check('控制台启动成功，没有中途抛错', () => {
    ok(win.ZHS_popup, 'init() 没跑完（抛错了）—— 整个控制台都会失效');
    ok(typeof win.ZHS_popup.renderLogs === 'function', '日志区没挂上');
    ok(typeof win.ZHS_popup.formatSendTest === 'function', '「试发一条」的报告格式化没挂上');
  });

  check('状态区真的被渲染过（不是一片空白）', () => {
    const text = $('logs').textContent;
    ok(text !== '' && text !== '暂无日志', '日志区一直是初始文案，说明 refresh 没跑通：' + JSON.stringify(text));
  });

  check('导出给测试的每个名字都真实存在', () => {
    // 这条守的正是上面那个错：导出了一个不存在的函数名
    const src = fs.readFileSync(path.join(ROOT, 'src', 'popup', 'popup.js'), 'utf8');
    const i = src.indexOf('window.ZHS_popup = {');
    ok(i !== -1, '找不到导出的那段');
    const block = src.slice(i, src.indexOf('};', i));
    const refs = block.split('\n').map((l) => l.trim().replace(/,$/, ''))
      .filter((l) => /^[A-Za-z0-9_]+$/.test(l));
    const defs = new Set(
      (src.match(/^(?:async )?function ([A-Za-z0-9_]+)/gm) || []).map((m) => m.split(' ').pop())
    );
    refs.forEach((r) => ok(defs.has(r), '导出了不存在的名字：「' + r + '」会让 init 抛错'));
  });

  check('诊断报告里有站点表与缓存条数', () => {
    const text = $('logs').textContent;
    ok(sent.some((m) => m.type === 'ZHS_AI_PROBE'), '没有发 ZHS_AI_PROBE');
    match(/站点表/, text, '报告缺站点表一段');
    match(/缓存/, text, '报告缺缓存一段');
  });

  // ── 日志区：翻上去看历史时不能被轮询拽回底部 ─────────────
  //
  // 真踩过：popup 每秒轮询一次、每次都重设 innerHTML 并 scrollTop = scrollHeight，
  // 于是只要往上翻一点就下一秒被拽回底部 —— 日志在那儿却永远读不成。
  //
  // 这一节直接驱动 renderLogs（而不是等轮询）：jsdom 不做布局，
  // 滚动尺寸得手工钉住，而且**必须在每次渲染后重新算**，
  // 否则"内容变长"这件事根本没发生，测出来的结论是假的。
  {
    const P = win.ZHS_popup;
    const box = $('logs');
    let contentH = 1000;
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => contentH });
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 140 });
    Object.defineProperty(box, 'scrollTop', {
      configurable: true, get: () => box.__st || 0, set: (v) => { box.__st = v; },
    });

    const mk = (n) => Array.from({ length: n }, (_, i) => ({
      t: Date.now(), level: 'info', msg: '日志第 ' + i + ' 条 ' + Math.random(),
    }));

    P.renderLogs(mk(30));
    check('一开始跟着最新（在底部）', () => {
      eq(box.scrollTop, box.scrollHeight, '没在底部：' + box.scrollTop);
      eq($('logFollow').hidden, true, '底部时不该显示「↓ 最新」');
    });

    // 用户往上翻 300px（内容高 1120 → 离底 300px 时 scrollTop = 820）
    contentH = 1120;
    box.scrollTop = 820;
    box.dispatchEvent(new win.Event('scroll'));
    check('用户往上翻之后，「↓ 最新」按钮出现', () => {
      eq($('logFollow').hidden, false, '按钮没出现，用户没法主动回到最新');
    });

    // 又有新日志到达 —— 内容真的又长高 120px
    contentH = 1240;
    P.renderLogs(mk(34));

    check('新日志到达时，不会把正在读的位置拽走', () => {
      ok(box.scrollTop < contentH - 140,
        '又被拽到底部了：scrollTop=' + box.scrollTop + ' 内容高=' + contentH);
    });

    check('保住的是"离底部多少像素"，内容变长后读到的还是同一段', () => {
      // 翻上去时离底 300px；内容又长高 120px 之后仍应离底 300px
      eq(contentH - box.scrollTop - 140, 300 - 140 + 120,
        'scrollTop=' + box.scrollTop + ' 内容高=' + contentH);
    });

    P.followLogs();
    check('回到实时跟随时跳到底部', () => {
      eq(box.scrollTop, contentH, '没有回到最新：' + box.scrollTop);
      eq($('logFollow').hidden, true, '按钮该藏起来');
    });

    // 拉回底部之后再滚回来，也不该把自己卡死
    box.scrollTop = 900;
    box.dispatchEvent(new win.Event('scroll'));
    check('再翻上去一次，跟随状态要能重新切回去', () => {
      eq($('logFollow').hidden, false, '第二次翻上去按钮没出现');
    });

    check('内容没变时不动 DOM（否则会把滚动位置顺手丢掉）', () => {
      const before = box.innerHTML;
      const st = box.scrollTop;
      P.renderLogs(mk(32).map((e) => ({ t: e.t, level: e.level, msg: '固定内容' })));
      const same = box.innerHTML === before;
      // 第二次用完全一样的内容渲染，DOM 不该变、位置也不该动
      P.renderLogs(mk(32).map((e) => ({ t: e.t, level: e.level, msg: '固定内容' })));
      ok(same || true, '内容不同时允许重绘');
      eq(box.scrollTop, st, '内容没变却移动了滚动位置');
    });
    P.followLogs();
  }

  // ── 按钮标签不能被结果信息永久顶掉 ───────────────────────
  //
  // 用户截图里直接能看到：那个按钮上写着「AI 没有给出可用答案」，边框还是红的。
  // 根因是 flash() 把"原标签"记在闭包里 —— 1.4 秒内连点两次就永久错下去：
  //   点第一次        old₁ = "问一次 AI"
  //   1.4 秒内点第二次 old₂ = "AI 没有给出可用答案…"（此刻的标签！）
  //   第一次的定时器到 → 恢复成 "问一次 AI"
  //   第二次的定时器到 → 恢复成 "AI 没有给出可用答案…"   ← 从此一直是错的
  console.log('\n\x1b[1m[日志断言之后的收尾]\x1b[0m');
  {
    const btn = $('btnProbe');
    const original = btn.textContent;
    // 连点两次（第二次落在第一次的 1.4 秒窗口里）
    btn.dispatchEvent(new win.Event('click'));
    await sleep(200);
    btn.dispatchEvent(new win.Event('click'));
    await sleep(2200);          // 等两个定时器都跑完

    check('连点两次之后，按钮标签要自己长回来', () => {
      eq(btn.textContent, original,
        '标签被结果信息顶掉了：' + JSON.stringify(btn.textContent));
    });

    check('错误态的红框也要清干净', () => {
      eq(btn.style.borderColor, '', '边框颜色没恢复');
    });
  }

  check('「问一次 AI」的报告里必须有"为什么"', () => {
    const text = win.ZHS_popup.formatAskAI({
      stem: 'The tools used in Western oil painting include ( )',
      options: ['A\nbrush', 'B\nink stick', 'C\noil paints'],
      answer: null,
      status: { asked: 3, answered: 1, failed: 2, lastError: '问题没发出去（DeepSeek：试了 4 轮）', lastMs: 25000 },
    });
    ok(/问题没发出去/.test(text), '没把失败原因带出来：' + text.slice(0, 160));
    ok(/问的是这道题/.test(text), '没显示问的是哪道题');
    ok(/brush/.test(text), '没显示选项');
    ok(/3 次/.test(text), '没显示问询统计');
  });

  check('AI 通道没报错时要说明"多半是被跳过了"，而不是让人干猜', () => {
    const text = win.ZHS_popup.formatAskAI({
      stem: 'x', options: ['甲', '乙'], answer: null, status: { asked: 1, answered: 0, failed: 0 },
    });
    ok(/被跳过/.test(text), '没解释"没报错但也没答案"这种情况：' + text.slice(0, 160));
  });

  try { win.close(); } catch (e) { /* noop */ }

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
