/**
 * ability.js — 「能力提升」整页卷子的自动作答
 *
 * 这是和「视频课」并列的另一套场景，两者结构完全不同：
 *
 *   视频课   看着看着弹一道题（浮层），答完关掉继续播，一题一次独立问询
 *   能力提升 一整套卷子铺满整页，一题一题翻，最后统一提交
 *
 * ── 和视频那套的隔离（这是硬要求）──
 *
 * 1. **模式互斥**：`cfg.mode` 是单选（video / ability），不是两个独立开关。
 *    同一时刻只会有一套在跑 —— 从配置层面就把"同时开"堵死。
 * 2. **AI 通道排队**：两边共用同一个网页端 AI 标签页，所以 ai-bridge 里
 *    加了一道串行闸门（`withAiLock`），后来的等前面的走完。
 *    即使有人手动把两边都触发了，也不会出现"两段题目混在一个输入框里发出去"。
 *
 * ── 选择器为什么集中放在一张表里 ──
 *
 * 知到这类页面改版很勤，而且不同学校的皮肤不一样。把所有"可能变的东西"
 * 收在一张表里，改版时只动这一处；配合控制台的「看这一页的结构」把真实的
 * class 名报回来，就不用靠猜。
 */
(function (root) {
  'use strict';

  const NS = root.__ZHS || (root.__ZHS = {});
  if (NS.AbilitySolver) return;

  const IS_TOP = (() => {
    try { return root.top === root.self; } catch (e) { return false; }
  })();

  // ── 选择器表（改版只动这里）───────────────────────────────

  /** 认这一页是不是「能力提升」 */
  const PAGE_HINTS = [
    '[class*="ability"]', '[class*="capacity"]', '[class*="improve"]',
    '[class*="exam-paper"]', '[class*="paper-wrap"]', '[class*="answer-card"]',
    // ⚠ 实测到的作业页标记（onlineexamh5new.zhihuishu.com）：
    //   <div class="node_detail examquestions-answer"><p><span>选项文字</span></p></div>
    // 上面那几条 hint 全靠猜的英文词，这页一个都不含 —— 于是"能力提升"这套
    // 从来没在这一页启动过（日志里连「开始答这套卷子」都没有）。
    '.examquestions-answer', '.exam-item',
  ];

  /** URL 上的特征 */
  const PAGE_URL_RE = /ability|capacity|improve|exam|paper|test/i;

  /** 一道题的容器 */
  const QUESTION_SELECTORS = [
    '.subject-describe', '.subject_describe', '.subject-title',
    '.topic-item', '.question-item', '.exam-question',
    '[class*="topic-item"]', '[class*="question-item"]', '[class*="subject-item"]',
  ];

  /**
   * ⚠ 下面这张表是**照着开源脚本抄的**，不是我们自己猜的。
   *
   * 来源：Cooanyh/zhihuishu-zhangwodu
   *   「知到智慧树掌握度答题-AI自动答题脚本 v2.1.0」
   *   https://github.com/Cooanyh/zhihuishu-zhangwodu
   *   https://scriptcat.org/zh-CN/script-show-page/4444
   *
   * 它在作业页（onlineexamh5new.zhihuishu.com）上取题干是这样取的：
   *   const q = document.querySelector('.exam-item:not([style*="display: none"]) .question-item');
   *   q.querySelector('.quest-type')                 → 题型（单选题/多选题/判断题）
   *   q.querySelector('.quest-title .option-name')   → **题干**
   *   q.querySelectorAll('.el-radio, .el-checkbox')  → 选项
   *   option.querySelector('.preStyle')              → 选项文字
   *   document.querySelector('.submit')              → 提交
   *
   * 我们之前是"在所有可见文本里挑一段最像题的"，于是把
   * 「1.【单选题】(5分)」那个**题型标签**当题干发了出去。
   * 站点明明把题干放在 `.quest-title .option-name` 里 —— 有明确选择器就别猜。
   */

  /** 题干的首选元素 —— 命中就直接用，不再走"猜"那条路 */
  const STEM_SELECTORS = [
    // ⚠ 下面第一条是**在真实页面上量出来的**，不是猜的。
    // 作业页（onlineexamh5new.zhihuishu.com）的题干在
    //   <p><span>What is not the purpose of "Sha Qing"?</span></p>
    // 里；而题型标签「1. 【单选题】 (5分)」是**三个 span**（不是 p）：
    //   <span>1.</span><span>【单选题】</span><span>(5分)</span>
    // 所以"取 p、不要取 span 的父元素"就能把两者分开 ——
    // 之前一直把标签当题干，就是因为取到了那三个 span 的父容器。
    '.examquestions-topic p',
    'p',
    '.quest-title .option-name',
    '.exam-item:not([style*="display: none"]) .quest-title',
    '.quest-title',
    '.subject-describe', '.subject_describe', '.subject-title',
  ];

  /** 题型标签元素 —— 取样题干时要绕开 */
  const TYPE_SELECTORS = ['.quest-type', '.quest-index', '.subject-type'];

  /** 选项 */
  const OPTION_SELECTORS = [
    // ⚠ 实测：作业页**不是 Element UI**。选项那一行是
    //   <div class="node_detail examquestions-answer fl dynamic-fonts"><p><span>…</span></p></div>
    // 开源脚本给的 .el-radio / .el-checkbox 在这页上一条都命不中
    //（那是掌握度练习页的写法）。两条都留着，实测到的那条放最前。
    '.examquestions-answer',
    '.el-radio', '.el-checkbox',
    '.subject_node_item', '.subject-node-item', '.subject_item',
    '.option-item', '.optionItem', '.answer-item',
    '[class*="node_item"]', '[class*="option-item"]', '[class*="optionItem"]',
    '.el-radio', '.el-checkbox',
    'li[class*="option"]', 'div[class*="option"]',
  ];

  /**
   * 翻页 / 提交按钮（按文字找，最稳）。
   *
   * ⚠ 判据要**宽容**，不能是一张精确清单 —— 踩过：视频那边写的是
   * `^(提交|确定|…)$`，而站点上摆的是「提交作答」，于是日志报
   * 「没找到提交按钮」。清单永远列不全站点的写法：
   * 提交 / 提交作答 / 提交答案 / 确认提交 / 立即作答 / 交卷 都要认。
   *
   * 但"宽容"必须有边界：配 `MAX_LEN` 限制长度，否则正文里含"提交"
   * 两个字的一段说明也会被当按钮。
   */
  const NEXT_TEXT = /(下一题|下一頁|下一页|保存|next)/i;
  const PREV_TEXT = /(上一题|上一頁|上一页|prev)/i;
  const SUBMIT_TEXT = /(提交|交卷|立即作答|开始作答|开始答题|确认提交|submit)/i;
  const BTN_MAX_LEN = 14;

  /**
   * 「1.【单选题】(5分)」这种**题型标签** —— 不是题干，不能拿它去问 AI。
   *
   * ⚠ 用户现场（作业/测试页）：
   *   页面上摆的是  1.【单选题】(5分)  ← 第一行是标签
   *                 What is not the purpose of "Sha Qing"?   ← 这才是题干
   * 而发出去的题目是「1. 【单选题】(5分)」—— 选项倒是对的，
   * 于是 AI 拿着一道没有问题的题在选答案。
   *
   * 判据：整行就是"题号 + 【题型】 + (N分)"，没有别的内容。
   * 只匹配**整行**，所以"【多选题】以下哪些说法正确"这种带正文的不会被误伤。
   */
  const TYPE_LABEL_RE = new RegExp(
    '^[\\s\\d.、]*[【\\[]\\s*(单选|多选|判断|填空|简答|论述|不定项|选择)[^】\\]]*[】\\]]' +
    '[\\s(（]*\\d*\\s*分?[)）]?\\s*$'
  );

  /**
   * 题型标签的**碎片** —— 页面上它是三段独立元素，不是一整行。
   *
   * 实测：题干被读成「（5分）」。因为 TYPE_LABEL_RE 认的是整行
   * 「1.【单选题】(5分)」，而这三段是分开的：
   *   <span>2.</span> <span>【单选题】</span> <span>(5分)</span>
   * 孤立看，只有 `【单选题】` 能被 TYPE_LABEL_RE 认出来，
   * `2.` 和 `(5分)` 都会漏过去 —— 而 (5分) 偏偏是选项中线上方最后一个候选，
   * 于是它赢了，题干就变成了「（5分）」。
   */
  // 题型标签的**碎片**：页面上它是三段独立元素，不是一整行 ——
  //   <span>2.</span> <span>【单选题】</span> <span>(5分)</span>
  // 孤立看只有 【单选题】 能被 TYPE_LABEL_RE 认出来，`2.` 和 `(5分)` 会漏过去，
  // 而 (5分) 偏偏是选项中线上方最后一个候选 —— 于是题干被读成了「（5分）」。
  const FRAGMENT_RE = /^[（(]\s*\d+\s*分\s*[）)]$|^\d+\s*[.、．]?\s*$|^[【\[][^】\]]{1,10}[】\]]$/;
  const NOISE_RE = /答题卡|已作答|未作答|客观题|主观题|注意甄别|AI\s*生成|仅供参考|选择题选项顺序|答题后请点|避免答题记录丢失|建议你学练结合|正在加载|加载中|保存成功|保存失败|提交成功|提交失败|操作成功|操作失败|网络异常|请稍后/;

  function textOf(el) {
    if (!el) return '';
    if (typeof NS.dom === 'object' && NS.dom && typeof NS.dom.textOf === 'function') {
      return NS.dom.textOf(el);
    }
    return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * "这段文字读得到吗" —— **不看 pointer-events**。
   *
   * isVisible 里那条 `pointerEvents === 'none' → false` 是给"能不能点"用的。
   * 对读文字来说它是个陷阱：题干常被放在可点区域里并设成 pointer-events:none
   * （为了不挡住点击），于是题干被判"不可见"，整条查找都绕过了它 ——
   * 实测后果就是题干被读成「总题数: 2」。
   */
  function visibleForText(el) {
    if (!el || !el.isConnected) return false;
    try {
      const st = root.getComputedStyle(el);
      if (!st) return false;
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      if (Number(st.opacity) < 0.05) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof NS.dom === 'object' && NS.dom && typeof NS.dom.isVisible === 'function') {
      return NS.dom.isVisible(el);
    }
    const st = root.getComputedStyle(el);
    if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function realClick(el) {
    if (!el) return false;
    if (typeof NS.dom === 'object' && NS.dom && typeof NS.dom.realClick === 'function') {
      return NS.dom.realClick(el);
    }
    try { el.click(); return true; } catch (e) { return false; }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function jitter(base, ratio) {
    const r = Number(ratio) || 0.4;
    return sleep(Math.round(base * (1 + (Math.random() * 2 - 1) * r)));
  }

  function classOf(el) {
    const c = el && el.className;
    if (typeof c === 'string') return c;
    if (c && typeof c.baseVal === 'string') return c.baseVal;   // SVG
    return '';
  }

  function letter(i) {
    return String.fromCharCode(65 + i);
  }

  // ── 探测 ─────────────────────────────────────────────────

  /** 这一页是不是「能力提升」卷子 */
  function looksLikeAbilityPage(doc) {
    const d = doc || root.document;
    if (!d) return false;
    // 先看 URL
    const href = String(root.location && root.location.href || '');
    for (const sel of PAGE_HINTS) {
      try { if (d.querySelector(sel)) return true; } catch (e) { /* 选择器不合法就跳过 */ }
    }
    // 兜底：页面上同时有"选项组 + 下一题按钮" —— 那就是在翻页做卷子，
    // 而不是弹了一道题。
    //
    // ⚠ 这里**不再**因为"页面上有对话框"就否掉整页。
    // 原来的写法末尾有一句 `&& !d.querySelector('.el-dialog__wrapper, [class*="message-box"]')`，
    // 本意是"别把弹题浮层当成整页卷子"。但作业页上「提交作业」的确认框
    // 就是 `.el-message-box` —— 它一挂在那儿，整页就被判成"不是能力页"，
    // 于是**什么都停摆了**（用户报的"网页端 ai 也不会输入题目了"）。
    // 判据换成：选项够多就是整页卷子；浮层里不会同时有 4 个选项行。
    const hasNext = findButtonByText(d, NEXT_TEXT) || findButtonByText(d, SUBMIT_TEXT);
    const optionGroups = countOptionGroups(d);
    if (hasNext && optionGroups >= 2) return true;
    if (hasNext && optionGroups >= 1 && PAGE_URL_RE.test(href)) return true;
    return false;
  }

  function findButtonByText(doc, re) {
    let all;
    try {
      all = doc.querySelectorAll('button, a, div[role="button"], span, div');
    } catch (e) {
      return null;
    }
    const cands = [];
    for (const el of all) {
      if (el.children && el.children.length > 1) continue;
      if (!isVisible(el)) continue;
      const t = textOf(el).replace(/\s+/g, '');
      if (!t || t.length > BTN_MAX_LEN) continue;
      if (!re.test(t)) continue;
      cands.push(el);
    }
    if (!cands.length) return null;
    // **最短的**那一个最像按钮本身：判据放宽之后，外层容器里也含这几个字
    cands.sort((a, b) => textOf(a).replace(/\s+/g, '').length - textOf(b).replace(/\s+/g, '').length);
    return cands[0];
  }

  function countOptionGroups(doc) {
    for (const sel of OPTION_SELECTORS) {
      let list;
      try { list = doc.querySelectorAll(sel); } catch (e) { continue; }
      const n = Array.from(list).filter(isVisible).length;
      if (n >= 2) return n;
    }
    return 0;
  }

  // ── 读当前这道题 ─────────────────────────────────────────

  class AbilitySolver {
    constructor() {
      this._log = () => {};
      this.running = false;
      this._stop = false;
      this.stats = { total: 0, answered: 0, byBank: 0, byAI: 0, failed: 0, submitted: 0 };
      this.lastKey = '';
    }

    setLogger(fn) { this._log = typeof fn === 'function' ? fn : () => {}; }

    log(level, msg) { try { this._log(level, msg); } catch (e) { /* noop */ } }

    /**
     * 算出"这一题"在屏幕上的矩形 —— 图像方案的取景框。
     *
     * 逻辑很简单，而且**不依赖任何 DOM 结构**：
     *   选项组是已知的（刚才已经拿到 optEls），所以
     *     下边 = 最后一个选项的底部 + 20px
     *     上边 = 第一个选项的顶部 - 320px   ← 把题干、题型标签、题号全圈进来
     *   左右取内容区边界（比选项稍宽一点，别把选项文字切掉）
     *
     * 为什么这样稳：**它只用到我们唯一确定的东西（选项的位置）**。
     * 前面十几轮栽的那些（题干元素叫什么、在 DOM 里排第几、是不是被 toast 盖住）
     * 全都绕开了 —— 让 AI 自己从图里读。
     */
    questionRect(optEls) {
      const els = optEls || [];
      if (!els.length) return null;
      let top = Infinity;
      let bottom = -Infinity;
      for (const el of els) {
        let r = null;
        try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
        if (!r || r.height < 1) continue;
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
      if (!Number.isFinite(top)) return null;

      const PAD_TOP = 320;      // 题干 + 题型标签 + 题号
      const PAD_BOTTOM = 20;
      const vw = root.innerWidth || 1200;
      const vh = root.innerHeight || 800;

      // ⚠ 横向**截满整屏**，不做收窄。
      //
      // 反复踩到"截图左边被切掉"（题干成了「m advocates for living in harmony…」）——
      // 根子在"CSS 像素 → 位图像素"那个缩放系数：Windows 缩放下它不总等于
      // devicePixelRatio，估算偏大就整体往右裁。
      //
      // 与其把缩放算准（已经试过一版，仍有偏差），不如**不去依赖它**：
      // 横向从 0 到满宽，误差就切不到任何文字；只有纵向需要精确定位，
      // 而纵向的误差只是"多截或少截一行"，AI 照样读得懂。
      const rect = {
        left: 0,
        top: Math.round(Math.max(0, top - PAD_TOP)),
        width: Math.round(vw),
        height: Math.round(Math.max(0, Math.min(vh, bottom + PAD_BOTTOM) - Math.max(0, top - PAD_TOP))),
      };
      if (rect.width < 40 || rect.height < 40) return null;

      // 判"要不要滚"只看**选项本身**跑没跑出视口。
      //
      // ⚠ 原来这里写的是 `(top - PAD_TOP < 0) || (bottom + PAD_BOTTOM > vh)` ——
      // 也就是说"往上留 320px 的取景余量"没装下就滚一次。
      // 那个条件**太松**：题目本来好好在屏幕里，它也照滚。
      //
      // 而滚动在这类页面上是**危险动作** —— 有些考试页是"靠滚动切题"的，
      // 滚一下就等于翻一页，于是跳过一道题（用户反复报的"跳题"）。
      // 收益（多留点题干余量）远小于代价（跳题），所以把条件收紧到
      // "选项真的不在视口里"才滚。
      const clipped = (top < 0) || (bottom > vh);
      return { rect, clipped: clipped };
    }

    /** 让题目进入视口（截全它）——**只在选项真的跑出视口时才动** */
    ensureQuestionVisible(optEls) {
      const els = optEls || [];
      if (!els.length) return false;
      try {
        const vh = root.innerHeight || 800;
        // 以**选项**为判据（不看"往上 320px 的取景余量"）：
        // 滚动的代价可能是翻页，所以条件必须严格。
        let top = Infinity;
        let bottom = -Infinity;
        for (const el of els) {
          let r = null;
          try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
          if (!r || r.height < 1) continue;
          top = Math.min(top, r.top);
          bottom = Math.max(bottom, r.bottom);
        }
        if (!Number.isFinite(top)) return false;
        if (top >= 0 && bottom <= vh) return false;      // 本来就在视口里，别动

        const want = Math.max(0, root.scrollY + top - 340);
        root.scrollTo({ top: want, behavior: 'instant' });
        return true;
      } catch (e) { /* noop */ }
      return false;
    }

    /** 找输入框（给 AI 页面用） */

    /** 停下来（换页 / 用户点了停止） */
    stop() { this._stop = true; }

    looksLikeAbilityPage() { return IS_TOP && looksLikeAbilityPage(); }

    /**
     * 题干候选的现场快照 —— 读出来的题干不对时，把候选摊开。
     *
     * 「题目读取」这条线已经猜了好几轮（先后猜"标签在前面"、"选择器不对"、
     * "循环里漏了判据"），每次都靠用户来回试。猜不下去的原因是**看不到真实 DOM**。
     * 所以这个方法让它在**出错的那一刻**自己把候选交出来：
     * 每条选择器命中几个、class 是什么、开头文字是什么 —— 一次就能定位。
     */
    dumpStemCandidates() {
      const doc = root.document;
      const out = [];
      const uniq = new Set();
      const push = (sel) => {
        let list;
        try { list = doc.querySelectorAll(sel); } catch (e) { return; }
        let n = 0;
        for (const el of list) {
          if (n >= 6) break;
          if (!isVisible(el)) continue;
          if (uniq.has(el)) continue;
          uniq.add(el);
          n++;
          out.push({
            sel: sel,
            cls: classOf(el).slice(0, 40),
            text: textOf(el).replace(/\s+/g, ' ').slice(0, 46),
            是选项: el.querySelector && !!el.querySelector('.el-radio,.el-checkbox,input[type=radio]'),
          });
        }
      };
      for (const s of STEM_SELECTORS) push(s);
      for (const s of QUESTION_SELECTORS) push(s);
      return out;
    }

    /** 当前这一题：{ stem, options, multi, key } 或 null */
    read() {
      const doc = root.document;

      // 选项：按表格里的选择器找**当前在看的**那一组
      //
      // ⚠ 这页把整张卷子的题**全都放在 DOM 里**，靠滚动切题 ——
      // 所以"文档里第一组选项"永远是第 1 题，而不是屏幕上这道。
      // 实测就是被这个坑住的：
      //   · 题干读成「总题数: 2」（因为拿的那组在最前面，"选项之前"只剩页头）
      //   · AI 拿第 1 题的选项作答，而用户在看第 2 题
      // 判据换成"**最靠近视口中心**的那一组" —— 屏幕上正在看哪道就读哪道。
      let optEls = [];
      for (const sel of OPTION_SELECTORS) {
        let list;
        try { list = doc.querySelectorAll(sel); } catch (e) { continue; }
        // 先排掉藏在屏幕外的（display:none 的祖先、或被挪到 -9999px 的）
        const alive = Array.from(list).filter((el) => isVisible(el) && el.offsetParent !== null);
        if (alive.length < 2) continue;

        // 按父元素归组（同一个 .exam-item 里的选项是一组）
        const groups = [];
        const seen = new Map();
        for (const el of alive) {
          const p = el.parentElement || doc.body;
          if (!seen.has(p)) { seen.set(p, []); groups.push(seen.get(p)); }
          seen.get(p).push(el);
        }

        let bestGroup = null;
        let bestDist = Infinity;
        const mid = (root.innerHeight || 600) / 2;
        for (const g of groups) {
          if (g.length < 2 || g.length > 12) continue;
          let r = null;
          try { r = g[0].getBoundingClientRect(); } catch (e) { r = null; }
          if (!r) continue;
          const d = Math.abs(r.top + r.height / 2 - mid);
          if (d < bestDist) { bestDist = d; bestGroup = g; }
        }
        // 一组都没凑齐（比如选项没父元素）就退回老做法
        const top = bestGroup || alive.slice(0, 12);
        if (top.length >= 2 && top.length <= 12) { optEls = top; break; }
      }
      // ⚠ 先把"我们到底在看哪一层 DOM"报出来。
      //
      // 实测出现过：题干读成"总题数: 2"、而且「下一题」「提交作业」都找不到 ——
      // 可页面上这两个按钮明明都在。这三件事一起说明一种可能：
      // content script 读到的这份 DOM 和屏幕上那个不是同一层（卷子正文在 iframe 里？）。
      // 光看元素名永远查不出来，得先确认"在看哪一层"。
      this.log('debug', '读取上下文：顶层框架=' + IS_TOP +
        ' · 文档里 iframe=' + (doc.querySelectorAll('iframe').length) +
        ' · 选项=' + optEls.length + ' 个');
      if (optEls.length) {
        const path0 = [];
        for (let n = optEls[0]; n && n !== doc.body && path0.length < 8; n = n.parentElement) {
          path0.push((n.tagName || '').toLowerCase() + (classOf(n) ? '.' + classOf(n).split(/\s+/)[0] : ''));
        }
        this.log('debug', '  选项[0] 的祖先链（由内向外）：' + path0.join(' < '));
        this.log('debug', '  选项[0] 是不是在 iframe 里：' +
          !!(optEls[0].ownerDocument && optEls[0].ownerDocument !== doc));
      }

      if (optEls.length < 2) {
        // ⚠ 别静默返回。用户这几轮报的"读不到题目"，
        // 日志里只有一句「读不到题目，停手」—— 断在哪一步完全看不出来。
        // 现在把每个选择器的**可见命中数**打出来，一眼就能定位。
        let probe = '';
        try {
          probe = OPTION_SELECTORS.map((sel) => {
            let n = -1;
            try { n = Array.from(doc.querySelectorAll(sel)).filter(isVisible).length; } catch (e) { n = -1; }
            return sel + '=' + n;
          }).join('  ');
        } catch (e) { probe = '(探测失败)'; }
        this.log('warn', '读不到题目：**选项不够**（只找到 ' + optEls.length + ' 个）');
        this.log('debug', '  各选项选择器可见命中：' + probe);
        return null;
      }

      // ⚠ 先走**明确选择器**，命中就完事 —— 别一上来就猜。
      //
      // 开源脚本在作业页上用的是 `.quest-title .option-name`（题干）
      // 和 `.quest-type`（题型标签，**另一个元素**）。
      // 我们原来是"在所有可见文本里挑一段最像题的"，于是题型标签
      // 「1.【单选题】(5分)」被当成了题干，选项倒是对的 ——
      // AI 拿着一道没有问题的题在选答案（用户的截图）。
      const optSet = new Set(optEls);
      let stem = '';
      let stemFrom = '';

      // ★★ 题干：**按像素位置取** —— 第一个选项的**正上方**、离它最近的那条文本。
      //
      // 这条放在最前面，因为它不依赖任何 DOM 结构假设。
      // 前面那些规则全都栽在同一件事上：DOM 顺序 ≠ 屏幕顺序。
      // 这页把整张卷子都留在 DOM 里，于是"文档顺序上排在选项之前"的元素
      // 可能压根不在这一题的旁边 —— 兜底三因此选到了「总题数: 2」。
      // 而"屏幕上就在选项正上方"是**几何事实**，骗不了人。
      {
        let optTop = Infinity;
        try { optTop = optEls[0].getBoundingClientRect().top; } catch (e) { optTop = Infinity; }
        if (Number.isFinite(optTop)) {
          const optTexts0 = new Set(optEls.map((o) => textOf(o).replace(/\s+/g, '')));
          let best = '';
          let bestGap = Infinity;
          let all = [];
          try {
            // ⚠ 扫**所有**元素，不限定标签名。
            //
            // 无障碍树里明明有那句题干（`paragraph "Which tea is a non-fermented tea?"`），
            // 可我怎么扫都扫不到它 —— 原因就是这里只列了 10 种标签，
            // 题干那个元素不在其中。平台**没有**反爬保护，是我的枚举不完整。
            // 代价是几千个元素遍历一遍，但每题只跑一次，可以接受。
            all = Array.from(doc.querySelectorAll('*'));
          } catch (e) { all = []; }
          for (const el of all) {
            if (!visibleForText(el)) continue;
            if (optEls.some((o) => o === el || o.contains(el))) continue;
            const t = textOf(el);
            if (!t || t.length < 6 || t.length > 300) continue;
            if (NOISE_RE.test(t)) continue;
            if (TYPE_LABEL_RE.test(t)) continue;
            if (FRAGMENT_RE.test(t)) continue;          // 2. / 【单选题】 / (5分)
            if (optTexts0.has(t.replace(/\s+/g, ''))) continue;
            let r = null;
            try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
            if (!r || r.height < 2) continue;
            const gap = optTop - r.bottom;              // 它在选项上方多少像素
            if (gap < -4) continue;                     // 落在选项下面/重叠太多 ⇒ 不是它
            if (gap < bestGap) { bestGap = gap; best = t; }
          }
          // ⚠ 再扫一遍**裸文本节点** —— 而且**必须无条件跑**。
          //
          // 上一版我把它写成 `if (!best)`（只在元素扫描一无所获时才跑），
          // 结果是：元素扫描随便抓到一个（右侧边栏的「完成率 0%」）就把 best 占住了，
          // 裸文本这一轮**根本没执行** —— 而真正的题干恰恰是裸文本节点。
          //
          // 现在改成**比 gap**：谁能给出更小的 gap（更贴近选项）谁赢。
          // 实测：题干是「Culture can be divided into （） sub-categories.」
          // 它是容器里的一段裸文本，按元素怎么扫都扫不到它。
          {
            // ⚠ `won` 必须声明在 try **外面** —— catch 之后的 `if (won)` 才看得见。
            // 写在 try 里会变成块级作用域，外面引用直接抛
            // `won is not defined`（实测崩了三轮）。
            let won = false;
            try {
              const walker = doc.createTreeWalker(doc.body, 4);   // 4 = SHOW_TEXT
              let tn = null;
              let bestGap2 = bestGap;          // 和元素扫描的冠军同台比
              while ((tn = walker.nextNode())) {
                const raw = (tn.nodeValue || '').replace(/\s+/g, ' ').trim();
                if (raw.length < 6 || raw.length > 300) continue;
                if (NOISE_RE.test(raw)) continue;
                if (TYPE_LABEL_RE.test(raw)) continue;
                if (FRAGMENT_RE.test(raw)) continue;
                if (optTexts0.has(raw.replace(/\s+/g, ''))) continue;
                const parent = tn.parentElement;
                if (!parent) continue;
                if (optEls.some((o) => o === parent || o.contains(parent))) continue;
                let r = null;
                try {
                  const range = doc.createRange();
                  range.selectNodeContents(tn);
                  r = range.getBoundingClientRect();
                } catch (e) { r = null; }
                if (!r || r.height < 2) continue;
                const gap = optTop - r.bottom;
                if (gap < -4) continue;
                if (gap < bestGap2) { bestGap2 = gap; best = raw; won = true; }
              }
            } catch (e) { /* noop */ }
            if (won) { stemFrom = '按像素位置(裸文本节点)'; }
            else if (best) { stemFrom = '按像素位置(选项正上方最近的一条)'; }
          }

          // ⚠⚠ 把算出来的结果**真正用上**。
          //
          // 之前这里少了一句 `stem = best` —— 上面那一整段（元素扫描 + 裸文本节点）
          // 认真算出了最优候选，然后被**丢掉**，接着落到"按内容挑"那条兜底路，
          // 于是题干一直是「总题数: N」。日志里 `题干来源=按内容挑` 就是这个原因，
          // 而"像素判据没生效"的假象也骗了好几轮。
          // **算出来了就要赋值** —— 这一句是整段的意义所在。
          if (best) stem = best;
        }
      }
      // ★ 题干：从选项往上找**最近的容器**，取容器里、选项中线上方最近的那个 <p>。
      //
      // 真页面量出来的结构：
      //   <div class="exam-item">
      //     <div class="quest-title"><span>1.</span><span>【单选题】</span><span>(5分)</span></div>
      //     <p><span>What is not the purpose of "Sha Qing"?</span></p>          ← 题干
      //     <div class="node_detail examquestions-answer">…</div>              ← 选项
      //   </div>
      //
      // ⚠ 为什么必须**限定在选项所在的容器里**（而不是全文档找 <p>）：
      // 页面上有瞬时提示条 —— 「正在加载中」「保存成功!」也是 <p>，
      // 而且它们挂在 body 上、位置在天上。全文档找的话，题干的位上就变成了
      // 这两句提示语（用户截图里连发了两条这种"题目"）。
      // 从选项往上逐层扩大范围，第一层就命中题干；提示条在 body 层，永远进不来。
      {
        let box = optEls[0];
        for (let up = 0; up < 6 && box && box !== doc.body && !stem; up++, box = box.parentElement) {
          let ps = [];
          try { ps = Array.from(box.querySelectorAll('p')); } catch (e) { ps = []; }
          for (const el of ps) {
            if (!visibleForText(el)) continue;
            if (optEls.some((o) => o === el || o.contains(el))) continue;
            // 必须排在选项之前
            // 必须排在**某个**选项之前（不要求是 optEls[0]：它未必是题目下面那一组的第一个）
            if (!optEls.some((o) => (el.compareDocumentPosition(o) & 4))) continue;

            const t = textOf(el);
            if (!t || t.length < 4 || t.length > 400) continue;
            // 排除"选项那一行"：文字以 A./B./… 开头
            if (/^\s*[A-H]\s*[.、．)）]/.test(t)) continue;
            // 排除"包住整个选项组的容器"：文字里出现两个以上选项字母
            if (((t.match(/(^|\s)[A-H]\s*[.、．)）]/g) || []).length) >= 2) continue;
            if (NOISE_RE.test(t)) continue;
            if (TYPE_LABEL_RE.test(t)) continue;
            if (FRAGMENT_RE.test(t)) continue;        // 题型标签的碎片：2. / 【单选题】 / (5分)
            stem = t;                                  // 一直覆盖 ⇒ 留下最近的那个
            stemFrom = 'p(选项容器内、其上方最近的段落)';
          }
        }
      }

      // ★ 兜底二：容器里没找到（页面上题干和选项可能**不在同一个容器**里，
      // 实测这页就是：题干是散落的 <p>，选项在 .node_detail.examquestions-answer 里），
      // 那就退回"全文档里、第一个选项之前最近的那个 <p>"。
      //
      // 为什么现在敢用全文档：瞬时提示条（正在加载中 / 保存成功!）已经在 NOISE_RE 里，
      // 而且这里额外排除"文字等于某个选项文字"的段落。
      if (!stem) {
        const optTexts = new Set(optEls.map((o) => textOf(o).replace(/\s+/g, '')));
        let best = '';
        let ps = [];
        try { ps = Array.from(doc.querySelectorAll('p')); } catch (e) { ps = []; }
        for (const el of ps) {
          if (!visibleForText(el)) continue;
          if (optEls.some((o) => o === el || o.contains(el))) continue;
          // ⚠ 不能包着选项！只判"在选项内部"是不够的 ——
          // 实测踩到：选项那一行的外层容器（含 "A." 和文字）文本以 "A." 开头，
          // 它 **包含** 选项，于是被当成了题干（日志里题干就是
          // "A.\n\nto change water content in tea leave"）。
          // 而且祖先元素对 compareDocumentPosition 也会返回 FOLLOWING(4)，
          // 这条做法已经废弃（见下面那条判据）。
          // 必须排在**某个**选项之前（不要求是 optEls[0]：它未必是题目下面那一组的第一个）
          if (!optEls.some((o) => (el.compareDocumentPosition(o) & 4))) continue;

          const t = textOf(el);
          if (!t || t.length < 4 || t.length > 400) continue;
          // 排除"选项那一行"：文字以 A./B./… 开头
          if (/^\s*[A-H]\s*[.、．)）]/.test(t)) continue;
          // 排除"包住整个选项组的容器"：文字里出现两个以上选项字母
          if (((t.match(/(^|\s)[A-H]\s*[.、．)）]/g) || []).length) >= 2) continue;
          if (NOISE_RE.test(t)) continue;
          if (TYPE_LABEL_RE.test(t)) continue;
          if (FRAGMENT_RE.test(t)) continue;        // 题型标签的碎片：2. / 【单选题】 / (5分)
          if (optTexts.has(t.replace(/\s+/g, ''))) continue;   // 别把选项文字当题干
          best = t;                                  // 一直覆盖 ⇒ 最近的那个
        }
        if (best) { stem = best; stemFrom = 'p(全文档里选项之前的最近段落)'; }
      }

      // ★ 兜底三：**不依赖标签名**。
      //
      // 实测（读页面控制台拿到的候选快照）：这页上所有 <p> 都是提示语和选项文字，
      // **题干压根不在 <p> 里** —— 前面两条兜底都按 <p> 找，所以都走不到。
      // （Chrome 的无障碍树把块级文本统称 "paragraph"，我因此误判了两轮。）
      //
      // 换成按内容判：把"选项之前"的所有元素都过一遍，用 quiz.js 那套
      // looksLikeStem（它认问号、认中英陈述句）挑出像题的那个，
      // 取**最靠近选项**的一条 —— 那就是题干。
      if (!stem) {
        const optTexts2 = new Set(optEls.map((o) => textOf(o).replace(/\s+/g, '')));
        let best = '';
        let bestLoose = '';
        let all = [];
        try {
          all = Array.from(doc.querySelectorAll('div,p,span,li,td,h1,h2,h3,h4,strong,em,b'));
        } catch (e) { all = []; }
        for (const el of all) {
          if (!visibleForText(el)) continue;
          if (optEls.some((o) => o === el || o.contains(el))) continue;
          // 必须排在**某个**选项之前（不要求是 optEls[0]：它未必是题目下面那一组的第一个）
          if (!optEls.some((o) => (el.compareDocumentPosition(o) & 4))) continue;

          const t = textOf(el);
          if (!t || t.length < 6 || t.length > 300) continue;
          // 排除"选项那一行"：文字以 A./B./… 开头
          if (/^\s*[A-H]\s*[.、．)）]/.test(t)) continue;
          // 排除"包住整个选项组的容器"：文字里出现两个以上选项字母
          if (((t.match(/(^|\s)[A-H]\s*[.、．)）]/g) || []).length) >= 2) continue;
          if (NOISE_RE.test(t)) continue;
          if (TYPE_LABEL_RE.test(t)) continue;
          if (FRAGMENT_RE.test(t)) continue;        // 题型标签的碎片：2. / 【单选题】 / (5分)
          if (optTexts2.has(t.replace(/\s+/g, ''))) continue;
          // ⚠ looksLikeStem 从"必须"降为"**优先**"。
          //
          // 它只是个启发式（认问号、认中英陈述句），而"最靠近选项"是**位置事实**。
          // 实测：答案就在选项正上方，可它被判据刷掉了 —— 一个启发式不该对位置事实一票否决。
          // 现在的取舍：优先给"既像题又最靠近选项"的那条；
          // 一条都没有时，退而取"最靠近选项"的那条（护栏仍然是全的：
          // 不是选项、不是噪声、不是题型标签、文字不等于选项）。
          bestLoose = t;                                // 一直覆盖 ⇒ 最靠近选项的那个
          if (!NS.quizUtils || !NS.quizUtils.looksLikeStem || NS.quizUtils.looksLikeStem(t)) {
            best = t;
          }
        }
        if (best) { stem = best; stemFrom = '按内容挑(选项之前最近的像题文本)'; }
        else if (bestLoose) {
          stem = bestLoose;
          stemFrom = '按内容挑(放宽：取选项正上方那条)';
          // ⚠ 走到"放宽"这条路，说明**没有一条候选长得像题** —— 那多半是我们
          // 找错了选项组（这页把整张卷子都放在 DOM 里，容易拿错）。
          // 这时把候选和选项的祖先链一起打出来，免得再来回猜。
          this.log('warn', '题干是从"放宽"那条路上取的（' + bestLoose.slice(0, 24) +
            '）—— 候选与选项现场如下：');
          try {
            const optPath = [];
            for (let n = optEls[0]; n && n !== doc.body && optPath.length < 8; n = n.parentElement) {
              optPath.push((n.tagName || '').toLowerCase() +
                (classOf(n) ? '.' + classOf(n).split(/\s+/)[0] : ''));
            }
            this.log('debug', '  选项[0] 祖先链：' + optPath.join(' < '));
            this.log('debug', '  选项[0] 文本：' + JSON.stringify(textOf(optEls[0]).slice(0, 40)));
            const opt0 = optEls[0];
            let shown = 0;
            for (const el of Array.from(doc.querySelectorAll('div,span,li,td,p,strong,em,b,font,h5'))) {
              if (shown >= 20) break;
              if (!visibleForText(el)) continue;
              let pos = 0;
              try { pos = el.compareDocumentPosition(opt0); } catch (e) { pos = 0; }
              if (!(pos & 4) || (pos & 16)) continue;      // 在选项之前、且不是它的祖先
              const t = textOf(el);
              if (!t || t.length < 4 || t.length > 200) continue;
              shown++;
              this.log('debug', '  · <' + (el.tagName || '').toLowerCase() +
                ' class=' + classOf(el).slice(0, 26) + '> ' + JSON.stringify(t.replace(/\s+/g, ' ').slice(0, 46)));
            }
            if (!shown) this.log('debug', '  · 选项之前没有任何可见文本元素');
          } catch (e) { /* noop */ }
        }
      }

      for (const sel of STEM_SELECTORS) {
        if (stem) break;
        let list;
        try { list = doc.querySelectorAll(sel); } catch (e) { continue; }
        for (const el of list) {
          if (!visibleForText(el)) continue;
          if (optSet.has(el)) continue;
          if (optEls.some((o) => o.contains(el))) continue;
          const t = textOf(el);
          if (!t || t.length < 4 || t.length > 400) continue;
          if (NOISE_RE.test(t)) continue;
          // ⚠ 这里**必须**也过一遍题型标签判据。
          //
          // 上一轮接开源选择器时，我给这个循环漏了这句 —— 而 STEM_SELECTORS 里
          // 有 `.quest-title` 这个候选。在一些版本的页面上 `.quest-title`
          // **恰好就是那个题型标签元素**（"1.【单选题】(5分)"），于是它一命中
          // 就把标签当成了题干，比加这个表之前还糟。
          // 教训：新加一条"更快的路径"时，原来那条路径上的**每一道校验**都要跟过来。
          if (TYPE_LABEL_RE.test(t)) continue;
          if (FRAGMENT_RE.test(t)) continue;        // 题型标签的碎片：2. / 【单选题】 / (5分)
          stem = t;
          stemFrom = sel;
          break;
        }
        if (stem) break;
      }

      // 兜底：明确选择器都没命中（别的页面布局）再走"猜"
      if (!stem) {
      for (const sel of QUESTION_SELECTORS) {
        let list;
        try { list = doc.querySelectorAll(sel); } catch (e) { continue; }
        for (const el of list) {
          if (!visibleForText(el)) continue;
          if (optSet.has(el)) continue;
          if (optEls.some((o) => o.contains(el))) continue;
          const t = textOf(el);
          if (!t || t.length < 4 || t.length > 400) continue;
          if (NOISE_RE.test(t)) continue;
          // 「1.【单选题】(5分)」这种题型标签不是题干 —— 跳过它，
          // 继续往下找真正的题目（用户现场就是被这一行顶掉了题干）
          if (TYPE_LABEL_RE.test(t)) continue;
          if (FRAGMENT_RE.test(t)) continue;        // 题型标签的碎片：2. / 【单选题】 / (5分)
          if (NS.quizUtils && NS.quizUtils.looksLikeStem && !NS.quizUtils.looksLikeStem(t)) continue;
          stem = t;
          stemFrom = '猜(' + sel + ')';
          break;
        }
        if (stem) break;
      }
      }   // ← 兜底块结束（明确选择器都没命中才会进这里）

      if (!stem) {
        this.log('warn', '读不到题目：选项有 ' + optEls.length + ' 个，但**找不着题干**');
        // ⚠ 再补一层现场：兜底三（不依赖标签名的那条）**看到**了什么、
        // 每条又是被哪一道判据刷掉的。前几轮只能看到"候选列表"，
        // 却看不到"筛掉了谁、为什么" —— 于是题干明明在页面上，我就是找不到它。
        try {
          const before = [];
          for (const el of Array.from(doc.querySelectorAll('div,span,li,td,p,strong,em,b'))) {
            if (!visibleForText(el)) continue;
            if (!optEls.some((o) => (el.compareDocumentPosition(o) & 4))) continue;
            const t = textOf(el);
            if (!t || t.length < 6) continue;
            before.push({ el: el, t: t });
          }
          before.slice(0, 40).forEach((c, i) => {
            this.log('debug', '  · 候选' + (i + 1) + ' <' + (c.el.tagName || '').toLowerCase() +
              ' class=' + classOf(c.el).slice(0, 30) + '> ' + JSON.stringify(c.t.replace(/\s+/g, ' ').slice(0, 60)));
          });
          if (!before.length) this.log('debug', '  · 选项之前没有任何可见文本元素');
        } catch (e) { /* noop */ }
        try {
          const cands = this.dumpStemCandidates();
          cands.slice(0, 8).forEach((c, i) => {
            this.log('debug', '  #' + (i + 1) + ' ' + c.sel + ' | class=' + c.cls +
              ' | 是选项=' + c.是选项 + ' | ' + JSON.stringify(c.text));
          });
          if (!cands.length) this.log('debug', '  题干候选一个都没有');
        } catch (e) { /* noop */ }
        return null;
      }

      const multi = this._isMulti(doc, stem);
      return {
        stem: stem,
        options: optEls,
        multi: multi,
        stemFrom: stemFrom || '未知',
        key: NS.bank ? NS.bank.keyOf(stem, optEls.length, multi) : stem.slice(0, 60) + '|' + optEls.length,
      };
    }

    /** 多选还是单选 —— 看题型标签，猜不到就当单选 */
    _isMulti(doc, stem) {
      try {
        const badge = textOf(doc.body).slice(0, 400);
        if (/多\s*选/.test(badge)) return true;
        if (/单\s*选|判\s*断/.test(badge)) return false;
      } catch (e) { /* noop */ }
      // 题干里的"多选/哪些"也算线索
      if (/多选|以下哪些|下列哪些/.test(stem)) return true;
      return false;
    }

    /** 读数：页面上"第几题 / 共几题 / 已答几题" */
    progress() {
      const doc = root.document;
      let done = 0;
      let total = 0;
      try {
        // 答题卡上的小方格：有的标"已作答"，有的只是变色
        const cards = doc.querySelectorAll('[class*="answer-card"] [class*="item"], [class*="answerCard"] li');
        total = cards.length;
        done = Array.from(cards).filter((el) => /已作答|done|finish|active/i.test(classOf(el))).length;
      } catch (e) { /* noop */ }

      // ⚠ 兜底：直接从页面上读「总题数: N」。
      //
      // 上面那个选择器跟这个页面**根本对不上**（实际是带编号的方格子，
      // 类名不是 answer-card）—— 之前日志里那个 `页面显示 0/1` 就是它算错了，
      // 而循环的收工判据又指望它给一个可靠的总数。
      // 「总题数: N」这行字就明明白白在页面上，读它比猜类名靠谱。
      if (!total) {
        try {
          const txt = (doc.body && (doc.body.innerText || doc.body.textContent)) || '';
          const m = txt.match(/总题数\s*[:：]\s*(\d+)/);
          if (m) total = Number(m[1]) || 0;
        } catch (e) { /* noop */ }
      }
      return { done: done, total: total };
    }

    // ── 作答 ──────────────────────────────────────────────

    /** 勾选第 i 个选项（会先清掉别的选择，避免单选选成两个） */
    async pick(quiz, indexes) {
      const want = new Set(indexes);
      let clicks = 0;          // 真的动手点了几次
      let skippedByBelief = 0; // 因为"以为已经选上了"而跳过的
      for (let i = 0; i < quiz.options.length; i++) {
        const el = quiz.options[i];
        if (!el || !el.isConnected) continue;
        const on = this.isSelected(el);
        const should = want.has(i);
        if (should === on) { skippedByBelief++; continue; }   // 已经是目标状态
        if (on === null && !should) continue;  // 看不出来，不动它
        clicks++;
        await this.clickOption(el);
        // ⚠ 还没勾上就**再试一层外层**。
        //
        // 实测这页的结构是 `div.node_detail`（文字）套在 `div.label` 里：
        //   div.node_detail < div.label < div.nodeLab < div.subject_node
        // 点击热区多半挂在 `.label` 那一层 —— 点文字容器什么都不会发生。
        // 内层→整行都试过还不行时，往上再试一层，成本很低、收益很直接。
        if (should) {
          const after = this.isSelected(el);
          if (after === false && el.parentElement) {
            await sleep(120);
            const rc = NS.dom.realClick || realClick;
            rc(el.parentElement);
          }
        }
      }

      // ⚠ 点完**回头核一遍**：真的选上了吗？
      // 「没有回答就点保存」这类问题，缺的就是这一步 ——
      // pick() 返回 true 只代表"我点过了"，不代表"站点认了"。
      //
      // ⚠⚠ 判据必须是**明确为真**（=== true），不能是"不是 false 就算"。
      // 原来写的是 `!== false` —— 而 isSelected 在看不出来时返回 **null**，
      // null !== false 成立 ⇒ **null 也被算成"选上了"** ⇒ pick 谎报成功
      // ⇒ 上层以为答完了、实际一个选项都没勾（用户报的"ai端没漏，填入答案漏了"）。
      let hit = 0;
      for (const i of want) {
        const el = quiz.options[i];
        if (!el || !el.isConnected) continue;
        if (this.isSelected(el) === true) hit++;
      }
      if (hit === 0 && clicks === 0 && skippedByBelief > 0) {
        this.log('warn', '一个选项都没点：isSelected 说"已经选上了"，但复核又不认 —— ' +
          '选中态读不准，这一题按没答上处理');
      }
      if (hit === 0) {
        this.log('warn', '点过了但一个选项都没选上（选中态没变化）—— 这一题算没答');
        this._pickFailed = true;
      } else {
        this._pickFailed = false;
      }
      return hit > 0;
    }

    /**
     * 点一个选项 —— 和视频那套同样的做法：**点对地方**，再确认动过。
     * 满宽的行中心常常落在右边空白里，点中心等于没点（「没法自动选择选项」）。
     */
    /**
     * 勾选一个选项 —— **直接复用视频答题那一套**。
     *
     * 这套逻辑在视频那条线上被真实站点打磨过好几轮：
     *   ① `clickTargetIn`：点"更像可点部位"的内层元素，而不是满宽行的几何中心
     *      （点中心会落在右边空白上，什么都不会发生）；
     *   ② 点完比对这个元素的**指纹**（class + style + aria + 内层长度），
     *      没变就补一下整行 —— 两种挂法（挂内层 / 挂整行）都覆盖；
     *   ③ 等待用**轮询**（40ms 一次，变了立刻返回）而不是固定 sleep：
     *      选中态通常是同步加的 class，固定等 200ms 不光白等，还会把整套
     *      枚举的时间拖长。
     *
     * 能力提升这边原来是自己抄了一份，等待是写死的 jitter(200)。
     * 两份实现迟早会漂，所以这里改成**委托**：一份实现，两边共用。
     * 拿不到视频那套时（模块加载顺序、单元测试里单独加载）退回本地实现。
     */
    async clickOption(el) {
      const q = NS.app && NS.app.quiz;
      if (q && typeof q.clickOption === 'function' && q !== this
          && typeof q.waitChanged === 'function') {

        // ⚠ 先**直接点这个元素本身**，再交给视频那套"找内部热区"的逻辑。
        //
        // 依据是实测（浏览器里真点，不是推断）：无障碍树把这页的选项渲染成
        //    @button "A."      ← 字母，是**独立的一个 button**
        //    @button "对"       ← 正文，另一个 button
        // 而直接点选项元素本身（正文那一块）**能把这一项勾上**（圆点变蓝、整行变灰）。
        //
        // 视频那套 clickOption 的策略是"先在元素内部找热区子元素" ——
        // 在这个页面上很可能找到那个**字母**去点，而点字母并不等于选中本项。
        // 所以这里反过来：**元素本身先来一次**，不灵再交给它。
        if (el && el.isConnected) {
          const sig = NS.dom && NS.dom.signatureOf;
          const sel = this.isSelected ? this.isSelected(el) : null;
          const before = sig ? sig(el) : '';
          realClick(el);
          await jitter(220, 0.4);
          const nowSel = this.isSelected ? this.isSelected(el) : null;
          const after = sig ? sig(el) : '';
          if (nowSel === true || after !== before) return true;
          if (sel === null && nowSel === null && after === before) {
            // 看不出状态也别急着判死 —— 交给下面那套再试
          }
        }

        return q.clickOption.call(q, el);
      }
      if (!el || !el.isConnected) return false;
      const sig = NS.dom && NS.dom.signatureOf;
      const before = sig ? sig(el) : '';
      const target = ((NS.dom && NS.dom.clickTargetIn) ? NS.dom.clickTargetIn(el) : el) || el;

      realClick(target);
      await jitter(200, 0.4);
      let after = sig ? sig(el) : '';
      if (after !== before) return true;

      if (target !== el) {           // 内层没反应 ⇒ 点击多半挂在整行上
        realClick(el);
        await jitter(200, 0.4);
        after = sig ? sig(el) : '';
        if (after !== before) return true;
      }
      return false;
    }

    /**
     * 这一个选项**选中了没有** —— 三态：true / false / **null（看不出来）**。
     *
     * ⚠ 这一条对应「第二题没有回答就点保存了」。
     *
     * 原来的本地实现末尾有这么一句：
     *     if (/border[^;]*(rgb|#)/.test(style) || /background.../.test(style)) return true;
     * 只要有**任何**内联边框/背景色就当成"选中"。而站点给未选中的选项也常写内联样式，
     * 于是 → `isSelected` 返回 true → `pick()` 里 `should === on` 成立 →
     * **continue，一个都不点**，接着就去点「保存」了。截图里圆圈全空就是这个样子。
     *
     * 现在把这一段换成"看不出来就老实说看不出来"（null）。调用方对 null 的处理是
     * "该点就点"（见 pick），所以宁可多一次点击，也不会漏点。
     * 同时整段委托给视频那套（一份实现，两边共用）。
     */
    isSelected(el) {
      const q = NS.app && NS.app.quiz;
      if (q && typeof q.isSelected === 'function' && q !== this) {
        return q.isSelected.call(q, el);
      }
      if (!el) return false;
      const cls = classOf(el).toLowerCase();
      if (/(inactive|unselected|unchecked|deselected)/.test(cls)) return false;
      if (/(active|selected|checked|chosen|highlight)/.test(cls)) return true;
      const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
      if (attr('aria-checked') === 'true') return true;
      if (attr('aria-selected') === 'true') return true;
      const input = el.querySelector && el.querySelector('input[type="radio"],input[type="checkbox"]');
      if (input) return input.checked === true ? true : false;
      const child = el.querySelector && el.querySelector(
        '.active,.selected,.checked,.icon-selected,.is-checked,[class*="selected"],[class*="active"]'
      );
      if (child) return true;
      // ⚠ 内联样式**不作为**"选中"的证据 —— 未选中的选项也常带边框/背景色，
      // 拿它当 true 会导致上面那条 bug（该点的没点）。
      return null;   // 看不出来
    }

    // ── 一题 ─────────────────────────────────────────────

    /**
     * 解这一题：题库 → 网页 AI。
     *
     * **问 AI 之前会先看题库** —— 能力提升是一整套卷子，一题一题问下去
     * 90 秒的等待乘以十几题就是十几分钟。做过的题秒过能省掉大部分时间。
     */
    async solveOne(quiz) {
      const cfg = NS.config.get();

      // ⚠ 题干**不可信时不许查/写题库**。
      //
      // 题库的键是 `hash(题干) + 选项数 + 题型`。而题干现在常常读成同一段乱码
      // （"总题数: 10" 这种）—— 于是**整张卷子所有题的键都一样**：
      // 一旦有一题被记进题库，后面每一题都"命中题库"、直接拿到同一个答案，
      // **连 AI 都不问**。用户看到的就是"程序自己在猜题"。
      //
      // 而且它还顺带解释了"后续题目不截图"：题库查询在截图**之前**，
      // 命中了就直接 return，后面的截图那段压根没执行。
      //
      // 判据：题干得**像一道真题**（够长、不是题型标签、不是提示语/碎片）。
      //
      // ⚠ 声明必须在 `if (cfg.useBank)` **外面** —— 下面"写题库"那一步也要用它，
      // 写在块里会变成块级作用域（实测：`stemOk is not defined`）。
      const stemOk = !!quiz.stem && quiz.stem.length >= 8
        && !FRAGMENT_RE.test(quiz.stem)
        && !TYPE_LABEL_RE.test(quiz.stem)
        && !NOISE_RE.test(quiz.stem);

      // ⚠ 「能力提升」模式下**默认不查、不写题库**（用户明确要求关掉）。
      //
      // 为什么必须关：
      //   这一模式的题干是从页面上"估"出来的，经常整卷读成同一段乱码
      //   （"总题数: 10"），而**题库的键就是题干哈希** ⇒ 全卷所有题共用一条记录：
      //     · 查：第 2 题起"命中题库"，把第 1 题的答案发给每一道题 —— 看起来像程序在猜题；
      //     · 写：更糟。第二次打开同一份卷子，那条错答案会被"命中"，**再也不会去问 AI**。
      //   两件事叠在一起，题库在这一模式下净是负作用。
      //
      // 想要的话可以在控制台里打开（abilityUseBank），默认关。
      const useBankHere = cfg.abilityUseBank === true;
      if (cfg.useBank && useBankHere) {
        const hit = stemOk
          ? NS.bank.lookup(quiz.stem, quiz.options.length, quiz.multi)
          : null;
        if (!stemOk) {
          this.log('debug', '题干不可信（' + String(quiz.stem).slice(0, 20) +
            '）—— 跳过题库查询，直接问 AI 看图');
        }
        if (hit) {
          this.log('info', '题库命中 → ' + hit.answer.map(letter).join(''));
          await this.pick(quiz, hit.answer);
          NS.bank.recordHit(hit.key);
          this.stats.byBank++;
          return true;
        }
      }

      if (!cfg.askWebAI) {
        this.log('warn', '题库没这道题，而且网页 AI 是关的 —— 跳过');
        this.stats.failed++;
        return false;
      }

      const bridge = NS.aiBridge;
      if (!bridge || typeof bridge.ask !== 'function') {
        this.stats.failed++;
        return false;
      }
      // 模式互斥的第二道保险：配置被手改成别的模式时，这里不再问 AI。
      // （第一道保险在 boot 里 —— 只有当前模式对应的那套才会被启动。）
      if (cfg.mode !== 'ability') {
        this.log('debug', '当前模式不是「能力提升」，跳过问 AI');
        this.stats.failed++;
        return false;
      }

      const t0 = Date.now();
      let answer = null;

      // ── 图像方案：把这一题**截下来**，让 AI 自己看 ──
      //
      // 从 DOM 读题干这条路在真实作业页上磨了十几轮都没稳住
      // （题型标签三段拆开、toast 覆盖、隐藏模板、题干是裸文本节点、
      //   DOM 顺序 ≠ 屏幕顺序……）。截图绕开了这全部。
      //
      // 取景只用**选项的位置** —— 那是我们唯一确定的东西。
      let image = null;
      try {
        const cfgI = NS.config.get();
        if (cfgI.askWithImage !== false) {
          let geo = this.questionRect(quiz.options);
          if (geo && geo.clipped) {
            // 题目没全在视口里，先滚一下再量 —— captureVisibleTab 抓不到屏幕外
            this.ensureQuestionVisible(quiz.options);
            await sleep(400);
            geo = this.questionRect(quiz.options);
          }
          if (geo && geo.rect) {
            // ⚠ 别用 `sendMessage` —— 那是 ai-bridge.js 里的**私有**函数，
            // ability.js 的作用域里没有它（实测：`截图异常：sendMessage is not defined`，
            // 截图这一步静默失败，于是又退回文字题干）。
            // 这里自己包一层 chrome.runtime.sendMessage。
            const shot = await new Promise((resolve) => {
              try {
                chrome.runtime.sendMessage(
                  {
                    type: 'ZHS_CAPTURE_REGION',
                    // 把视口尺寸一起带上 —— 后台靠"位图宽 ÷ 视口宽"算出真实缩放，
                    // 而不是拿 devicePixelRatio 猜（Windows 缩放下令猜错，
                    // 表现就是截图左边被切掉、AI 只能靠猜）。
                    rect: Object.assign({}, geo.rect, {
                      viewportW: root.innerWidth || 0,
                      viewportH: root.innerHeight || 0,
                    }),
                    dpr: root.devicePixelRatio || 1,
                  },
                  (r) => {
                    void chrome.runtime.lastError;   // 吞掉 lastError，别让它污染控制台
                    resolve(r || null);
                  }
                );
              } catch (e) {
                resolve(null);
              }
            });
            if (shot && shot.ok) {
              image = shot.dataUrl;
              this.log('info', '已截下这一题：' + shot.msg +
                '（区域 ' + geo.rect.width + '×' + geo.rect.height + '）');
            } else {
              this.log('warn', '截图没成：' + ((shot && shot.msg) || '无响应'));
            }
          } else {
            this.log('warn', '算不出取景框（选项没有有效位置）');
          }
        } else {
          this.log('info', '看图的开关是关的（askWithImage=false）—— 只发文字题干');
        }
      } catch (e) {
        this.log('warn', '截图异常：' + (e && e.message));
      }

      try {
        answer = await bridge.ask({
          stem: quiz.stem,
          options: quiz.options.map(textOf),
          multi: quiz.multi,
          // 有图就走看图作答：AI 页面那边先塞图、再用看图专用提示词；
          // 没图就退回老路（文字题干），不会因为截图失败整条停摆。
          image: image,
          // ⚠ 看图比纯文字慢：要上传、要渲染缩略图、模型还要读图。
          // 沿用同一个预算会让它在"图刚传上去、还没开口"时被判超时 ——
          // 多给 45 秒，代价只是超时那一刻晚一点到。
          timeoutMs: Math.max(5000, Number(NS.config.get().askWaitMs) || 45000) + (image ? 45000 : 0),
        });
      } catch (e) {
        this.log('debug', 'AI 通道异常：' + (e && e.message));
      }
      if (!answer || !answer.length) {
        this.stats.failed++;
        this.log('warn', '这道题没拿到答案（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
        return false;
      }

      // ⚠ 勾选前**重新读一遍选项** —— 别用十几秒前那批元素。
      //
      // 用户报的现象：所有题都截图上传了，但**只有第 1 题填入了答案**。
      // 时序是这样的：
      //   read() 拿到选项元素 → 截图 → 问 AI（十几秒）→ pick(quiz, answer)
      // 而在这十几秒里页面会重渲染（右侧"剩余时间"每秒都在跳），
      // **旧节点已经脱离文档** —— 点上去当然什么都不会发生。
      // 第 1 题之所以侥幸成功，是因为它离 read() 最近。
      //
      // 所以答案到手后**重新取一次选项**（数量对得上才用，免得拿错题）。
      let freshOpts = null;
      try {
        const again = this.read();
        if (again && again.options && again.options.length === quiz.options.length) {
          freshOpts = again.options;
        }
      } catch (e) { freshOpts = null; }
      const targetQuiz = freshOpts ? Object.assign({}, quiz, { options: freshOpts }) : quiz;
      if (freshOpts) {
        const alive = targetQuiz.options.filter((o) => o && o.isConnected).length;
        if (alive < targetQuiz.options.length) {
          this.log('debug', '重读到的选项里有 ' + (targetQuiz.options.length - alive) +
            ' 个已脱离文档 —— 用新读到的这批来点');
        }
      }

      await this.pick(targetQuiz, answer);
      this.log('info', '用 AI 的答案作答 [' + answer.map(letter).join('') + ']' +
        '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
      // 题干不可信时**也不许写题库** —— 写进去就是一颗脏数据，
      // 而它的键和整张卷子所有题都一样，下次会把这条答案发给每一道题。
      // （这一模式默认连题库都不用，见上面 useBankHere 的说明。）
      if (cfg.learnAnswers && useBankHere && stemOk) {
        NS.bank.remember(quiz.stem, quiz.options.length, quiz.multi, answer);
      }
      this.stats.byAI++;
      return true;
    }

    /**
     * 翻到下一题 —— 视频那边的"切章节"就是同一个问题，解法也照搬。
     *
     * ⚠ 提交逻辑（按用户要求改过）：
     *   ① 按钮文案：下一题 / 下一页 / **保存**（站点上「下一题」答完会变成「保存」，
     *      只认「下一题」会在这里停住）；
     *   ② **点完要确认页面真的翻了** —— 比对题干是否变化。原来只是 `realClick` 完就走，
     *      点空了什么都不知道，下一轮 `read()` 读到的还是同一道题，于是
     *      run() 里"题干没变就收工"直接结束整套答题；
     *   ③ 没翻动就**换另一种点法再试一次**（CDP ⇄ 合成事件）：
     *      哪条能生效取决于页面状态，光看日志分不出来，别赌。
     */
    async next() {
      const el = findButtonByText(root.document, NEXT_TEXT);
      if (!el) return false;                 // 真的没有「下一题」＝到头了

      // ⚠ **只点一次。**
      //
      // 上一版在"没看出变化"时会**补点第二下** —— 而"没看出变化"经常只是
      // 读题失败（这条路读不准是常态），页面其实已经翻过去了，
      // 第二下就**又翻一页** ⇒ 一次跳过一整道题（用户报的"3 和 4 题被跳过"）。
      //
      // 判不出来时**什么都不做**才是安全的：
      //   · 真翻过去了 → 外层继续正常答下一题
      //   · 真没翻动   → 外层的 lastSig 会发现"和上一题一样"并停下（停下来，不是跳过）
      //
      // 补点那一下的收益（把没点上的救回来）远小于它的代价（跳题）。
      const before = this._optSig();
      realClick(el);
      await this._waitOptChanged(before, 6000);
      return true;
    }

    /** 当前选项的文字签名 —— 用来判断"这一题换了没有" */
    _optSig() {
      try {
        const q = this.read();
        return q ? q.options.map((o) => textOf(o)).join('|') : '';
      } catch (e) {
        return '';
      }
    }

    /**
     * 页面进度签名 —— **不依赖 read()** 的第二个信号。
     *
     * 为什么要它：`read()` 读题的能力本身就不稳（整条线的麻烦都出在这儿），
     * 而我一直拿它的输出当"翻页成功没有"的**唯一**判据。
     * 实测日志：翻页后 read() 返回的内容没变 ⇒ 判据永远为假 ⇒
     * `这一题和上一题完全一样（翻页没生效？），收工` ⇒ 只答了 1 题。
     *
     * 而页面上有站点**自己维护**的进度显示（「完成率 14%」/ 答题卡高亮）——
     * 存档之后它会变。这个信号跟 read() 完全独立，两个一起看就稳得多。
     */
    _pageSig() {
      let rate = '';
      let card = '';
      try {
        const doc = root.document;
        const txt = (doc.body && (doc.body.innerText || doc.body.textContent)) || '';
        const m = txt.match(/完成率\s*[:：]?\s*(\d+)/);
        if (m) rate = m[1];
        // 答题卡里"当前题"的高亮（类名因站点而异，取一个宽松的判据）
        const cards = doc.querySelectorAll('[class*="card"] li, [class*="card"] [class*="item"]');
        for (const el of cards) {
          if (/active|current|on\b|selected/i.test(classOf(el))) {
            card = classOf(el) + ':' + textOf(el).trim().slice(0, 6);
            break;
          }
        }
      } catch (e) { /* noop */ }
      return rate + '|' + card;
    }

    /**
     * 等选项文字真的变了 —— **这一步是"截图拍到上一题"的修法**。
     *
     * 用户判断得很准：点完「下一题」页面要重新渲染，如果不等它渲染完就去截图，
     * 拍到的还是上一题（或者过渡状态）。原来这里只 `sleep(250ms)`，
     * 而 AI 那一段又要等十几秒，节奏更容易错位。
     *
     * 现在改成**轮询到内容真的换了、或超时为止**（最多 6 秒）。
     * 换得快就立刻走，慢就多等一会儿 —— 两种情况都不会拍到旧题。
     */
    async _waitOptChanged(before, maxMs) {
      if (!before) return true;                 // 拿不到基线，不卡在这里
      const basePage = this._pageSig();
      const until = Date.now() + maxMs;
      for (;;) {
        const now = this._optSig();
        if (now && now !== before) {
          await sleep(260);                     // 再给渲染收个尾（字号/布局）
          return true;
        }
        // 选项签名没变时，看**页面进度**变没变（站点自己维护的那个信号）
        if (this._pageSig() !== basePage) {
          await sleep(260);
          return true;
        }
        if (Date.now() >= until) return false;
        await sleep(180);
      }
    }

    /** 当前页面上的题干（读不到就返回空串）—— 用来判断"翻页翻动没有" */
    _stemNow() {
      try {
        const q = this.read();
        return q ? q.stem : '';
      } catch (e) {
        return '';
      }
    }

    _stemChanged(before) {
      const now = this._stemNow();
      return !!now && now !== before;
    }

    /**
     * 提交确认弹窗。
     *
     * 点「提交作业」之后站点会问一句：
     *   「是否确认提交?提交后,批阅过的试卷不能再修改!」  取消 / 确定
     * 不点「确定」就等于没交 —— 而这一步原来是漏的（截图里那个弹窗就挂在那儿）。
     *
     * 只在**确实弹出确认框**时才动手：先找可见的对话框且里面有那句确认文案，
     * 再点它内部的「确定」。这样不会误点到页面上别的"确定"按钮。
     */
    confirmSubmit() {
      const doc = root.document;
      let dlg = null;
      const SEL = ['.el-message-box', '.el-dialog', '[role="dialog"]', '.el-popup-parent--hidden .el-message-box'];
      for (const sel of SEL) {
        let list;
        try { list = doc.querySelectorAll(sel); } catch (e) { continue; }
        for (const el of list) {
          if (!visibleForText(el)) continue;
          if (!/确认提交|是否提交|确认交卷|不能再修改/.test(textOf(el))) continue;
          dlg = el;
          break;
        }
        if (dlg) break;
      }
      if (!dlg) return false;

      // 在弹窗内部找「确定」，**绝不**用页面上别的地方的按钮
      const inner = Array.from(dlg.querySelectorAll('button, .el-button, [role="button"]'));
      for (const b of inner) {
        const t = textOf(b).trim();
        if (!isVisible(b)) continue;
        if (!/^(确定|确认|是|提交)$/.test(t)) continue;   // 「取消」不匹配
        realClick(b);
        return true;
      }
      return false;
    }

    submit() {
      const el = findButtonByText(root.document, SUBMIT_TEXT);
      if (!el) return false;
      realClick(el);
      return true;
    }

    // ── 整套 ─────────────────────────────────────────────

    /**
     * 把整页卷子答完。
     *
     * 循环是"读一题 → 答一题 → 下一题"，用**题干指纹**判断有没有真的翻页：
     * 翻不动了就收工。这比数"答了几题"稳 —— 页面上的计数不一定准，
     * 而"题干变了没有"是硬信号。
     */
    async run() {
      if (!IS_TOP) return false;
      if (this.running) {
        this.log('debug', '整套答题已经在跑了');
        return false;
      }      const cfg = NS.config.get();
      // ⚠ 这三条守卫原来是**静默** return false 的 —— 于是"什么都没发生"
      // 在日志里查不出原因（用户这回就是：没有任何日志，AI 那侧也没收到题）。
      // 每一条都必须说出自己拦下了什么。
      if (!cfg.enabled) {
        this.log('warn', '总开关是关的（enabled=false）—— 不答题');
        return false;
      }
      if (!cfg.abilityAuto) {
        this.log('warn', '「能力提升 · 自动答题」这个开关是关的 —— 到控制台把它打开');
        return false;
      }
      if (cfg.mode !== 'ability') {
        this.log('warn', '当前模式不是「能力提升」（现在是 ' + cfg.mode + '）—— 不在这里答题');
        return false;
      }

      this.running = true;
      this._stop = false;
      const max = Math.max(1, Number(cfg.abilityMaxQuestions) || 30);
      const seen = new Set();
      // 上一题的"选项文字 + 题干"指纹 —— 用来判断翻页到底生效没有
      let lastSig = '';
      // 哪几题没答上（从 1 数）—— 走完之后回头补
      const missed = [];
      let n = 0;
      // ⚠ 中途退出（读不到题 / 没答上 / 翻页没生效）和"正常走完"必须分开。
      // 用户现场：第 1 题答完、第 2 题没答，**却点了「提交作业」**，
      // 弹出"是否确认提交?提交后批阅过的试卷不能再修改!"。
      // 原因就是这个 break 之后照样往下走 submit()。
      let incomplete = false;

      try {
        this.log('info', '开始答这套卷子（最多 ' + max + ' 题）');
        while (!this._stop && n < max) {
          const quiz = this.read();
          if (!quiz) {
            this.log('warn', '读不到题目，停手（可能已经到底了）');
            incomplete = true;
            break;
          }
          // 同一道题**连着**读到两次 ⇒ 翻页没生效，别再空转。
          //
          // ⚠ 这个判据只能**提醒**，不能**收工**。
          //
          // 日志实测（判断题那一套）：每一题选项都是「对/错」，而题干又读成同一段乱码
          // ⇒ sig 十道题完全一样 ⇒ 判"没翻页" ⇒ **第一题之后立刻收工**
          //   （"这一轮答了 1 题：成功 1 · 跳过 6 · 卷面 5 题"就是这么来的）。
          // 单选题之所以能跑，只是因为它们的选项各不相同 —— 也就是说这条判据
          // **在题型上是不可靠的**，拿它决定"收工"就是把误判当结论。
          //
          // 真正可靠的收工条件有两个，都在下面：
          //   · 没有「下一题」按钮了（到最后一题）
          //   · 已经答满页面上写的总题数
          // 这条只用来提示"可能没翻动"，让日志里有痕迹可查。
          const sig = quiz.options.map((o) => textOf(o)).join('|') + '#' + quiz.stem
            + '@' + this._pageSig();
          if (lastSig === sig) {
            this.log('warn', '这一题的读数和上一题一模一样（判断题的选项天然相同）' +
              '—— 继续作答；收工只由"没有下一题"和"答满总题数"决定');
          }
          lastSig = sig;
          n++;
          this.stats.total++;

          this.log('info', '第 ' + n + ' 题：' + quiz.stem.slice(0, 40) +
            (quiz.multi ? ' 【多选】' : ' 【单选】') + ' · ' + quiz.options.length + ' 选项' +
            ' · 题干来源=' + (quiz.stemFrom || '?'));

          // ⚠ 题干看着像"题型标签"（1.【单选题】(5分) 那种），或者来源是"猜"的 ——
          // 这两种情况多半读错了，**当场把候选摊开**，不用等用户来回试。
          // 「题目读取」这条线已经靠猜走了好几轮，就是因为看不到真实 DOM。
          if (TYPE_LABEL_RE.test(quiz.stem) || /^猜\(/.test(quiz.stemFrom || '')) {
            this.log('warn', '题干可疑（' + quiz.stem.slice(0, 24) + '）—— 下面是题干候选的现场：');
            try {
              const cands = this.dumpStemCandidates();
              cands.forEach((c, i) => {
                this.log('debug', '  #' + (i + 1) + ' ' + c.sel +
                  ' | class=' + c.cls + ' | 是选项=' + c.是选项 + ' | ' + JSON.stringify(c.text));
              });
              if (!cands.length) this.log('debug', '  一个候选都没有');
            } catch (e) {
              this.log('debug', '  候选快照失败：' + (e && e.message));
            }
          }
          const answered = await this.solveOne(quiz);
          // ⚠ 这个计数器原来**从来没人加过** —— stats.answered 一直是 0，
          // 于是汇总那行永远写着"成功 0"。加在这里：solveOne 说答上了就算数。
          if (answered) this.stats.answered++;

          // ⚠ 这一题没答上也**必须往前走** —— 否则就是"漏题"。
          //
          // 用户的现场：第 1 题没答上，然后**整张卷子剩下的题一道都没碰**。
          // 原因就是这里 `break`：一题失败 ⇒ 退出整个循环 ⇒ 后面全部跳过。
          //
          // 取舍更正过来：
          //   · 中途的「下一题/保存」= 翻页，**每一轮都要点**（用户明确要求
          //     "填入答案 → 下一题，直到遇见保存"）；
          //   · 而最后那个「提交作业」是不可逆的，那个才需要谨慎（见下面 incomplete 分支）。
          // 没答上就跳过、继续下一题，比"卡死在第一题、后面全不做"好得多。
          if (!answered) {
            this.log('warn', '这一题没答上（没拿到答案，或点了没选上）—— 跳过它，继续下一题');
            this.stats.failed++;
            incomplete = true;
            missed.push(n);        // 记下来，等下回头补
          }

          // 最后一题可能没有「下一题」，那就直接去提交
          if (!(await this.next())) {
            this.log('info', '没有「下一题」按钮了，准备提交');
            break;
          }

          // ⚠ 答满**页面上写明的题数**就收工。
          //
          // 用户报的「点保存后插件不停止、还继续发截图」：循环的收工判据是
          // lastSig（选项+题干），而**题干每次读出来都可能不一样**（像素判据取到的
          // 元素会飘），于是"和上一题一样"永远不成立 ⇒ 到了最后一题还在空转。
          //
          // 「总题数: N」是页面上明写的数字，用它当硬上限最可靠。
          const pNow = this.progress();
          if (pNow.total && n >= pNow.total) {
            this.log('info', '已经答满页面上写的总题数（' + pNow.total + '）—— 收工');
            break;
          }
          await sleep(Math.max(300, Number(cfg.abilityStepMs) || 1400));
        }

        // ── 回头补答：把主循环里跳过的那些题再试一遍 ──
        //
        // 用户报的现象：「2/3/6 没有存进去」—— 因为主循环里没答上就跳过，
        // 而**循环走完就结束了，从来不回头**，那几题就永久漏掉了。
        //
        // 补答靠**答题卡上的编号**（页面上那一排数字，点一下会跳到那一题）。
        // 每补一题最多试一次，失败就记日志 —— 不无限重试，避免又变成"空转"。
        if (missed.length && !this._stop) {
          this.log('info', '有 ' + missed.length + ' 题没答上（' + missed.join('/') +
            '）—— 按答题卡回去补一遍');
          for (const idx of missed) {
            if (this._stop) break;
            try {
              const doc2 = root.document;
              // ⚠ 不猜类名 —— 按**文字 + 尺寸**找。
              //
              // 前一版写的是 `[class*="card"] li`，实测四个都报"找不到"，
              // 因为这一页的答题卡类名不是 card 系（跟 progress() 当初栽的是同一个坑）。
              //
              // 而它长什么样我们是知道的（无障碍树里）：
              //   list "1 2 3 4 5" → listitem "1" → StaticText "1"
              // 也就是"一小段文字正好是那个数字"。所以按文字找 + 用尺寸筛掉
              // 大块容器，比猜类名稳。
              const cands = doc2.querySelectorAll('li, span, div, a, i, button, em, p');
              const card = Array.from(cands).find((el) => {
                if (textOf(el).trim() !== String(idx)) return false;
                let r = null;
                try { r = el.getBoundingClientRect(); } catch (e) { return false; }
                if (!r || r.width < 8 || r.height < 8) return false;
                if (r.width > 64 || r.height > 64) return false;   // 排除大块容器
                return visibleForText(el);
              });
              if (!card) {
                this.log('debug', '答题卡上找不到第 ' + idx + ' 题那一格，跳过');
                continue;
              }
              realClick(card);
              await sleep(900);
              const again = this.read();
              if (!again) {
                this.log('debug', '补答第 ' + idx + ' 题：读不到题目，放弃');
                continue;
              }
              const ok = await this.solveOne(again);
              if (ok) {
                this.stats.answered++;
                this.stats.failed = Math.max(0, this.stats.failed - 1);
                this.log('ok', '补答第 ' + idx + ' 题：成功');
              } else {
                this.log('warn', '补答第 ' + idx + ' 题：还是没答上');
              }
            } catch (e) {
              this.log('debug', '补答第 ' + idx + ' 题出错：' + (e && e.message));
            }
          }
          incomplete = missed.length > this.stats.failed;
        }

        const p = this.progress();
        // ⚠ 别只报 progress().done —— 那个数**经常是 0**（它找的是
        // `[class*="answer-card"]`，而这一页的答题卡类名不是那个），
        // 于是日志里写着"页面显示 0/7"，而你屏幕上明明是 57% —— 白白让人以为失效。
        // 真话在 stats 里：成功几题、其中 AI 几题、跳了几题。
        const st = this.stats || {};
        const okN = st.answered || 0;
        this.log('info', '这一轮答了 ' + n + ' 题：成功 ' + okN +
          '（AI ' + (st.byAI || 0) + ' · 题库 ' + (st.byBank || 0) + '）· 跳过 ' +
          (st.failed || 0) +
          (p.total ? ' · 卷面 ' + p.total + ' 题' : '') +
          (p.done ? ' · 页面自报已完成 ' + p.done : ''));

        if (incomplete) {
          // 没答完**绝不自动提交** —— 这是用户明确提过的要求，
          // 而且提交之后"批阅过的试卷不能再修改"，代价不可逆。
          this.log('warn', '这套卷子没答完（' + n + ' 题未完成）—— **不自动提交**，留给你手动补答');
        } else if (!this._stop && cfg.abilityAutoSubmit) {
          if (this.submit()) {
            this.stats.submitted++;
            this.log('ok', '已点「提交」');
            // 站点还会弹一个"是否确认提交?"—— 不点「确定」等于没交
            await sleep(600);
            if (this.confirmSubmit()) {
              this.log('ok', '已在确认弹窗里点「确定」，交卷完成');
            } else {
              this.log('info', '没有出现确认弹窗（或者它没被认出来）—— 如果弹了，请手动点「确定」');
            }
          } else {
            this.log('warn', '没找到「提交」按钮 —— 请手动交卷');
          }
        }
        return true;
      } finally {
        this.running = false;
      }
    }
  }

  NS.AbilitySolver = AbilitySolver;
  NS.abilityUtils = {
    looksLikeAbilityPage,
    findButtonByText,
    countOptionGroups,
    NEXT_TEXT,
    PREV_TEXT,
    SUBMIT_TEXT,
    OPTION_SELECTORS,
    QUESTION_SELECTORS,
  };
})(typeof window !== 'undefined' ? window : self);
