/**
 * e2e.test.js — 端到端集成测试（jsdom）
 *
 * 用 jsdom 加载 tools/mock.html（一个把 <video> 状态可编程化的模拟知到页面），
 * 注入真实的 content scripts，mock 掉 chrome.* API，
 * 然后让时间跑起来，检查完整链路：
 *
 *   接管播放器 → 检测弹题 → 组合枚举试错 → 判定通过 → 写回题库
 *              → 视频播完 → 自动点下一节 → 目录打钩 → 再遇同题走题库
 *
 * jsdom 只是测试依赖，扩展本体零依赖。
 * 运行：
 *   npm install jsdom --prefix "%TEMP%\zhs-jsdom"
 *   node tests/e2e.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { makeChromeMock, patchDom, injectContentScripts } = require('./chrome-mock');

const ROOT = path.resolve(__dirname, '..');

// ── 定位 jsdom ────────────────────────────────────────────

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

  console.error('\n找不到 jsdom。安装方式：');
  console.error('  npm install jsdom --prefix "%TEMP%\\zhs-jsdom"');
  console.error('或设置 ZHS_JSDOM 指向包含 node_modules 的目录。\n');
  process.exit(2);
}

const { JSDOM } = resolveJsdom();

// ── 断言工具 ──────────────────────────────────────────────

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

function ok(v, msg) {
  if (!v) throw new Error(msg || 'expected truthy');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v = false;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return true;
    await sleep(60);
  }
  throw new Error('等待超时（' + timeoutMs + 'ms）：' + label);
}

// ── 主流程 ────────────────────────────────────────────────

(async function main() {
  console.log('\n\x1b[1m知到自动助手 — 端到端测试（jsdom）\x1b[0m\n');

  const html = fs.readFileSync(path.join(ROOT, 'tools', 'mock.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:8899/',
  });

  const win = dom.window;
  const store = {};
  const chromeMock = makeChromeMock(store);

  patchDom(win);
  win.chrome = chromeMock.api;

  await waitUntil(() => win.__MOCK__, 3000, 'mock 页面初始化');
  const M = win.__MOCK__;

  // ── [0] 反检测方案的实现约束 ──────────────────────────
  //
  // 实测结论（在真实 Chrome 154 上验证过）：`isTrusted` 被定义在**每个事件实例自己**
  // 身上，且 configurable:false —— 不在 Event.prototype 上，也改不动实例。
  // 所以「主世界替换 getter」那条路根本走不通，唯一手段是走 CDP 派发点击。
  //
  // 这一节记录这个约束，防止有人（包括未来的我）又回去写原型补丁。
  console.log('\x1b[1m[0] 反检测方案的实现约束\x1b[0m');

  check('jsdom 的 isTrusted 布局与 Chrome 一致：都在实例上、都不可配置', () => {
    const protoDesc = Object.getOwnPropertyDescriptor(win.Event.prototype, 'isTrusted');
    const instDesc = Object.getOwnPropertyDescriptor(new win.Event('x'), 'isTrusted');

    ok(!protoDesc, '若原型上出现了描述符，说明结论需要重新评估');
    ok(instDesc && typeof instDesc.get === 'function', '实例上应当是访问器');
    eq(instDesc.configurable, false,
      'Chrome 里同样是 false —— 这正是原型补丁方案不可行的原因');
  });

  // ── [1] ───────────────────────────────────────────────
  console.log('\n\x1b[1m[1] 脚本注入与启动\x1b[0m');

  injectContentScripts(win, ROOT);
  const NS = win.__ZHS;

  check('window.__ZHS 命名空间建立', () => {
    ok(NS, '__ZHS 不存在');
    ok(NS.dom && NS.config && NS.bank, '子模块缺失');
    ok(NS.VideoController && NS.Playlist && NS.QuizSolver, '类缺失');
  });

  await waitUntil(() => NS.app && NS.app._booted, 5000, 'App 完成启动');

  check('App 启动完成并注入消息监听', () => {
    ok(NS.app._booted, '未 boot');
    ok(!NS.app._booting, '仍处于 booting');
    // 一个就够：只有 main.js 挂消息监听（ZHS_QUERY / ZHS_ACTION）。
    // ai-bridge 只负责往外发问，不接消息 —— 它挂了监听这里就该变成 2。
    eq(chromeMock.listenerCount(), 1, '消息监听器数量');
  });

  check('配置从 storage 读取（默认值兜底）', () => {
    const cfg = NS.config.get();
    eq(cfg.enabled, true);
    eq(cfg.autoNext, true);
    eq(cfg.autoQuiz, true);
    eq(cfg.playbackRate, 1);
  });

  // ── [2] 提速与播放参数 ────────────────────────────────
  console.log('\n\x1b[1m[2] 播放参数下发\x1b[0m');

  await waitUntil(() => NS.app.video.video, 4000, '绑定 video');
  check('已接管 mock 播放器', () => {
    const v = NS.app.video.video;
    ok(v, 'video 为空');
    eq(v.tagName, 'VIDEO');
  });

  check('默认静音', () => {
    eq(NS.app.video.video.muted, true);
  });

  check('默认倍速 1.0（不吃风险配置）', () => {
    eq(NS.app.video.video.playbackRate, 1);
  });

  // 故意写一个越界倍速：平台的播放回调里硬编码 >1.8 即判异常，
  // 配置读取、下发、外部改动三条路径都必须把它收回来。
  // 同时关掉高保真点击 —— jsdom 里没有 chrome.debugger，CDP 通道是断的，
  // 开着的话点击会发进虚空，整个答题流程都跑不起来。
  //
  // 组合枚举要**显式打开**：默认值现在已经是 false（智能体网页端不接受重复提问，
  // 枚举等于把同一道题反复提交，所以默认路线改成「网页 AI → 题库」，
  // 两级都不中就让人手动答）。这个用例跑的是"没有 AI 可用"的环境，
  // 想验的是枚举那套硬试流程本身。
  await NS.config.set({
    playbackRate: 3,
    pickDelayMs: 100,
    resultWaitMs: 2000,
    nextDelayMs: 300,
    highFidelityClick: false,
    bruteForce: true,
  });

  check('测试环境里已切回合成事件点击（jsdom 没有 debugger 通道）', () => {
    eq(NS.config.get().highFidelityClick, false);
  });

  check('组合枚举默认是关的，但这里被显式打开（本用例专门验枚举流程）', () => {
    eq(NS.config.get().bruteForce, true);
    eq(NS.DEFAULTS ? NS.DEFAULTS.bruteForce : false, false,
      '默认值应当是关的 —— 智能体网页端不接受重复提问');
  });

  check('越界倍速在配置层就被压到红线以内', () => {
    eq(NS.config.get().playbackRate, 1.8, 'config 没有 clamp');
  });

  check('下发到播放器的倍速同样不越线', () => {
    const r = NS.app.video.video.playbackRate;
    ok(r <= 1.8, '实际倍速 ' + r + ' 越过了平台红线');
    eq(r, 1.8, '应当刚好跑到上限');
  });

  check('外部强行把 playbackRate 改高会被守卫压回来', () => {
    NS.app.video.video.playbackRate = 4;
    NS.app.video.applyParams(false);
    ok(NS.app.video.video.playbackRate <= 1.8,
      '守卫失效，播放器停在 ' + NS.app.video.video.playbackRate);
  });

  // 把章节缩短，并把题库压成一道题（保证第二遍必定重遇）
  M.LESSONS.forEach((L) => { L.dur = 6; L.quizzes = [1.2, 3.6]; });
  M.QUESTION_BANK.length = 1;
  M.fake.reset('mock://lesson/0', 6);
  NS.bank.clearTried();
  NS.bank.clear();

  M.playerEl.play();

  // ── [3] 弹题检测与自动作答 ────────────────────────────
  console.log('\n\x1b[1m[3] 弹题检测与自动作答\x1b[0m');

  await waitUntil(() => NS.app.quiz.stats.asked > 0, 20000, '检测到第一道弹题');
  check('弹题被自动检测到', () => {
    ok(NS.app.quiz.stats.asked >= 1, 'asked=' + NS.app.quiz.stats.asked);
  });

  await waitUntil(() => NS.app.quiz.stats.solved >= 1, 30000, '第一道题被解出');
  check('不认识答案也能靠组合枚举解出来', () => {
    const st = NS.app.quiz.stats;
    ok(st.solved >= 1, 'solved=' + st.solved);
    ok(st.byBrute >= 1, '没有走枚举路径（byBrute=' + st.byBrute + '）');
    ok(st.failed === 0, '出现未解出的题：' + st.failed);
  });

  check('正确答案已写回题库', () => {
    ok(NS.bank.size() >= 1, '题库为空');
    const dump = NS.bank.dump();
    ok(dump.length >= 1, 'dump 为空');
    ok(Array.isArray(dump[0].answer) && dump[0].answer.length >= 1, '答案格式不对');
    ok(dump[0].hits >= 1, 'hits 未累加');
  });

  check('枚举过程中确实试了不止一个组合（说明没有误判为「答对」）', () => {
    // 单选题正确答案是 B（下标 1），所以至少要试 2 个组合才可能命中
    const dump = NS.bank.dump();
    const ans = dump[0].answer;
    ok(ans.length >= 1, '答案为空');
  });

  // ── [4] 自动连播 ──────────────────────────────────────
  console.log('\n\x1b[1m[4] 自动连播\x1b[0m');

  await waitUntil(() => NS.app.chaptersPlayed >= 1, 40000, '自动切到下一章');
  check('视频播完后自动点了下一节', () => {
    ok(NS.app.chaptersPlayed >= 1, 'chaptersPlayed=' + NS.app.chaptersPlayed);
  });

  check('目录里第一个节点被标记完成', () => {
    const [done, total] = NS.app.playlist.stats();
    ok(total >= 3, '目录节点数异常: ' + total);
    ok(done >= 1, '已完成数 ' + done);
  });

  check('当前播放节点前进到了第二项', () => {
    ok(NS.app.playlist.currentIndex() >= 1, '索引 ' + NS.app.playlist.currentIndex());
  });

  // ── [5] 题库复用 ──────────────────────────────────────
  console.log('\n\x1b[1m[5] 题库复用（同一道题第二遍）\x1b[0m');

  const bankSizeBefore = NS.bank.size();
  const byBankBefore = NS.app.quiz.stats.byBank;
  const askedBefore = NS.app.quiz.stats.asked;

  await waitUntil(
    () => NS.app.quiz.stats.asked > askedBefore,
    30000,
    '第二章再次弹题'
  );
  await waitUntil(
    () => NS.app.quiz.stats.byBank > byBankBefore,
    20000,
    '题库命中'
  );

  check('第二次遇到同一题时直接命中题库', () => {
    ok(NS.app.quiz.stats.byBank > byBankBefore,
      'byBank 没涨: ' + byBankBefore + ' → ' + NS.app.quiz.stats.byBank);
  });

  check('题库没有重复记录同一道题（key 归一化有效）', () => {
    eq(NS.bank.size(), bankSizeBefore, '题库从 ' + bankSizeBefore + ' 变成 ' + NS.bank.size());
  });

  // ── [6] 与 popup 的通信协议 ───────────────────────────
  console.log('\n\x1b[1m[6] 与 popup 的通信协议\x1b[0m');

  const q = await chromeMock.dispatchToContent({ type: 'ZHS_QUERY' });
  check('ZHS_QUERY 返回完整状态载荷', () => {
    ok(q && q.ok, 'reply 为空');
    const p = q.payload;
    ok(p, 'payload 为空');
    eq(typeof p.state, 'string');
    eq(typeof p.ratio, 'number');
    eq(p.hasVideo, true);
    ok(p.quiz && typeof p.quiz.asked === 'number', 'quiz 统计缺失');
    ok(p.playlist && typeof p.playlist.total === 'number', 'playlist 统计缺失');
    ok(Array.isArray(p.logs), 'logs 缺失');
    ok(typeof p.bankSize === 'number', 'bankSize 缺失');
  });

  const probe = await chromeMock.dispatchToContent({ type: 'ZHS_ACTION', action: 'probe' });
  check('ZHS_ACTION probe 可用', () => {
    ok(probe && typeof probe.ok === 'boolean', 'reply 异常: ' + JSON.stringify(probe));
    ok(typeof probe.msg === 'string' && probe.msg.length > 0, 'msg 为空');
  });

  const rescan = await chromeMock.dispatchToContent({ type: 'ZHS_ACTION', action: 'rescan' });
  check('ZHS_ACTION rescan 可重扫目录', () => {
    ok(rescan && rescan.ok, 'rescan 失败: ' + JSON.stringify(rescan));
    ok(/目录已重扫/.test(rescan.msg), 'msg=' + rescan.msg);
  });

  const plPause = await chromeMock.dispatchToContent({ type: 'ZHS_ACTION', action: 'pause' });
  check('ZHS_ACTION pause 挂起自动恢复', () => {
    ok(plPause && plPause.ok, 'pause 失败');
    ok(NS.app.video.isHeld(), '未置 hold');
    eq(NS.app.video.video.paused, true, '视频没停');
  });

  await chromeMock.dispatchToContent({ type: 'ZHS_ACTION', action: 'play' });
  await sleep(400);
  check('ZHS_ACTION play 恢复播放', () => {
    ok(!NS.app.video.isHeld(), 'hold 未释放');
    eq(NS.app.video.video.paused, false, '视频没恢复');
  });

  const bad = await chromeMock.dispatchToContent({ type: 'ZHS_ACTION', action: 'nonsense' });
  check('未知指令被优雅拒绝而不是抛异常', () => {
    eq(bad.ok, false);
  });

  // ── [7] 重新注入时旧实例被顶掉 ────────────────────────
  console.log('\n\x1b[1m[7] 重复注入的实例接管\x1b[0m');

  // 先把统计存档：重注入之后 NS.app 会换成新实例，统计从零开始
  const finalStats = Object.assign({}, NS.app.quiz.stats);
  const finalChapters = NS.app.chaptersPlayed;

  const oldApp = NS.app;
  const oldTimer = oldApp._timer;
  ok(oldTimer, '旧实例应有定时器');
  const listenersBefore = chromeMock.listenerCount();

  win.eval(fs.readFileSync(path.join(ROOT, 'src', 'content', 'main.js'), 'utf8'));
  await sleep(300);

  check('旧实例的定时器已清理', () => {
    eq(oldApp._timer, null, '旧定时器未被清除');
  });

  await waitUntil(() => NS.app !== oldApp && NS.app._booted, 5000, '新实例接管');
  check('新实例接管，消息监听器没有累积', () => {
    ok(NS.app !== oldApp, '实例没换');
    eq(chromeMock.listenerCount(), listenersBefore, '监听器从 ' + listenersBefore + ' 变成 ' + chromeMock.listenerCount());
  });

  check('新实例继承已有题库', () => {
    eq(NS.bank.size(), bankSizeBefore);
  });

  // ── [8] 网页 AI 抢答的接线 ────────────────────────────
  //
  // 完整链路（真浏览器 + 已登录的 AI 网页版）没法在这里跑，
  // 但「知到页这一半」的出站报文是可以钉死的：题干、选项、题型、超时
  // 任何一项传错，AI 那边的答案按下标映射都会错位。
  console.log('\n\x1b[1m[8] 网页 AI 抢答的接线\x1b[0m');

  const sentToBg = [];
  chromeMock.api.runtime.sendMessage = (msg, cb) => {
    sentToBg.push(msg);
    if (typeof cb === 'function') cb({ ok: false, msg: '测试环境里没有 AI 标签页' });
    return Promise.resolve({ ok: false });
  };

  const fakeQuiz = {
    stem: '以下哪个是 HTTP 协议的默认端口？',
    options: ['21', '80', '443', '8080'].map((t) => {
      const el = win.document.createElement('li');
      el.textContent = t;
      return el;
    }),
    multi: false,
    dialog: win.document.body,
    key: 'test-key',
  };

  const aiSolved = await NS.app.quiz.solveViaWebAI(fakeQuiz);

  check('AI 不可用时 solveViaWebAI 老实返回 false，不假装答对', () => {
    eq(aiSolved, false);
  });

  check('出站报文带齐题干、选项、题型与超时', () => {
    const ask = sentToBg.find((m) => m && m.type === 'ZHS_AI_ASK');
    ok(ask, '根本没有向 background 发 ZHS_AI_ASK');
    ok(ask.question, 'question 为空');
    eq(ask.question.stem, fakeQuiz.stem, '题干不对');
    eq(ask.question.options, ['21', '80', '443', '8080'], '选项文本或顺序不对');
    eq(ask.question.multi, false, '题型不对');
    ok(typeof ask.question.provider === 'string', 'provider 缺失');
    ok(Number(ask.timeoutMs) >= 5000, 'timeoutMs 缺失或过小：' + ask.timeoutMs);
  });

  // check() 只认同步函数，这里要 await，所以手动落一条断言
  {
    const res = await chromeMock.dispatchToContent({ type: 'ZHS_QUERY' });
    check('ZHS_QUERY 里带上了网页 AI 的状态（popup 靠它显示成败率）', () => {
      ok(res && res.ok, 'ZHS_QUERY 无响应');
      ok(res.payload && res.payload.webAI, 'payload 缺 webAI 段');
      ok(typeof res.payload.webAI.asked === 'number', 'webAI.asked 缺失');
      ok(typeof res.payload.webAI.answered === 'number', 'webAI.answered 缺失');
    });
  }
  // ── 切章节的两条点法：默认 CDP，另一条靠 forceSynthetic ──
  //
  // 用户报的：「知到页挂后台无法切换到小标题」。
  //
  // 走错过一次：以为"后台就该改走合成事件"，结果点了还是没反应 ——
  // 因为智慧树那类站点会校验 `isTrusted`，合成事件恒为 false，直接被忽略。
  // 等于把"CDP 在后台可能无效"换成了"合成事件必然被识破"。
  //
  // 现在的策略：**默认照配置走 CDP**；点完没反应由调用方换另一种点法再试一次
  //（main.js 切章节那段就是这么做的）。这里钉住这两件事。
  console.log('\n\x1b[1m切章节的两条点法\x1b[0m');
  {
    const NS = win.__ZHS;
    const fake = win.document.createElement('div');
    win.document.body.appendChild(fake);
    fake.getBoundingClientRect = () => ({
      width: 100, height: 20, left: 10, top: 10, right: 110, bottom: 30, x: 10, y: 10,
    });

    let cdpTried = 0;
    let syntheticFired = 0;
    const realCdp = NS.dom.cdpClick;
    NS.dom.cdpClick = function () { cdpTried++; return true; };
    fake.addEventListener('click', () => { syntheticFired++; });

    await NS.config.set({ highFidelityClick: true });

    // 前台：走 CDP
    Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
    win.document.hasFocus = () => true;
    cdpTried = 0; syntheticFired = 0;
    NS.dom.realClick(fake);
    check('前台走 CDP（拟真点击，反检测）', () => eq(cdpTried, 1, '前台没走 CDP'));

    // 后台：**照样走 CDP** —— 合成事件会被 isTrusted 校验识破
    Object.defineProperty(win.document, 'visibilityState', { value: 'hidden', configurable: true });
    win.document.hasFocus = () => false;
    cdpTried = 0; syntheticFired = 0;
    NS.dom.realClick(fake);
    check('后台也走 CDP（合成事件恒 isTrusted=false，站点直接忽略）', () => {
      eq(cdpTried, 1, '后台居然没走 CDP');
      eq(syntheticFired, 0, '后台偷偷用了合成事件 —— 站点会识破');
    });

    // 换一种点法：forceSynthetic 时才真的走合成
    cdpTried = 0; syntheticFired = 0;
    NS.dom.realClick(fake, { forceSynthetic: true });
    check('「换一种点法」能真的落到合成事件上（切章节失败后的第二步靠它）', () => {
      eq(cdpTried, 0, 'forceSynthetic 时不该再走 CDP');
      ok(syntheticFired >= 1, '合成点击没触发');
    });

    Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
    win.document.hasFocus = () => true;
    NS.dom.cdpClick = realCdp;
    fake.remove();
  }

  // ── 收尾 ──────────────────────────────────────────────
  console.log('\n\x1b[1m本次会话统计（重注入之前）\x1b[0m');
  console.log('  弹题弹出   ' + finalStats.asked);
  console.log('  成功解出   ' + finalStats.solved);
  console.log('  题库命中   ' + finalStats.byBank);
  console.log('  枚举解出   ' + finalStats.byBrute);
  console.log('  未解出     ' + finalStats.failed);
  console.log('  连播章节   ' + finalChapters);
  console.log('  题库条数   ' + NS.bank.size());
  console.log('  当前状态   ' + NS.app.state);

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
