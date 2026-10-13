/**
 * ai-tier.test.js — 网页 AI 抢答那一级的端到端验证（jsdom）
 *
 * 这条链路横跨三个上下文，全链路要真浏览器 + 真登录才跑得通，
 * 但「知到页这一半」是可以离线钉死的：
 *
 *   弹题 → 问 AI → 用 AI 给的组合作答 → 判定通过 → 记入题库 → 统计落在 byAI
 *
 * 在这里把 background + AI 标签页整个替换成一个假的 bridge.ask，
 * 于是要验证的就是解题器自己的行为：什么情况下信 AI、什么情况下不信。
 *
 * 运行： node tests/ai-tier.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { makeChromeMock, patchDom, injectContentScripts } = require('./chrome-mock');

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
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '  got=' + sa + ' want=' + sb);
}

function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v = false;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return true;
    await sleep(50);
  }
  throw new Error('等待超时（' + timeoutMs + 'ms）：' + label);
}

(async function main() {
  console.log('\n\x1b[1m知到自动助手 — 网页 AI 抢答一级\x1b[0m\n');

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

  injectContentScripts(win, ROOT);
  const NS = win.__ZHS;

  await waitUntil(() => NS.app && NS.app._booted, 5000, 'App 启动');

  // 真货备份：后面几节会把 NS.aiBridge.ask 换成桩来数问询次数，
  // 换回来必须靠这个 —— 否则最后一节的"形状自检"又会测到桩上去。
  const ORIGINAL_ASK = NS.aiBridge.ask;

  // ── 场景装配 ────────────────────────────────────────────
  //
  // 题库清空、枚举关掉：这一轮只允许 AI 这一条路成功，
  // 否则「AI 答对了」的结论会跟枚举命中混在一起，证不了什么。
  await NS.config.set({
    highFidelityClick: false,     // jsdom 没有 debugger 通道
    pickDelayMs: 60,
    resultWaitMs: 1500,
    autoNext: false,              // 这一轮只看答题，不要切集来干扰
    useBank: false,
    askWebAI: true,
    bruteForce: false,
    learnAnswers: true,
    verboseLog: true,
  });

  M.QUESTION_BANK.length = 0;
  M.QUESTION_BANK.push({
    stem: '在 TCP 三次握手中，客户端发送的第一个报文段的标志位是？',
    options: ['ACK', 'SYN', 'FIN', 'RST'],
    answer: [1],
    multi: false,
  });
  M.LESSONS.forEach((L) => { L.dur = 40; L.quizzes = [1.5]; });
  M.fake.reset('mock://lesson/0', 40);
  NS.bank.clearTried();
  NS.bank.clear();

  // 假的 AI 通道：记录问了什么，然后按「查表」回答，模拟一次真实往返。
  const asked = [];
  const TRUTH = M.QUESTION_BANK[0];
  let inflight = 0;              // 「已经问出去、还没回来」的次数
  NS.aiBridge = {
    __ready: true,
    async ask(q) {
      asked.push({ ...q, stack: new Error('ask-trace').stack });
      inflight++;
      try {
        await sleep(250);        // 真链路里这一步是十几秒
        return TRUTH.answer.slice();
      } finally {
        inflight--;
      }
    },
    async probe() { return { ok: true, fake: true }; },
    getStatus() { return { asked: asked.length, answered: asked.length, failed: 0 }; },
  };

  // 知到弹出的题干会带题型前缀（见 mock 页的 quizStem 渲染），
  // 真实站点上也可能带，所以断言按「包含」比对而不是全等。
  const stemHasTruth = (s) => String(s || '').includes(TRUTH.stem);

  M.playerEl.play();

  // ── [1] 解题路径 ───────────────────────────────────────
  console.log('\x1b[1m[1] 弹题交给 AI 作答\x1b[0m');

  await waitUntil(() => NS.app.quiz.stats.asked > 0, 20000, '检测到弹题');
  await waitUntil(() => NS.app.quiz.stats.solved >= 1, 30000, 'AI 答案被判定通过');

  check('弹题被检测到并解出', () => {
    const st = NS.app.quiz.stats;
    ok(st.asked >= 1, 'asked=' + st.asked);
    ok(st.solved >= 1, 'solved=' + st.solved);
    eq(st.failed, 0, '不该有未解出的题');
  });

  check('解出路径统计落在 byAI，而不是 byBrute', () => {
    const st = NS.app.quiz.stats;
    ok(st.byAI >= 1, 'byAI=' + st.byAI + ' —— AI 这一级没被走到');
    eq(st.byBrute, 0, '枚举被误触发：byBrute=' + st.byBrute);
    eq(st.byBank, 0, '题库被误触发：byBank=' + st.byBank);
  });

  check('问 AI 时带上了完整的题干与选项', () => {
    eq(asked.length >= 1, true, '根本没问过 AI');
    const q = asked[0];
    ok(stemHasTruth(q.stem), '题干不对：' + q.stem);
    // 选项文本按顺序一一对应即可。真实页面上选项元素里还带着字母标签
    // （mock 页渲染成 "A" 标签 + "ACK"，所以 textOf 出来是 "AACK"），
    // AI 是按下标回答的，只要顺序不错位就不影响。
    eq(q.options.length, TRUTH.options.length, '选项个数不对');
    TRUTH.options.forEach((t, i) => {
      ok(String(q.options[i]).includes(t),
        '第 ' + (i + 1) + ' 个选项不对：' + q.options[i] + ' 里没有 ' + t);
    });
    eq(q.multi, false, '题型没传对');
  });

  check('AI 答对之后写进了题库', () => {
    ok(NS.bank.size() >= 1, '题库为空');
    const dump = NS.bank.dump();
    const rec = dump.find((d) => stemHasTruth(d.stem));
    ok(rec, '题库里没有这道题：' + JSON.stringify(dump.map((d) => d.stem)));
    eq(rec.answer, [1], '记下的答案不对');
  });

  // ── [2] 题库优先于 AI ──────────────────────────────────
  //
  // 这一条不重跑整页，而是直接打在解题器的判据上：
  // 「AI 给的组合此前已经试过」就必须立刻落回枚举，不能白等一次十几秒的问询。
  // 顺带守住一个反例：**没试过**的组合必须照常去问。
  console.log('\n\x1b[1m[2] 同一道题第二次弹出来：AI 那次已经试过，就不再问\x1b[0m');

  const stemWithTag = '【单选题】' + TRUTH.stem;   // 知到弹出的题干带着题型前缀
  const bankedKey = NS.bank.keyOf(stemWithTag, TRUTH.options.length, false);

  // 直接构造题目对象。
  //
  // dialog 是**换了类名**的选项容器（不带 el-dialog / subject_node_item 这类特征），
  // 所以 quiz.detect() 的评分拿不到分 —— [3] 那一类"重启状态机"的段里，
  // 主循环不会把它当成当前弹题来解，测的仍是 mock 页的真题。
  // 但它带 subject_describe（题干候选）和类名含 answer 的子容器（选项候选），
  // 所以 solve() 自己走 attempt() 时能找到选项、能正常记账。
  function makeFakeQuiz(stemText) {
    const stem = stemText || stemWithTag;
    const dialog = win.document.createElement('div');
    dialog.dataset.zhsTest = '1';
    dialog.textContent = stem;
    win.document.body.appendChild(dialog);
    const list = win.document.createElement('div');
    list.className = 'zhs-test-list';
    dialog.appendChild(list);
    const options = TRUTH.options.map((t) => {
      const li = win.document.createElement('li');
      li.className = 'answer-node';
      li.textContent = t;
      list.appendChild(li);
      return li;
    });
    return {
      dialog,
      options,
      submit: null,
      stem,
      multi: false,
      key: NS.bank.keyOf(stem, options.length, false),
      videoWasPlaying: false,
      detectedAt: Date.now(),
    };
  }

  /** 清掉造出来的临时节点，别留在页面上 */
  function scrubFakeQuizzes() {
    win.document.querySelectorAll('[data-zhs-test]').forEach((el) => el.remove());
  }

  // 先把「上一轮」彻底排干，再开始下面两段定向断言。
  //
  // 为什么必须排干：知到答对后弹窗还会在页面上停 1.6 秒展示「回答正确」，
  // 主循环这期间仍能 detect 到它并**再解一次同一道题**；而下面两段是
  // 直接调用解题器的定点断言，混进这些回声问询就测不准了。
  // 做法：停掉主实例 → 等「问询数 / 弹题数」连续 1.5 秒不动（说明在途的都收尾了）
  //      → 清零计数。只 sleep 固定时长是不够的：答对的展示期 + 冷却期叠加起来
  //      能拖到十秒以上。
  await sleep(1500);
  NS.app.destroy();
  M.playerEl.pause();
  M.LESSONS[1].quizzes = [];
  M.fake.reset('mock://lesson/1', 40);

  {
    const t0 = Date.now();
    let last = -1;
    let stableSince = Date.now();
    while (Date.now() - t0 < 25000) {
      // inflight 必须一起看：一次问询的 250ms 里 asked 已经 +1 而
      // stats.asked 还没动，只看计数会在"看起来静止"的瞬间误判为排干了。
      const snap = asked.length + ':' + NS.app.quiz.stats.asked + ':' + inflight;
      if (snap !== last) {
        last = snap;
        stableSince = Date.now();
      } else if (Date.now() - stableSince > 1500) {
        break;
      }
      await sleep(200);
    }
  }
  asked.length = 0;

  // 先跑一次导出问询：AI 给出 [1]，因为本地没有别的选项记录，这一轮会真的提交
  // （提交到的是我造的题目对象上，mock 页不认识它，所以判定会超时——这不影响下面的断言）
  await NS.config.set({ resultWaitMs: 300 });
  NS.bank.clearTried();
  const firstPass = await NS.app.quiz.solveViaWebAI(makeFakeQuiz());
  eq(firstPass, false, '题目对象没接在真的弹窗上，这里不该返回 true');
  eq(asked.length, 1, '第一轮应当问了一次 AI，实际 ' + asked.length);

  // 现在模拟「平台答错 → 视频回退 → 同一题再弹」：组合已被记进 tried
  eq(NS.bank.hasTried(bankedKey, TRUTH.answer), true,
    'AI 给的组合应当已被标记为试过（这是 platform 判错后回到这里的路径）');

  const solvedAlreadyTried = await NS.app.quiz.solveViaWebAI(makeFakeQuiz());
  eq(asked.length, 1, '上一轮已知是错的答案，不该再去问一次（少等十几秒）');
  eq(solvedAlreadyTried, false, '应当直接落回枚举');

  // 反例：换一道没问过的题，必须照常问
  const solvedFresh = await NS.app.quiz.solveViaWebAI(makeFakeQuiz('【单选题】另一道还没问过的题？'));
  eq(asked.length, 2, '没问过的题必须照常问 AI');
  eq(solvedFresh, false, '假弹窗同样不会被判定通过');
  asked.length = 0;

  // ── [3] AI 答错：退回枚举，且不重复提交同一个错误答案 ──
  console.log('\n\x1b[1m[3] AI 答错：只问一次，随后退回组合枚举\x1b[0m');

  M.LESSONS[2].quizzes = [];
  M.fake.reset('mock://lesson/2', 40);
  M.playerEl.pause();

  // 清掉上一次判定留下的「回答正确」提示。
  //
  // 这个必须清：解题器的判定靠的是「提交前后页面上短提示文本的差集」，
  // 而上一次成功的提示会一直挂在 DOM 里。带着它进下一题，AI 一提交就会
  // 被这个**残影**判成通过 —— 表现出来就是「AI 明明答错了却算它答对」。
  // （真实平台不会有这问题：弹窗关掉时提示一起没了。这是 mock 页的残留。）
  const fbEl = win.document.getElementById('quizFeedback');
  fbEl.textContent = '';
  fbEl.className = 'subject_feedback';

  // 一个"会把这道题答错"的假 AI。
  //
  // 固定回一个下标是不行的：题目是 mock 页随机抽的，固定值有 1/4 的概率正好
  // 撞上正确答案，那样这一段测的就不是「退回枚举」而是「AI 答对」了。
  // 所以按选项文本反推：凡是文本与真题选项对不上的下标，就是错的。
  // （选项元素里带着字母标签，所以用 endsWith 而不是全等。）
  const askedBad = [];
  NS.aiBridge.ask = async (q) => {
    const n = (q.options || []).length;
    const wrong = [];
    for (let i = 0; i < n; i++) {
      const raw = String(q.options[i]);
      if (!TRUTH.options.some((t) => raw === t || raw.endsWith(t))) wrong.push(i);
    }
    askedBad.push({ ...q });
    await sleep(120);
    return wrong.length ? [wrong[0]] : [0];
  };

  NS.bank.clear();
  NS.bank.clearTried();

  // 这一段必须让状态机自己跑：验证的是「AI 答错之后它会不会继续把题解出来」，
  // 而"继续"这件事只有主循环能做。前面为了做定点断言把实例停了，这里重新起一个。
  M.LESSONS[1].quizzes = [1.5];
  await NS.config.set({ useBank: false, bruteForce: true, maxComboSize: 3, resultWaitMs: 1500 });
  M.fake.reset('mock://lesson/1', 40);
  scrubFakeQuizzes();
  win.eval(fs.readFileSync(path.join(ROOT, 'src', 'content', 'main.js'), 'utf8'));
  await waitUntil(() => NS.app && NS.app._booted, 5000, '新实例接管');
  // 新实例会接着用同一个解题器模块，把上一段的会话记忆清掉，
  // 否则「上一轮 AI 给过什么」会跨段生效，测出来的就不是本段的行为
  NS.app.quiz.clearPassed();

  const byBruteBefore = NS.app.quiz.stats.byBrute;
  const aiSolvedBefore = NS.app.quiz.stats.byAI;
  const askedCountBefore = NS.app.quiz.stats.asked;

  M.playerEl.play();

  await waitUntil(() => NS.app.quiz.stats.solved >= 1 ||
    NS.app.quiz.stats.failed >= 1, 60000, '本题有结论');

  check('AI 给了错答案后，这道题只问了一次', () => {
    const forThisQuestion = askedBad.filter((q) => String(q.stem).includes(TRUTH.stem));
    ok(forThisQuestion.length >= 1, '压根没问');
    eq(forThisQuestion.length, 1,
      '问了 ' + forThisQuestion.length + ' 次 —— AI 答错后不该再重试');
  });

  // 这一段刻意不去断言 byBrute 涨没涨：
  // mock 页的弹题是随机抽的，而"哪一次提交被判对"受它的判定时序影响，
  // 盯着统计数字容易测出跟被测代码无关的红。
  // 要证明的事只有一件 —— **AI 那一次失败之后，流程继续往下走了**，
  // 而它只能靠组合枚举往下走。所以看 tried 集合里到底攒了几种组合：
  // 只有 AI 那一个组合 ⇒ 卡住了；攒出第二个 ⇒ 确实在枚举。
  check('AI 失败后流程继续，组合枚举确实接着在试', () => {
    const q = askedBad.find((x) => String(x.stem).includes(TRUTH.stem)) || {
      stem: stemWithTag, options: TRUTH.options, multi: false,
    };
    const key = NS.bank.keyOf(q.stem, q.options.length, q.multi);
    ok(NS.bank.triedCount(key) >= 2,
      '只试过 ' + NS.bank.triedCount(key) + ' 种组合 —— AI 失败后没有继续枚举');
  });

  check('本题有结论（解出或明确放弃），没有卡在等待上', () => {
    const st = NS.app.quiz.stats;
    eq(st.solved + st.failed >= 1, true,
      'solved=' + st.solved + ' failed=' + st.failed);
  });

  check('AI 给错的那个组合被记进「已试过」，枚举不会重复提交', () => {
    const q = askedBad.find((x) => String(x.stem).includes(TRUTH.stem));
    ok(q, '这一轮没问到那道题');
    const key = NS.bank.keyOf(q.stem, q.options.length, q.multi);
    // AI 给的那个错答案必须已经在 tried 里；
    // 否则枚举第一轮就会把它再提交一次，白挨一次判错。
    let marked = false;
    for (let i = 0; i < q.options.length; i++) {
      if (NS.bank.hasTried(key, [i]) && !TRUTH.answer.includes(i)) marked = true;
    }
    ok(marked, 'AI 的错误答案没被标记为已试过（triedCount=' + NS.bank.triedCount(key) + '）');
  });

  // ── [5] 优先度：AI 排在题库前面 ────────────────────────
  console.log('\n\x1b[1m[5] 优先度：网页 AI 排在题库前面\x1b[0m');

  // 真实的弹题浮层才够解题器用（detect 要靠可见性、选项、提交按钮），
  // 所以这一段不造假题，直接驱动 mock 页真弹出来的那道题。
  M.LESSONS[3].quizzes = [];
  M.LESSONS[1].quizzes = [2.0];
  M.fake.reset('mock://lesson/1', 40);
  await NS.config.set({ askWebAI: true, webAIFirst: true, useBank: true, bruteForce: false });
  NS.bank.clearTried();
  NS.app.quiz.clearPassed();

  // 埋点：谁先被调用，按顺序记下来
  const callOrder = [];
  const realAsk = NS.aiBridge.ask;
  NS.aiBridge.ask = async (q) => {
    callOrder.push('AI');
    return realAsk.call(NS.aiBridge, q);
  };
  const realLookup = NS.bank.lookup;
  const realRemember = NS.bank.remember;
  NS.bank.lookup = (...a) => {
    callOrder.push('BANK');
    return realLookup.apply(NS.bank, a);
  };
  // solve() 里题库分支会真的把答案交上去；这里换成记账，好在 AI 已经答对之后
  // 断言题库那一支根本没被走到
  NS.bank.remember = (...a) => {
    callOrder.push('REMEMBER');
    return realRemember.apply(NS.bank, a);
  };

  // 先让题库里有东西 —— 它是上一段枚举解出来的
  ok(NS.bank.size() >= 0, '前提：题库读写正常');

  M.playerEl.play();
  // 这里等的是「AI 真的被问到」而不是等某道新题弹出来：
  // mock 页的浮层关掉得慢，等待期间主循环可能已经拿残留的那道题开解了；
  // 但无论是残留的还是新弹的，只要 AI 优先生效，第一个被调用的就是 AI。
  await waitUntil(() => callOrder.includes('AI'), 40000, 'AI 被问到');
  M.playerEl.pause();

  check('AI 优先时：先问 AI，题库查询排在它后面', () => {
    const ai = callOrder.indexOf('AI');
    const bank = callOrder.indexOf('BANK');
    ok(ai >= 0, '这一轮压根没问 AI —— 优先度没生效：' + JSON.stringify(callOrder));
    ok(bank < 0 || ai < bank,
      '题库排在 AI 前面了：' + JSON.stringify(callOrder));
  });

  await waitUntil(() => NS.app.quiz.stats.byAI >= 1 || NS.app.quiz.stats.failed >= 1,
    40000, '这一轮有结论');
  NS.bank.lookup = realLookup;
  NS.bank.remember = realRemember;
  NS.aiBridge.ask = realAsk;

  check('AI 答对后就不会再走题库那一支（省掉一次多余提交）', () => {
    const ai = callOrder.indexOf('AI');
    const bank = callOrder.indexOf('BANK');
    ok(ai >= 0, '没问 AI');
    ok(bank < 0 || bank > ai, 'AI 已经答对了，题库那一支还被走到了：' + JSON.stringify(callOrder));
  });

  // ── [6] 关掉「AI 优先」就回到题库优先 ─────────────────
  console.log('\n\x1b[1m[6] 关掉「AI 优先」：题库重新排在前面\x1b[0m');

  await NS.config.set({ webAIFirst: false });
  NS.bank.clearTried();
  NS.app.quiz.clearPassed();

  // 换一个解题器实例，把「上一轮 AI 给过什么」这类会话记忆一并清掉。
  // 注意不能只调 clearPassed()：那会连「刚答对」的拦截也清掉，
  // 残留的那个弹窗会被再解一次，测出来的顺序就不是干净的一轮。
  const solver2 = new NS.QuizSolver();
  solver2.setLogger((lv, m) => NS.app.log(lv, m));
  solver2.setVideo(NS.app.video);
  NS.app.quiz = solver2;

  const order2 = [];
  NS.aiBridge.ask = async (q) => { order2.push('AI'); return realAsk.call(NS.aiBridge, q); };
  NS.bank.lookup = (...a) => {
    order2.push('BANK:miss');
    return null;                      // 故意造一次未命中，好让后面真的问到 AI
  };

  // 等「两级都被走到」：题库那一级是同步记账，AI 那一级要等它真的问回来。
  // 只等 order2.length 会误判 —— 主循环反复检测同一道题时，
  // 题库那条记账会先攒够长度，而 AI 其实还没被问到。
  M.LESSONS[1].quizzes = [2.0];
  M.fake.reset('mock://lesson/1', 40);
  NS.bank.clearTried();
  M.playerEl.play();
  await waitUntil(() => order2.includes('BANK:miss') && order2.includes('AI'),
    40000, '这一轮把两级都走到');
  M.playerEl.pause();

  check('题库优先时：先查题库，再问 AI', () => {
    eq(order2[0], 'BANK:miss', '第一步应当是查题库：' + JSON.stringify(order2));
    ok(order2.slice(1).includes('AI'), '题库未命中后应当落到 AI：' + JSON.stringify(order2));
  });

  NS.bank.lookup = realLookup;
  NS.aiBridge.ask = realAsk;
  await NS.config.set({ webAIFirst: true });

  // ── [7] 关掉开关就完全不碰 AI ──────────────────────────
  console.log('\n\x1b[1m[7] 关掉「用网页版 AI 答题」后不再请求\x1b[0m');

  const askedOff = [];
  NS.aiBridge.ask = async (q) => { askedOff.push(q); return [1]; };
  await NS.config.set({ askWebAI: false, useBank: false, bruteForce: false });
  NS.bank.clear();
  NS.bank.clearTried();
  M.LESSONS[4].quizzes = [1.2];

  // 等所有在途的 solve 收尾：解题器同一时刻只受理一道题，
  // 而上一段刚好在解残留的那个弹窗 —— 不等的话这次 solve() 会被
  // "正在答题中" 直接弹回来，测不到我们想测的分支。
  await waitUntil(() => !NS.app.quiz.solving, 15000, '没有在途的解题');

  // 手工造一道题走完整 solve()：比等 mock 页"碰巧"弹一道更可控，
  // 也顺带验证了开关的判据是配置而不是"有没有弹题"。
  const offSolved = await NS.app.quiz.solve(makeFakeQuiz('【单选题】关掉开关之后的题？'));

  check('开关关掉后一次都没问', () => {
    eq(askedOff.length, 0, '仍然问了 ' + askedOff.length + ' 次');
  });

  check('关掉后既不问答也不枚举，直接放弃本题（避免误交）', () => {
    eq(offSolved, false, '不该在这个配置下答对');
    eq(NS.app.quiz.stats.failed >= 1, true,
      '未解计数没有累加：' + JSON.stringify(NS.app.quiz.stats));
  });

  // ── [8] 同一道题不能无限重问（网页端会拒答） ─────────────
  console.log('\n\x1b[1m[8] 同一道题最多问 N 次，而且每次换个说法\x1b[0m');

  {
    const askedList = [];
    NS.aiBridge.ask = async (q) => { askedList.push(q); return null; };  // 一直不给答案
    await NS.config.set({
      askWebAI: true, webAIFirst: true, useBank: false, bruteForce: false,
      maxAskAttempts: 2,
      resultWaitMs: 300,
    });
    NS.bank.clearTried();
    NS.app.quiz.clearPassed();
    NS.app.quiz._lastAIAnswer.clear();
    NS.app.quiz._askCount.clear();

    await waitUntil(() => !NS.app.quiz.solving, 15000, '没有在途的解题');

    const sameQuiz = makeFakeQuiz('【单选题】反复问同一道题试试？');
    await NS.app.quiz.solve(sameQuiz);
    await waitUntil(() => !NS.app.quiz.solving, 15000, '第二次解题收尾');
    await NS.app.quiz.solve(makeFakeQuiz('【单选题】反复问同一道题试试？'));

    check('问到上限之后不再重问', () => {
      eq(askedList.length, 2, '问了 ' + askedList.length + ' 次，上限是 2');
    });

    check('每次都会带上"第几次问"，让 AI 页面换个说法', () => {
      eq(askedList[0] && askedList[0].attempt, 1, '第一次的 attempt 应当是 1');
      eq(askedList[1] && askedList[1].attempt, 2, '第二次的 attempt 应当是 2');
    });
  }

  // ── [8.5] 作业/测试页：题型标签不能被当成题干 ─────────────
  //
  // 用户现场（能力提升模式，作业/测试页）：
  //     页面上摆的是  1.【单选题】(5分)                        ← 第一行是标签
  //                   What is not the purpose of "Sha Qing"?  ← 这才是题干
  // 而发出去的题目是「1. 【单选题】(5分)」—— 选项是对的，
  // 于是 AI 拿着一道**没有问题的题**在选答案。
  console.log('\n\x1b[1m[8.5] 题型标签不能被当成题干\x1b[0m');

  {
    check('能力提升那套也带了题型标签判据（标签不当题干）', () => {
      // 判据本身：整行就是"题号 + 【题型】 + (N分)"
      const RE = new RegExp(
        '^[\\s\\d.、]*[【\\[]\\s*(单选|多选|判断|填空|简答|论述|不定项|选择)[^】\\]]*[】\\]]' +
        '[\\s(（]*\\d*\\s*分?[)）]?\\s*$'
      );
      ok(RE.test('1.【单选题】(5分)'), '标签没被认出来');
      ok(RE.test('1. 【单选题】 (5分)'), '带空格的标签没被认出来');
      ok(!RE.test('What is not the purpose of "Sha Qing"?'), '真题干被误判成标签');
      ok(!RE.test('【多选题】以下哪些说法正确'), '带正文的标签行被误判成整行标签');
    });
  }

  // ── [8.6] 能力提升复用视频那套勾选模块 + 翻页要确认 ───────
  //
  // 用户要求：把视频答题的最终答题模块套进能力提升模式，再改提交逻辑。
  // 两件事各自钉一条：
  //   ① 勾选**委托**给视频那套（一份实现，不再各写一份，免得漂）
  //   ② 翻页按钮认「下一题 / 保存」，而且**点完要确认题干真的变了**
  console.log('\n\x1b[1m[8.6] 能力提升复用视频勾选模块 · 翻页要确认\x1b[0m');

  {
    const A = NS.AbilitySolver;
    const solver = new A();

    check('勾选走的是视频那套（同一次调用，不是各写一份）', async () => {
      // ⚠ 不要替换 NS.app.quiz 对象本身：check 之间会交错，
      // 后一个 check 可能在前一个还没恢复时就捕获到假对象，
      // 于是"恢复"反而把假对象永久装了回来（踩过：后面所有用例读 stats 都炸）。
      // 就地换方法、就地换回来，只有一个 await，不会交错。
      const realQ = NS.app.quiz;
      const savedClickOption = realQ.clickOption;
      let called = 0;
      realQ.clickOption = function (el) { called++; void el; return true; };
      try {
        await solver.clickOption({ isConnected: true });
      } finally {
        realQ.clickOption = savedClickOption;
      }
      eq(called, 1, '没有委托给视频那套勾选模块');
    });

    check('拿不到视频那套时退回本地实现（不会整条崩掉）', async () => {
      const realQ = NS.app.quiz;
      const savedClickOption = realQ.clickOption;
      realQ.clickOption = undefined;      // 模拟"视频那套还没就绪"
      let out;
      try {
        out = await solver.clickOption(null);   // 空元素 → false，但**不能抛**
      } finally {
        realQ.clickOption = savedClickOption;
      }
      eq(out, false, '退回实现没兜住');
    });

    check('没选中的选项带内联样式时，不许被当成"已选中"', () => {
      // ⚠ 这条对应「第二题没有回答就点保存了」：
      // 原实现里"有内联边框/背景色 ⇒ 选中"，而站点给未选中的选项也常写内联样式。
      // 一旦误判成 true，pick() 里 should===on 成立 → continue → 一个都不点，
      // 接着就去点「保存」了（截图里圆圈全空）。
      const el = win.document.createElement('li');
      el.className = 'opt';
      el.setAttribute('style', 'border: 1px solid rgb(221, 221, 221); background: #fff');
      el.textContent = 'A. Oolong';
      const realQ = NS.app.quiz;
      const savedIs = realQ.isSelected;
      realQ.isSelected = undefined;      // 走能力提升自己的兜底实现
      let v;
      try {
        v = NS.app.ability.isSelected(el);
      } finally {
        realQ.isSelected = savedIs;
      }
      eq(v, null, '带内联样式的未选中项被判成了 true（应该老实返回 null）');
    });

    check('「下一题」和「保存」都要认（站点答完会把下一题变成保存）', () => {
      const M = NS.abilityUtils || {};
      const RE = M.NEXT_TEXT;
      ok(RE, '拿不到 NEXT_TEXT');
      ok(RE.test('下一题'), '下一题 不认');
      ok(RE.test('保存'), '保存 不认 —— 站点上答完就是它，会卡在这一步');
      ok(RE.test('下一頁'), '繁体 不认');
      ok(!RE.test('上一题'), '上一题 不能被当成翻页');
    });

    check('真实作业页结构：题干取 p，不取题型标签的父容器', () => {
      // ⚠ 这份 DOM 是**用浏览器直接看真页面抄下来的**（不再靠猜）：
      //   · 题型标签是三个 span：<span>1.</span><span>【单选题】</span><span>(5分)</span>
      //     ⇒ 它们的父容器 textContent 正好是 "1.【单选题】(5分)"，被当成题干的就是它
      //   · 题干是 <p><span>What is not the purpose…</span></p>
      //   · 选项是 <div class="node_detail examquestions-answer"><p><span>…</span></p></div>
      //   · 页面上另有两个噪声 <p>（提示 / 答题后请点…）
      const { JSDOM } = resolveJsdom();
      const dom2 = new JSDOM(`<!DOCTYPE html><html><body>
        <p>提示：选择题选项顺序为随机排列，若要核对答案，请以选项内容为准</p>
        <div class="exam-item">
          <div class="quest-title"><span>1.</span><span>【单选题】</span><span>(5分)</span></div>
          <p><span>What is not the purpose of "Sha Qing"?</span></p>
          <div class="node_detail examquestions-answer"><p><span>to change water content in tea leaves</span></p></div>
          <div class="node_detail examquestions-answer"><p><span>to develop the aroma</span></p></div>
          <div class="node_detail examquestions-answer"><p><span>to stop the enzymatic oxidation</span></p></div>
          <div class="node_detail examquestions-answer"><p><span>to change the color of tea leaves</span></p></div>
        </div>
        <p>答题后请点【下一题】保存答案，全部试题答完后请点击右上角【提交】按钮完成答题，避免答题记录丢失！</p>
      </body></html>`, { pretendToBeVisual: true });

      check('选项用 .examquestions-answer 取到 4 个', () => {
        const opts = dom2.window.document.querySelectorAll('.examquestions-answer');
        eq(opts.length, 4, '选项没取到');
      });

      check('"选项组之前最近的 p" 正好是题干，不是标签、不是提示、不是页脚', () => {
        const d = dom2.window.document;
        const opt0 = d.querySelector('.examquestions-answer');
        const NOISE = /选择题选项顺序|答题后请点/;
        const LABEL = new RegExp(
          '^[\\s\\d.、]*[【\\[]\\s*(单选|多选|判断|填空|简答)[^】\\]]*[】\\]][\\s(（]*\\d*\\s*分?[)）]?\\s*$'
        );
        let best = null;
        for (const el of Array.from(d.querySelectorAll('p'))) {
          const pos = el.compareDocumentPosition(opt0);
          if (!(pos & 4)) continue;
          const t = el.textContent.replace(/\s+/g, ' ').trim();
          if (!t || t.length < 4 || t.length > 400) continue;
          if (NOISE.test(t) || LABEL.test(t)) continue;
          best = t;
        }
        eq(best, 'What is not the purpose of "Sha Qing"?',
          '取到的不是题干：' + JSON.stringify(best));
      });

      check('挂在 body 上的瞬时提示条不会被当成题干', () => {
        // ⚠ 这对应"题干变成了 正在加载中 / 保存成功!"。
        // 提示条也是 <p>、也排在选项前面，但它在 body 层。
        // 所以规则必须是"**选项所在容器内**、其上方最近的 p"，
        // 而不是"全文档里选项之前最近的 p"。
        const d = dom2.window.document;
        const body = d.body;
        const toast = d.createElement('p');
        toast.textContent = '正在加载中';
        body.insertBefore(toast, body.firstChild);      // 挂在 body 最前面，位置最"靠前"
        toast.getBoundingClientRect = () => ({ width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 });

        const opt0 = d.querySelector('.examquestions-answer');
        const t = toast.textContent.trim();
        ok(/正在加载|保存成功/.test(t), 'fixture 里的提示条文字不对');
        // 结构判据：提示条**不在**选项的祖先链里
        let inBox = false;
        for (let n = opt0; n && n !== body; n = n.parentElement) {
          if (n.contains(toast)) inBox = true;
        }
        eq(inBox, false, '提示条不该在选项容器里（fixture 本身有问题）');
        toast.remove();
      });
    });

    check('.quest-title 就是题型标签时，不许把标签当题干', () => {
      // ⚠ 这条对应"接了开源选择器之后 bug 依旧存在"。
      // 我加了 `.quest-title` 进 STEM_SELECTORS，但那个循环漏掉了题型标签判据 ——
      // 而有些页面上 `.quest-title` **恰好就是标签元素**，
      // 于是它一命中就把「1.【单选题】(5分)」当成了题干，
      // 比加这张表之前还糟。
      //
      // 结构护栏：STEM_SELECTORS 的循环体里必须有 TYPE_LABEL_RE 这道校验。
      const src = require('fs').readFileSync('src/content/ability.js', 'utf8');
      const iLoop = src.indexOf('for (const sel of STEM_SELECTORS)');
      ok(iLoop > 0, '找不到 STEM_SELECTORS 循环');
      const body = src.slice(iLoop, src.indexOf('// 兜底：明确选择器都没命中'));
      ok(/TYPE_LABEL_RE\.test\(t\)/.test(body),
        'STEM_SELECTORS 循环里没有题型标签判据 —— 标签会被当成题干');
      ok(/if \(NOISE_RE\.test\(t\)\) continue;/.test(body),
        'STEM_SELECTORS 循环里没有噪声判据');
      ok(/t\.length > 400/.test(body), 'STEM_SELECTORS 循环里没有长度上限');

      // 行为护栏：标签文本必须被那条判据挡住
      const RE = new RegExp(
        '^[\\s\\d.、]*[【\\[]\\s*(单选|多选|判断|填空|简答|论述|不定项|选择)[^】\\]]*[】\\]]' +
        '[\\s(（]*\\d*\\s*分?[)）]?\\s*$'
      );
      ok(RE.test('1. 【单选题】 (5分)'), '作业页那个标签没被挡住');
      ok(!RE.test('What is not the purpose of "Sha Qing"?'), '真题干被误挡');
    });

    check('没答完绝不自动提交（提交后不可逆），并要处理确认弹窗', () => {
      // ⚠ 用户现场：第 1 题答完、第 2 题没答，**却点了「提交作业」**，
      // 弹出「是否确认提交?提交后,批阅过的试卷不能再修改!」。
      // 根因：run() 里那个 break 之后照样往下走 submit()。
      const src = require('fs').readFileSync('src/content/ability.js', 'utf8');
      const run = src.slice(src.indexOf('async run()'));

      ok(/let incomplete = false;/.test(run), '没有把"提前退出"记下来');
      // ⚠ 阈值从 3 改成 2：原来第三个是"这一题和上一题完全一样 ⇒ 收工"，
      // 而那个判据本身是错的（判断题的选项天然相同、题干又读成同一段乱码，
      // 于是十道题的签名一模一样 ⇒ 第一题之后立刻收工）。
      // 现在只剩两个**真的**提前退出分支：读不到题目、以及有题没答上。
      const marks = run.match(/incomplete = true;/g) || [];
      ok(marks.length >= 2, '提前退出的分支没都标记上（只有 ' + marks.length + ' 处）');
      // 而"答满总题数"这条正常结束的路径**不该**被标成未完成
      ok(/已经答满页面上写的总题数/.test(run), '答满总题数那条正常收工路径不见了');

      const iGuard = run.indexOf('if (incomplete) {');
      const iSubmit = run.indexOf('cfg.abilityAutoSubmit');
      ok(iGuard > 0, '没有"没答完就不提交"的分支');
      ok(iGuard < iSubmit, '顺序不对：必须先判 incomplete，再考虑自动提交');
      ok(/不自动提交/.test(run.slice(iGuard, iSubmit)), '守卫里没说清"不自动提交"');

      // 确认弹窗：只在弹窗内部点「确定」，且「取消」不能被匹配
      ok(/confirmSubmit\(\) \{/.test(src), '没有 confirmSubmit()');
      ok(/const inner = Array\.from\(dlg\.querySelectorAll/.test(src),
        '在弹窗**内部**找确定这一步没了 —— 会误点页面上别的按钮');
      const RE = /^(确定|确认|是|提交)$/;
      ok(RE.test('确定'), '确定 不认');
      ok(!RE.test('取消'), '「取消」被认成了确定 —— 会把弹窗关掉等于没交');
      ok(!RE.test('确定并提交作业'), '带尾巴的文案不该命中（宁可不点）');
    });

    check('选项那一行 / 包住选项组的容器，都不能被当成题干', () => {
      // ⚠ 这两条是拿真日志对出来的：
      //   #17 第 1 题：A.⏎⏎to change water content in tea leave   ← 选项那一行
      //   #23 第 2 题：2.⏎【单选题】(5分)⏎A.⏎White⏎B.⏎ Green⏎C.  ← 包住选项组的容器
      // 判据必须**按内容形状**，不能按 DOM 层级 ——
      // 试过 `el.contains(选项) 就排除`，结果把"题干和选项同容器"也排掉了，
      // 一个候选都不剩（read() 直接返回 null）。
      const LEAD = /^\s*[A-H]\s*[.、．)）]/;
      const COUNT = /(^|\s)[A-H]\s*[.、．)）]/g;
      const bad = (t) => LEAD.test(t) || ((t.match(COUNT) || []).length >= 2);

      ok(bad('A.\n\nto change water content in tea leaves'), '选项那一行没被挡住');
      ok(bad('2.\n【单选题】(5分)\nA.\nWhite\nB.\n Green\nC.'), '包住选项组的容器没被挡住');
      ok(!bad('What is not the purpose of "Sha Qing"?'), '真题干被误挡');
      ok(!bad('Which tea is a non-fermented tea?'), '真题干 2 被误挡');
      ok(!bad('In Western dining culture, it is customary to: ( )'), '带冒号的真题干被误挡');

      // 结构护栏：三条查找路径都要有这两条判据
      const src = require('fs').readFileSync('src/content/ability.js', 'utf8');
      eq((src.match(/if \(\/\^\\s\*\[A-H\]/g) || []).length, 3, '选项行判据不是 3 处');
      eq((src.match(/>= 2\) continue;/g) || []).length, 3, '选项组判据不是 3 处');
      eq(/el\.contains\(o\)/.test(src), false, '"包着选项就排除"那条不该再留着（会排除过头）');

      // ⚠ 位置护栏：判据必须写在 `const t = textOf(el)` **之后**。
      // 摆前面会撞 TDZ —— **`Cannot access 't' before initialization`**，
      // 那是脚本自己崩掉（日志里连着报了三次"整套答题异常"），
      // 比读错题干还糟。用脚本批量插代码时特别容易踩。
      const lines = src.split('\n');
      let badPos = 0;
      lines.forEach((l, i) => {
        if (!/^\s*if \(\/\^\\s\*\[A-H\]/.test(l)) return;
        let found = false;
        for (let j = i; j >= 0 && i - j < 12; j--) {
          if (/const t = textOf\(el\);/.test(lines[j])) { found = true; break; }
        }
        if (!found) badPos++;
      });
      eq(badPos, 0, badPos + ' 处判据写在了 t 声明之前 —— 会抛 TDZ 崩掉');
    });

    check('能力提升模式下，视频那套解题器必须拒绝启动（对称闸门）', async () => {
      // ⚠ 这条对应作业页上「题目读不对 + 没答就点保存」的**真正来源**：
      // 视频那套探测器在作业页上跑着（日志里是它的措辞："检测到弹题"、
      // "用 AI 的答案作答"、"未开启组合枚举"、"补一次提交（<span>保存 …）"），
      // 它读到的"题干"是题型标签「1.\n【单选题】 (5分)」。
      //
      // 根因是**竞态**：main.js 的 tick 可能在配置从 storage 读回来之前
      // 跑过一次，那刻 mode 还是默认 'video'，于是放行了；
      // 一旦 handleQuiz 已经在跑，后面就不再回头看模式。
      // 所以要在 solve() 下决心的那一刻再判一次（那时配置一定已就绪）。
      //
      // 说明：这里用**结构护栏**。行为上很难造——喂一个假 quiz 进去，
      // 它本来也会因为选项不是真元素而失败，那样测出来的绿是假的
      //（第一版就是这么假通过的）。
      const src = require('fs').readFileSync('src/content/quiz.js', 'utf8');
      const iSolve = src.indexOf('async solve(quiz)');
      ok(iSolve > 0, '找不到 solve()');
      const body = src.slice(iSolve, src.indexOf('async ', iSolve + 10));
      ok(/cfg\.mode \|\| 'video'\) !== 'video'/.test(body),
        'solve() 里没有"当前模式不是视频就退出"的闸门');
      // 拒绝时要把 solving 复位，否则整条线卡死
      const iGuard = body.indexOf("!== 'video'");
      const iReset = body.indexOf('this.solving = false', iGuard);
      ok(iReset > iGuard, '拒绝分支里没有复位 solving —— 会卡住整条视频线');

      // 行为上仍然验一条：不抛异常、不把 solving 留在 true
      await NS.config.set({ mode: 'ability', askWebAI: true });
      try {
        await NS.app.quiz.solve({
          stem: '作业页上的一段文字', options: [{}, {}], multi: false, key: 'guard-test',
        });
      } catch (e) { /* 它随时可能因为别的原因失败，这里只关心闸门 */ }
      eq(NS.app.quiz.solving, false, '拒绝之后 solving 没复位，会卡住整条线');
      await NS.config.set({ mode: 'video' });
    });

    check('题干选择器（照开源脚本抄的）能避开题型标签', () => {
      // 来源：Cooanyh/zhihuishu-zhangwodu v2.1.0
      //   题干 = `.quest-title .option-name`，题型 = `.quest-type`（另一个元素）
      const src = require('fs').readFileSync('src/content/ability.js', 'utf8');
      ok(/\.quest-title \.option-name/.test(src), 'STEM_SELECTORS 里没有作业页的题干选择器');
      ok(/const TYPE_SELECTORS/.test(src), '没有题型标签的元素表');
      ok(/const STEM_SELECTORS/.test(src), '没有 STEM_SELECTORS');
      // 明确选择器必须排在"猜"的前面
      const iStem = src.indexOf('const stem = ');
      const iExplicit = src.indexOf('STEM_SELECTORS');
      const iGuess = src.indexOf('// 兜底：明确选择器都没命中');
      ok(iExplicit > 0 && iGuess > iExplicit, '明确选择器没排在兜底前面');
      void iStem;
    });

    check('总开关关掉时，两套答题都必须闭嘴', () => {
      // ⚠ 用户报的「总开关失效」：main.js 的两道启动闸门**都无视了 cfg.enabled** ——
      // 能力提升那边只看 mode + abilityAuto，视频那边只看 mode + autoQuiz。
      // 关掉总开关，卷子照答不误。
      const src = require('fs').readFileSync('src/content/main.js', 'utf8');
      const iVideo = src.indexOf('if (this.isVideoMode &&');
      const iAbility = src.indexOf('if (this.isAbilityMode &&');
      ok(iVideo > 0, '找不到视频那条闸门');
      ok(iAbility > 0, '找不到能力提升那条闸门');

      const vSeg = src.slice(iVideo, iVideo + 120);
      const aSeg = src.slice(iAbility, iAbility + 120);
      ok(/cfg\.enabled/.test(vSeg), '视频那条闸门没检查总开关');
      ok(/cfg\.enabled/.test(aSeg), '能力提升那条闸门没检查总开关');
    });

    check('没答上时**跳过并继续**，不许整个收工（那会漏掉后面所有题）', () => {
      // ⚠ 这条契约改过一次，方向正好相反，所以注释必须写清楚：
      //
      // 第一版要求"没答上就停下、不点保存" —— 出发点是别悄悄交白卷。
      // 但真实后果是：**第 1 题没答上 ⇒ break ⇒ 后面所有题一道都没碰**
      //（用户现场："纯在漏题现象"，而且后续题连截图都没截 —— 因为压根没进循环）。
      //
      // 现在的契约（用户明确要求）：
      //   填入答案 → 下一题 → …… 直到遇见「保存 / 没有下一题」
      //   · 中途翻页**每轮都点**，没答上也照点（否则卡死在这一题）
      //   · 只有最后那个不可逆的「提交作业」才需要谨慎
      const src = win.__ZHS.abilitySource ||
        require('fs').readFileSync('src/content/ability.js', 'utf8');
      const run = src.slice(src.indexOf('async run()'));
      const iAns = run.indexOf('const answered = await this.solveOne(quiz);');
      ok(iAns > 0, 'run() 里没接住 solveOne 的返回值');

      // 没答上的分支里**不许有 break** —— 那正是漏题的根因
      const iNext = run.indexOf('没有「下一题」按钮了', iAns);
      const seg = run.slice(iAns, iNext);
      ok(seg.length > 20, '没答上的分支不见了');
      eq(/\bbreak;/.test(seg), false,
        '没答上的分支里还有 break —— 后面的题会被全部跳过（漏题）');
      ok(/跳过它，继续下一题/.test(seg), '没答上时没有"继续下一题"的说明');

      // 但"提交作业"那一步仍然不能因为没答完就自动点（不可逆）
      const iGuard = run.indexOf('if (incomplete) {');
      ok(iGuard > 0, '最后"不自动提交"那道守卫不见了');
      ok(/不自动提交/.test(run.slice(iGuard, iGuard + 200)), '守卫里没说清"不自动提交"');
    });

    check('点完要回头核实真的选上了（不能只报"我点过了"）', () => {
      const src = require('fs').readFileSync('src/content/ability.js', 'utf8');
      const pick = src.slice(src.indexOf('async pick(quiz, indexes)'));
      ok(/点过了但一个选项都没选上/.test(pick), 'pick() 里没有"点完核实"这一步');
      ok(/return hit > 0/.test(pick), 'pick() 没有把核实结果返回出去');
    });

    check('页面没翻动时，绝不许报"翻页成功"', async () => {
      // 关键护栏：原来是 realClick 完就 return true，
      // 点空了什么都不知道 → run() 下一轮读到同一道题 → "题干没变就收工"，
      // 整套答题在第 1 题之后直接结束。
      // 这里只验最要紧的一条：**没翻动就必须返回 false**。
      const d = win.document;
      const before = solver._stemNow();
      const btn = d.createElement('button');
      btn.textContent = '保存';
      const savedQSA = d.querySelectorAll;
      d.querySelectorAll = (sel) => {
        if (/button|btn/i.test(sel)) return [btn];
        return savedQSA.call(d, sel);
      };
      const savedClick = NS.dom.realClick;
      NS.dom.realClick = function () { return true; };
      let out;
      try {
        out = await solver.next();
      } finally {
        d.querySelectorAll = savedQSA;
        NS.dom.realClick = savedClick;
      }
      eq(out, false, '页面没翻动却报成功 —— 下一轮会读到同一道题然后收工');
      void before;
    });

    check('压根没有翻页按钮时也返回 false（最后一题）', async () => {
      const d = win.document;
      const savedQSA = d.querySelectorAll;
      d.querySelectorAll = () => [];
      let out;
      try {
        out = await solver.next();
      } finally {
        d.querySelectorAll = savedQSA;
      }
      eq(out, false, '没按钮却报成功');
    });
  }

  // ── [9] 模式隔离：两套答题不许同时跑 ─────────────────────
  //
  // 这是硬要求：视频课那套和能力提升那套**共用同一个网页端 AI 标签页**。
  // 同时问会互相踩 —— 一处刚把题目打进输入框，另一处把输入框清了，
  // 两边都拿不到答案，还把对话污染了。
  // 隔离靠两道闸门：
  //   ① 配置层：mode 是单选（video / ability），不是两个独立开关
  //   ② 运行时：tick 里按模式只启动对应那一套；ai-bridge 里再加一道串行闸门
  console.log('\n\x1b[1m[9] 模式隔离：视频 / 能力提升不能同时跑\x1b[0m');

  {
    await waitUntil(() => !NS.app.quiz.solving, 15000, '没有在途的解题');

    const D = win.ZHS_DEFAULTS || NS.DEFAULTS;

    check('mode 是单选，只有 video / ability 两个取值', () => {
      const modes = win.ZHS_MODES || NS.MODES;
      ok(Array.isArray(modes), '拿不到模式白名单');
      eq(modes.slice().sort(), ['ability', 'video']);
      ok(modes.indexOf(D.mode) !== -1, '默认值不在白名单里：' + D.mode);
    });

    check('写一个不存在的模式会被压回默认值（不会两台一起跑）', () => {
      const cfg = NS.config.get();
      const bad = win.ZHS_sanitizeConfig(Object.assign({}, cfg, { mode: 'both' }));
      ok(bad.mode === 'video' || bad.mode === 'ability',
        '非法模式没被收回来：' + bad.mode);
    });

    // 视频模式下：能力提升那套不启动
    await NS.config.set({ mode: 'video', askWebAI: true });
    NS.app.ability._stop = true;
    NS.app.ability.running = false;
    const beforeVideo = NS.app.quiz.stats.asked;

    check('视频模式下 isVideoMode / isAbilityMode 互为反面', () => {
      eq(NS.app.isVideoMode, true, 'video 模式下 isVideoMode 该是 true');
      eq(NS.app.isAbilityMode, false, 'video 模式下 isAbilityMode 该是 false');
    });

    check('视频模式下，能力提升那套直接拒绝启动', async () => {
      // 它自己会看 cfg.mode，不是靠调用方自觉
      const ran = await NS.app.ability.run();
      eq(ran, false, '视频模式下能力提升居然跑起来了');
    });
    void beforeVideo;

    // 能力提升模式下：问 AI 之前会再查一次模式
    await NS.config.set({ mode: 'video' });
    const ability = NS.app.ability;
    const askedModeCheck = [];
    const realBridgeAsk = NS.aiBridge.ask;
    // 桩要一直挂着 —— 两次调用都要经过它，中间不能还原
    NS.aiBridge.ask = async (q) => { askedModeCheck.push(q); return [1]; };

    const okMode = await ability.solveOne({
      stem: '模式检查用的题？', options: ['甲', '乙'], multi: false, key: 'modecheck',
    });
    eq(okMode, false, '视频模式下不该去问 AI');
    eq(askedModeCheck.length, 0, '居然真的问了 AI —— 模式闸门没生效');

    // 切到能力提升模式后，同一道题能正常走通
    // （注意要把 askWebAI 打开 —— 上一节 [7] 把它关掉了，config.set 是合并语义）
    await NS.config.set({ mode: 'ability', useBank: false, askWebAI: true });
    NS.bank.clearTried();
    const okAbility = await ability.solveOne({
      stem: '模式检查用的题？', options: ['甲', '乙'], multi: false, key: 'modecheck2',
    });
    check('能力提升模式下同一道题能问到答案', () => {
      eq(okAbility, true, '切到能力提升模式后还是被拦住了');
      ok(askedModeCheck.length === 1, '问询次数不对：' + askedModeCheck.length);
    });
    NS.aiBridge.ask = realBridgeAsk;

    await NS.config.set({ mode: 'video' });
  }

  // ── [10] AI 通道自身的形状自检 ───────────────────────────
  //
  // 踩过：给 ask() 加串行闸门时，只改了开头的 `const promise = withAiLock(async () => {`，
  // **忘了把结尾的 `})()` 改成 `})`** —— 于是变成了"调用 withAiLock 的结果"，
  // 每次提问都抛 `withAiLock(...) is not a function`。
  //
  // 这个错特别难发现，因为调用方把异常吞了（只留一行 debug 日志），
  // e2e 也照样全绿 —— 只有用户从日志里看到「AI 通道异常」才暴露出来。
  // 所以这里直接对 ask() 做一次形状自检：不抛异常、返回值要么是 null 要么是数组。
  console.log('\n\x1b[1m[10] AI 通道形状自检\x1b[0m');

  {
    await NS.config.set({ askWebAI: true, mode: 'video' });
    // ⚠ 前面几节把 NS.aiBridge.ask 换成了桩，而且没还原 ——
    // 不换回真货的话，这一节测的就是桩，那个 TypeError 照样溜过去。
    // （第一版就是这样假通过的：注入 bug 之后测试依然全绿。）
    NS.aiBridge.ask = ORIGINAL_ASK;
    let err = null;
    let out;
    try {
      out = await NS.aiBridge.ask({
        stem: '接口自检用的题？', options: ['甲', '乙'], multi: false,
      });
    } catch (e) {
      err = e;
    }
    check('aiBridge.ask 不会在内部炸掉（这条能挡住"忘了改结尾"那种低级错）', () => {
      eq(err, null, 'ask 抛异常了：' + (err && err.message));
    });
    check('返回值要么是 null 要么是下标数组', () => {
      ok(out === null || Array.isArray(out),
        '返回值形状不对：' + JSON.stringify(out));
    });
  }

  // ── 收尾 ───────────────────────────────────────────────
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
