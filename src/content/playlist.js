/**
 * playlist.js — 课时目录识别与自动切集
 *
 * 知到的目录结构在不同版本里差异很大，这里用「候选选择器 + 结构启发式」两层探测：
 *   第一层：已知 class 名单（studyvideoh5 / onlineweb 等版本都覆盖）
 *   第二层：找一组同层级可点节点中，文本形如 "1.1 xxx" 且带时长/状态图标的元素
 *
 * ⚠ 目录是**树**，不是平表。课程被拆成 1.2 → 1.2.1 / 1.2.2 / 1.2.3 这种两层结构时，
 * 章节容器和它内部的课时往往都命中同一批选择器。此时必须**整棵展开成叶子列表**，
 * 不能"去重时把子项删掉" —— 那会只剩章节标题本身：它没有时长、点了也不播，
 * 表现就是"识别不到小章节"，自动连播走到一半就卡住。
 * 展开时父节点在前、子节点在后，正好就是文档顺序，next() 顺着走就行。
 *
 * 切集动作统一走「点击下一个节点」，不做 URL 拼接 —— 平台的鉴权参数在路由里，
 * 手拼 URL 十有八九会掉登录态。
 */
(function () {
  'use strict';

  const NS = (window.__ZHS = window.__ZHS || {});
  const { isVisible, textOf, depth, sleep } = NS.dom;

  // 已知课时节点选择器（按特异性从高到低）
  const ITEM_SELECTORS = [
    '.clearfix.video',                 // studyvideoh5 目录项
    '.catalogue_learn_item',           // onlineweb 目录项
    '.chapter-item',
    '.video_list_item',
    '.lesson-item',
    '.catalogue_item',
    '.video-item',
    'li[class*="catalogue"]',
    'div[class*="catalogue"]',
  ];

  // 「正在播放」标记
  const ACTIVE_HINTS = [
    'current_play', 'current', 'active', 'playing', 'on', 'selected', 'cur',
  ];

  // 「已完成」标记
  const DONE_HINTS = ['finish', 'finished', 'complete', 'done', 'passed', 'time_icofinish'];

  // 「锁定/未开放」标记
  const LOCK_HINTS = ['lock', 'disabled', 'forbid', 'cannot', 'noopen'];

  // 时长文本 00:12:33 / 12:33 / 1:02:03
  const DURATION_RE = /^\d{1,3}:\d{2}(:\d{2})?$/;

  function parseDurationSec(text) {
    const t = String(text || '').trim();
    if (!DURATION_RE.test(t)) return 0;
    const parts = t.split(':').map((x) => parseInt(x, 10) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts[0] * 60 + parts[1];
  }

  function classOf(el) {
    const c = el.className;
    return typeof c === 'string' ? c : (el.getAttribute && el.getAttribute('class')) || '';
  }

  function hasHint(el, hints) {
    // 自身 + 两层祖先 + 全部后代的 class 里找
    let n = el;
    for (let i = 0; i < 3 && n; i++, n = n.parentElement) {
      const cls = classOf(n).toLowerCase();
      if (cls && hints.some((h) => cls.indexOf(h) !== -1)) return true;
    }
    const kids = el.querySelectorAll('[class]');
    for (let i = 0; i < kids.length; i++) {
      const cls = classOf(kids[i]).toLowerCase();
      if (cls && hints.some((h) => cls.indexOf(h) !== -1)) return true;
    }
    return false;
  }

  function isLocked(el) {
    const cls = classOf(el).toLowerCase();
    if (LOCK_HINTS.some((h) => cls.indexOf(h) !== -1)) return true;
    const txt = textOf(el);
    if (/未解锁|未开放|不可学习|待解锁/.test(txt)) return true;
    return false;
  }

  function isDone(el) {
    return hasHint(el, DONE_HINTS);
  }

  function isActive(el) {
    return hasHint(el, ACTIVE_HINTS);
  }

  class Playlist {
    constructor() {
      this.items = [];
      this.container = null;
      this._logger = null;
    }

    setLogger(fn) { this._logger = fn; }

    log(level, msg) { if (this._logger) this._logger(level, msg); }

    /** 找目录容器 + 课时节点数组 */
    /**
     * 排障用：把"目录是怎么被读出来的"摊开。
     *
     * 「小章节读不到」这类问题只有两种可能，而这一份报告能直接分辨：
     *   ① 选择器压根没匹配到那些小章节（每条选择器命中几个，一眼看出）
     *   ② 匹配到了，但被 flattenLeaves 当成"容器"丢掉了
     *      （命中数 vs 展开后的数，两者一比就知道）
     * 每条还带上"嵌套层数"，方便判断小章节是兄弟还是子节点。
     */
    debugScan() {
      const probe = [];
      for (const sel of ITEM_SELECTORS) {
        let all;
        try { all = Array.from(document.querySelectorAll(sel)); } catch (e) { all = []; }
        const withText = all.filter((el) => el.isConnected && textOf(el).length > 1);
        const vis = withText.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 40 && r.height > 10;
        });
        const flat = vis.length ? flattenLeaves(vis) : [];
        probe.push({
          sel: sel,
          命中: all.length,
          有文字: withText.length,
          可见: vis.length,
          展开成叶子: flat.length,
        });
      }
      const items = [];
      for (const el of (this.items || []).slice(0, 20)) {
        let d = 0;
        let n = el;
        while (n && n !== document.body) { d++; n = n.parentElement; }
        // ⚠ 把"这一条的块级子节点"也摊出来。
        // 「小章节扫不出来」卡在这里：报告里 `块级子节点: 4` 说明 7.2 底下确实
        // 有 4 个块级节点，但展开结果又是 4（说明那 4 个没被当成课时收进去）。
        // 光看数量分不清那 4 个是什么 —— 是子课时、还是标题行的包装 div？
        // 所以把它们逐个列出来（标签 + class + 文字 + 有没有尺寸）。
        const kids = [];
        for (const k of blockChildren(el).slice(0, 5)) {
          const r = k.getBoundingClientRect();
          kids.push({
            tag: k.tagName.toLowerCase(),
            cls: (typeof k.className === 'string' ? k.className : '').slice(0, 40),
            text: textOf(k).replace(/\s+/g, ' ').slice(0, 50),
            有尺寸: r.width > 0 && r.height > 0,
            再往下的块级节点: blockChildren(k).length,
          });
        }
        items.push({
          title: textOf(el).slice(0, 40),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
          depth: d,
          块级子节点: blockChildren(el).length,
          子节点明细: kids,
        });
      }
      const st = this.stats ? this.stats() : null;
      return {
        当前条目数: (this.items || []).length,
        进度: st ? (st.done + '/' + st.total) : '?',
        每一条选择器的命中情况: probe.filter((p) => p.命中 > 0),
        全部选择器: ITEM_SELECTORS,
        实际用上的条目: items,
      };
    }

    /**
     * 隔一段时间重扫一次目录 —— 目录会"长"出来。
     *
     * ⚠ 这一条对应「7.2.1~3 还是不在」。用户那份诊断报告里写得很清楚：
     *   `.chapter-item 命中 42 → 可见 4 → 展开成叶子 4`
     * 也就是说扫描那一刻，页面上**只有 4 条可见** —— 折叠着的章节
     * 根本没把子课时渲染进 DOM。等我们播到 7.2、页面把它展开之后，
     * 7.2.1 / 7.2.2 / 7.2.3 才出现，而那时目录早就扫完了、没人再看一眼。
     *
     * 所以定期重扫（默认 4 秒一次，开销就是一次 querySelectorAll）。
     * 条目数变了就报一声，日志里能看到「目录更新：条目 4 → 7」。
     */
    refresh(minIntervalMs) {
      const now = Date.now();
      const gap = Math.max(0, Number(minIntervalMs) || 0);
      if (this._lastScanAt && now - this._lastScanAt < gap) return 0;
      const before = (this.items || []).length;
      this.scan();
      const after = (this.items || []).length;
      return after - before;
    }

    scan() {
      this._lastScanAt = Date.now();
      const cfg = NS.config.get();

      // 用户手填了选择器就直接用
      if (cfg.selPlaylistItem) {
        const list = Array.from(document.querySelectorAll(cfg.selPlaylistItem)).filter(isVisible);
        if (list.length) {
          this.items = flattenLeaves(list);
          this.container = this.items.length ? commonAncestor(this.items) : null;
          return this.items;
        }
      }

      for (const sel of ITEM_SELECTORS) {
        const list = Array.from(document.querySelectorAll(sel)).filter(
          (el) => el.isConnected && textOf(el).length > 1
        );
        const vis = list.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 40 && r.height > 10;
        })
        // 站点自己的导航菜单要从候选里剔掉 —— 它们是跳转链接，不是课时。
        // 少了这一步，"目录"会变成侧边栏菜单（最后一个还叫「退课」）。
          .filter((el) => !isJunkItem(el));

        if (vis.length >= 2 && vis.length <= 400) {
          // 关键一步：把命中的容器整棵展开成叶子课时。
          // 章节容器本身没有时长、点了不播，留着它只会让自动连播卡在半路。
          const picked = flattenLeaves(vis);
          // 再上一道保险：**整批都是导航条目**就换下一条选择器。
          // 注意判据只能查"是不是垃圾"，不能要求"必须像课时" ——
          // 「第零章: Introduction」这种没有编号也没有时长的正经课时是存在的，
          // 按"像不像课时"去卡会把它们一起拒掉，反而让更差的选择器胜出。
          const junk = picked.filter(isJunkItem).length;
          if (picked.length >= 2 && junk * 5 < picked.length * 4) {   // 垃圾占比 < 80%
            this.items = picked;
            this.container = commonAncestor(picked);
            return this.items;
          }
        }
      }

      // 兜底：结构启发式
      const guess = guessItems();
      this.items = guess;
      this.container = guess.length ? commonAncestor(guess) : null;
      return this.items;
    }

    /**
     * 目录节点会被框架整体重渲染（innerHTML 清空重建 / Vue diff 换节点），
     * 缓存的快照随时可能变成一堆不在文档里的孤儿节点。
     * 任何读操作之前都先验一遍，失效就重扫。
     */
    ensureFresh() {
      if (!this.items.length) return this.scan();
      for (let i = 0; i < this.items.length; i++) {
        if (!this.items[i].isConnected) return this.scan();
      }
      return this.items;
    }

    currentIndex() {
      this.ensureFresh();
      // 优先取带 active 标记的
      let idx = this.items.findIndex(isActive);
      if (idx !== -1) return idx;

      // 其次：取 URL 里章节 id 能匹配上的
      const m = location.href.match(/[?&](?:recruitId|recruitAndCourseId|courseId|chapterId|lessonId)=([\w-]+)/);
      if (m) {
        const target = m[1];
        idx = this.items.findIndex((el) => (el.innerHTML || '').indexOf(target) !== -1);
        if (idx !== -1) return idx;
      }

      // 最后：取第一个未完成项
      idx = this.items.findIndex((el) => !isDone(el));
      return idx;
    }

    current() {
      const i = this.currentIndex();
      return i === -1 ? null : this.items[i];
    }

    /**
     * 找下一个可播的课时。
     * 自动跳过已完成 / 已锁定的项，一直找到第一个能播的。
     */
    next(fromEl) {
      this.ensureFresh();
      if (!this.items.length) return null;

      let idx = fromEl ? this.items.indexOf(fromEl) : this.currentIndex();
      if (idx === -1) idx = 0;

      for (let i = idx + 1; i < this.items.length; i++) {
        const el = this.items[i];
        if (isLocked(el)) continue;
        if (isDone(el)) continue;
        return el;
      }
      // 后面全完成了，返回 null（本次课程结束）
      return null;
    }

    /** 返回 [已完成数, 总数] */
    stats() {
      this.ensureFresh();
      const total = this.items.length;
      const done = this.items.filter(isDone).length;
      return [done, total];
    }

    /**
     * 点击某个课时节点，同时尝试展开它所在的折叠章节。
     *
     * `opts` 会透传给 `NS.dom.realClick` —— 用来**换一种点法再试一次**：
     *   `{ forceCdp: true }`       → 强制走 chrome.debugger 的拟真点击
     *   `{ forceSynthetic: true }` → 强制走合成事件
     * 哪条能用取决于页面当时的状态（前后台、DevTools 有没有占着调试会话），
     * 光看日志分不出来，所以两条都试，别赌。
     */
    async activate(el, opts) {
      if (!el) return false;
      await expandAncestors(el, this.log.bind(this));
      this.log('info', '切换章节：' + textOf(el).replace(/\s+/g, ' ').slice(0, 40));
      NS.dom.realClick(el, opts);
      // 有些版本的点击热区是内部标题，补一发
      const inner = el.querySelector('span, .video_titbox, .title, p, a, div');
      if (inner && inner !== el) {
        await sleep(180);
        NS.dom.realClick(inner, opts);
      }
      return true;
    }

    /** 播放器右下角的"下一集"按钮 —— 有的版本提供 */
    clickPlayerNext() {
      const cfg = NS.config.get();
      if (cfg.selNextButton) {
        const b = document.querySelector(cfg.selNextButton);
        if (b && isVisible(b)) {
          NS.dom.realClick(b);
          return true;
        }
      }
      const cands = Array.from(
        document.querySelectorAll('button, a, div, span, i')
      ).filter((el) => {
        if (el.children.length > 2) return false;
        if (!isVisible(el)) return false;
        const t = textOf(el).replace(/\s+/g, '');
        const title = (el.getAttribute('title') || '') + (el.getAttribute('aria-label') || '');
        return /^(下一集|下一个|下节|下一章)$/.test(t) || /下一集|播放下一个/.test(title);
      });
      if (cands.length) {
        cands.sort((a, b) => depth(b) - depth(a));
        NS.dom.realClick(cands[0]);
        return true;
      }
      return false;
    }
  }

  // ── 辅助 ─────────────────────────────────────────────────

  /** 去掉互为祖先的重复项，保留最内层 */
  function dedupe(list) {
    const arr = list.slice();
    return arr.filter((el) => !arr.some((o) => o !== el && el.contains(o)));
  }

  /**
   * 这个候选是"装课时的盒子"，还是"一个课时本身"？
   *
   * 判据：**有没有块级的元素子节点**。
   *   <div class="item"><span>1.1</span><span>10:00</span></div>   → 叶子（课时）
   *   <div class="item"><div>…</div><div>…</div></div>             → 容器（章节）
   *
   * ⚠ 这里不能用「内部有没有时长文本 / 字母序号」来判断。
   * 踩过的坑：mock 页那种平表条目，时长就写在子 span 里
   * （`<span>计算机网络概述</span><span>32s</span>`），
   * 用"内部有课时标记"当容器判据，会把**真正的课时**也判成容器、
   * 然后把它的子 span 当课时收进去 —— 结果 5 节课只认出 4 节，
   * 目录里还多出一堆 "32s" 这种纯时长条目。
   *
   * 行内元素（span / i / b / em / label）不算子节点：它们就是课时内部的排版。
   */
  const INLINE_TAGS = {
    SPAN: 1, I: 1, B: 1, EM: 1, STRONG: 1, SMALL: 1, LABEL: 1, SUP: 1, SUB: 1, CODE: 1,
  };

  /**
   * 站点自己的**导航菜单**条目 —— 它们长得像课时，但点了是跳页面，不是播放。
   *
   * ⚠ 这一条是拿用户发回来的诊断报告定位的。报告里清清楚楚：
   *   目录读到 13 条，实际用上的全是 `router-item`：
   *   知识图谱 / 掌握度分析 / 成绩分析 / 作业考试 / 课程资料 / 课程问答 /
   *   见面课 / 学前必读 / 系统消息 / 课程提醒 / 班级信息 / **退课**
   *
   * 这是**比"小章节读不到"严重得多的问题**：插件把侧边栏菜单当成了课程目录，
   * 于是"自动连播"会按顺序去点这些跳转链接 —— 而列表最后一个叫「退课」。
   */
  const JUNK_CLASS_RE = /router-item|menu-item|nav-item|navbar|breadcrumb|sidebar-item|tab-item|header-item|user-info/i;
  const JUNK_TEXT_RE = new RegExp('^(知识图谱|掌握度分析|成绩分析|作业考试|课程资料|课程问答|' +
    '见面课|学前必读|系统消息|课程提醒|班级信息|退课|首页|个人中心|我的课程|设置|帮助|' +
    '退出登录|退出|返回|上一页|下一页)$');

  /** 往上几层里有没有"导航"的意思（菜单常常把标记挂在祖先上） */
  function insideNav(el) {
    let n = el;
    for (let i = 0; i < 4 && n && n !== document.body; i++, n = n.parentElement) {
      const tag = (n.tagName || '').toUpperCase();
      if (tag === 'NAV' || tag === 'ASIDE') return true;
      // 只认**明确的**导航容器类名。写宽了会误伤 ——
      // 课程目录的容器完全可能叫 `.catalogue_menu` 之类，那样整套目录都会被剔掉。
      if (/(^|[\s_-])(router|navbar|nav|sidebar|tabbar|breadcrumb)([\s_-]|$)/i.test(classOf(n))) {
        return true;
      }
    }
    return false;
  }

  function isJunkItem(el) {
    if (!el) return true;
    // 只查**元素自己**，不往上查祖先。
    //
    // 试过加"祖先里有 nav/menu 就算导航"，结果误伤一片：测试里
    // 正经目录的容器类名也可能含这些词，整批课时会被剔掉 ——
    // 而用户那份报告里，13 条垃圾**元素自己**就带着 `router-item`，
    // 查自己已经足够。少一层猜测就少一类误伤。
    if (JUNK_CLASS_RE.test(classOf(el))) return true;
    if (JUNK_TEXT_RE.test(textOf(el).replace(/\s+/g, ''))) return true;
    return false;
  }

  /** 这一条像"课时"吗：带编号（7.2.1 / 6.5）或带时长（04:59） */
  function looksLikeLesson(el) {
    const t = textOf(el);
    if (/\d+\s*[:：]\s*\d{2}/.test(t)) return true;          // 时长
    if (/\d+(?:[.\-]\d+){1,3}/.test(t)) return true;         // 7.2 / 7.2.1
    if (/第\s*[0-9一二三四五六七八九十百]+\s*[章节讲篇]/.test(t)) return true;
    return false;
  }

  function elementChildren(el) {
    const out = [];
    const kids = el.children;
    if (!kids) return out;
    for (let i = 0; i < kids.length; i++) out.push(kids[i]);
    return out;
  }

  /** 直接的块级元素子节点（不算行内的排版标签） */
  function blockChildren(el) {
    return elementChildren(el).filter((k) => !INLINE_TAGS[k.tagName]);
  }

  function isPotentialContainer(el) {
    return blockChildren(el).length > 0;
  }

  /**
   * 一棵树 → 课时叶子列表。
   *
   * 命中列表里同时出现「章节容器」和「它内部的课时」时，留下**叶子**：
   *   - 章节容器（内部还套着块级节点）被丢掉 —— 它点了不播，
   *     留着它只会让 next() 走到它然后卡住；
   *   - 它内部的 1.2.1 / 1.2.2 / 1.2.3 全留下。
   *
   * 展开时用 TreeWalker 按文档顺序走，所以父在前子在后，next() 顺着走就行。
   * 万一整批都被判成容器（理论上不会），退回最内层那一批，至少别把目录丢空。
   */
  /**
   * 一棵树 → 课时叶子列表。
   *
   * 命中列表里同时出现「章节容器」和「它内部的课时」时，留下**叶子**：
   *   - 章节容器（内部还套着块级节点）被丢掉 —— 它点了不播，
   *     留着它只会让 next() 走到它然后卡住；
   *   - 它内部的 1.2.1 / 1.2.2 / 1.2.3 全留下。
   *
   * 展开时用 TreeWalker 按文档顺序走，所以父在前子在后，next() 顺着走就行。
   * 万一整批都被判成容器（理论上不会），退回最内层那一批，至少别把目录丢空。
   */
  /** 一行自己直接含的文字（直接文本 + 行内子元素），不含块级子节点的 */
  function selfText(el) {
    let s = '';
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n.nodeType === 3) s += n.nodeValue || '';
      else if (n.nodeType === 1 && INLINE_TAGS[n.tagName]) s += n.textContent || '';
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * 这一条**自己**是不是"能播的课时"（而不是纯分组标题）。
   *
   * 判据（三层，都是被数据逼出来的）：
   *   ① 子树里必须有**时长**（04:59）—— 这是"点了会播"的直接证据；
   *   ② 它自己得有**编号**（7.2）—— 没有编号的是「第七章: …」那种纯章节头；
   *   ③ 第一个块级子节点的编号**不能比它更细** ——
   *        `1.2` 的第一个子节点是 `1.2.1`（更细）⇒ 它是分组，丢了；
   *        `7.2` 的第一个子节点是它自己的标题行（还是 `7.2`）⇒ 它是**既是课时又是分组**，
   *        必须留下，否则它底下的 7.2.1 / 7.2.2 / 7.2.3 看起来就"读不到"。
   */
  function isPlayableItem(el) {
    const full = textOf(el);
    if (!/\d+\s*[:：]\s*\d{2}/.test(full)) return false;
    const kids = blockChildren(el);
    if (!kids.length) return true;
    const own = /(\d+(?:\.\d+)*)/.exec(selfText(el) || full);
    if (!own) return false;
    const firstNum = /(\d+(?:\.\d+)*)/.exec(textOf(kids[0]));
    if (firstNum && firstNum[1].split('.').length > own[1].split('.').length) return false;
    return true;
  }

  /**
   * 一棵树 → 课时叶子列表。
   *
   * 规则（第二版，第一版把 7.2 这种"既是课时又是分组"的东西丢了）：
   *   · 不是容器 ⇒ 就是课时，留下；
   *   · 是容器，但**它自己也能播** ⇒ 留着它，然后**接着收它的子节点**；
   *   · 是容器、自己也播不了（纯章节头，如「第七章: …」）⇒ 只收子节点。
   *
   * 用户那份诊断报告里就是第二种情况：
   *   `7.2 The Classification…` cls=chapter-item 块级子节点=4
   * 它既是能播的一节，又套着 7.2.1 / 7.2.2 / 7.2.3 三个小章节。
   * 第一版把它当"容器"整个丢掉，于是小章节看起来"读不到"。
   */
  /**
   * 把"父子标题粘在一起"的条目拆开。
   *
   * ⚠ 用户日志现场：
   *     15:07:03 切换章节：10.2 5G Technology 10.2.1 Five Generation
   *     15:07:23 切换超时，保持当前状态继续重试
   * 一条条目的文字里出现了**两个编号**（10.2 和 10.2.1），说明它是个
   * 把父标题和子标题包在一起的包装节点 —— 点它不会切章节，只会白白等 20 秒。
   *
   * 判据很干净：带点号的编号（`10.2` / `7.2.1`）出现两次以上 ⇒ 包装节点。
   * 换成里面**各自只带一个编号**的子节点，那些才是真能点的课时行。
   * （"第3章"、"5G" 这种没有点号的数字不受影响。）
   */
  function splitWrappers(items) {
    const numsOf = (el) => {
      const m = textOf(el).match(/\d+(?:\.\d+)+/g) || [];
      return m.filter((v, i) => m.indexOf(v) === i);
    };
    const out = [];
    for (const el of items) {
      if (numsOf(el).length < 2) { out.push(el); continue; }
      const inner = [];
      const walk = (n) => {
        for (const k of elementChildren(n)) {
          if (numsOf(k).length === 1) inner.push(k);
          else walk(k);
        }
      };
      walk(el);
      if (inner.length) out.push(...inner);
      else out.push(el);      // 真拆不开就还留着，别把目录丢空
    }
    return out;
  }

  /**
   * 去掉"分组标题"行 —— 它们点了不播。
   *
   * ⚠ 用户日志现场（卡了好几轮的那个）：
   *     15:50:36 切换章节：10.2 5G Technology
   *     15:51:17 切换章节：10.3 Beidou GPS
   *     切换超时 ×2
   * 而站点 UI 里这两行是**加粗的分组标题**（没有完成勾），
   * 真正能播的是它们底下的 10.2.1 / 10.2.2 / 10.3.1 …
   * 点标题永远不会切章节，只能白等 20 秒。
   *
   * 判据（只看列表本身，不需要认识站点的 class）：
   *   **如果某条的编号是紧邻下一条编号的前缀**（`10.2` → 紧跟着 `10.2.1`），
   *   那它就是这一组的标题，子课时已经在后面排着 —— 丢掉它，什么也没少。
   *
   * 对一遍真实数据：
   *   10.1     后一条是 10.2     不是前缀 ⇒ 留（顶层课时）
   *   10.2     后一条是 10.2.1   是前缀   ⇒ 丢（分组标题）
   *   10.2.3   后一条是 10.3     不是前缀 ⇒ 留
   *   10.3     后一条是 10.3.1   是前缀   ⇒ 丢
   *   10.3.2   后一条是 10.4     不是前缀 ⇒ 留
   *   10.4     最后一条                  ⇒ 留
   */
  function dropGroupHeaders(items) {
    const numOf = (el) => {
      const m = /(\d+(?:\.\d+)*)/.exec(textOf(el));
      return m ? m[1] : '';
    };
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const a = numOf(items[i]);
      const b = i + 1 < items.length ? numOf(items[i + 1]) : '';
      // a 是 b 的前缀（且 a !== b）⇒ a 是分组标题
      if (a && b && a !== b && b.indexOf(a + '.') === 0) continue;
      out.push(items[i]);
    }
    // 全被丢光说明判据不适合这个站点，那就原样留着，别把目录弄空
    return out.length ? out : items;
  }

  function flattenLeaves(list) {
    const innermost = dedupe(list.slice());
    const seen = new Set();
    const out = [];
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };

    // ⚠ 这里遍历的是**原始命中列表**，不是 dedupe 之后的那份。
    // dedupe 会把"祖先"剔掉 —— 而 `7.2`（套着小章节的那一层）正好是
    // 7.2.1 的祖先，于是它底下的 7.2.1 / 7.2.2 / 7.2.3 就没机会被收进来，
    // 用户看到的现象是「小章节读不到」。
    // 原始列表是按文档顺序的，父天然在子前面。
    //
    // 容器本身照旧丢掉（它多半是分组标题，点了不播），只收它内部的叶子。
    // 试过"自己也带时长就留下"，但那会把 `1.2 Confucianism` 这类纯分组标题
    // 也留下（它的子树里有时长，但那是子项的）—— 两头都不讨好，
    // 而且真机上多出来的一行会打乱 next() 的顺序。宁可少一行，不可多一行。
    for (const el of list) {
      if (!isPotentialContainer(el)) {
        push(el);
        continue;
      }
      const leaves = collectLeaves(el);
      // 收了半天一个都没收到 ⇒ 这一层自己是"最里面的那条"，
      // 不能把它整条丢掉（丢掉就等于目录里凭空少一节）。
      if (leaves.length) for (const leaf of leaves) push(leaf);
      else push(el);
    }

    // 万一整批都被判成容器（理论上不会），退回最内层那一批，至少别把目录丢空
    if (!out.length) return innermost;

    // 把包装节点拆成真正能点的课时行（见 splitWrappers 的注释）
    const split = splitWrappers(out);
    // 再去掉"点了不播"的分组标题（见 dropGroupHeaders 的注释）
    const final = dropGroupHeaders(split.length ? split : out);

    // 按文档顺序排一遍 —— next() 顺着走才不会乱跳。
    // 用字面量而不是 `Node.DOCUMENT_POSITION_*`：`Node` 这个全局在
    // 某些执行环境里拿不到（测试里就抛过 "Node is not defined"）。
    const POS_FOLLOWING = 4;
    const POS_PRECEDING = 2;
    final.sort((a, b) => {
      if (a === b) return 0;
      let pos = 0;
      try { pos = a.compareDocumentPosition(b); } catch (e) { return 0; }
      if (pos & POS_FOLLOWING) return -1;
      if (pos & POS_PRECEDING) return 1;
      return 0;
    });
    return final;
  }

  /** 收集 el 内部所有"不再往下套块级节点"的元素，按文档顺序 */
  function collectLeaves(el) {
    const leaves = [];
    let budget = 4000;

    const walk = (node) => {
      if (budget-- <= 0) return;
      const kids = elementChildren(node);
      if (!kids.length) return;
      const blocks = kids.filter((k) => !INLINE_TAGS[k.tagName]);
      if (!blocks.length) {
        // 只有行内子节点 ⇒ 这一层就是课时
        leaves.push(node);
        return;
      }
      for (const k of blocks) walk(k);
    };

    walk(el);
    return leaves;
  }

  function commonAncestor(list) {
    if (!list.length) return null;
    let node = list[0].parentElement;
    while (node) {
      if (list.every((el) => node.contains(el))) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * 结构启发式：在一组兄弟里找"看起来像课时列表"的那一组。
   * 判据：≥3 个同级同 tag 的兄弟、每个都有文本、并且出现重复的时长文本。
   */
  function guessItems() {
    const best = { score: 0, items: [] };
    const containers = document.querySelectorAll('div, ul, ol, section, aside');
    for (let i = 0; i < containers.length; i++) {
      const box = containers[i];
      const kids = Array.from(box.children);
      if (kids.length < 3 || kids.length > 300) continue;

      const groups = new Map();
      for (const k of kids) {
        const key = k.tagName + '|' + classOf(k);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(k);
      }

      for (const [, arr] of groups) {
        if (arr.length < 3) continue;
        const texts = arr.map(textOf);
        if (texts.some((t) => !t || t.length > 200)) continue;

        let durationHits = 0;
        let numbered = 0;
        for (const t of texts) {
          if (DURATION_RE.test(t.trim())) durationHits++;
          if (/^\s*\d+([.\-]\d+)?\s*[、.．]?/.test(t)) numbered++;
        }
        const score =
          arr.length * 2 +
          durationHits * 6 +
          numbered * 2 +
          (durationHits >= 2 ? 20 : 0) +
          (classOf(arr[0]).toLowerCase().indexOf('video') !== -1 ? 30 : 0) +
          (classOf(arr[0]).toLowerCase().indexOf('catalog') !== -1 ? 25 : 0);

        if (score > best.score) {
          best.score = score;
          best.items = arr.slice();     // ← 这一行以前漏了：算了半天分，items 一直是空的
        }
      }
    }

    // 分数太低说明根本没找到目录，宁可返回空也不乱点
    return best.score >= 12 ? best.items : [];
  }

  /** 目标节点在被折叠的章节里时，逐层点开父级可点元素 */
  async function expandAncestors(el, log) {
    const chain = [];
    let n = el.parentElement;
    while (n && n !== document.body) {
      const r = n.getBoundingClientRect();
      if (r.height < 4) chain.push(n);
      n = n.parentElement;
    }
    if (!chain.length) return;

    for (const box of chain.reverse()) {
      // 找这个折叠块前面的可点标题
      const trigger =
        box.previousElementSibling ||
        (box.parentElement && box.parentElement.querySelector('[class*="chapter"],[class*="section"],[class*="title"]'));
      if (trigger && isVisible(trigger)) {
        NS.dom.realClick(trigger);
        if (log) log('debug', '展开折叠章节');
        await sleep(350);
      }
    }
  }

  NS.Playlist = Playlist;
  NS.playlistUtils = {
    isDone,
    isActive,
    isLocked,
    flattenLeaves,
    collectLeaves,
    isPotentialContainer,
    dedupe,
    ITEM_SELECTORS,
    parseDurationSec,
  };
})();
