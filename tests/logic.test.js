/**
 * logic.test.js — 纯 Node 逻辑测试（无外部依赖）
 *
 * 把 content 层的模块放进一个 vm 沙箱里跑，mock 掉 chrome.* 与 DOM，
 * 只验证不依赖真实页面的部分：组合枚举、文本归一化、题库读写、试错记忆。
 *
 * 运行： node tests/logic.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// ── 沙箱 ──────────────────────────────────────────────────

const store = {};

function makeSandbox() {
  const win = {};
  const changeListeners = [];
  const sandbox = {
    window: win,
    self: win,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    isFinite,
    parseInt,
    parseFloat,
    chrome: {
      storage: {
        local: {
          get: (k) => {
            if (typeof k === 'string') return Promise.resolve({ [k]: store[k] });
            if (Array.isArray(k)) {
              const out = {};
              k.forEach((key) => { out[key] = store[key]; });
              return Promise.resolve(out);
            }
            return Promise.resolve(Object.assign({}, store));
          },
          set: (obj) => {
            Object.assign(store, obj);
            return Promise.resolve();
          },
        },
        onChanged: { addListener: (fn) => changeListeners.push(fn) },
      },
      runtime: {
        id: 'test-extension',
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage() {},
        lastError: null,
      },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.__changeListeners = changeListeners;
  vm.createContext(sandbox);
  return sandbox;
}

function load(sandbox, rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

const sandbox = makeSandbox();
['src/shared/defaults.js', 'src/content/dom.js', 'src/content/config.js', 'src/content/bank.js', 'src/content/quiz.js']
  .forEach((f) => load(sandbox, f));

const NS = sandbox.window.__ZHS;

// ── 迷你测试框架 ──────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    fail++;
    failures.push({ name, err: e });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('      ' + (e && e.message));
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    fail++;
    failures.push({ name, err: e });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('      ' + (e && e.message));
  }
}

function eq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '\n      got:      ' + sa + '\n      expected: ' + sb);
}

function ok(v, msg) {
  if (!v) throw new Error(msg || 'expected truthy, got ' + JSON.stringify(v));
}

// ── 用例 ──────────────────────────────────────────────────

(async function main() {
  console.log('\n\x1b[1m知到自动助手 — 逻辑测试\x1b[0m\n');

  const { combinations, comboSpan } = NS.quizUtils;
  const { normalize, hash } = NS.dom;

  console.log('\x1b[1m[1] 组合枚举器\x1b[0m');

  test('maxSize=1 → 单项组合 + 全选兜底', () => {
    const got = [...combinations(4, 1)];
    eq(got, [[0], [1], [2], [3], [0, 1, 2, 3]]);
  });

  test('4 选项 / 最大组合 2 → 10 种 + 全选兜底 = 11，按长度升序', () => {
    const got = [...combinations(4, 2)];
    eq(got, [
      [0], [1], [2], [3],
      [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
      [0, 1, 2, 3],
    ]);
  });

  test('4 选项 / 最大组合 3 → 14 种 + 全选兜底 = 15', () => {
    const got = [...combinations(4, 3)];
    eq(got.length, 15);
    eq(comboSpan(4, 3), 15);
  });

  test('5 选项 / 最大组合 3 → 25 种 + 全选兜底 = 26', () => {
    eq([...combinations(5, 3)].length, 26);
    eq(comboSpan(5, 3), 26);
  });

  test('全选兜底排在枚举序列的最后', () => {
    const got = [...combinations(4, 3)];
    eq(got[got.length - 1], [0, 1, 2, 3], '最后一项应是全选');
  });

  test('全选题能被枚举覆盖到（「以下哪些属于…」答案常常是全部选项）', () => {
    const n = 4;
    const TRUE_ANSWER = [0, 1, 2, 3];
    let found = null;
    for (const combo of combinations(n, 3)) {
      if (combo.length === TRUE_ANSWER.length &&
          combo.every((v, i) => v === TRUE_ANSWER[i])) {
        found = combo;
        break;
      }
    }
    eq(found, [0, 1, 2, 3], '全选没被产出的话，这类题会一直卡住');
  });

  test('maxComboSize 已经覆盖 n 时不会重复产出全选', () => {
    const got = [...combinations(3, 3)];
    eq(got.length, 7, '完整幂集应为 2^3-1');
    eq(got.filter((c) => c.length === 3).length, 1, '全选只应出现一次');
  });

  test('无重复组合', () => {
    const seen = new Set();
    for (const c of combinations(6, 3)) {
      const k = c.join(',');
      ok(!seen.has(k), '重复组合 ' + k);
      seen.add(k);
    }
    eq(seen.size, comboSpan(6, 3));
  });

  test('每个组合内部下标严格递增', () => {
    for (const c of combinations(7, 4)) {
      for (let i = 1; i < c.length; i++) {
        ok(c[i] > c[i - 1], '组合未递增 ' + c.join(','));
      }
    }
  });

  test('maxSize 大于 n 时退化完整幂集', () => {
    eq(comboSpan(3, 99), 7);   // 2^3 - 1
    eq([...combinations(3, 99)].length, 7);
  });

  test('n=1 边界', () => {
    eq([...combinations(1, 3)], [[0]]);
    eq(comboSpan(1, 3), 1);
  });

  console.log('\n\x1b[1m[2] 文本归一化\x1b[0m');

  test('去空白', () => {
    eq(normalize('  下列  说法 正确 '), '下列说法正确');
  });

  test('全角标点转半角', () => {
    eq(normalize('A．正确（对）'), 'a.正确(对)');
  });

  test('全角字母数字转半角', () => {
    eq(normalize('选项ＡＢＣ１２３'), '选项abc123');
  });

  test('全角问号/感叹号/冒号', () => {
    eq(normalize('对吗？对！注意：'), '对吗?对!注意:');
  });

  test('中文句号与顿号', () => {
    eq(normalize('甲。乙、丙'), '甲.乙,丙');
  });

  test('破折号与省略号', () => {
    eq(normalize('甲—乙…丙'), '甲-乙...丙');
  });

  test('书名号与方头括号', () => {
    eq(normalize('《论语》【重点】'), '<论语>[重点]');
  });

  test('中文引号', () => {
    eq(normalize('“答案”和‘选项’'), '"答案"和\'选项\'');
  });

  test('带字母的数字前缀不被误剥（3D打印）', () => {
    eq(normalize('3D打印技术'), '3d打印技术');
  });

  test('带分隔符的题号会被剥掉', () => {
    eq(normalize('1、题干'), '题干');
    eq(normalize('2. 题干'), '题干');
    eq(normalize('(3)题干'), '题干');
    eq(normalize('（4）题干'), '题干');
  });

  test('同样的题不同排版归一化一致', () => {
    const a = normalize('1、下列哪个选项是正确的？');
    const b = normalize('下列哪个选项是正确的?');
    eq(a, b);
  });

  test('全角句号结尾与半角句点结尾一致', () => {
    eq(normalize('这是题目。'), normalize('这是题目.'));
  });

  console.log('\n\x1b[1m[3] 哈希稳定性\x1b[0m');

  test('同输入同输出', () => {
    eq(hash('hello world'), hash('hello world'));
  });

  test('不同输入不同输出', () => {
    ok(hash('题目甲') !== hash('题目乙'));
  });

  test('输出为 8 位十六进制', () => {
    ok(/^[0-9a-f]{8}$/.test(hash('任何中文题干')));
  });

  console.log('\n\x1b[1m[4] 题库\x1b[0m');

  const bank = NS.bank;

  test('keyOf 区分题型与选项数', () => {
    const a = bank.keyOf('题干X', 4, false);
    const b = bank.keyOf('题干X', 4, true);
    const c = bank.keyOf('题干X', 5, false);
    ok(a !== b && a !== c && b !== c);
  });

  test('keyOf 对排版差异不敏感', () => {
    eq(bank.keyOf('1、题干X？', 4, false), bank.keyOf('题干X?', 4, false));
  });

  test('查库未命中返回 null', () => {
    eq(bank.lookup('从没见过的题目', 4, false), null);
  });

  test('记库后可命中', () => {
    bank.remember('下列属于常量的是', 4, true, [0, 2]);
    const hit = bank.lookup('下列属于常量的是', 4, true);
    ok(hit, '应命中');
    eq(hit.answer, [0, 2]);
  });

  test('答案自动排序', () => {
    bank.remember('排序测试题', 5, true, [3, 0, 2]);
    eq(bank.lookup('排序测试题', 5, true).answer, [0, 2, 3]);
  });

  test('选项数变化则丢弃旧答案', () => {
    bank.remember('选项数会变的题', 4, false, [3]);
    eq(bank.lookup('选项数会变的题', 5, false), null);
  });

  test('下标越界则丢弃旧答案', () => {
    bank.remember('越界测试题', 4, false, [9]);
    eq(bank.lookup('越界测试题', 4, false), null);
  });

  test('hits 累加', () => {
    bank.remember('命中计数题', 3, false, [1]);
    const k = bank.lookup('命中计数题', 3, false).key;
    bank.recordHit(k);
    bank.recordHit(k);
    eq(bank.lookup('命中计数题', 3, false).hits, 3);
  });

  await testAsync('题库持久化到 storage', async () => {
    await bank.flush();
    ok(store.bank, 'storage 中应存在 bank');
    ok(Object.keys(store.bank).length >= 5, '至少写入 5 条');
  });

  await testAsync('clear 清空题库', async () => {
    const before = bank.size();
    ok(before > 0);
    await bank.clear();
    eq(bank.size(), 0);
    await bank.importBank({ k1: { answer: [0], stem: 'x' } });
    eq(bank.size(), 1);
  });

  // ⚠ 控制台那个「清空题库」按钮只写 chrome.storage，
  // 而内容脚本内存里有一份 bank + loaded 标记 —— 内存不跟着清的话：
  //   ① 你看到题库还在用
  //   ② 下一次 record() 会把内存那份**整个写回存储**，清空被彻底撤销
  await testAsync('外部清空存储时，内存那份要跟着清（否则清空按钮等于没按）', async () => {
    bank.clearTried();
    await bank.clear();
    bank.remember('外部清空测试题', 4, false, [1]);
    eq(bank.size(), 1, 'fixture 没准备好');
    await bank.flush();
    eq(Object.keys(store.bank || {}).length, 1, '先得真的落进存储');

    // 模拟"控制台点了清空题库"：只改存储，不碰内容脚本的内存
    store.bank = {};
    const fires = sandbox.__changeListeners || [];
    ok(fires.length >= 2, 'storage.onChanged 监听数不对（config + bank 应该各一个）：' + fires.length);
    fires.forEach((fn) => { try { fn({ bank: { newValue: {} } }, 'local'); } catch (e) { /* noop */ } });
    eq(bank.size(), 0, '存储清了，内存里还留着：' + bank.size() + ' 条');

    // 关键：清空之后再答对一题，不许把旧数据带回来
    bank.remember('清空后新题', 4, false, [2]);
    await bank.flush();
    const keys = Object.keys(store.bank || {});
    eq(keys.length, 1, '旧数据被写回存储了（清空失效）：' + JSON.stringify(keys));
    eq(bank.lookup('外部清空测试题', 4, false), null, '被清掉的那道题又回来了');
  });

  console.log('\n\x1b[1m[5] 试错记忆（防重复枚举）\x1b[0m');

  test('同一组合标记后可查到', () => {
    bank.clearTried();
    const key = 'q-aaaa';
    eq(bank.hasTried(key, [0, 1]), false);
    bank.markTried(key, [0, 1]);
    eq(bank.hasTried(key, [0, 1]), true);
  });

  test('组合顺序无关（[1,0] 与 [0,1] 视为同一组）', () => {
    bank.clearTried();
    bank.markTried('q-bbbb', [1, 0]);
    eq(bank.hasTried('q-bbbb', [0, 1]), true);
  });

  test('不同题目互不干扰', () => {
    bank.clearTried();
    bank.markTried('q-cccc', [0]);
    eq(bank.hasTried('q-dddd', [0]), false);
  });

  test('triedCount 统计正确', () => {
    bank.clearTried();
    const key = 'q-eeee';
    const gen = combinations(4, 2);
    for (let i = 0; i < 6; i++) {
      bank.markTried(key, gen.next().value);
    }
    eq(bank.triedCount(key), 6);
  });

  test('clearTried(key) 只清一题', () => {
    bank.clearTried();
    bank.markTried('q-ffff', [0]);
    bank.markTried('q-gggg', [0]);
    bank.clearTried('q-ffff');
    eq(bank.hasTried('q-ffff', [0]), false);
    eq(bank.hasTried('q-gggg', [0]), true);
  });

  console.log('\n\x1b[1m[6] 配置默认值\x1b[0m');

  const D = sandbox.window.ZHS_DEFAULTS;

  test('默认值齐全', () => {
    ['enabled', 'autoNext', 'autoQuiz', 'useBank', 'bruteForce', 'maxComboSize',
     'pickDelayMs', 'resultWaitMs', 'retryOnWrong', 'learnAnswers'].forEach((k) => {
      ok(D[k] !== undefined, '缺少默认值 ' + k);
    });
  });

  test('默认值是冻结的', () => {
    'use strict';
    let threw = false;
    try { D.autoNext = 'x'; } catch (e) { threw = true; }
    // 非严格模式下静默失败也算通过，只要值没变
    ok(D.autoNext === true, '默认值被改写');
    void threw;
  });

  test('默认倍速保守，高保真点击默认开启', () => {
    eq(D.playbackRate, 1.0, '倍速默认不该激进');
    eq(D.highFidelityClick, true,
      'CDP 点击是绕过平台 isTrusted 检测的唯一手段，必须默认开');
  });

  test('倍速红线常量在两个命名空间下都可用', () => {
    eq(sandbox.window.ZHS_MAX_PLAYBACK_RATE, 1.8);
    eq(sandbox.window.__ZHS.MAX_PLAYBACK_RATE, 1.8,
      'content 侧拿不到的话，video.js 就无从收敛');
  });

  await testAsync('历史配置里的越界倍速在 load 时被压回红线以内', async () => {
    store.config = { playbackRate: 5, enabled: true };   // 模拟旧版本残留 / 手改 storage
    const cfg = await NS.config.load();
    eq(cfg.playbackRate, 1.8, 'load 没有 clamp');
  });

  await testAsync('set 写入越界倍速同样被压回来', async () => {
    const cfg = await NS.config.set({ playbackRate: 9 });
    eq(cfg.playbackRate, 1.8, 'set 没有 clamp');
  });

  await testAsync('popup 改配置走的 storage.onChanged 路径也会 clamp', async () => {
    const fn = sandbox.__changeListeners[0];
    ok(typeof fn === 'function', 'config.js 没有注册 storage.onChanged 监听');
    fn({ config: { oldValue: { playbackRate: 1 }, newValue: { playbackRate: 7 } } }, 'local');
    eq(NS.config.get().playbackRate, 1.8, 'onChanged 路径没有 clamp');
  });

  await testAsync('红线以内和边界值不被误伤', async () => {
    eq((await NS.config.set({ playbackRate: 1.5 })).playbackRate, 1.5);
    eq((await NS.config.set({ playbackRate: 1.8 })).playbackRate, 1.8, '正好压线应当放行');
    eq((await NS.config.set({ playbackRate: 1.81 })).playbackRate, 1.8);
  });

  // 回归：v1 → v2 的配置迁移。
  // v1 里 highFidelityClick 默认 false，用户本地存的那份自然也是 false；
  // v2 把它变成了反检测的必需项，而 Object.assign(DEFAULTS, 用户配置) 里
  // 用户配置写在后面会把新默认值盖掉 —— 光改 DEFAULTS 是没用的。
  await testAsync('v1 老配置里的 highFidelityClick:false 会被迁移成 true', async () => {
    store.config = { playbackRate: 1, mute: true, highFidelityClick: false };
    const cfg = await NS.config.load();
    eq(cfg.highFidelityClick, true, '没有迁移的话点击会带着 isTrusted=false 出去，必被识破');
    eq(cfg.configVersion, 2, '迁移后应打上新版本号');
  });

  await testAsync('其它字段在迁移时保持不变', async () => {
    store.config = { playbackRate: 1.5, mute: false, autoNext: false };
    const cfg = await NS.config.load();
    eq(cfg.mute, false, '用户关掉的静音被改动');
    eq(cfg.autoNext, false, '用户关掉的自动连播被改动');
    eq(cfg.playbackRate, 1.5);
  });

  await testAsync('迁移之后用户再显式关掉是被允许的', async () => {
    store.config = { configVersion: 2, highFidelityClick: true };
    await NS.config.load();
    await NS.config.set({ highFidelityClick: false });
    eq(NS.config.get().highFidelityClick, false,
      'set 是用户此刻的显式选择，不该被迁移逻辑扳回去');
    eq(NS.config.get().configVersion, 2, '不应再触发迁移');
  });

  await testAsync('已迁移过的配置不会每次读取都被扳回 true', async () => {
    store.config = { configVersion: 2, highFidelityClick: false };
    const cfg = await NS.config.load();
    eq(cfg.highFidelityClick, false, 'v2 配置里用户关掉就是关掉');
  });

  await testAsync('storage 变更路径也走同一套迁移', async () => {
    const fn = sandbox.__changeListeners[0];
    fn({ config: { newValue: { highFidelityClick: false } } }, 'local');
    eq(NS.config.get().highFidelityClick, true,
      'popup 写回老配置时走的正是这条路径，不迁移就会把开关又关掉');
  });

  console.log('\n\x1b[1m[7] 模拟一轮完整刷题流程\x1b[0m');

  await testAsync('正确答案在第 6 个组合时被找到（多选）', async () => {
    bank.clearTried();
    await bank.clear();
    const n = 4;
    const TRUE_ANSWER = [0, 2];           // 假设正确答案是 A + C
    const key = bank.keyOf('模拟多选题目', n, true);

    let found = null;
    let tries = 0;
    for (const combo of combinations(n, 3)) {
      if (bank.hasTried(key, combo)) continue;
      tries++;
      bank.markTried(key, combo);
      if (combo.length === TRUE_ANSWER.length &&
          combo.every((v, i) => v === TRUE_ANSWER[i])) {
        found = combo;
        bank.remember('模拟多选题目', n, true, combo);
        break;
      }
    }

    // 枚举序：[0] [1] [2] [3] [0,1] [0,2] → [0,2] 是第 6 个
    eq(found, [0, 2]);
    eq(tries, 6, '应在第 6 次命中');

    // 重播同一题：应直接从题库拿到答案，且不再走枚举
    const hit = bank.lookup('模拟多选题目', 4, true);
    eq(hit.answer, [0, 2]);
  });

  test('已试组合在「答错→重播→再弹」后仍被跳过', () => {
    bank.clearTried();
    const n = 4;
    const key = bank.keyOf('会重播的题目', n, true);

    // 第一次：试了前 3 个组合都不对，平台把视频回退重播
    const first = combinations(n, 3);
    for (let i = 0; i < 3; i++) bank.markTried(key, first.next().value);
    eq(bank.triedCount(key), 3);

    // 第二次弹出同一题：枚举器应从第 4 个组合继续，而不是从头再来
    const again = combinations(n, 3);
    let skipped = 0;
    let nextTry = null;
    for (const combo of again) {
      if (bank.hasTried(key, combo)) { skipped++; continue; }
      nextTry = combo;
      break;
    }
    eq(skipped, 3, '应跳过已试的 3 个组合');
    eq(nextTry, [3], '第 4 个该试的是 [3]');
  });

  test('组合上限内的枚举不会重复试同一组合', () => {
    bank.clearTried();
    const n = 5;
    const key = 'q-stress';
    const seen = new Set();
    for (const combo of combinations(n, 3)) {
      const tag = combo.join(',');
      ok(!seen.has(tag), '重复: ' + tag);
      seen.add(tag);
      bank.markTried(key, combo);
    }
    eq(seen.size, 26);
    eq(bank.triedCount(key), 26);
  });

  console.log('\n\x1b[1m[8] Service worker 顶层执行\x1b[0m');
  console.log('  \x1b[2m回归：manifest 里没有 debugger 权限时，SW 不能因为\n' +
              '  顶层访问 chrome.debugger.onDetach 而注册失败（Chrome 报 status code 15）\x1b[0m');

  /**
   * 造一个 service worker 的全局环境。
   * SW 里没有 window，全局对象是 self。
   */
  function makeSwSandbox(opts) {
    const o = opts || {};
    const seen = { messages: [], badge: [], created: [], scripting: [] };

    // getManifest 直接读真实的 manifest.json —— 后台靠它取「AI 站点那一份
    // content script 的文件列表」来按需补注入，喂假数据就测不出真顺序。
    let realManifest = { content_scripts: [] };
    try {
      realManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    } catch (e) { /* 读不到就用空的 */ }

    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      Math,
      JSON,
      Promise,
      Map,
      Set,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Error,
      RegExp,
      isFinite,
      /**
       * MV3 的 service worker 用 importScripts 同步加载 shared/web-ai.js。
       * 沙箱里没有这个函数，于是后台那条「复用同一份站点表」的路径
       * 在测试里永远不会被执行 —— 用一个真读文件的实现补上，
       * 让 [7] 那几条断言打在真实代码上而不是兜底分支上。
       */
      importScripts(rel) {
        if (o.breakImportScripts) throw new Error('模拟 importScripts 失败');
        const p = path.resolve(path.join(ROOT, 'src', 'background'), rel);
        vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: rel });
      },
      chrome: {
        runtime: {
          onMessage: {
            addListener(fn) { seen.messages.push(fn); },
          },
          onInstalled: { addListener() {} },
          getURL: (p) => 'chrome-extension://test/' + p,
          getManifest: () => realManifest,
        },
        tabs: {
          onRemoved: { addListener() {} },
          update: () => Promise.resolve(),
          query: () => Promise.resolve(o.tabs || []),
          create: (a) => { seen.created.push(a); return Promise.resolve({ id: 99, url: a.url }); },
          sendMessage: (id, msg, cb) => {
            const r = typeof o.tabReply === 'function' ? o.tabReply(id, msg) : o.tabReply;
            if (cb) cb(r || { ok: true });
            return Promise.resolve(r || { ok: true });
          },
        },
        scripting: {
          /**
           * 补注入的观测点。默认就当注入成功（并记一笔），
           * 单个用例可以用 o.inject 换成"注入失败"之类的行为。
           */
          executeScript: (a) => {
            seen.scripting.push(a);
            if (typeof o.inject === 'function') return o.inject(a);
            return Promise.resolve([]);
          },
        },
        storage: {
          local: {
            get: () => Promise.resolve(o.store || {}),
            set: () => Promise.resolve(),
          },
        },
        action: {
          setBadgeText: (a) => { seen.badge.push(a); return Promise.resolve(); },
          setBadgeBackgroundColor: () => Promise.resolve(),
        },
        permissions: {
          contains: () => Promise.resolve(o.grantedDebugger !== false),
        },
      },
      __seen: seen,
    };

    if (o.withDebugger) {
      const calls = [];
      sandbox.chrome.debugger = {
        onDetach: { addListener() {} },
        getTargets: () => Promise.resolve(o.targets || []),
        attach: (t, v) => { calls.push(['attach', t, v]); return Promise.resolve(); },
        detach: () => Promise.resolve(),
        sendCommand: (t, m, p) => { calls.push(['cmd', m, p]); return Promise.resolve({}); },
      };
      sandbox.__cdpCalls = calls;
    }

    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    return sandbox;
  }

  function loadSW(o) {
    const sb = makeSwSandbox(o);
    const code = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
    vm.runInContext(code, sb, { filename: 'service-worker.js' });
    return sb;
  }

  test('没有 debugger 权限时 SW 能干净加载（不再抛 TypeError）', () => {
    let sb;
    try {
      sb = loadSW({ withDebugger: false });
    } catch (e) {
      throw new Error('SW 顶层抛错 → Chrome 会报 status code 15：' + e.message);
    }
    ok(sb.chrome.debugger === undefined, '前提不成立：本应没有 chrome.debugger');
    ok(sb.__seen.messages.length === 1, '消息监听未注册');
  });

  test('有 debugger 权限时 SW 同样正常加载', () => {
    const sb = loadSW({ withDebugger: true });
    ok(sb.chrome.debugger !== undefined, '前提不成立：本应有 chrome.debugger');
    ok(sb.__seen.messages.length === 1, '消息监听未注册');
  });

  function sendToSw(sb, msg, sender) {
    return new Promise((resolve) => {
      let settled = false;
      const reply = (r) => { if (!settled) { settled = true; resolve(r); } };
      let async_ = false;
      for (const fn of sb.__seen.messages) {
        const ret = fn(msg, sender || { tab: { id: 1 }, url: 'http://x/' }, reply);
        if (ret === true) async_ = true;
      }
      if (!async_) reply(null);
      setTimeout(() => reply(null), 800);
    });
  }

  await testAsync('无 debugger 权限时 CDP 点击被优雅拒绝而不是崩溃', async () => {
    const sb = loadSW({ withDebugger: false });
    const r = await sendToSw(sb, { type: 'ZHS_CDP_CLICK', x: 10, y: 20 });
    eq(r.ok, false, '应当失败');
    ok(/debugger/i.test(r.msg), '错误信息应指明 debugger：' + r.msg);
  });

  await testAsync('有 debugger 权限时 CDP 点击真的下发 mousePressed/mouseReleased', async () => {
    const sb = loadSW({ withDebugger: true });
    const r = await sendToSw(sb, { type: 'ZHS_CDP_CLICK', x: 10, y: 20 });
    eq(r.ok, true, '应当成功: ' + JSON.stringify(r));
    const types = sb.__cdpCalls.filter((c) => c[1] === 'Input.dispatchMouseEvent').map((c) => c[2].type);
    ok(types.includes('mousePressed'), '缺少 mousePressed：' + JSON.stringify(types));
    ok(types.includes('mouseReleased'), '缺少 mouseReleased：' + JSON.stringify(types));
    ok(r.isTrusted === true, '应标记 isTrusted');
  });

  await testAsync('ZHS_LOG 进入环形缓冲并可被 dump', async () => {
    const sb = loadSW({ withDebugger: false });
    await sendToSw(sb, { type: 'ZHS_LOG', entry: { t: 1, level: 'ok', msg: 'hello' } });
    const dump = await sendToSw(sb, { type: 'ZHS_LOG_DUMP' });
    ok(dump.ok, 'dump 失败');
    ok(dump.logs.some((e) => e.msg === 'hello'), '日志未进缓冲');
  });

  // ── 网页 AI 抢答用的 CDP 原语 ──────────────────────────

  test('后台确实加载了 shared/web-ai.js 的站点表', () => {
    const sb = loadSW({ withDebugger: false });
    ok(sb.ZHS_webAI, 'importScripts 那条路径没把站点表挂上来');
    ok(sb.ZHS_webAI.PROVIDERS.length >= 5, '站点表不完整');
    ok(sb.ZHS_webAI.PROVIDERS.some((p) => p.id === 'doubao'), '缺豆包');
    ok(sb.ZHS_webAI.PROVIDERS.some((p) => p.id === 'deepseek'), '缺 DeepSeek');
  });

  await testAsync('ZHS_CDP_TEXT 走 Input.insertText（React 站点唯一认的塞字方式）', async () => {
    const sb = loadSW({ withDebugger: true });
    const r = await sendToSw(sb, { type: 'ZHS_CDP_TEXT', text: '答案：B' });
    eq(r.ok, true, '应当成功: ' + JSON.stringify(r));
    const call = sb.__cdpCalls.find((c) => c[1] === 'Input.insertText');
    ok(call, '没有下发 Input.insertText：' + JSON.stringify(sb.__cdpCalls.map((c) => c[1])));
    eq(call[2].text, '答案：B', '文本没传对');
  });

  await testAsync('塞字前会 trim：行尾空白会让某些站点的发送按钮一直不点亮', async () => {
    const sb = loadSW({ withDebugger: true });
    await sendToSw(sb, { type: 'ZHS_CDP_TEXT', text: '\n\n答案：B\n\n' });
    const call = sb.__cdpCalls.find((c) => c[1] === 'Input.insertText');
    eq(call[2].text, '答案：B', '首尾空白没被收掉');
  });

  await testAsync('ZHS_CDP_KEY 成对派发 keyDown/keyUp，且 keyDown 带 text', async () => {
    const sb = loadSW({ withDebugger: true });
    const r = await sendToSw(sb, { type: 'ZHS_CDP_KEY', key: 'Enter' });
    eq(r.ok, true);
    const types = sb.__cdpCalls.filter((c) => c[1] === 'Input.dispatchKeyEvent').map((c) => c[2].type);
    ok(types.includes('keyDown'), '缺 keyDown：' + JSON.stringify(types));
    ok(types.includes('keyUp'), '缺 keyUp —— 挂在 keyup 上的发送逻辑会漏掉');
    const down = sb.__cdpCalls.find((c) => c[1] === 'Input.dispatchKeyEvent' && c[2].type === 'keyDown');
    eq(down[2].key, 'Enter');
    eq(down[2].text, '\r', 'keyDown 必须带 \\r，否则浏览器只是"按了个键"，不会插东西');
  });

  await testAsync('raw 模式下走 rawKeyDown + insertText + keyUp（给挂在 input 上的站点兜底）', async () => {
    const sb = loadSW({ withDebugger: true });
    const r = await sendToSw(sb, { type: 'ZHS_CDP_KEY', key: 'Enter', raw: true });
    eq(r.ok, true);
    eq(r.raw, true);
    const keyTypes = sb.__cdpCalls.filter((c) => c[1] === 'Input.dispatchKeyEvent').map((c) => c[2].type);
    eq(keyTypes, ['rawKeyDown', 'keyUp'], '键盘序列不对：' + JSON.stringify(keyTypes));
    const inserts = sb.__cdpCalls.filter((c) => c[1] === 'Input.insertText');
    eq(inserts.length, 1, '应当用 insertText 补一个 \\r');
    eq(inserts[0][2].text, '\r');
    // 顺序也要对：rawKeyDown → insertText → keyUp
    // （calls 里还混着 ensureAttach 的 attach 记录，先筛出输入相关的）
    const seq = sb.__cdpCalls
      .map((c) => c[1])
      .filter((m) => m === 'Input.dispatchKeyEvent' || m === 'Input.insertText')
      .join('>');
    eq(seq, 'Input.dispatchKeyEvent>Input.insertText>Input.dispatchKeyEvent', '调用顺序不对：' + seq);
  });

  await testAsync('没有 debugger 权限时文本输入被优雅拒绝', async () => {
    const sb = loadSW({ withDebugger: false });
    const r = await sendToSw(sb, { type: 'ZHS_CDP_TEXT', text: 'x' });
    eq(r.ok, false);
    ok(/debugger/i.test(r.msg), '错误信息应指明 debugger：' + r.msg);
  });

  await testAsync('开关关掉后 ZHS_AI_ASK 直接拒绝，不去开标签页', async () => {
    const sb = loadSW({ withDebugger: false, store: { config: { askWebAI: false } } });
    const r = await sendToSw(sb, {
      type: 'ZHS_AI_ASK',
      question: { stem: '题目', options: ['甲', '乙'], multi: false },
    });
    eq(r.ok, false);
    ok(/关闭/.test(r.msg), '应当说明是开关关掉：' + r.msg);
    eq(sb.__seen.created.length, 0, '不该新开标签页');
  });

  await testAsync('题目不完整时 ZHS_AI_ASK 不会拿空题去骚扰 AI 站点', async () => {
    const sb = loadSW({ withDebugger: false, store: { config: { askWebAI: true } } });
    const r = await sendToSw(sb, { type: 'ZHS_AI_ASK', question: { stem: '题目', options: [] } });
    eq(r.ok, false);
    ok(/不完整/.test(r.msg), 'msg=' + r.msg);
    eq(sb.__seen.created.length, 0, '不该新开标签页');
  });

  await testAsync('缓存命中时直接给出答案：不开标签页、不等待', async () => {
    const q = { stem: '同一道题', options: ['甲', '乙'], multi: false };
    const key = 'deadbeef-2-s';
    const store = {
      config: { askWebAI: true },
      aiCache: {
        [key]: { answer: [1], provider: 'doubao', reason: '乙更合适', at: Date.now() },
      },
    };
    const sb = loadSW({ withDebugger: false, store });
    // 把哈希算成已知值，好让上面那条缓存命中
    sb.ZHS_webAI.questionKey = () => key;

    const before = sb.__seen.created.length;
    const r = await sendToSw(sb, { type: 'ZHS_AI_ASK', question: q, timeoutMs: 20000 });

    eq(r.ok, true, '应当命中缓存: ' + JSON.stringify(r));
    eq(r.answer, [1], '缓存里的答案没取出来');
    eq(r.cached, true, '应当标记为缓存命中');
    eq(r.provider, 'doubao');
    eq(sb.__seen.created.length, before, '缓存命中不该新开 AI 标签页');
  });

  await testAsync('ZHS_AI_PROBE 报告站点表（排障入口）', async () => {
    const sb = loadSW({ withDebugger: true });
    sb.chrome.tabs.query = () => Promise.resolve([{ id: 7, url: 'https://www.doubao.com/chat/', active: true }]);
    const r = await sendToSw(sb, { type: 'ZHS_AI_PROBE' });
    eq(r.ok, true);
    ok(r.scriptsLoaded, '站点表没加载');
    ok(r.providers.length >= 5, 'providers 不全');
    eq(r.openTabs[0].id, 7, '没报告已打开的 AI 标签页');
    ok(r.debuggerAvailable, 'debugger 可用性没报告');
  });

  /** sendToSw 的默认等待只有 800ms，而这条链路里有一次 1.2s 的 ping 超时要等 */
  function sendToSwLong(sb, msg, sender, waitMs) {
    return new Promise((resolve) => {
      let settled = false;
      const reply = (r) => { if (!settled) { settled = true; resolve(r); } };
      let async_ = false;
      for (const fn of sb.__seen.messages) {
        const ret = fn(msg, sender || { tab: { id: 1 }, url: 'http://x/' }, reply);
        if (ret === true) async_ = true;
      }
      if (!async_) reply(null);
      setTimeout(() => reply(null), waitMs || 6000);
    });
  }

  await testAsync('AI 标签页的归属由域名判断，不受 tabs.query 模式的宽窄影响', async () => {
    const sb = loadSW({ withDebugger: false });
    // 故意返回一批混杂的标签页：只有真正属于站点表的那两个该被收下。
    // 「子域名伪装」那条（chat.deepseek.com.evil.com）尤其不能放进来。
    sb.chrome.tabs.query = () => Promise.resolve([
      { id: 7, url: 'https://chat.deepseek.com/a/chat/s/1', active: false },
      { id: 8, url: 'https://www.doubao.com/chat/2', active: true },
      { id: 9, url: 'https://chat.deepseek.com.evil.com/', active: false },
      { id: 10, url: 'https://www.zhihuishu.com/study/x', active: false },
      { id: 11, url: 'chrome://extensions/', active: false },
    ]);
    const r = await sendToSw(sb, { type: 'ZHS_AI_PROBE' });
    eq(r.openTabs.map((t) => t.id), [7, 8], '收下的标签页不对：' + JSON.stringify(r.openTabs));
  });

  await testAsync('ZHS_AI_PROBE 会报告每个 AI 标签页的脚本是否活着', async () => {
    const sb = loadSW({ withDebugger: false, tabs: [
      { id: 7, url: 'https://www.doubao.com/chat/', active: true },
    ] });
    // 让 ping 失败：这正是「页面开着但没挂脚本」的样子
    sb.chrome.tabs.sendMessage = (id, msg, cb) => { if (cb) cb(undefined); };
    const r = await sendToSw(sb, { type: 'ZHS_AI_PROBE' });
    eq(r.openTabs[0].scriptAlive, false, 'ping 失败时必须如实报告 scriptAlive=false');
    eq(r.openTabs[0].provider, 'doubao', '应当带上是哪一家');
  });

  await testAsync('已打开的 AI 页没有挂脚本时：补注入脚本，然后正常提问', async () => {
    const sb = loadSW({ withDebugger: false, tabs: [
      { id: 7, url: 'https://www.doubao.com/chat/', active: true },
    ] });
    let injected = false;
    sb.chrome.tabs.sendMessage = (id, msg, cb) => {
      if (msg.type === 'ZHS_AI_PING') { if (cb) cb(injected ? { ok: true } : undefined); return; }
      if (msg.type === 'ZHS_AI_ASK') {
        if (cb) cb({ ok: true, answer: [1], provider: 'doubao', reason: '测试' });
      }
    };
    sb.chrome.scripting.executeScript = (a) => {
      sb.__seen.scripting.push(a);
      injected = true;
      return Promise.resolve([]);
    };

    const r = await sendToSwLong(sb, {
      type: 'ZHS_AI_ASK',
      timeoutMs: 9000,
      question: { stem: '测试题', options: ['甲', '乙', '丙'], multi: false },
    });

    // 这一条是这次修的核心：以前会直接回「AI 页无响应（可能没登录或被卸载）」，
    // 而真相往往是"扩展重载过、那一页没刷"，补注入就能救回来
    eq(r.ok, true, '补注入之后应当能正常问出答案：' + JSON.stringify(r));
    eq(r.answer, [1]);
    ok(sb.__seen.scripting.length > 0, '压根没补注入');
    // 补注入必须按 manifest 的顺序来，否则 web-ai.js 可能先于 defaults.js 跑
    const files = sb.__seen.scripting.map((a) => a.files[0]);
    eq(files[0], 'src/shared/defaults.js', '第一个应当是 defaults.js：' + JSON.stringify(files));
    ok(files.includes('src/ai/web-ai.js'), '没注入站点驱动：' + JSON.stringify(files));
    eq(sb.__seen.created.length, 0, '已经开着的标签页不该再新开一个');
  });

  await testAsync('补注入也救不回来时，报错要指明"刷新那一页"而不是"没登录"', async () => {
    const sb = loadSW({ withDebugger: false, tabs: [
      { id: 7, url: 'https://www.doubao.com/chat/', active: true },
    ] });
    sb.chrome.tabs.sendMessage = (id, msg, cb) => { if (cb) cb(undefined); };   // 永远没回执
    sb.chrome.scripting.executeScript = () => Promise.reject(new Error('被拦'));

    // 这条路径要等满两次 ping 超时 + 一次 8 秒的补注入等待，给足时间
    const r = await sendToSwLong(sb, {
      type: 'ZHS_AI_ASK',
      timeoutMs: 9000,
      question: { stem: '测试题', options: ['甲', '乙'], multi: false },
    }, null, 20000);
    eq(r.ok, false);
    ok(/刷新|没挂|脚本/.test(r.msg), '错误信息应当指向"脚本没挂/刷新页面"：' + r.msg);
    ok(!/可能没登录/.test(r.msg), '别再给"可能没登录"这种误导性结论：' + r.msg);
  });

  await testAsync('tabs.query 用的模式必须是 Chrome 认得的合法 match pattern', async () => {
    const sb = loadSW({ withDebugger: false });
    const pats = [];
    sb.chrome.tabs.query = (q) => { pats.push(q.url); return Promise.resolve([]); };
    await sendToSw(sb, { type: 'ZHS_AI_PROBE' });
    ok(pats.length > 0, '一次 query 都没发');
    for (const p of pats) {
      ok(typeof p === 'string', '模式不是字符串：' + JSON.stringify(p));
      // 以前这里是用站点表的域名正则现拼 match pattern 的，
      // `(?:www\.)?` 拼出来是坏的（*://*.?deepseek\.com$/*），tabs.query 会直接抛错。
      ok(/^\*:\/\/(\*\.)?[a-z0-9.*-]+(\/.*)?$/i.test(p), '模式形态可疑：' + p);
      ok(!/[\\()?$|]/.test(p), '模式里混进了正则语法：' + p);
    }
  });

  await testAsync('页面探测报得出「每个选择器命中几个」', async () => {
    const sb = loadSW({
      withDebugger: true,
      tabs: [{ id: 7, url: 'https://chat.deepseek.com/a/chat/s/1', active: true }],
      // ping 要能应答（否则 ensureAiTab 会白等 8 秒），但 ASK 一律失败 ——
      // 页面探测正好跑在失败路径上
      tabReply: (id, msg) => (msg.type === 'ZHS_AI_PING'
        ? { ok: true }
        : { ok: false, msg: '假装的页面侧失败', wantShot: true }),
    });
    // 让页面里的 Runtime.evaluate 回两份：先结构探测、再选择器统计
    sb.chrome.debugger.sendCommand = (t, method, params) => {
      if (method !== 'Runtime.evaluate') return Promise.resolve({});
      const expr = params.expression;
      if (/querySelectorAll\(s\)\.length/.test(expr)) {
        return Promise.resolve({
          result: { value: JSON.stringify({ input: [['textarea#chat-input', 1]], send: [['div[role="button"]', 2]], answer: [['.ds-markdown', 0]], stop: [] }) },
        });
      }
      return Promise.resolve({
        result: { value: JSON.stringify({ href: 'https://chat.deepseek.com/a/chat/s/1', active: 'textarea.chat-input', editor: [], buttons: [], stopVisible: false }) },
      });
    };

    const r = await sendToSw(sb, {
      type: 'ZHS_AI_ASK',
      timeoutMs: 9000,
      question: { stem: '测试题', options: ['甲', '乙'], multi: false },
    }, null, 12000);

    eq(r.ok, false, '页面侧说失败了，这里应当是失败路径');
    ok(r.dom, '没带回来页面探测结果 —— 「试发一条」的现场就靠它');
    ok(r.dom.selectors, '缺「选择器命中数」，用户会找不到这一段：' + JSON.stringify(r.dom));
    eq(r.dom.selectors.answer[0][1], 0, '命中数要如实报 0（示例里 .ds-markdown 就是 0）');
    ok(r.dom.selectorSource, '没说明这份选择器表是哪来的');
  });

  await testAsync('站点表没加载上来时，选择器统计仍然要给得出来（内置兜底表）', async () => {
    // 这一条守的是真踩过的坑：选择器统计整块挂在 `if (WEB_AI)` 里，
    // 而 WEB_AI 是 service worker 里 importScripts 的结果 —— 它一失败，
    // 那一段就**静默消失**，用户根本找不到。
    const sb = loadSW({
      withDebugger: true,
      breakImportScripts: true,          // 模拟 importScripts 失败
      tabs: [{ id: 7, url: 'https://chat.deepseek.com/a/chat/s/1', active: true }],
      tabReply: (id, msg) => (msg.type === 'ZHS_AI_PING'
        ? { ok: true }
        : { ok: false, msg: '假装的页面侧失败', wantShot: true }),
    });
    eq(sb.ZHS_webAI, undefined, '前提不成立：这次本来就该拿不到站点表');

    let gotSelectorQuery = false;
    sb.chrome.debugger.sendCommand = (t, method, params) => {
      if (method !== 'Runtime.evaluate') return Promise.resolve({});
      const expr = params.expression;
      if (/querySelectorAll\(s\)\.length/.test(expr)) {
        gotSelectorQuery = true;
        ok(/textarea#chat-input/.test(expr),
          '兜底表里应当有 DeepSeek 的输入框选择器：' + expr.slice(0, 200));
        return Promise.resolve({ result: { value: JSON.stringify({ input: [['textarea#chat-input', 1]] }) } });
      }
      return Promise.resolve({
        result: { value: JSON.stringify({ href: 'https://chat.deepseek.com/a/chat/s/1', active: '', editor: [], buttons: [], stopVisible: false }) },
      });
    };

    const r = await sendToSw(sb, {
      type: 'ZHS_AI_ASK',
      timeoutMs: 9000,
      question: { stem: '测试题', options: ['甲', '乙'], multi: false },
    }, null, 12000);

    ok(gotSelectorQuery, '压根没发选择器统计那一段 —— 兜底表没生效');
    ok(r.dom && r.dom.selectors, '拿不到站点表时也该给出命中数：' + JSON.stringify(r.dom));
    eq(r.dom.selectorSource, '内置兜底表', '应当标明用的是兜底表');
  });

  await testAsync('探测失败时要说明原因，而不是悄悄返回空', async () => {
    const sb = loadSW({
      withDebugger: true,
      tabs: [{ id: 7, url: 'https://chat.deepseek.com/a/chat/s/1', active: true }],
      tabReply: (id, msg) => (msg.type === 'ZHS_AI_PING'
        ? { ok: true }
        : { ok: false, msg: '假装的页面侧失败', wantShot: true }),
    });
    sb.chrome.debugger.sendCommand = (t, method) => {
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ exceptionDetails: { text: '页面抛异常了' } });
      }
      return Promise.resolve({});
    };
    const r = await sendToSw(sb, {
      type: 'ZHS_AI_ASK',
      timeoutMs: 9000,
      question: { stem: '测试题', options: ['甲', '乙'], multi: false },
    }, null, 12000);
    ok(r.dom && r.dom.error, '探测失败必须带 error 说明：' + JSON.stringify(r.dom));
  });

  await testAsync('ZHS_AI_CACHE_CLEAR 清空缓存', async () => {
    const sb = loadSW({ withDebugger: false });
    const r = await sendToSw(sb, { type: 'ZHS_AI_CACHE_CLEAR' });
    eq(r.ok, true);
    eq(r.cleared, 0, '初始缓存应当为空');
  });

  await testAsync('未知消息类型被忽略（返回 undefined 不占用通道）', async () => {
    const sb = loadSW({ withDebugger: false });
    const r = await sendToSw(sb, { type: 'NOPE' });
    eq(r, null, '不该有回执');
  });

  // ── 目录扫描 ──────────────────────────────────────────────
  //
  // 目录结构相关的断言放在 tests/playlist.test.js 里 —— 那几条要用真实 DOM
  // （querySelectorAll / innerText / getBoundingClientRect），而这个文件
  // 是**零依赖**的纯逻辑测试，不该把 jsdom 拉进来当硬依赖。
  // 这里只守一条不依赖 DOM 的：展开逻辑必须是 playlist.js 自己实现的，
  // 而不是某个外部库顺手带来的。
  test('目录展开逻辑在 playlist.js 里自己实现（不是靠外部库）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/content/playlist.js'), 'utf8');
    ok(/function flattenLeaves/.test(src), '缺少 flattenLeaves');
    ok(/function collectLeaves/.test(src), '缺少"往下收叶子"的遍历');
    ok(/isPotentialContainer|INLINE_TAGS/.test(src), '缺少"容器 vs 课时"的判断');
    // 以前这里是 dedupe(vis)：把子项当"重复项"删掉，结果只剩章节标题，
    // 表现就是"识别不到小章节"。这条断言防止有人改回去。
    ok(!/this\.items = dedupe\(/.test(src),
      'scan() 里又用 dedupe 直接收尾了 —— 那会把嵌套的小章节当重复项删掉');
  });

  console.log('\n\x1b[1m[9] manifest 静态校验\x1b[0m');

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const CONTENT_CS = manifest.content_scripts[0];

  test('content script 只有两条：知到页一条、AI 站点一条', () => {
    // 这一条原本是「只有一条」，用来守住那个已被证伪的主世界 isTrusted 补丁
    // （见 [10]）不再被加回来。现在多了第二条，是给网页版 AI 抢答用的：
    // 它只注入到 AI 站点、只加载站点驱动，跟主世界补丁没有任何关系。
    eq(manifest.content_scripts.length, 2,
      '除知到页与 AI 站点外，不应该再有第三条 content script');
    ok(!manifest.content_scripts.some((c) => c.world === 'MAIN'),
      '无论哪一条都不能是 world:MAIN');
  });

  test('两条 content script 的适用范围互不重叠', () => {
    const zhihu = manifest.content_scripts[0].matches.join(' ');
    const ai = manifest.content_scripts[1].matches.join(' ');
    ok(/zhihuishu\.com/.test(zhihu) && !/zhihuishu/.test(ai), 'AI 段不该注入知到');
    ok(/doubao|deepseek|kimi/.test(ai) && !/doubao|deepseek/.test(zhihu),
      '知到段不该注入 AI 站点');
  });

  test('网页 AI 抢答用到的 CDP 原语在 manifest/后台里都齐了', () => {
    const swSrc = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
    ok(/'ZHS_CDP_TEXT'/.test(swSrc), '后台没有处理高保真文本输入');
    ok(/Input\.insertText/.test(swSrc), '没有走 CDP 的 insertText，React 站点会收不到输入');
    ok(/'ZHS_CDP_KEY'/.test(swSrc), '后台没有处理按键');
    ok(/Input\.dispatchKeyEvent/.test(swSrc), '没有走 CDP 的按键派发');
    ok(/'ZHS_AI_ASK'/.test(swSrc), '后台没有转发 AI 提问');
    ok(/importScripts/.test(swSrc), '后台没有复用 shared/web-ai.js 的站点表');
  });

  test('host_permissions 覆盖了网页版 AI 站点', () => {
    const hosts = manifest.host_permissions.join(' ');
    ['doubao.com', 'deepseek.com', 'kimi.com', 'tongyi.com', 'yuanbao.tencent.com'].forEach((h) => {
      ok(hosts.includes(h), '缺少 host permission：' + h);
    });
  });

  test('manifest 引用的每个文件都真实存在', () => {
    const refs = []
      .concat(CONTENT_CS.js)
      .concat([manifest.background.service_worker, manifest.action.default_popup])
      .concat(Object.values(manifest.icons))
      .concat(Object.values(manifest.action.default_icon));

    eq(refs.filter((p) => !fs.existsSync(path.join(ROOT, p))), [], '缺失文件');
  });

  test('模块加载顺序满足依赖关系', () => {
    const js = CONTENT_CS.js;
    const idx = (n) => js.findIndex((p) => p.endsWith(n));
    ok(idx('defaults.js') < idx('dom.js'), 'defaults 必须在 dom 之前');
    ok(idx('dom.js') < idx('config.js'), 'dom 必须在 config 之前');
    ok(idx('config.js') < idx('video.js'), 'config 必须在 video 之前');
    ok(idx('video.js') < idx('main.js'), 'video 必须在 main 之前');
    ok(idx('quiz.js') < idx('main.js'), 'quiz 必须在 main 之前');
  });

  test('声明了 debugger 权限（CDP 真实点击的前提）', () => {
    ok(manifest.permissions.includes('debugger'),
      '没有它就绕不开平台对 isTrusted 的检测');
  });

  test('debugger 没有出现在 optional_permissions 里', () => {
    ok(!(manifest.optional_permissions || []).includes('debugger'),
      'Chrome 会报 "Permission cannot be listed as optional" 并忽略该声明');
  });

  test('运行时权限齐全', () => {
    ['storage', 'tabs', 'scripting', 'debugger'].forEach((p) => {
      ok(manifest.permissions.includes(p), '缺少权限 ' + p);
    });
  });

  test('host_permissions 覆盖知到域名', () => {
    ok(manifest.host_permissions.some((h) => /zhihuishu\.com/.test(h)), '缺少 zhihuishu host');
  });

  test('matches 同时覆盖知到与本地验证地址', () => {
    ok(CONTENT_CS.matches.some((m) => /zhihuishu\.com/.test(m)), '缺少知到');
    ok(CONTENT_CS.matches.some((m) => /127\.0\.0\.1/.test(m)), '缺少本地验证地址');
  });

  test('manifest_version 为 3 且声明了 background.service_worker', () => {
    eq(manifest.manifest_version, 3);
    ok(manifest.background && typeof manifest.background.service_worker === 'string');
  });

  console.log('\n\x1b[1m[10] 反检测方案的一致性\x1b[0m');
  console.log('  \x1b[2m实测结论：Chrome 把 isTrusted 定义在每个事件实例自己身上、\n' +
              '  且 configurable:false —— JS 侧既改不了原型也改不了实例，\n' +
              '  主世界 getter 补丁这条路已被证伪。唯一手段是 CDP 派发点击。\n' +
              '  这一节守住这个结论不被改回那条死路。\x1b[0m');

  test('没有残留的 world:MAIN content script', () => {
    ok(!manifest.content_scripts.some((c) => c.world === 'MAIN'),
      'world:MAIN 对 isTrusted 无效，留着只会造成「已防护」的错觉');
  });

  test('已证伪的补丁文件被删除', () => {
    ok(!fs.existsSync(path.join(ROOT, 'src/stealth/main-world.js')),
      'src/stealth/main-world.js 应当删除');
  });

  test('高保真点击默认开启（否则反检测形同虚设）', () => {
    eq(D.highFidelityClick, true,
      '关掉它的话所有点击都会带着 isTrusted=false 出去，立刻被平台识破');
  });

  test('dom.js 的 realClick 会走 CDP 分支', () => {
    const domSrc = fs.readFileSync(path.join(ROOT, 'src/content/dom.js'), 'utf8');
    ok(/highFidelityClick/.test(domSrc), 'realClick 没有检查高保真开关');
    ok(/cdpClick/.test(domSrc), 'realClick 没有走 CDP 通道');
    ok(/'ZHS_CDP_CLICK'/.test(domSrc), '没有向 background 发 CDP 点击消息');
  });

  test('CDP 点击会把坐标换算到顶层视口', () => {
    const domSrc = fs.readFileSync(path.join(ROOT, 'src/content/dom.js'), 'utf8');
    ok(/absolutePoint/.test(domSrc), '缺少跨 iframe 的坐标换算');
    ok(/frameElement/.test(domSrc), '没有累加 iframe 偏移，子框架里的点击会打偏');
  });

  test('background 在缺少 debugger 权限时优雅降级而不是崩溃', () => {
    const swSrc = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
    ok(/DEBUGGER_ENABLED/.test(swSrc), '缺少权限存在性判断');
    ok(/const dbg = /.test(swSrc), '没有做 API 兜底引用');
  });


  // ── 汇总 ────────────────────────────────────────────────

  console.log('\n' + '─'.repeat(48));
  console.log(`  \x1b[32m通过 ${pass}\x1b[0m    \x1b[31m失败 ${fail}\x1b[0m`);
  console.log('─'.repeat(48) + '\n');

  if (fail) {
    failures.forEach((f) => console.log('  ✗ ' + f.name + '\n    ' + f.err.stack));
    process.exit(1);
  }
})();
