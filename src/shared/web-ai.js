/**
 * web-ai.js — 网页版免费 AI 抢答：站点表 + 提示词构建 + 回包解析
 *
 * 纯函数模块，不碰 DOM、不碰 chrome.*，同时给两个世界用：
 *   content script（知到页 / AI 页） → window.__ZHS.webAI
 *   普通页面（popup）                → window.ZHS_webAI
 *
 * 之所以把「问什么」和「怎么读回包」跟 DOM 驾驶逻辑分开，是因为这两块是
 * 这条链路里唯一能离线断言的部分：站点改版会把选择器打飞，但题干格式、
 * 答案解析的正确性不该跟着一起变。tests/web-ai.test.js 直接吃这一层。
 */
(function (root) {
  'use strict';

  // ── 站点表 ───────────────────────────────────────────────
  //
  // 每个站点只是「一串候选选择器」，按顺序试到第一个可见的为止 ——
  // 这些免费站点的 DOM 结构改得比知到还勤，写死单个类名活不过一个版本。
  //
  // stop 为 null 表示该站点没有「停止生成」按钮，此时靠「文本不再增长」
  // 判定流式输出结束（见 src/ai/web-ai.js 的 readReply）。
  const PROVIDERS = [
    {
      id: 'gemini',
      name: 'Gemini',
      home: 'https://gemini.google.com/app',
      // Gemini 会按地区跳到 .co.jp / .co.uk 之类的镜像；host 判断放宽到 google 全域，
      // 路径和页面结构是同一套（都是 Angular 那个应用）
      hosts: [
        /^gemini\.google\.[a-z.]+$/i,
        /^aistudio\.google\.com$/i,
      ],
      // Gemini 用的是 Quill 编辑器（.ql-editor 是个 contenteditable div），不是 textarea。
      // 这是它和另外几家最大的不同 —— 写 textarea 选择器在这边永远匹配不到。
      input: [
        'rich-textarea .ql-editor[contenteditable="true"]',
        'rich-textarea [contenteditable="true"]',
        '.ql-editor[contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        '[aria-label*="message" i][contenteditable="true"]',
        'div[contenteditable="true"]',
        'textarea[placeholder]',
        'textarea',
      ],
      send: [
        'button[aria-label="Send message"]',
        'button[aria-label*="Send message" i]',
        'button.send-button',
        'button[class*="send-button"]',
        'mat-icon[fonticon="send"]',
      ],
      answer: [
        'model-response .response-content',
        'model-response .markdown',
        'model-response',
        '.response-content',
        '.model-response-text',
        'message-content',
        'div[class*="response-container"]',
        '.markdown',
      ],
      stop: [
        'button[aria-label*="Stop response" i]',
        'button[aria-label*="停止" i]',
        'mat-icon[fonticon="stop"]',
        'button[class*="stop"]',
      ],
      // Gemini 的用户消息（用来判断"发出去了没有"）：
      // 自定义元素 model-response / user-query 比它那些混淆过的 class 稳得多，
      // 后者每次改版都在变
      source: 'user-query, .query-text, .conversation-container',
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      home: 'https://chat.deepseek.com/',
      hosts: [/^(www\.)?chat\.deepseek\.com$/i, /^(www\.)?deepseek\.com$/i],
      input: [
        'textarea#chat-input',
        'textarea[data-testid="chat-input"]',
        'textarea[placeholder]',
        'div[contenteditable="true"]',
        'textarea',
      ],
      send: [
        'div[role="button"][aria-disabled="false"]._7436101',
        'div[role="button"][aria-disabled="false"]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send message" i]',
        'button[class*="send"]',
        'button[type="submit"]',
      ],
      answer: [
        '.ds-markdown',
        'div[class*="markdown"]',
        'div[class*="message"]',
      ],
      stop: [
        'div[role="button"][aria-label*="Stop" i]',
        'div[role="button"][aria-label*="停止"]',
        'button[aria-label*="停止"]',
        'div[class*="stop"]',
      ],
      source: 'div[class*="message"]',
    },
    {
      id: 'doubao',
      name: '豆包',
      home: 'https://www.doubao.com/chat/',
      hosts: [/^(www\.)?doubao\.com$/i],
      input: [
        'textarea[data-testid="chat_input_input"]',
        'div[data-testid="chat_input_input"]',
        'textarea[placeholder]',
        'div[contenteditable="true"]',
        'textarea',
      ],
      send: [
        'button[data-testid="chat_input_send_button"]',
        'button[aria-label*="发送"]',
        'button[class*="send"]',
      ],
      answer: [
        '[data-testid="receive_message"]',
        '[data-testid="message_text_content"]',
        'div[class*="message-content"]',
        'div[class*="markdown"]',
      ],
      stop: [
        'button[data-testid="chat_input_stop_button"]',
        'button[aria-label*="停止"]',
        'div[class*="stop"]',
      ],
      source: '[data-testid="receive_message"]',
    },
    {
      id: 'kimi',
      name: 'Kimi',
      home: 'https://www.kimi.com/',
      hosts: [/^(www\.)?kimi\.(com|moonshot\.cn)$/i, /^kimi\.moonshot\.cn$/i],
      input: [
        'div[contenteditable="true"]',
        'textarea[placeholder]',
        'textarea',
      ],
      send: [
        'button[class*="send"]',
        'button[aria-label*="发送"]',
        'div[class*="send-button"]',
      ],
      answer: [
        '.markdown',
        'div[class*="markdown"]',
        'div[class*="segment-content"]',
        'div[class*="message"]',
      ],
      stop: [
        'button[class*="stop"]',
        'button[aria-label*="停止"]',
      ],
      source: 'div[class*="message"]',
    },
    {
      id: 'tongyi',
      name: '通义千问',
      home: 'https://www.tongyi.com/qianwen/',
      hosts: [/^(www\.)?tongyi\.com$/i, /^(www\.)?qianwen\.com$/i, /^tongyi\.aliyun\.com$/i],
      input: [
        'textarea[placeholder]',
        'textarea',
        'div[contenteditable="true"]',
      ],
      send: [
        'div[class*="operateBtn"]',
        'button[class*="send"]',
        'button[aria-label*="发送"]',
      ],
      answer: [
        'div[class*="markdown-body"]',
        'div[class*="markdown"]',
        'div[class*="answer"]',
      ],
      stop: [
        'div[class*="stopBtn"]',
        'button[aria-label*="停止"]',
      ],
      source: 'div[class*="answer"],div[class*="message"]',
    },
    {
      id: 'yuanbao',
      name: '腾讯元宝',
      home: 'https://yuanbao.tencent.com/chat/',
      hosts: [/^(www\.)?yuanbao\.tencent\.com$/i],
      input: [
        'div[contenteditable="true"]',
        'textarea[placeholder]',
        'textarea',
      ],
      send: [
        'a[class*="send"]',
        'button[class*="send"]',
        'button[aria-label*="发送"]',
      ],
      answer: [
        'div[class*="agent-chat__bubble__content"]',
        'div[class*="hyc-content-md"]',
        'div[class*="markdown"]',
      ],
      stop: [
        'a[class*="stop"]',
        'div[class*="stop"]',
        'button[aria-label*="停止"]',
      ],
      source: 'div[class*="agent-chat__bubble"]',
    },
  ];

  const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

  /** 只用 hostname 匹配，避免把 path 写进正则里 */
  function hostOf(url) {
    const s = String(url || '');
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(s);
    return m ? m[1].toLowerCase() : '';
  }

  /** 当前页面是哪个站点；不是已知站点返回 null */
  function providerForUrl(url) {
    const host = hostOf(url);
    if (!host) return null;
    for (const p of PROVIDERS) {
      if (p.hosts.some((re) => re.test(host))) return p;
    }
    return null;
  }

  function getProvider(id) {
    if (!id || id === 'auto') return null;
    for (const p of PROVIDERS) if (p.id === id) return p;
    return null;
  }

  // ── 提示词 ───────────────────────────────────────────────

  const LETTERS = 'ABCDEFGH'.split('');

  function letter(i) {
    return LETTERS[i] || String(i + 1);
  }

  function clip(text, max) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const n = max || 300;
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

  /**
   * 去掉选项自带的前缀。
   *
   * 三种写法都要认：
   *   `A. 北京`   半角点
   *   `A、北京`   顿号 / `A、` `A）`
   *   `A 北京`    **裸空格** —— 知到的选项元素文字是"对"、"错"这种，
   *               而平台渲染出来的是 `A 对`，中间只有一个空格、没有任何分隔符。
   *               少认这一种，发出去的提示词里就会出现两套字母：
   *                 A. A 西方意象派诗歌完全模仿中国古典诗歌的形式   ← 用户看到的就是这个
   *               模型对着 `A. A …` 这种双字母选项，注意力会被带偏。
   */
  function stripOptionPrefix(text) {
    return String(text == null ? '' : text)
      // 带分隔符的：A. / A、/ A) / （A）/ A: / A·
      .replace(/^\s*[（(]?\s*[A-Ha-h]\s*[）)]?\s*[、,.:：·•)）\-—]\s*/, '')
      // 裸空格的：`A 北京` —— 但要求后面还有内容（别把孤零零一个 "A" 吃成空串）
      .replace(/^\s*[A-Ha-h]\s+(?=\S)/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 【不要用它！】以前这里给的是"示例答案"，比如单选回 `B`、多选回 `AB`。
   *
   * 这是个**反向锚点**：模型看到具体字母就会直接抄它，而不是去读题。
   * 实测的表现就是"答案永远等于示例里那个字母"。现在提示词里只给格式、
   * 不给答案（见 buildPrompt），这个函数只留着给测试和一些外部工具用。
   */
  function exampleLetters(multi, n) {
    if (!multi) return 'B';
    const count = Math.min(Math.max(2, Math.floor(n / 2)), n, 3);
    const out = [];
    for (let i = 0; i < count; i++) out.push(LETTERS[i]);
    return out.join('');
  }

  /**
   * 同一道题重问时用的引导语。
   *
   * 为什么要换：智能体网页端对**重复提问**很敏感 —— 同一道题在原对话里
   * 再问一遍，它经常回一句"这个问题我已经回答过了"，或者干脆不理你。
   * 换一句不同的开场白，看起来就不是同一个问题，它才会认真再答一次。
   *
   * 这些句子都刻意**不含任何选项内容**，免得给模型新的锚点。
   */
  const RETRY_LEADS = [
    '直接说出答案，不用解析。',
    '直接说答案，不用解析。',
    '只回答案本身，不要解释。',
    '请直接选，不要分析。',
    '给出答案就行，不用说明理由。',
  ];

  /** 提示词里给模型看的题：[多选提示] 题干 / A. 选项 … / 答案：<字母> */
  function previewPrompt(quiz, opts) {
    const o = opts || {};
    const t = buildPrompt(quiz, o);
    return t.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /**
   * 构建提问文本。
   *
   * ⚠ 这个模板刻意做到「最短」，而且**绝不在示例里给出真实答案**。
   *
   * 三件事都是踩过亏才定下来的：
   *
   * 1. 以前末尾写的是「答案：B」这种**具体示例** —— 结果是模型直接抄它。
   *    表现就是"答案永远等于示例里那个字母"，跟题目没关系。
   *    现在最后一行是格式占位 `答案：<字母>`，只传达"要用这个前缀"，
   *    不给任何具体字母当锚点。
   * 2. 更要命的是以前还在提示词里给了真答案（选项不重新编号的时代），
   *    那等于把答案递到模型嘴边 —— 必须一次都不能给。
   * 3. 不要【输出格式】【规则 1/2/3】那种长模板：空行、`【】`、
   *    多行清单会让豆包 / DeepSeek 的发送按钮一直不点亮（"发不出去"）。
   *
   * 仍然保留的两条约束：
   *  - 选项统一重新编号成 A/B/C…，平台自带的字母前缀被剥掉（否则会出现
   *    "A. B.北京"，模型会照着念一路串位）。
   *  - 换行只留在「指令 / 题干 / 选项 / 格式行」之间。
   */
  function buildPrompt(quiz, opts) {
    const o = opts || {};
    const options = (quiz.options || []).map((t) => stripOptionPrefix(t));
    const multi = !!quiz.multi;
    const n = options.length;
    const maxLen = o.maxStem || 360;
    const maxOpt = o.maxOption || 160;
    // showExample 保留这个名字是给旧调用方用的；现在它只控制
    // "要不要输出那一行格式占位"，不再涉及任何真实答案
    const showExample = o.showExample !== false;
    // attempt 从 1 开始：第 2 次起换一句开场白（见 RETRY_LEADS）
    const attempt = Math.max(1, Number(o.attempt) || 1);

    const lines = [RETRY_LEADS[(attempt - 1) % RETRY_LEADS.length]];
    if (multi) lines.push('多选题，答案可能不止一个。');
    lines.push('题目：' + clip(quiz.stem, maxLen));
    for (let i = 0; i < n; i++) {
      lines.push(letter(i) + '. ' + clip(options[i], maxOpt));
    }
    if (showExample) {
      // 只给**格式**：`<字母>` 是占位符，不是答案。
      // 千万别在这里放真字母（以前的 `答案：B`）—— 模型会直接抄它。
      lines.push(multi ? '最后只回一行：答案：<字母>' : '最后只回一行：答案：<单个字母>');
    }
    return lines.join('\n');
  }

  // ── 回包解析 ─────────────────────────────────────────────

  // 「答案」那一行。几种写法都认：
  //   答案：B / 答案是：B / 【答案】D / （答案）B / Answer: D
  //
  // 三个容易写错的点，都是实测踩出来的：
  //  · 不能加 `\b` —— 全角 Ｂ 在 JS 正则里不是 \w，`...Ｂ\b` 会匹配失败，
  //    于是"全角字母"整条路径失效。改成用 lookahead。
  //  · 分隔符要认成对的括号，不只是 答案：D。
  //  · 抓取那一段要用**惰性 + 前瞻**，不能贪心也不能只抓一个字符：
  //      贪心 → `答案：B。因为 B 更合适` 里的那个解释用的 B 也会被收进来
  //      只抓一个 → `答案：A、C` 只拿到 A，多选就漏了
  //    所以"抓一段候选字母"，交给 lettersOf 去重排序后取下标。
  // 「答案」标记。只用来**定位**，取字母交给下面的扫描器。
  //
  // 以前这里是"一条大正则把字母也抓出来"，同一处返工过三次，最后放弃了 ——
  // `答案：A、C` 这条输入上，惰性量词会满足于 `答案：A、` 就收工（`、` 属于
  // "非字母"，收尾条件提前成立），换前瞻、换锚、放宽字符类都只是把问题挪个地方。
  // 与其继续和回溯较劲，不如让正则只干一件事：找到「答案」这两个字在哪。
  //
  // 顺手认掉几种包装：【答案】D / （答案）B / 答案是：B / Answer: D
  const ANSWER_MARK_RE = /[（(【\[]?\s*(?:答\s*案(?:是|为)?|answer|ans)\s*[）)】\]]?\s*[:：=]?\s*/i;

  /**
   * 提示词里那一行格式占位（`答案：<单个字母>`）如果被模型原样抄回来了，
   * 这里要能认出来并丢掉 —— 否则会去点一个不存在的选项。
   * 注意别把真实答案误伤进来：这里只匹配"字母 / X / 选项"这类占位词，
   * A~H 本身不在其中。
   */
  const PLACEHOLDER_RE = /^[<＜(（[［【]?\s*(单个字母|一个字母|字母|字母们|多个字母|选项|多个选项|X|x|单选|多选)\s*[>＞)）\]］】]?$/;

  /** 这次扫描里已经收集到的字母数上限：选择题不会超过 8 个选项 */
  const MAX_ANSWER_LETTERS = 8;

  /**
   * 从「答案」标记往后扫，把这一段里属于答案的字母捡出来。
   *
   * 规则（都是被真实回包逼出来的）：
   *   · 遇到字母就收（全角折算成半角后判断）
   *   · 字母之间最多隔 **一个** 分隔符（`、` `,` `，` `/` 空格 `和`）——
   *     所以 `答案：A、C` 两个都收
   *   · 连着两个非字母/非分隔符（比如 `。` 后面还有字）就判定"答案说完了"——
   *     所以 `答案：B。因为 B 更合适` 里解释用的那个 B 不会被收进来
   *   · 收够 8 个就停
   *
   * @returns {string[]} 半角大写字母数组（可能为空）
   */
  function scanLettersAfter(text, from) {
    const out = [];
    let i = from;

    while (i < text.length && out.length < MAX_ANSWER_LETTERS) {
      const ch = text[i];
      const folded = foldLetter(ch);

      if (folded) {
        out.push(folded);
        i++;
        continue;
      }

      // 字母之间允许夹空白和"连接性"分隔符，继续往后看：
      //   `答案: A, C`（逗号 + 空格）、`答案：A、C`、`答案：A和C` 都要能收全
      if (/[ \t\u3000,，、\/|和及與与+]/.test(ch)) {
        i++;
        continue;
      }

      // 标点（。.；;：:）、汉字、数字…… 一律算"答案说完了"。
      // 这一条挡的是 `答案：B。因为 B 更合适` —— 解释里那个 B 不会被收进来。
      break;
    }

    return out;
  }

  /** 单个字符 → 半角大写字母（A~H 之外返回 ''） */
  function foldLetter(ch) {
    if (!ch) return '';
    const code = ch.charCodeAt(0);
    // 全角 Ａ-Ｈ / ａ-ｈ
    if (code >= 0xFF21 && code <= 0xFF28) return String.fromCharCode(code - 0xFEE0);
    if (code >= 0xFF41 && code <= 0xFF48) return String.fromCharCode(code - 0xFEE0);
    const up = ch.toUpperCase();
    return (up >= 'A' && up <= 'H') ? up : '';
  }

  // 判断题回包：模型经常无视「输出字母」而只答"正确"/"对"。
  //
  // 判定规则（三个条件必须同时成立）：
  //   ① 整句话很短 —— 长句多半是在讲题或复述选项，它的结尾凑巧是个判定词而已；
  //   ② 判定词落在句尾 —— 剥掉句末的标点和语气助词（「…是正确的。」→「…是正确的」→「…是正确的」）；
  //   ③ 「不 / 没」如果直接跟在判定词前面，结论取反 ——
  //      「这个说法不正确」是 FALSE，不能被"正确"两个字骗到。
  const JUDGE_RE = /(不正确|不对|不成立|错误|正确|对|否|是|成立|true|false)$/i;

  function tailJudgement(text) {
    // 先取最后一个分句：模型经常先讲一串分析再给结论，
    // 「……所以，这个说法是正确的。」的结论段才是要读的地方。
    const segs = String(text || '').split(/[。\n；;!！?？]/).filter((s) => s.trim());
    const seg = segs.length ? segs[segs.length - 1] : '';

    const t = seg
      // 句末的语气助词和标点都要剥掉：「这句话是正确的。」的结尾是「的」
      .replace(/[\s。.!！?？~～、,，;；:："'“”‘’()（）\[\]【】*_`的了吧啊呢哦呀嘛啦]+$/g, '')
      .trim();
    if (!t || t.length > 40) return null;

    const m = JUDGE_RE.exec(t);
    if (!m) return null;
    const word = m[1].toLowerCase();
    const from = t.length - m[1].length;
    const prev = from > 0 ? t.charAt(from - 1) : '';

    // 「是否有结论标记」是这条路径的准入条件。理由是踩过的：
    // 「……其中 A 项的表述是正确」这种**复述题干**的句子，结尾也长这样，
    // 光看尾部会把它当成答案。所以要么句子里有明确的结论语，
    // 要么就是「正确」这种非常短、只有一个判断词的口语回答。
    const hasCue = /答|应选|选|所以|因此|故|结论|判断|来看/.test(t);
    if (!hasCue) {
      if (t.length > 14) return null;
      if (/[的个]/.test(prev)) return null;   // 「…的表述是正确」「…的说法是对的」
    }

    if (/^(不正确|不对|不成立|错误|false)$/.test(word)) return 1;   // 下标 0/1 = A/B
    if (/[不没]/.test(prev)) return 1;                             // 「不是」「没有成立」
    if (word === '否') {
      // 脱单的「否」太容易撞上「是否」，只在「是 / 答」后面才当"错误"用
      return /[是答]/.test(prev) ? 1 : null;
    }
    if (/^(正确|对|是|成立|true)$/.test(word)) return 0;
    return null;
  }

  // 整段文本里「连着的字母」，用在没有「答案：」行时的退化路径
  const TOKEN_RE = /^(?:[A-Ha-h][A-Ha-h]+|[A-Ha-h])$/;

  function lettersOf(raw, optionCount) {
    const seen = new Set();
    const out = [];
    // 全角 Ａ-Ｈ 在中文输入法下很常见，先折算回半角再取下标。
    // ⚠ 上限是 Ｈ（U+FF28），不是 Z —— 但 A 到 H 正好在 \uFF21-\uFF28 里，
    // 写成"全字母范围"反而会把 Ｉ/Ｊ 之类也折进来，虽然它们照样会被
    // LETTERS.indexOf 滤掉，但范围写准一点不容易让人看糊涂。
    const s = String(raw || '')
      .replace(/[\uFF21-\uFF28]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[\uFF41-\uFF48]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    for (const ch of s) {
      const up = ch.toUpperCase();
      const idx = LETTERS.indexOf(up);
      if (idx < 0) continue;
      if (idx >= optionCount) continue;      // 越界的字母直接丢
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
    return out.sort((a, b) => a - b);
  }

  function snippetAround(text, index) {
    const t = String(text || '');
    const from = Math.max(0, index - 30);
    return t.slice(from, Math.min(t.length, index + 60)).replace(/\s+/g, ' ').trim();
  }

  function extractReason(text) {
    const m = /理\s*由\s*[:：]?\s*(.{0,60})/.exec(String(text || ''));
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * 从 AI 回包里取答案。
   *
   * 三级退化：
   *   1. 「答案：X」行  —— 唯一可信的通道，取**最后一个**（模型有时会先写一版再修正）
   *   2. 判断题的「正确 / 错误」字面    —— 对应下标 0 / 1
   *   3. 正文里最后一个「像选项字母」的 token —— 只为「我选 C」这种漏格式兜底
   *
   * @returns {{answer:number[], letters:string, raw:string, source:string,
   *            reason:string, uncertain:boolean}|null}
   */
  function parseReply(text, optionCount, opts) {
    const o = opts || {};
    const n = Math.max(0, Number(optionCount) || 0);
    const body = String(text == null ? '' : text).trim();
    if (!body || n < 2) return null;

    const base = {
      answer: [],
      letters: '',
      raw: '',
      source: '',
      reason: extractReason(body),
      uncertain: false,
    };

    // ① 「答案：X」
    //
    // 做法：先用 MARK 正则找到每个「答案 / Answer」标记的位置，再从那个位置
    // 往后**扫描**字母（scanLettersAfter）。不把字母塞进同一条正则里，
    // 是因为"惰性量词 + 收尾条件"在 `答案：A、C` 上必然提前收工，
    // 试过三种写法都只是把问题挪个地方 —— 扫描器一眼就能看懂，也好改。
    //
    // 取**最后一个**有效标记：模型有时会先写一版再修正
    // （`答案：B 或 答案：C` 应当取 B —— 但既然它把两个都写了，
    //  说明它自己也没定，取最后一个更接近它的最终判断）。
    // 占位符（`答案：<单个字母>`）被原样抄回来时不算答案，跳过。
    let picked = null;
    let search = 0;
    while (search < body.length) {
      const hit = ANSWER_MARK_RE.exec(body.slice(search));
      if (!hit) break;
      const after = search + hit.index + hit[0].length;
      const letters = scanLettersAfter(body, after);
      const answer = lettersOf(letters.join(''), n);
      // 占位符判定：标记后面紧跟的是一个占位词（"<单个字母>"），不是字母
      const preview = body.slice(after, after + 12).replace(/^[（(【\[]?\s*/, '');
      if (answer.length && !PLACEHOLDER_RE.test(preview.split('>')[0] + '>')
        && !/^(单个字母|一个字母|字母|选项)/.test(preview)) {
        picked = { answer, rawTok: letters.join('') };
      }
      search = after;
    }
    if (picked) {
      base.answer = picked.answer;
      base.letters = picked.answer.map(letter).join('');
      base.raw = picked.rawTok;
      base.source = 'answer-line';
      return base;
    }

    // ② 判断题：模型只回「正确」「不对」这种字面时，按 A=正确 / B=错误 理解
    if (o.allowBoolean && n === 2) {
      const verdict = tailJudgement(body);
      if (verdict != null) {
        base.answer = [verdict];
        base.letters = letter(verdict);
        base.raw = verdict === 0 ? '正确' : '错误';
        base.source = 'boolean';
        return base;
      }
    }

    // ③ 没有「答案：」行时的兜底。这一条必须收得很紧 —— 它读的是**散文**，
    //    而散文里到处是字母：题号、选项名、学科缩写（TCP / OS / IP）。
    //    只信「很短、整段基本就是一个字母」的回包，比如模型只回了 "B" 或 "选 B"。
    //    其余一律返回 null，让上层老老实实退回组合枚举：
    //    枚举慢，但它是确定性的；猜错一次要等平台判错、回退重播，代价更大。
    const trimmed = body.trim();
    if (trimmed.length <= 12) {
      const loose = trimmed
        .replace(/^(我的|我选|我选的是|应该?选|应该是|应选|答案|选|为|是)[:：=\s]*/, '')
        .trim();
      if (TOKEN_RE.test(loose)) {
        const answer = lettersOf(loose, n);
        if (answer.length) {
          base.answer = answer;
          base.letters = answer.map(letter).join('');
          base.raw = trimmed;
          base.source = 'loose';
          base.uncertain = true;
          return base;
        }
      }
    }

    return null;
  }

  /** 题库 / 缓存用的题目身份：题干哈希 + 选项数 + 题型 */
  function questionKey(stem, optionCount, multi) {
    // 归一化规则必须与 content/dom.js 的 normalize() 逐字对齐：
    // 两边算出来的是"同一道题"的标识，差一个字符就会让缓存命中率莫名下滑。
    const norm = String(stem || '')
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ')
      .replace(/\s+/g, '')
      .replace(/^[（(]\d+[）)]\s*/, '')      // 题号 (1) （1）
      .replace(/^\d+\s*[、.,:：]\s*/, '')     // 题号 1、 1. 1: 1，
      .toLowerCase();
    let h = 0x811c9dc5;
    for (let i = 0; i < norm.length; i++) {
      h ^= norm.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8) +
      '-' + optionCount + '-' + (multi ? 'm' : 's');
  }

  const api = {
    PROVIDERS,
    PROVIDER_IDS,
    LETTERS,
    letter,
    clip,
    stripOptionPrefix,
    hostOf,
    providerForUrl,
    getProvider,
    buildPrompt,
    previewPrompt,
    parseReply,
    questionKey,
    exampleLetters,
  };

  if (!root.__ZHS) root.__ZHS = {};
  root.__ZHS.webAI = api;
  root.ZHS_webAI = api;
})(typeof window !== 'undefined' ? window : self);
