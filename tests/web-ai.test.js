/**
 * web-ai.test.js — 网页 AI 抢答的纯逻辑层（无 jsdom、无 chrome）
 *
 * 覆盖 src/shared/web-ai.js：站点识别、提示词构建、回包解析。
 * 这三块是整条链路里唯一能离线断言的部分 —— 站点 DOM 改版会把选择器打飞，
 * 但「题干怎么问出去」和「回包怎么读回来」的正确性不该跟着一起变。
 *
 * 运行： node tests/web-ai.test.js
 */
'use strict';

const path = require('path');
const { loadShared } = require('./chrome-mock');

const ROOT = path.resolve(__dirname, '..');

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
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message);
  }
}

function eq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '  got=' + sa + ' want=' + sb);
}

function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

const win = loadShared([
  'src/shared/defaults.js',
  'src/shared/web-ai.js',
], ROOT);

const WA = win.ZHS_webAI;

console.log('\n\x1b[1m网页 AI 抢答 — 纯逻辑\x1b[0m\n');

// ── [1] 站点识别 ─────────────────────────────────────────
console.log('\x1b[1m[1] 站点识别\x1b[0m');

test('ZHS_webAI 在本模块与 __ZHS 两侧都挂上了', () => {
  ok(WA, 'window.ZHS_webAI 缺失');
  ok(win.__ZHS && win.__ZHS.webAI, 'window.__ZHS.webAI 缺失');
});

test('识别豆包与 DeepSeek 的各种域名形态', () => {
  eq(WA.providerForUrl('https://www.doubao.com/chat/').id, 'doubao');
  eq(WA.providerForUrl('https://doubao.com/chat/123').id, 'doubao');
  eq(WA.providerForUrl('https://chat.deepseek.com/a/chat/s/xxx').id, 'deepseek');
  eq(WA.providerForUrl('https://www.kimi.com/chat/x').id, 'kimi');
  eq(WA.providerForUrl('https://kimi.moonshot.cn/').id, 'kimi');
  eq(WA.providerForUrl('https://www.yuanbao.tencent.com/chat/').id, 'yuanbao');
  eq(WA.providerForUrl('https://tongyi.aliyun.com/qianwen/').id, 'tongyi');
});

test('识别 Gemini，含地区镜像', () => {
  // Gemini 会按地区跳到不同域名，页面结构是同一套
  eq(WA.providerForUrl('https://gemini.google.com/app').id, 'gemini');
  eq(WA.providerForUrl('https://gemini.google.com/app/abc123').id, 'gemini');
  eq(WA.providerForUrl('https://gemini.google.co.jp/app').id, 'gemini');
  eq(WA.providerForUrl('https://gemini.google.com.hk/app').id, 'gemini');
  // 但别的 google 服务不能被卷进来
  eq(WA.providerForUrl('https://www.google.com/search?q=x'), null);
  eq(WA.providerForUrl('https://mail.google.com/'), null);
});

test('不认识的域名返回 null，不会误接管', () => {
  eq(WA.providerForUrl('https://www.zhihuishu.com/'), null);
  eq(WA.providerForUrl('https://chat.deepseek.com.evil.com/'), null);
  eq(WA.providerForUrl(''), null);
  eq(WA.providerForUrl('not a url'), null);
});

test('id 白名单里没有拼错的站点就返回 null（背景侧据此回落 auto）', () => {
  eq(WA.getProvider('deepseek').id, 'deepseek');
  ok(WA.getProvider('auto') === null, 'auto 不是具体站点，应当是 null');
  ok(WA.getProvider('doubao2') === null, '不存在的 id 应当返回 null');
});

test('每个站点都有输入框/发送/回答/停止四组选择器', () => {
  for (const p of WA.PROVIDERS) {
    ok(p.input.length >= 1, p.id + ' 缺 input');
    ok(p.send.length >= 1, p.id + ' 缺 send');
    ok(p.answer.length >= 1, p.id + ' 缺 answer');
    ok(p.stop.length >= 1, p.id + ' 缺 stop');
    ok(/^https:\/\//.test(p.home), p.id + ' 的 home 不是 https');
    ok(WA.providerForUrl(p.home), p.id + ' 自己的 home 认不出来');
  }
});

test('Gemini 的输入框按 Quill 编辑器找，而不是按 textarea', () => {
  // Gemini 用的是 .ql-editor（contenteditable div）。写 textarea 在这边永远匹配不到 ——
  // 这是它和另外几家最大的不同，单独钉一条。
  const g = WA.getProvider('gemini');
  ok(g, '没有 gemini 这一项');
  ok(g.input.some((s) => /ql-editor/.test(s)), 'input 里没有 .ql-editor：' + JSON.stringify(g.input));
  ok(g.send.some((s) => /Send message/i.test(s)), 'send 里没有 aria-label="Send message"');
  ok(g.answer.some((s) => /model-response/.test(s)), 'answer 里没有 model-response');
});

// ── [2] 提示词 ───────────────────────────────────────────
console.log('\n\x1b[1m[2] 提示词构建\x1b[0m');

const single = {
  stem: '以下哪个是 HTTP 协议的默认端口？',
  options: ['A. 21', 'B. 80', 'C. 443', 'D. 8080'],
  multi: false,
};

test('选项重新编号成 A/B/C…，平台自带的字母前缀被剥掉', () => {
  const p = WA.buildPrompt(single, {});
  ok(/A\. 21/.test(p), '没重新编号：\n' + p);
  ok(!/A\. A\./.test(p), '旧前缀没被剥掉：\n' + p);
  ok(/D\. 8080/.test(p), '最后一个选项丢了');
});

test('裸空格前缀也要剥掉 —— 知到的选项文字就是"对"/"错"', () => {
  // 用户实际看到的提示词里出现了两套字母：
  //   A. A 西方意象派诗歌完全模仿中国古典诗歌的形式
  // 因为知到渲染出来的选项是 `A 西方意象派…`（字母 + 一个空格），
  // 而旧的正则只认 `A.` `A、` `A)` 这种带分隔符的写法。
  const p = WA.buildPrompt({
    stem: '以下哪个？',
    options: ['A 西方意象派诗歌完全模仿中国古典诗歌的形式', 'B 受到中国古典诗歌影响'],
    multi: false,
  }, {});
  ok(!/^A\. A /m.test(p), '又出现两套字母了：\n' + p);
  ok(/^A\. 西方意象派/m.test(p), '前缀没被剥掉：\n' + p);
});

test('判断题的「A 对 / B 错」也剥得干净', () => {
  const p = WA.buildPrompt({ stem: '这句话对吗？', options: ['A 对', 'B 错'], multi: false }, {});
  ok(/^A\. 对$/m.test(p), 'A 对没剥干净：\n' + p);
  ok(/^B\. 错$/m.test(p), 'B 错没剥干净：\n' + p);
});

test('本身就叫 A 的选项不能被剥成空串', () => {
  const p = WA.buildPrompt({ stem: '下列哪一个是？', options: ['A', 'B'], multi: false }, {});
  ok(/^A\. A$/m.test(p), '裸字母选项被吃掉了：\n' + p);
});

test('提示词就是「指令 + 题干 + 选项 + 一行格式」，行数 = 选项数 + 3', () => {
  const p = WA.buildPrompt(single, {});
  const lines = p.split('\n');
  eq(lines.length, 4 + 3, '行数不对：\n' + p);
  eq(lines[0], '直接说出答案，不用解析。', '第一行应当是指令');
  eq(lines[1], '题目：' + single.stem, '第二行应当是题干');
  ok(/^最后只回一行：答案：/.test(lines[lines.length - 1]),
    '最后一行应当是输出格式：' + lines[lines.length - 1]);
});

test('提示词里绝不能出现具体答案字母（否则模型会直接抄它）', () => {
  // 这是踩过的坑：以前末尾写的是「答案：B」这种具体示例，
  // 结果模型不看题、直接回 B —— 表现就是"答案永远等于示例里那个字母"。
  const single4 = WA.buildPrompt(single, {});
  ok(!/答案\s*[:：]\s*[A-Ha-h]/.test(single4),
    '单选提示词里出现了具体字母：\n' + single4);
  ok(!/\bB\b(?![.\s])/.test(single4.split('\n').pop() || ''),
    '最后一行出现了字母 B：' + single4.split('\n').pop());

  const multi4 = WA.buildPrompt({
    stem: '以下哪些属于 HTTP 请求方法？',
    options: ['GET', 'POST', 'PUT', 'FETCH'],
    multi: true,
  }, {});
  ok(!/答案\s*[:：]\s*[A-Ha-h]/.test(multi4),
    '多选提示词里出现了具体字母：\n' + multi4);
});

test('格式那一行用的是占位符，而且只有一行', () => {
  const p = WA.buildPrompt(single, {});
  const last = p.split('\n').pop();
  ok(/<[^>]*字母[^>]*>/.test(last), '缺占位符：' + last);
  ok(/只回一行/.test(last), '应当点明"只回一行"：' + last);
  // 整个提示词里「答案：」只该出现一次（就是这一行格式）
  const hits = p.split('答案：').length - 1;
  eq(hits, 1, '「答案：」出现了 ' + hits + ' 次：\n' + p);
});

test('多选题的占位符同样不给具体字母，且说明多个要连写', () => {
  const p = WA.buildPrompt({
    stem: '以下哪些属于 HTTP 请求方法？',
    options: ['GET', 'POST', 'PUT', 'FETCH'],
    multi: true,
  }, {});
  const last = p.split('\n').pop();
  ok(/多选/.test(p), '缺多选标记：\n' + p);
  ok(/<[^>]*字母[^>]*>/.test(last), '缺占位符：' + last);
});

test('指令要求「直接说出答案，不用解析」（不让它写长篇分析）', () => {
  // 长推理既拖慢等待、又更容易在中途跑偏；这句是用户点名要的
  const p = WA.buildPrompt(single, {});
  ok(/直接说出答案/.test(p), '缺"直接说出答案"：\n' + p);
  ok(/不用解析|不要解析|无需解析/.test(p), '缺"不用解析"：\n' + p);
  eq(p.split('\n')[0], '直接说出答案，不用解析。', '这句应当在最前面');
});

test('重问同一道题时换一句开场白（网页端会拒答重复提问）', () => {
  const a1 = WA.buildPrompt(single, { attempt: 1 });
  const a2 = WA.buildPrompt(single, { attempt: 2 });
  const a3 = WA.buildPrompt(single, { attempt: 3 });

  ok(a1 !== a2, '第一次和第二次的提示词一模一样，容易被当成重复提问顶回来');
  ok(a2 !== a3, '第二次和第三次也一样');
  eq(a1.split('\n')[0], '直接说出答案，不用解析。', '第一次必须还是原来那句');
  eq(a1.split('\n')[1], a2.split('\n')[1], '题干不该跟着变');

  // 换的那句话本身不能带进选项内容 —— 那等于给模型新的锚点
  for (const p of [a2, a3]) {
    const lead = p.split('\n')[0];
    ok(lead.length <= 20, '开场白太长了：' + lead);
    ok(!/21|80|443|8080/.test(lead), '开场白里混进了选项内容：' + lead);
  }

  // 缺省时等同于第一次
  eq(WA.buildPrompt(single, {}).split('\n')[0], '直接说出答案，不用解析。');
});

test('没有【输出格式】【规则】这类长模板（它们会让网页版发不出去）', () => {
  // 这一条是回归护栏：早先的模板带【题型】【输出格式】【规则 1/2/3】和
  // 「理由：不超过 20 字」，实测在豆包 / DeepSeek 上发送按钮一直不点亮。
  const p = WA.buildPrompt(single, {});
  ok(!/输出格式/.test(p), '又出现了【输出格式】');
  ok(!/规则/.test(p), '又出现了规则清单');
  ok(!/理由/.test(p), '又要它写理由了');
  ok(!/[【】]/.test(p), '提示词里不该再有全角方括号包装的段落标题');
  ok(!/\n\s*\n/.test(p), '不该有空行');
  ok(!/\n\s|\s\n/.test(p), '行首行尾不该有空白（站点会当成"还没输入完"）');
});

test('提示词足够短（不会撞上输入框的字数上限）', () => {
  const p = WA.buildPrompt(single, {});
  ok(p.length < 220, '四个选项的题用了 ' + p.length + ' 字，太长了');
});

test('多选题的提示词只说明"不止一个"，不再给连写示例', () => {
  // 以前这里检查的是「答案：AB」这种连写示例 —— 那个示例本身就是锚点
  // （模型会直接抄 AB），已经去掉了。现在只保留"多个要连写"的格式说明。
  const p = WA.buildPrompt({
    stem: '以下哪些属于 HTTP 请求方法？',
    options: ['GET', 'POST', 'PUT', 'FETCH'],
    multi: true,
  }, {});
  ok(/多选/.test(p), '缺多选标记：\n' + p);
  ok(!/答案：[A-H]/.test(p), '又给出具体字母示例了：\n' + p);
  ok(/<[^>]*字母[^>]*>/.test(p.split('\n').pop()), '缺占位符：' + p.split('\n').pop());
});

test('单选题不啰嗦地声明题型（少一行就可能少一次发不出去）', () => {
  const p = WA.buildPrompt(single, {});
  ok(!/单选/.test(p), '单选题不必声明题型：\n' + p);
});

test('超长题干与选项会被截断（免费站点的输入框有长度上限）', () => {
  const p = WA.buildPrompt({
    stem: '很长'.repeat(600),
    options: ['甲'.repeat(400), '乙'.repeat(400)],
    multi: false,
  }, {});
  ok(p.length < 1200, '提示词过长：' + p.length + ' 字');
  ok(/\.\.\./.test(p), '没有截断标记');
});

test('previewPrompt 给出可以直接贴进日志的逐行形式', () => {
  const lines = WA.previewPrompt(single, {});
  ok(Array.isArray(lines), '应当返回数组');
  eq(lines.length, 4 + 3, '行数不对：' + JSON.stringify(lines));
  ok(lines.every((l) => l.trim() === l), '每行都不该有首尾空白');
  ok(lines.every((l) => l.length > 0), '不该有空行');
});

test('showExample:false 时去掉示例行，只剩指令 + 题干 + 选项', () => {
  const p = WA.buildPrompt(single, { showExample: false });
  ok(!/^答案：/m.test(p), '示例行没被去掉：\n' + p);
  ok(/直接说出答案/.test(p), '指令丢了');
  eq(p.split('\n').length, 4 + 2, '行数不对：\n' + p);
  // 去掉示例之后模型多半只回一个字母 —— 那条路 parseReply 的短回包兜底要能接住
  const parsed = WA.parseReply('B', 4);
  ok(parsed && parsed.answer[0] === 1, '短回包兜底接不住，showExample:false 就不能用了');
});

// ── [3] 回包解析 ─────────────────────────────────────────
console.log('\n\x1b[1m[3] 回包解析\x1b[0m');

test('标准回包：从「答案：行」取值并映射成下标', () => {
  const r = WA.parseReply('答案：B\n理由：80 是 HTTP 默认端口', 4);
  eq(r.answer, [1]);
  eq(r.letters, 'B');
  eq(r.source, 'answer-line');
  eq(r.uncertain, false);
  ok(/80 是/.test(r.reason), '理由没被提出来：' + r.reason);
});

test('多选：「答案：A、C」这种顿号写法也能读', () => {
  eq(WA.parseReply('答案：A、C', 4).answer, [0, 2]);
  eq(WA.parseReply('答案: A, C', 4).answer, [0, 2]);
  eq(WA.parseReply('答案：A，C', 4).answer, [0, 2]);
  eq(WA.parseReply('答案：A和C', 4).answer, [0, 2]);
  eq(WA.parseReply('**答案：AC**', 4).answer, [0, 2]);
});

test('「答案」的各种包装都要认', () => {
  // 这几条是同一处返工三次才稳定的：以前把字母塞进同一条大正则里，
  // 惰性量词会在 `答案：A、C` 上提前收工。现在标记定位 + 扫描取字母，分开做。
  eq(WA.parseReply('答案：B', 4).answer, [1]);
  eq(WA.parseReply('答案是：B', 4).answer, [1]);
  eq(WA.parseReply('答案: C', 4).answer, [2]);
  eq(WA.parseReply('答案 B', 4).answer, [1], '没冒号也认');
  eq(WA.parseReply('【答案】D', 4).answer, [3], '方括号包装');
  eq(WA.parseReply('（答案）B', 4).answer, [1], '圆括号包装');
  eq(WA.parseReply('Answer: D', 4).answer, [3], '英文标记（Gemini 常这么回）');
  eq(WA.parseReply('Answer：C', 4).answer, [2], '英文标记配全角冒号');
});

test('全角字母、全角空格同样认（中文输入法下很常见）', () => {
  eq(WA.parseReply('答案：Ｂ', 4).answer, [1]);
  eq(WA.parseReply('答案：ｃ', 4).answer, [2]);
  eq(WA.parseReply('答案：　B', 4).answer, [1]);
});

test('答案后面跟了解释时，解释里的字母不会被当答案', () => {
  // 这是把字母塞进同一条正则时最容易踩的坑：贪心会把"因为 B 更合适"的 B 也收进来
  eq(WA.parseReply('答案：B。因为 B 更合适', 4).answer, [1]);
  eq(WA.parseReply('答案：B，因为 B 项与定义相符', 4).answer, [1]);
  eq(WA.parseReply('答案：A、C，因为 HTTP 支持它们', 4).answer, [0, 2],
    '多选后面跟解释也要能正确收尾');
});

test('多选全选（ABCD）是合法的，不许被当成「在罗列选项」丢掉', () => {
  // 这一条是刻意的：解析器分不清「答案就是全选」和「在罗列」，
  // 宁可先按全选提交一次（题库会记住结果），也不要直接放弃这道题。
  eq(WA.parseReply('答案：ABCD', 4).answer, [0, 1, 2, 3]);
});

test('答案重复写两遍时取最后一次（模型常常先写一版再修正）', () => {
  const r = WA.parseReply('答案：A\n仔细想想，答案：C', 4);
  eq(r.answer, [2], '没有取最后一个答案');
});

test('提示词里那行格式占位被抄回来时，不能当成答案', () => {
  // 提示词末尾是「最后只回一行：答案：<单个字母>」。模型偶尔会连这行一起抄回来，
  // 这时必须当"没给答案"，而不是去点一个不存在的选项。
  eq(WA.parseReply('答案：<单个字母>', 4), null);
  eq(WA.parseReply('答案：<字母>', 4), null);
  eq(WA.parseReply('答案：X', 4), null);
  eq(WA.parseReply('答案：单个字母', 4), null);
  // 但不能因此把真答案也误伤
  eq(WA.parseReply('答案：D', 4).answer, [3]);
});

test('越界字母被丢掉，不会拿 E 去点一个只有 4 个选项的题', () => {
  eq(WA.parseReply('答案：E', 4), null);
  eq(WA.parseReply('答案：BE', 4).answer, [1], 'E 应当被丢掉，B 留下');
});

test('判断题：模型只答「正确 / 错误」时映射成 A / B', () => {
  eq(WA.parseReply('这句话是正确的。', 2, { allowBoolean: true }).answer, [0]);
  eq(WA.parseReply('这个说法错误。', 2, { allowBoolean: true }).answer, [1]);
  eq(WA.parseReply('答案：正确', 2, { allowBoolean: true }).answer, [0]);
  eq(WA.parseReply('答案是：不正确', 2, { allowBoolean: true }).answer, [1],
    '「不正确」不能被当成「正确」');
  eq(WA.parseReply('对', 2, { allowBoolean: true }).answer, [0]);
  eq(WA.parseReply('错', 2, { allowBoolean: true }), null, '单字「错」不该被过拟合地认下来');
});

test('判断题的判定词必须落在句尾，讲题的长句不会被误判', () => {
  const r = WA.parseReply(
    '题干里说"下列说法不正确的是"，其中 A 项的表述是正确', 2, { allowBoolean: true });
  eq(r, null, '长句的结尾凑巧是判定词，不该据此作答');
});

test('先分析后结论的句式：读最后一个分句', () => {
  const r = WA.parseReply(
    'A 项说反了，B 项与定义不符。所以，这个说法是正确的。', 2, { allowBoolean: true });
  eq(r.answer, [0], '结论段没被读到');
});

test('「答案是：不正确」里的否定不能被前缀剥皮吃掉', () => {
  // 这一条踩过：剥前缀的正则里如果放了"不"字，就会把「不正确」剥成「正确」
  eq(WA.parseReply('答案是：不正确', 2, { allowBoolean: true }).answer, [1]);
});

test('多选题不启用「正确/错误」这条退化路径（会误伤正常表述）', () => {
  const r = WA.parseReply('以下说法正确的是……', 4, { allowBoolean: false });
  eq(r, null, '不该在纯叙述里猜出答案');
});

test('没有「答案：」行时，只在「整段基本就是一个字母」的短回包上兜底', () => {
  eq(WA.parseReply('B', 4).answer, [1]);
  eq(WA.parseReply('选 B', 4).answer, [1]);
  eq(WA.parseReply('我的答案：B', 4).answer, [1]);
  eq(WA.parseReply('应该是B', 4).answer, [1]);
  const r = WA.parseReply('B', 4);
  eq(r.source, 'loose');
  eq(r.uncertain, true, '这条路径必须标记不确定，便于日志里审计');
});

test('散文里的字母不会被当成答案（题号、缩写到处都是字母）', () => {
  eq(WA.parseReply('我选 C 是因为 C 项符合 TCP 协议的定义。', 4), null);
  eq(WA.parseReply('其中 A 项的表述是正确', 4), null);
  eq(WA.parseReply('第 1 题：TCP 与 UDP 的区别在于……', 4), null);
});

test('完全读不出答案就返回 null，交给上层退回枚举', () => {
  eq(WA.parseReply('', 4), null);
  eq(WA.parseReply('这道题我无法确定。', 4), null);
  eq(WA.parseReply('答案：', 4), null);
  eq(WA.parseReply('A 是对的', 1), null, '选项少于 2 个就不该解析');
});

test('小写字母与全角字母同样接受', () => {
  eq(WA.parseReply('答案：b', 4).answer, [1]);
  eq(WA.parseReply('答案：Ｃ', 4).answer, [2]);
});

// ── [4] 题目身份键 ───────────────────────────────────────
console.log('\n\x1b[1m[4] 题目身份键（缓存用）\x1b[0m');

test('题号/空白差异不该产生两个缓存条目', () => {
  eq(
    WA.questionKey('1、以下哪个是 HTTP 协议的默认端口？', 4, false),
    WA.questionKey('以下哪个是 HTTP 协议的默认端口?', 4, false)
  );
});

test('选项数量或题型变了就是另一道题', () => {
  const a = WA.questionKey('同一句话', 4, false);
  const b = WA.questionKey('同一句话', 5, false);
  const c = WA.questionKey('同一句话', 4, true);
  ok(a !== b && a !== c && b !== c, '键没有区分开：' + [a, b, c].join(' '));
});

test('试题身份键与 content 侧的题库键算法一致（同一道题两边算出同一个哈希）', () => {
  // quiz.js 用的是 dom.js 的 normalize + hash，web-ai.js 为了能在
  // service worker 里跑，自己实现了一份。两边的哈希必须对得上，
  // 否则缓存命中率和题库命中率会莫名其妙地不一致。
  const domWin = loadShared(['src/content/dom.js'], ROOT);
  const stem = '1、以下哪个是 HTTP 协议的默认端口？';
  const a = WA.questionKey(stem, 4, false);
  const b = domWin.__ZHS.dom.hash(domWin.__ZHS.dom.normalize(stem)) + '-4-s';
  eq(a, b, '两套哈希不一致');
});

// ── [5] 与解题器的接线 ───────────────────────────────────
console.log('\n\x1b[1m[5] 与解题器的接线\x1b[0m');

test('content 侧加载顺序里 web-ai.js 排在 ai-bridge.js 之前', () => {
  const fs = require('fs');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')
  );
  const js = manifest.content_scripts[0].js;
  const idx = (n) => js.findIndex((p) => p.endsWith(n));
  ok(idx('web-ai.js') >= 0, 'content 侧没有加载 shared/web-ai.js');
  ok(idx('web-ai.js') < idx('ai-bridge.js'), 'web-ai 必须在 ai-bridge 之前（后者要用它的 letter/questionKey）');
  ok(idx('defaults.js') < idx('web-ai.js'), 'defaults 必须最先');
 });

test('AI 站点那一条 content script 只加载站点驱动需要的文件', () => {
  const fs = require('fs');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')
  );
  eq(manifest.content_scripts.length, 2, '应当有两条 content script（知到页 / AI 页）');
  const ai = manifest.content_scripts[1];
  eq(ai.js, [
    'src/shared/defaults.js',
    'src/shared/web-ai.js',
    'src/content/dom.js',
    'src/content/config.js',
    'src/ai/web-ai.js',
  ], '第二段的文件列表变了');
  eq(ai.all_frames, false, 'AI 页只需要主框架');
  ok(ai.matches.some((m) => /doubao/.test(m)), 'AI 段的 matches 里没有豆包');
  ok(ai.matches.some((m) => /deepseek/.test(m)), 'AI 段的 matches 里没有 DeepSeek');
});

// ── 汇总 ─────────────────────────────────────────────────
console.log('\n' + '─'.repeat(48));
console.log('  \x1b[32m通过 ' + pass + '\x1b[0m    \x1b[31m失败 ' + fail + '\x1b[0m');
console.log('─'.repeat(48) + '\n');

if (fail) {
  failures.forEach((f) => console.log('  ✗ ' + f.name + '\n    ' + (f.err.stack || f.err)));
  process.exit(1);
}
