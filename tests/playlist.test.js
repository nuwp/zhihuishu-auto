/**
 * playlist.test.js — 课时目录识别（jsdom）
 *
 * 专门守一类很容易复发的错：**目录是棵树，不是平表**。
 *
 * 知到把课程拆成  1.2 → 1.2.1 / 1.2.2 / 1.2.3  这种两层结构时，
 * 章节容器和它内部的课时往往命中同一批选择器。早先的实现用 dedupe() 去重 ——
 * 而 dedupe 的语义是"去掉被别的候选包含的那个"，于是**子项全被当成重复项删掉**，
 * 只剩下章节标题本身：它没有时长、点了不播，表现就是
 * 「识别不到小章节」+ 自动连播走到一半卡死。
 *
 * 现在 scan() 走 flattenLeaves()：把命中的容器整棵展开成叶子课时，
 * 章节容器（内部还能捞出课时样的后代）丢掉，叶子留下，顺序仍是文档顺序。
 *
 * 运行： node tests/playlist.test.js
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
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '  got=' + sa + ' want=' + sb);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// ── 搭一个只装目录扫描所需环境的沙箱 ─────────────────────
//
// 只加载 defaults / dom / config / playlist 四个文件。
// video.js、quiz.js、main.js 一个都不进 —— 它们会起定时器、注入监听器，
// 对一个只想知道"扫出几个条目"的测试来说全是噪音。
//
// 注入方式：把每个文件包成函数再调，把 window / self / document / location
// 当参数传进去。两个原因：
//   1. jsdom 的 win.eval 里**没有裸的 window / self 标识符**
//      （实测 `typeof window` 直接抛 ReferenceError），而 shared/defaults.js
//      的收尾是 `(typeof window !== 'undefined' ? window : self)`；
//   2. 包成函数后，文件里的裸 document / location 走的是函数作用域，
//      而不是 jsdom 的 eval 上下文 —— 那个上下文里同样没有它们。

function inject(win, rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // eslint-disable-next-line no-new-func
  const runner = new win.Function('window', 'self', 'document', 'location', code);
  runner(win, win, win.document, win.location);
}

function makeEnv(innerHtml) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body>' + innerHtml + '</body></html>',
    { pretendToBeVisual: true, url: 'https://www.zhihuishu.com/study/x' }
  );
  const win = dom.window;

  win.chrome = {
    storage: {
      local: {
        get: () => Promise.resolve({ config: {} }),
        set: () => Promise.resolve(),
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      id: 'test',
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage() {},
      lastError: null,
    },
  };

  patchLayout(win);

  for (const rel of [
    'src/shared/defaults.js',
    'src/content/dom.js',
    'src/content/config.js',
    'src/content/playlist.js',
  ]) {
    inject(win, rel);
  }

  return { dom, win, NS: win.__ZHS };
}

/**
 * jsdom 里所有元素的 getBoundingClientRect 都是 0，目录扫描的可见性过滤
 * 会把它们全部判成不可见（一个都扫不出来）。按 computed style 伪造一个
 * 正常尺寸的矩形 —— 和 e2e.test.js 里的 patchDom 是同一件事。
 */
function patchLayout(win) {
  const rect = (visible) => ({
    x: visible ? 100 : 0,
    y: visible ? 100 : 0,
    width: visible ? 260 : 0,
    height: visible ? 36 : 0,
    top: visible ? 100 : 0,
    left: visible ? 100 : 0,
    right: visible ? 360 : 0,
    bottom: visible ? 136 : 0,
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
  win.Element.prototype.scrollIntoView = function () { /* jsdom 没有 */ };
}

/** 扫一遍，返回每个条目的文本（空白压平） */
function scan(innerHtml) {
  const { dom, win, NS } = makeEnv(innerHtml);
  const pl = new NS.Playlist();
  pl.scan();
  const texts = pl.items.map((el) => NS.dom.textOf(el).replace(/\s+/g, ' ').trim());
  try { dom.window.close(); } catch (e) { /* noop */ }
  void win;
  return { texts, pl };
}

/** 直接测 flattenLeaves：输入一组节点，看它吐出哪些 */
function flatten(innerHtml, selector) {
  const { dom, win, NS } = makeEnv(innerHtml);
  const list = Array.from(win.document.querySelectorAll(selector));
  const out = NS.playlistUtils.flattenLeaves(list);
  const texts = out.map((el) => NS.dom.textOf(el).replace(/\s+/g, ' ').trim());
  try { dom.window.close(); } catch (e) { /* noop */ }
  return texts;
}

console.log('\n\x1b[1m知到自动助手 — 课时目录识别（jsdom）\x1b[0m\n');

// ── [1] 嵌套目录 ─────────────────────────────────────────
console.log('\x1b[1m[1] 两层目录：章节容器 + 内部课时\x1b[0m');

const NESTED = `
  <aside class="catalogue">
    <div class="catalogue_list">
      <div class="catalogue_learn_item">
        <span class="title">1.2 Confucianism</span>
        <div class="sub">
          <div class="catalogue_learn_item">
            <span>1.2.1 Confucianism and Confucius</span><span class="dur">12:33</span>
          </div>
          <div class="catalogue_learn_item">
            <span>1.2.2 The Analects and Benevolence</span><span class="dur">08:10</span>
          </div>
        </div>
      </div>
      <div class="catalogue_learn_item">
        <span>1.2.3 Benevolence in the Modern World</span><span class="dur">10:00</span>
      </div>
    </div>
  </aside>`;

check('小章节不再被漏掉：1.2.1 / 1.2.2 / 1.2.3 全都进列表', () => {
  const { texts } = scan(NESTED);
  ok(texts.length >= 2, '至少两个条目，实际 ' + texts.length);
  ok(texts.some((t) => t.includes('1.2.1')), '漏了 1.2.1：' + JSON.stringify(texts));
  ok(texts.some((t) => t.includes('1.2.2')), '漏了 1.2.2：' + JSON.stringify(texts));
  ok(texts.some((t) => t.includes('1.2.3')), '漏了 1.2.3：' + JSON.stringify(texts));
});

check('章节容器本身不留在列表里（它没有时长，点了不播）', () => {
  const { texts } = scan(NESTED);
  eq(texts.some((t) => /^1\.2\s+Confucianism$/.test(t)), false,
    '章节标题被当成课时了：' + JSON.stringify(texts));
});

check('展开后仍是文档顺序（next 顺着走才不会乱跳）', () => {
  const { texts } = scan(NESTED);
  const order = texts.map((t) => (t.match(/1\.2\.(\d)/) || [])[1]).join('');
  eq(order, '123', '顺序乱了：' + JSON.stringify(texts));
});

check('next() 从第一项能一路走到最后一项', () => {
  const { dom, NS } = makeEnv(NESTED);
  const pl = new NS.Playlist();
  pl.scan();
  const visited = [];
  let cur = pl.items[0];
  visited.push(NS.dom.textOf(cur));
  for (let i = 0; i < 10; i++) {
    const nxt = pl.next(cur);
    if (!nxt) break;
    visited.push(NS.dom.textOf(nxt));
    cur = nxt;
  }
  eq(visited.length, pl.items.length,
    '走不到底：走了 ' + visited.length + ' 项，列表里有 ' + pl.items.length + ' 项');
  ok(/10:00/.test(visited[visited.length - 1]), '最后一项不对：' + visited[visited.length - 1]);
  try { dom.window.close(); } catch (e) { /* noop */ }
});

// ── [2] 更深的层级 ───────────────────────────────────────
console.log('\n\x1b[1m[2] 三层结构\x1b[0m');

check('三层结构一路展开到底，中间层容器全部丢掉', () => {
  const { texts } = scan(`
    <div class="catalogue_list">
      <div class="catalogue_learn_item">
        <span>第 1 章</span>
        <div>
          <div class="catalogue_learn_item">
            <span>1.1 小节</span>
            <div>
              <div class="catalogue_learn_item"><span>1.1.1 课时</span><span>05:00</span></div>
              <div class="catalogue_learn_item"><span>1.1.2 课时</span><span>06:00</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>`);
  ok(texts.some((t) => t.includes('1.1.1')), '漏了第三层：' + JSON.stringify(texts));
  ok(texts.some((t) => t.includes('1.1.2')), '漏了第三层：' + JSON.stringify(texts));
  eq(texts.some((t) => /^1\.1\s+小节$/.test(t)), false, '中间层容器没丢掉：' + JSON.stringify(texts));
  eq(texts.some((t) => /^第 1 章$/.test(t)), false, '顶层容器没丢掉：' + JSON.stringify(texts));
});

// ── [3] 不能误伤平表 ─────────────────────────────────────
console.log('\n\x1b[1m[3] 平表目录不能被误删\x1b[0m');

check('本来就是平表时，一个都不少', () => {
  const { texts } = scan(`
    <div class="catalogue_list">
      <div class="catalogue_learn_item"><span>1.1 甲</span><span>10:00</span></div>
      <div class="catalogue_learn_item"><span>1.2 乙</span><span>09:00</span></div>
      <div class="catalogue_learn_item"><span>1.3 丙</span><span>08:00</span></div>
    </div>`);
  eq(texts.length, 3, '平表被动了：' + JSON.stringify(texts));
  ok(texts[0].includes('1.1') && texts[2].includes('1.3'), '内容不对：' + JSON.stringify(texts));
});

check('时长藏在子元素里的平表条目也留得住', () => {
  const { texts } = scan(`
    <div class="catalogue_list">
      <div class="catalogue_learn_item"><div><span>1.1 甲</span><span>10:00</span></div></div>
      <div class="catalogue_learn_item"><div><span>1.2 乙</span><span>09:00</span></div></div>
    </div>`);
  ok(texts.some((t) => t.includes('1.1')), '漏了 1.1：' + JSON.stringify(texts));
  ok(texts.some((t) => t.includes('1.2')), '漏了 1.2：' + JSON.stringify(texts));
});

// ── [4] flattenLeaves 的边界 ─────────────────────────────
console.log('\n\x1b[1m[4] flattenLeaves 的边界\x1b[0m');

check('候选里只剩互相嵌套的容器时，退回最内层而不是全丢', () => {
  // 极端构造：外层套内层，但内层里没有"像课时"的标记（既没时长也没字母序号）
  const texts = flatten('<div class="x"><div class="x">光秃秃的文本</div></div>', '.x');
  ok(texts.length >= 1, '不该整个丢空：' + JSON.stringify(texts));
});

check('容器内部有课时时不重复收录（子项只出现一次）', () => {
  const texts = flatten(`
    <div class="x">
      <div class="x"><span>1.1.1</span><span>05:00</span></div>
      <div class="x"><span>1.1.2</span><span>06:00</span></div>
    </div>`, '.x');
  const dup = texts.filter((t) => t.includes('1.1.1'));
  eq(dup.length, 1, '1.1.1 出现了 ' + dup.length + ' 次：' + JSON.stringify(texts));
});

check('没有子项的单个条目保持原样（当叶子留着）', () => {
  const texts = flatten('<div class="x"><span>1.1 甲</span><span>10:00</span></div>', '.x');
  eq(texts.length, 1, JSON.stringify(texts));
  ok(texts[0].includes('1.1 甲'), JSON.stringify(texts));
});

// ── [4.5] 侧边栏导航菜单不能被当成课程目录 ───────────────
//
// 这一节是拿用户发回来的诊断报告写的。报告里清清楚楚：插件把站点**自己的导航菜单**
// 当成了课程目录 —— 13 条 `router-item`：
//   知识图谱 / 掌握度分析 / 成绩分析 / 作业考试 / 课程资料 / 课程问答 /
//   见面课 / 学前必读 / 系统消息 / 课程提醒 / 班级信息 / **退课**
//
// 这比"小章节读不到"严重得多：自动连播会按顺序去点这些跳转链接，
// 而列表最后一个叫「退课」。
console.log('\n\x1b[1m[4.5] 侧边栏导航菜单不能被当成课程目录\x1b[0m');

{
  const NAV = ['知识图谱', '掌握度分析', '成绩分析', '作业考试', '课程资料', '课程问答',
    '见面课', '学前必读', '系统消息', '课程提醒', '班级信息', '退课'];
  const row = (t) => '<div class="router-item"><span>' + t + '</span></div>';
  const env = makeEnv(`
    <div class="course-nav">
      ${NAV.map(row).join('')}
    </div>
    <aside class="catalogue">
      <div class="chapter-item">第七章: Food Culture: Tea Culture</div>
      <div class="video_list_item"><span>7.1 The Origin and Spread of Tea</span></div>
      <div class="video_list_item"><span>7.2 The Classification and Processing Techniques</span></div>
      <div class="video_list_item"><span>7.2.1 Criteria of Tea Classification</span></div>
      <div class="video_list_item"><span>7.2.2 Basic Tea Processing Techniques</span></div>
      <div class="video_list_item"><span>7.2.3 Six Major Categories of Tea</span></div>
    </aside>`);
  const solver = new env.NS.Playlist();
  const items = solver.scan();
  const titles = items.map((el) => env.NS.dom.textOf(el));

  check('导航菜单条目全部被剔掉（含「退课」那一项）', () => {
    NAV.forEach((t) => {
      eq(titles.some((x) => x === t), false, '导航条目混进目录了：' + t);
    });
  });

  check('正经课时和小章节照常读得到', () => {
    ok(titles.some((t) => /7\.1/.test(t)), '正经课时没了：' + JSON.stringify(titles));
    ok(titles.some((t) => /7\.2\.1/.test(t)), '小章节没了：' + JSON.stringify(titles));
  });

  check('整批都是导航时，宁可为空也不认（绝不把「退课」当课时）', () => {
    const env2 = makeEnv('<div class="course-nav">'
      + ['知识图谱', '系统消息', '退课'].map(row).join('') + '</div>');
    const s2 = new env2.NS.Playlist();
    const t2 = s2.scan().map((el) => env2.NS.dom.textOf(el));
    eq(t2.indexOf('退课'), -1, '「退课」被当成课时了 —— 自动连播会去点它');
  });

  // 用户第二份报告：`7.2` 既是能播的一节（带时长）、又套着 7.2.1/7.2.2/7.2.3。
  // 旧逻辑把它当"容器"整个丢掉 —— 于是小章节看起来"读不到"。
  check('「既是课时又是分组」的那一层要留着，子章节也要收', () => {    const env3 = makeEnv(`
      <aside class="catalogue">
        <div class="chapter-item" id="ch7">
          <div class="tit">第七章: Food Culture: Tea Culture</div>
          <div class="chapter-item"><span>7.1</span><span>The Origin and Spread of Tea</span><span>04:59</span></div>
          <div class="chapter-item" id="c72">
            <div class="tit"><span>7.2</span><span>The Classification</span><span>03:20</span></div>
            <div class="sub">
              <div class="chapter-item"><span>7.2.1</span><span>Criteria of Tea Classification</span><span>02:10</span></div>
              <div class="chapter-item"><span>7.2.2</span><span>Basic Tea Processing Techniques</span><span>01:40</span></div>
              <div class="chapter-item"><span>7.2.3</span><span>Six Major Categories of Tea</span><span>02:30</span></div>
            </div>
          </div>
          <div class="chapter-item"><span>7.3</span><span>Various Tea Cultures</span><span>05:12</span></div>
        </div>
      </aside>`);
    const s3 = new env3.NS.Playlist();
    const titles = s3.scan().map((el) => env3.NS.dom.textOf(el).replace(/\s+/g, ''));

    // 7.2 那一层自己也丢（它是分组标题，点了不播）—— 这是有意保留的旧契约；
    // 关键是它底下的三个小章节必须收进来，那才是用户报的问题。
    ['7.2.1', '7.2.2', '7.2.3'].forEach((k) => {
      ok(titles.some((t) => t.indexOf(k) === 0), k + ' 没进列表：' + JSON.stringify(titles));
    });
    ok(titles.some((t) => /^7\.3/.test(t)), '7.3 丢了');
    eq(titles.some((t) => /^第七章/.test(t)), false, '纯章节头不该进列表（点了不播）');

    // 顺序：7.2.1 -> 7.2.2 -> 7.2.3 必须按文档顺序
    const i721 = titles.findIndex((t) => /^7\.2\.1/.test(t));
    const i723 = titles.findIndex((t) => /^7\.2\.3/.test(t));
    ok(i721 >= 0 && i721 < i723, '小章节顺序乱了：' + JSON.stringify(titles));
  });
}

// ── [5] 与真实 mock 页对齐 ───────────────────────────────
console.log('\n\x1b[1m[5] 真实 mock 页的平表目录\x1b[0m');
check('mock 页（clearfix video 结构）仍然识别出 5 节', () => {
  const html = fs.readFileSync(path.join(ROOT, 'tools', 'mock.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:8899/',
  });
  const win = dom.window;
  win.chrome = {
    storage: { local: { get: () => Promise.resolve({ config: {} }), set: () => Promise.resolve() }, onChanged: { addListener() {} } },
    runtime: { id: 't', onMessage: { addListener() {} }, sendMessage() {}, lastError: null },
  };
  win.Element.prototype.scrollIntoView = function () { /* jsdom 没有 */ };
  patchLayout(win);
  for (const rel of ['src/shared/defaults.js', 'src/content/dom.js', 'src/content/config.js', 'src/content/playlist.js']) {
    inject(win, rel);
  }
  const NS = win.__ZHS;
  const pl = new NS.Playlist();
  pl.scan();
  const [done, total] = pl.stats();
  eq(total, 5, 'mock 页有 5 节课，识别到 ' + total + ' 个：' +
    JSON.stringify(pl.items.map((el) => NS.dom.textOf(el).replace(/\s+/g, ' '))));
  eq(done, 0, '初始不该有已完成项');
  ok(pl.items.every((el) => el.isConnected), '条目里有孤儿节点');
  // 平表条目里的子 span 不该被当成"课时"单独收进来
  for (const el of pl.items) {
    const t = NS.dom.textOf(el).replace(/\s+/g, ' ').trim();
    ok(/^[12]\.\d\s/.test(t), '收进来一个不像课时的条目：' + JSON.stringify(t));
  }
  try { dom.window.close(); } catch (e) { /* noop */ }
});

// ── [6] 目录会"长"：折叠的章节展开后要能重扫出来 ─────────
//
// 用户第二份报告里的关键一行：
//   .chapter-item 命中 42 → 有文字 42 → **可见 4** → 展开成叶子 4
// 扫描那一刻页面上只有 4 条可见 —— 折叠着的 7.2 根本没把 7.2.1~3 渲染进 DOM。
// 只在页面加载时扫一次，小章节永远进不了列表。
console.log('\n\x1b[1m[6] 折叠章节展开后要能重扫出来\x1b[0m');

{
  const collapsed = `
    <aside class="catalogue">
      <div class="chapter-item"><span>7.1</span><span>The Origin</span><span>04:59</span></div>
      <div class="chapter-item" id="c72"><span>7.2</span><span>The Classification</span><span>03:20</span></div>
      <div class="chapter-item"><span>7.3</span><span>Various Tea Cultures</span><span>05:12</span></div>
    </aside>`;
  const env4 = makeEnv(collapsed);
  const solver4 = new env4.NS.Playlist();
  solver4.scan();
  const before = solver4.items.length;

  check('折叠状态下只能读到父级（这就是"小章节不在"的样子）', () => {
    eq(before, 3, '折叠时条目数不对：' + before);
  });

  // 页面把 7.2 展开了（子课时这时才被渲染出来）
  const c72 = env4.win.document.getElementById('c72');
  const sub = env4.win.document.createElement('div');
  sub.innerHTML = '<div class="chapter-item"><span>7.2.1</span><span>Criteria</span><span>02:10</span></div>'
    + '<div class="chapter-item"><span>7.2.2</span><span>Basic Techniques</span><span>01:40</span></div>'
    + '<div class="chapter-item"><span>7.2.3</span><span>Six Categories</span><span>02:30</span></div>';
  c72.appendChild(sub);

  check('重扫之后，新出现的小章节要被收进列表', () => {
    const grew = solver4.refresh(0);
    ok(grew > 0, '重扫没发现新条目（grew=' + grew + '）');
    const titles = solver4.items.map((el) => env4.NS.dom.textOf(el).replace(/\s+/g, ''));
    ['7.2.1', '7.2.2', '7.2.3'].forEach((k) => {
      ok(titles.some((t) => t.indexOf(k) === 0), k + ' 没被重扫出来：' + JSON.stringify(titles));
    });
    ok(solver4.items.length > before, '条目数没涨：' + before + ' → ' + solver4.items.length);
  });

  check('节流生效：刚扫过就不重复扫', () => {
    eq(solver4.refresh(4000), 0, '节流没起作用 —— 每 tick 都扫一遍太浪费');
  });
}

// ── [7] 包装节点不能被当成课时去点 ───────────────────────
//
// 用户日志现场：
//   15:07:03 切换章节：10.2 5G Technology 10.2.1 Five Generation
//   15:07:23 切换超时，保持当前状态继续重试      ← 白等 20 秒
// 一条条目的文字里带了**两个编号** ⇒ 它是把父标题和子标题包在一起的包装节点，
// 点它不会切章节。要换成里面各自只带一个编号的子节点。
console.log('\n\x1b[1m[7] 父子标题粘在一起的包装节点，不能拿去点\x1b[0m');

{
  const env7 = makeEnv(`
    <aside class="catalogue">
      <div class="chapter-item" id="wrap">
        <div class="tit">10.2 5G Technology</div>
        <div class="kids">
          <div class="chapter-item">10.2.1 Five Generation of Mobile Networks</div>
          <div class="chapter-item">10.2.2 5G Standards and Deployment</div>
        </div>
      </div>
      <div class="chapter-item">10.3 The Future of Communication</div>
    </aside>`);
  const s7 = new env7.NS.Playlist();
  const items = s7.scan();
  const titles = items.map((el) => env7.NS.dom.textOf(el).replace(/\s+/g, ' ').trim());

  check('没有任何一条同时带两个编号（包装节点已被拆开）', () => {
    items.forEach((el, i) => {
      const m = titles[i].match(/\d+(?:\.\d+)+/g) || [];
      const uniq = m.filter((v, k) => m.indexOf(v) === k);
      eq(uniq.length <= 1, true,
        '这条带了两个编号，点它只会超时：' + JSON.stringify(titles[i]));
    });
  });

  check('拆出来的是能点的小标题', () => {
    ok(titles.some((t) => t.indexOf('10.2.1') === 0), '10.2.1 没被拆出来：' + JSON.stringify(titles));
    ok(titles.some((t) => t.indexOf('10.2.2') === 0), '10.2.2 没被拆出来：' + JSON.stringify(titles));
  });
}

// ── [8] 分组标题不能当成课时去点 ─────────────────────────
//
// 用户诊断报告里的 9 条（真实站点的 class 都在）：
//   10.1      chapter-item            ← 有完成勾，能播
//   10.2      item-box                ← **纯分组标题，没有勾，点了不播**
//   10.2.1~3  chapter-content-second  ← 有勾，能播
//   10.3      item-box                ← **纯分组标题**
//   10.3.1~2  chapter-content-second
//   10.4      chapter-item            ← 能播
//
// 日志现场就是一直在点那两个标题：
//   15:50:36 切换章节：10.2 5G Technology   → 切换超时
//   15:51:17 切换章节：10.3 Beidou GPS      → 切换超时
console.log('\n\x1b[1m[8] 分组标题不能当成课时去点\x1b[0m');

{
  const env8 = makeEnv(`
    <aside class="catalogue">
      <div class="chapter-item"><div class="item-box">10.1 The Influence of Science</div></div>
      <div class="chapter-item" id="grp102">
        <div class="item-box"><div class="item-num">10.2</div><div class="item-name">5G Technology</div></div>
        <div class="chapter-content-second"><div class="item-num">10.2.1</div><div class="item-name">Five Generations</div></div>
        <div class="chapter-content-second"><div class="item-num">10.2.2</div><div class="item-name">Application of 5G</div></div>
        <div class="chapter-content-second"><div class="item-num">10.2.3</div><div class="item-name">Communication with the world</div></div>
      </div>
      <div class="chapter-item" id="grp103">
        <div class="item-box"><div class="item-num">10.3</div><div class="item-name">Beidou GPS</div></div>
        <div class="chapter-content-second"><div class="item-num">10.3.1</div><div class="item-name">BDS Development</div></div>
        <div class="chapter-content-second"><div class="item-num">10.3.2</div><div class="item-name">Services and Applications</div></div>
      </div>
      <div class="chapter-item"><div class="item-box">10.4 A Sichuan Paper-Making Technique</div></div>
    </aside>`);
  const s8 = new env8.NS.Playlist();
  const items = s8.scan();
  const nums = items.map((el) => (/^(\d+(?:\.\d+)*)/.exec(
    env8.NS.dom.textOf(el).replace(/\s+/g, ' ').trim()) || [])[1] || '?');

  check('分组标题 10.2 / 10.3 被丢掉（点了不播，只会白等超时）', () => {
    eq(nums.indexOf('10.2'), -1, '10.2 这个分组标题还在列表里：' + JSON.stringify(nums));
    eq(nums.indexOf('10.3'), -1, '10.3 这个分组标题还在列表里：' + JSON.stringify(nums));
  });

  check('真能播的课时一个都不少', () => {
    ['10.1', '10.2.1', '10.2.2', '10.2.3', '10.3.1', '10.3.2', '10.4'].forEach((n) => {
      ok(nums.indexOf(n) !== -1, n + ' 被误删了：' + JSON.stringify(nums));
    });
  });

  check('顺序没乱（10.2.x 在 10.3.x 前面）', () => {
    const i3 = nums.indexOf('10.2.3');
    const i31 = nums.indexOf('10.3.1');
    ok(i3 >= 0 && i31 > i3, '顺序不对：' + JSON.stringify(nums));
  });
}

console.log('\n' + '─'.repeat(48));
console.log('  \x1b[32m通过 ' + pass + '\x1b[0m    \x1b[31m失败 ' + fail + '\x1b[0m');
console.log('─'.repeat(48) + '\n');

if (fail) {
  failures.forEach((f) => console.log('  ✗ ' + f.name + '\n    ' + (f.err.stack || f.err)));
  process.exit(1);
}
