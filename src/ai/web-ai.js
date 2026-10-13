/**
 * web-ai.js — 在 AI 站点自己的页面上把问题问出去，再把答案扣回来
 *
 * 这个文件只在豆包 / DeepSeek / Kimi / 通义 / 元宝 的页面上运行
 * （见 manifest 的第二段 content_scripts），知到页面上不会加载它。
 *
 * 链路（每一步都有降级，任何一步失败都返回 ok:false 而不是抛出去）：
 *   ZHS_AI_ASK
 *     → 找输入框（多候选选择器 + 可见性过滤）
 *     → 聚焦：CDP 点击；如果 focus 没落到输入框（被别的扩展的遮挡层接走了）就直接用
 *            CDP 的 Input.insertText 往当前焦点里塞字 —— 关键路径不依赖 DOM 事件
 *     → 发送：点发送按钮；没找到 / 点了没反应就压一次真实回车
 *     → 等待：先记下「已经有多少条回答」，只认新出现的那条；
 *            结束判据 = 「停止生成」按钮消失 **且** 文本 1.4 秒不再增长
 *     → 解析：交给 shared/web-ai.js 的 parseReply（纯函数，离线可测）
 *
 * 为什么不用合成 input 事件当主路径：豆包和 DeepSeek 都是 React，
 * 合成事件要撞它们的受控组件状态机，而 CDP 的 insertText 是浏览器层面
 * 真正把字敲进 DOM，组件状态天然跟得上。
 */
(function () {
  'use strict';

  const NS = (window.__ZHS = window.__ZHS || {});
  const WA = NS.webAI;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base, spread) => sleep(Math.round(base * (1 + (Math.random() * 2 - 1) * ((spread == null) ? 0.35 : spread))));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    let st = null;
    try { st = window.getComputedStyle(el); } catch (e) { return false; }
    if (!st) return false;
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (Number(st.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    // ⚠ 这里刻意**不看元素是否落在视口内**。
    // 以前额外要求 r.bottom > 0 && r.top < vh，结果聊得久一点、回答被滚出
    // 视野之后，那些消息就被判成"不可见"，`sent()` 永远数不到新消息 ——
    // 表现就是"问题明明发出去了，插件却说没发出去"。
    // 只要它占了地方（有尺寸）就算存在，滚出视野不影响这个判断。
    return r.width >= 1 && r.height >= 1;
  }

  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  const dom = NS.dom || {};
  const realClick = dom.realClick || (() => false);
  const absolutePoint = dom.absolutePoint || (() => null);

  // ── 与 background 的原语 ─────────────────────────────────

  function callBackground(msg) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(!!v); } };
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.id) return finish(false);
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          finish(res && res.ok);
        });
      } catch (e) {
        return finish(false);
      }
      setTimeout(() => finish(false), 12000);
    });
  }

  /** 走 CDP 往当前焦点里塞文本（isTrusted=true，React 受控组件照样认） */
  function cdpInsertText(text) {
    return callBackground({ type: 'ZHS_CDP_TEXT', text: String(text) });
  }

  /** 走 CDP 敲一次真实按键（默认回车）。raw=true 时换成纯键盘序列 */
  function cdpKey(key, raw) {
    return callBackground({ type: 'ZHS_CDP_KEY', key: key || 'Enter', raw: !!raw });
  }

  // ── 元素定位 ─────────────────────────────────────────────

  function anyVisible(selectors, root) {
    const list = anyVisibleAll(selectors, root);
    return list.length ? list[0] : null;
  }

  /** 所有可见的命中元素（按去重 + 文档顺序） */
  function anyVisibleAll(selectors, root) {
    const scope = root || document;
    const seen = new Set();
    const out = [];
    for (const sel of (selectors || [])) {
      let list;
      try { list = scope.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of list) {
        if (seen.has(el)) continue;
        if (!isVisible(el)) continue;
        seen.add(el);
        out.push(el);
      }
    }
    return out;
  }

  function allVisible(selectors, root) {
    const scope = root || document;
    const out = [];
    const seen = new Set();
    for (const sel of (selectors || [])) {
      let list;
      try { list = scope.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of list) {
        if (seen.has(el)) continue;
        if (!isVisible(el)) continue;
        // 只收最内层：外层容器会把整段会话文本一起算进来
        if (out.some((o) => o.contains(el))) continue;
        seen.add(el);
        out.push(el);
      }
    }
    return out.filter((el) => !out.some((o) => o !== el && o.contains(el)));
  }

  /**
   * 回答区的**兜底**找法：不信选择器，改看结构。
   *
   * 这条是用户报的「问题发出去了但没返回答案」的直接原因。
   * 截图里 DeepSeek 的回答是干干净净一行 `答案：B` —— 它**没有** `.markdown`
   * 之类的容器（那些 class 只在回答里带格式（代码块/列表）时才出现）。
   * 于是 `countReplies` 一个元素都匹配不到，`readReply` 永远等不到新回答，
   * 整条链路在"已经拿到答案了"的状态下报失败。
   *
   * 办法：从输入框往上找到"对话那一列"，然后在那一列里挑**最后一块有文字的
   * 叶子节点** —— 最新的回答必然是它。
   */
  function findConversationRoot(input) {
    let n = input && input.parentElement;
    let fallback = null;
    for (let i = 0; i < 12 && n && n !== document.body; i++, n = n.parentElement) {
      const r = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
      if (!r || r.height < 200) continue;
      // 这一列里得有"像 AI 回复"的块，不然它就只是输入框外面那层壳
      const hasText = Array.from(n.querySelectorAll('div, p, article, section')).some((el) => {
        if (!isVisible(el)) return false;
        const t = textOf(el);
        return t.length >= 2 && el.children.length === 0;
      });
      if (hasText) fallback = fallback || n;
      // 越高越好，但不能高到 body
      if (hasText && r.height > 320) return n;
    }
    return fallback;
  }

  /** 一个元素自己直接含着的文字（不算后代的） */
  function ownText(el) {
    if (!el) return '';
    let s = '';
    for (const c of el.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * 结构兜底：对话列里最后那些"有文字的末梢块"。
   * 只收最深的、有直接文字的节点，所以不会把整段会话当成一条回答。
   */
  function textBlocksIn(root) {
    if (!root) return [];
    let all;
    try {
      all = Array.from(root.querySelectorAll('div, p, span, article, section, li'));
    } catch (e) {
      return [];
    }
    const blocks = [];
    for (const el of all) {
      if (!isVisible(el)) continue;
      // 只看末梢：有直接子元素当文字载体的不算
      if (el.children.length > 0) continue;
      const t = (ownText(el) || textOf(el)).trim();
      if (t.length < 1) continue;
      blocks.push(el);
    }
    return blocks;
  }

  /**
   * 「这个按钮像不像发送键」—— 打分用的负向特征。
   *
   * DeepSeek 的 composer 里，「深度思考」「智能搜索」两个模式开关也是
   * `div[role="button"]`，和发送箭头长得一样"合法"。
   * 这类东西点下去只是切了个模式，字还在输入框里 —— 必须踢出去。
   */
  const NOT_SEND_RE = /深度|思考|搜索|联网|附件|上传|语音|麦克风|朗读|复制|分享|重新生成|停止生成|清空|新建|历史|设置|帮助|反馈|展开|收起|thinking|deep|search|attach|upload|mic|voice|speak|copy|share|regenerate|stop|clear|new\s*chat|history|settings|help|menu|more|expand/i;

  /**
   * 「还在忙」的状态文字 —— 读到它**不能当回答**。
   *
   * 实测（图像方案上线后）：reply 区域里最先冒出来的就是这类提示，
   * 我们的读回包立刻把它当成回复 ⇒ 解析不出答案 ⇒ 3 秒就放弃，
   * 而模型其实还在看图。日志里那句
   *   「AI 原话：正在分析图片 正在分析图片」
   * 就是这么来的 —— 每一次提问都被它顶掉，于是整卷漏答。
   *
   * 所以：命中它就**继续等**，直到等到真回答或到点。
   *
   * ⚠ 整句要允许**重复**：实测抓到的原文是「正在分析图片 正在分析图片」
   * （状态行出现两次），只认单次的写法会漏掉它 —— 而它才是现场的真实文本。
   */
  const PLACEHOLDER_REPLY_RE = /^\s*(?:[·•.]?\s*(?:正在分析图片|正在分析|正在思考|深度思考中|思考中|正在生成|正在阅读|正在搜索|正在联网|分析图片中|正在处理|请稍候|请稍等|生成中|Thinking|Analyzing|Loading)[\s.·。！!…]*)+$/i;

  /**
   * 找"composer 那个盒子"：从输入框往上走，直到某一层里出现了别的可点元素。
   *
   * 发送键、模式开关、附件都住在这个盒子里；再往上就是整个聊天区了，
   * 那里面混进历史消息里的按钮，按位置猜就会猜错。
   */
  function composerBoxOf(inputEl) {
    if (!inputEl) return null;
    let n = inputEl.parentElement;
    for (let i = 0; i < 6 && n && n !== document.body; i++, n = n.parentElement) {
      let others;
      try {
        others = Array.from(n.querySelectorAll('button,[role="button"],a'))
          .filter((el) => el !== inputEl && isVisible(el));
      } catch (e) { others = []; }
      if (others.length >= 1) return n;
    }
    return null;
  }

  /**
   * 发送按钮的**候选**，按「像不像发送」排序。
   *
   * ⚠ 这里是「字打进去了但发不出去」真正的根因，也是为什么"点了没反应"。
   *
   * 以前是 `findSend = anyVisible(p.send)` —— 按选择器表的顺序，**第一个可见的就点**。
   * 而 DeepSeek 那张表里有一条非常泛化的：
   *     `div[role="button"][aria-disabled="false"]`
   * 它排在具体选择器（`button[aria-label="Send message"]`）**前面**。
   * composer 里的「深度思考」「智能搜索」正好命中这条泛化规则 ——
   * 于是我们点的是那两个开关之一：界面毫无变化，字仍在输入框里，
   * 从外面看就是"第一步做了、第二步没做"，而且重试多少轮都一样。
   *
   * 所以不能"第一个可见的就点"，得排序。判据从硬到软：
   *   · aria-label / title 里带 send / 发送 / 提交      ← 最硬
   *   · class 里带 send / submit，或 type="submit"
   *   · 文本就是"发送"两个字
   *   · **和输入框在同一个容器里**（发送键必然挨着输入框）
   *   · 是真 `<button>` 而不是 `div[role=button]`
   *   · 当下处于"能按"的状态（禁用态不扣分，只是不加分）
   * 以及"明显不是发送键的"直接重罚：模式开关、附件、语音、菜单……
   */
  function findSendCandidates(p, inputEl) {
    const seen = new Set();
    const out = [];
    const add = (el, score) => {
      if (!el || seen.has(el) || !isVisible(el)) return;
      seen.add(el);
      out.push({ el: el, score: score });
    };

    // 先只在输入框往上几层里找 —— 发送键必然挨着输入框，
    // 而模式开关之类的东西经常也在同一个容器里，所以这只是加分项，不是过滤条件
    const scopes = [];
    if (inputEl) {
      let n = inputEl.parentElement;
      for (let i = 0; i < 4 && n && n !== document.body; i++, n = n.parentElement) {
        scopes.push({ root: n, bonus: 50 - i * 12 });
      }
    }
    scopes.push({ root: document, bonus: 0 });

    // ③ 结构兜底：**发送键几乎总在 composer 里、输入框的右侧、而且是那一排最末一个。**
    //
    // 这一条是「第二次提问发不出去」最可能的答案：
    // 第一问的 composer 和第一问之后的 composer 往往是**两套标记**
    // （落地页一个组件、会话页另一个组件）。会话页那个箭头经常是
    // `div[role="button"]` 但**没有 aria-disabled、没有 aria-label、class 里也没有 send** ——
    // 站点表里那六条选择器一条都不命中，候选列表就是空的，
    // 于是"点发送"这一步根本没发生，只剩回车；回车再不行就彻底没戏。
    //
    // 用位置关系来找，就不依赖任何命名：
    // 取 composer 容器里、横向位于输入框右半边的可点元素，取文档顺序最后一个。
    if (inputEl) {
      const box = composerBoxOf(inputEl);
      if (box) {
        let clickables = [];
        try {
          clickables = Array.from(box.querySelectorAll(
            'button,[role="button"],a,[class*="icon"],svg,i'
          )).filter(isVisible);
        } catch (e) { clickables = []; }

        const ir = inputEl.getBoundingClientRect();
        const mid = ir.left + ir.width / 2;
        const rightSide = clickables.filter((el) => {
          const r = el.getBoundingClientRect();
          return (r.left + r.width / 2) > mid;      // 在输入框中线的右边
        });
        if (rightSide.length) {
          // 取最右那一个（同一条水平线上文档顺序最后的）
          add(rightSide[rightSide.length - 1], 55);
        }
      }
    }

    for (const scope of scopes) {
      for (const sel of (p.send || [])) {
        let list;
        try { list = scope.root.querySelectorAll(sel); } catch (e) { continue; }
        for (const el of list) {
          let s = scope.bonus;
          const aria = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
          const cls = typeof el.className === 'string' ? el.className : '';
          const txt = textOf(el).replace(/\s+/g, '').slice(0, 12);
          if (/send|发送|提交|submit/i.test(aria)) s += 100;
          if (/send|submit/i.test(cls)) s += 60;
          if (el.getAttribute('type') === 'submit') s += 50;
          if (/^(发送|提交|send)$/i.test(txt)) s += 40;
          if (el.tagName === 'BUTTON') s += 15;
          if (sendable(el, p)) s += 20;
          // 明显不是发送键的：重罚，基本直接出局
          if (NOT_SEND_RE.test(aria + ' ' + cls + ' ' + txt)) s -= 300;
          add(el, s);
        }
      }
    }

    return out.sort((a, b) => b.score - a.score).map((x) => x.el);
  }

  function findSend(p, inputEl) {
    const list = findSendCandidates(p, inputEl);
    return list.length ? list[0] : null;
  }

  /**
   * 找输入框。
   *
   * ⚠ 有多个可见输入框时，取**最靠下的那一个**。
   *
   * 用户给了一条很硬的规律：「只要对话里存在上一条问题，下一条就发不出去」——
   * 空对话（落地页）能发、有一轮对话之后（会话页）永远发不出去。
   * 最符合这条规律的机制就是**页面上同时存在两个 composer**：
   * 落地页那个（已经不用了但仍在 DOM 里、尺寸也不为零）+ 会话页那个。
   * 我们按文档顺序取第一个，于是往后一直在操作那个"已经死掉的"输入框：
   * 字塞得进去（DOM 改得动）、但它的按钮和回车都不连着任何东西 ——
   * 而屏幕上看，字确实躺在**下面那个**活的 composer 里（其实是我们塞错了位置，
   * 只是它长得一样，肉眼分不出来）。
   *
   * 聊天站的输入框永远在页面底部，所以"最靠下"是安全且通用的判据。
   */
  function findInput(p) {
    const list = anyVisibleAll(p.input);
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    let best = list[0];
    let bestTop = -Infinity;
    for (const el of list) {
      let top = 0;
      try { top = el.getBoundingClientRect().top; } catch (e) { top = 0; }
      if (top >= bestTop) { bestTop = top; best = el; }
    }
    return best;
  }

  /**
   * 这个发送按钮现在"能按"吗。
   *
   * 站点在把我们的字收进自己的状态之前，发送按钮是**禁用**的
   * （`aria-disabled="true"` / `disabled` / 半透明）。
   * 这时候点它等于什么都没发生 —— 而我们的字已经进去了，
   * 所以从外面看就是"第一次只把题目打进了输入框、没有发送"。
   */
  function sendable(el, provider) {
    if (!el) return false;
    try {
      if (el.disabled === true) return false;
      const ad = el.getAttribute && el.getAttribute('aria-disabled');
      if (ad === 'true') return false;
      const st = window.getComputedStyle(el);
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
      if (st && Number(st.opacity) > 0 && Number(st.opacity) < 0.5) return false;
    } catch (e) { return true; }
    void provider;
    return true;
  }

  /**
   * 把输入框清空 —— **每次提问前都要做**。
   *
   * ⚠ 这一条对应「二次提问依旧没发出去」。
   *
   * 现场：上一问如果没被判成"发出去了"，重试循环的步骤④会把同一段文字
   * **重新塞回输入框**；于是下一问开始时，composer 里还躺着上一问的题目，
   * 我们又往里塞新的 —— 两段文字连在一起，点发送发出去的是一团垃圾，
   * 或者站点干脆不接受。用户截图里那个还带着「取消 / 发送」的输入框就是现场。
   *
   * 用户给的修法很直接，也是对的：**让每一次提问都从"干净的输入框"开始，
   * 和第一次一模一样**。所以不管上一轮发生过什么，开问之前先清空。
   */
  async function clearComposer(el) {
    if (!el) return true;
    const empty = () => inputText(el).trim().length === 0;
    if (empty()) return true;

    // ① DOM 路径（不需要焦点，也最快）
    try {
      if ('value' in el && typeof el.value === 'string' && el.tagName === 'TEXTAREA') {
        const proto = safeProto(el, 'HTMLTextAreaElement');
        const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, '');
        else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await jitter(100, 0.4);
      if (empty()) return true;
    } catch (e) { /* 落到键盘路径 */ }

    // ② 受控组件把值又拉回来了 ⇒ 走"全选 + 删除"，让它以为是人删的
    try {
      await refocus(el);
      if (typeof document.execCommand === 'function') {
        document.execCommand('selectAll');
        document.execCommand('delete');
      }
      await jitter(100, 0.4);
    } catch (e) { /* 全挂了 */ }

    return empty();
  }

  /**
   * 把一张图片塞进 AI 站点的上传入口。
   *
   * 这是「图像方案」的关键一步：DOM 读题干这条路已经在真实页面上磨了十几轮
   * 都没稳（多题共存、toast 覆盖、隐藏模板、标签枚举……），改成**截图给 AI 看**。
   *
   * 做法上**不落盘、不走 CDP**：
   *   base64 → Blob → File → DataTransfer → input.files → change 事件
   * 这是标准的"程序化上传"手法。DeepSeek / Gemini 都是框架应用，
   * 它们监听的就是 input 的 change —— 所以只要把 files 换掉再派发一次就行。
   *
   * （实测过 DeepSeek 页面上确实存在 `input[type="file"]`，只是被隐藏；
   *   程序化写入不受"可见性"限制，反而比去点那个回形针按钮稳。）
   */
  async function attachImage(p, dataUrl) {
    if (!dataUrl) return { ok: false, msg: '没有图片数据' };

    let input = null;
    const sels = (p.upload && p.upload.length) ? p.upload : ['input[type="file"]'];
    for (const sel of sels) {
      let list;
      try { list = document.querySelectorAll(sel); } catch (e) { continue; }
      // 隐藏的也算 —— 这里要的是"能写进去"，不是"能看见"
      if (list.length) { input = list[0]; break; }
    }
    if (!input) return { ok: false, msg: '没找到上传入口（input[type=file]）' };

    try {
      // ⚠ 这几个全局从 window 上取，不要用裸名字。
      // 裸名在"把 window 当参数传进来"的执行环境里拿不到（测试里就报过
      // `DataTransfer is not defined`）—— 而在真浏览器里两者是同一个对象。
      const W = (typeof window !== 'undefined') ? window : self;
      const DT = W.DataTransfer;
      const F = W.File;
      const doFetch = W.fetch || (typeof fetch !== 'undefined' ? fetch : null);
      if (!DT || !F || !doFetch) {
        return { ok: false, msg: '这个环境缺 DataTransfer/File/fetch，没法直接塞图' };
      }

      const blob = await (await doFetch(dataUrl)).blob();
      const file = new F([blob], 'question.png', { type: blob.type || 'image/png' });
      const dt = new DT();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await jitter(500, 0.3);
      // 复核：站点真的收到了吗
      const n = input.files ? input.files.length : 0;
      if (!n) return { ok: false, msg: '图塞进去了但站点没接住（files 为空）' };
      return { ok: true, msg: '已上传 ' + file.name + '（' + Math.round((blob.size || 0) / 1024) + 'KB）' };
    } catch (e) {
      return { ok: false, msg: '上传失败：' + (e && e.message) };
    }
  }

  /** 等发送按钮变成"能按"的样子，最多 waitMs。返回等到与否 */
  async function waitSendable(provider, waitMs, inputEl) {
    const until = Date.now() + Math.max(0, waitMs || 0);
    for (;;) {
      const list = findSendCandidates(provider, inputEl);
      if (list.length && sendable(list[0], provider)) return true;
      if (Date.now() >= until) return false;
      await sleep(120);
    }
  }

  /** 按发送按钮；按不到"能按"状态就返回 false，不浪费一次点击 */
  async function clickSend(provider, inputEl) {
    const list = findSendCandidates(provider, inputEl);
    if (!list.length) return false;
    const btn = list[0];
    if (!sendable(btn, provider)) return false;
    realClick(btn);
    return true;
  }

  function findStop(p) {
    return anyVisible(p.stop);
  }

  /**
   * 「上一个回答还在生成」——**严格**判据，因为我们要动手点它。
   *
   * 为什么分成宽/严两套：宽判据（`div[class*="stop"]` 这种）用来"等"是安全的，
   * 用来"点"就危险 —— 它可能命中一个跟停止毫无关系的元素，
   * 点下去就是随机的副作用。只有明确写着"停止 / Stop"的才敢点。
   */
  function findStopStrict(p) {
    void p;
    return anyVisible([
      'button[aria-label*="停止" i]',
      'button[aria-label*="stop" i]',
      'div[role="button"][aria-label*="停止" i]',
      'div[role="button"][aria-label*="stop" i]',
      'button[title*="停止"]',
      'button[title*="stop" i]',
    ]);
  }

  // 最近一次找到的输入框。纯粹给"结构兜底"用：从输入框往上找对话列，
  // 是判断"哪里是回答区"最可靠的办法（比猜 class 名强得多）。
  let lastInputEl = null;

  function countReplies(p, inputEl) {
    if (inputEl) lastInputEl = inputEl;
    const list = allVisible(p.answer);
    if (list.length) return list;
    const viaSource = allVisible([p.source || p.answer[0]]);
    if (viaSource.length) return viaSource;

    // ── 选择器全军覆没时的结构兜底 ──
    //
    // 用户实际遇到的：DeepSeek 回答是干干净净一行 `答案：B`，
    // **没有** `.markdown` 之类的容器（那些 class 只在回答里带格式时才出现）。
    // 于是这里一个元素都匹配不到，`readReply` 永远等不到新回答，
    // 整条链路在"答案其实已经拿到"的状态下报失败。
    // 改从输入框往上找对话列，取那一列里最后的有文字末梢块。
    const root = findConversationRoot(lastInputEl);
    if (!root) return [];
    let blocks = textBlocksIn(root);
    // 输入框自己和它的工具栏不算回答
    if (lastInputEl) {
      blocks = blocks.filter((el) => !lastInputEl.contains(el) && el !== lastInputEl);
    }
    // 最多回看 40 块：只关心"最新那条"，多了纯属浪费
    return blocks.slice(-40);
  }

  /**
   * 「回答区现在长什么样」的一个指纹。
   *
   * 为什么需要它：光数消息条数**不可靠** —— 站点的回答是流式渲染的，
   * 同一屏里 `.markdown` 这类"最内层"元素的数量会在渲染过程中忽增忽减，
   * 于是"条数变多了吗"这个判据会时灵时不灵。
   *
   * 指纹用两条更稳的信号：
   *   · `last`：最后一条回答的文字长度（回答一开始变长就说明动起来了）
   *   · `node`：最后一条回答的元素引用（换了节点 ⇒ 来了新回答）
   *
   * 判"发出去了没有"时把发送前后的指纹比一比（见 submit 的 moved()）。
   */
  function replyAnchor(p, inputEl) {
    const list = countReplies(p, inputEl);
    if (!list.length) return { count: 0, last: '', node: null };
    const node = list[list.length - 1];
    return { count: list.length, last: textOf(node), node };
  }

  /** 输入框里现有的内容（textarea 与 contenteditable 两种形态） */
  /**
   * 安全地取一个元素构造函数的 prototype。
   *
   * 直接写 `el instanceof HTMLTextAreaElement` 是危险的：这个构造函数
   * 不保证在当前作用域里存在（扩展重载后的旧 content script 世界、
   * 各种沙箱里都是 undefined），一旦它抛 ReferenceError，
   * 整个 try 块连同后面的兜底路径一起完蛋 —— 表现就是"字永远塞不进去"。
   */
  function safeProto(el, ctorName) {
    let Ctor = null;
    try {
      const g = (typeof window !== 'undefined' && window) ||
        (typeof self !== 'undefined' && self) || {};
      Ctor = g[ctorName] || (typeof globalThis !== 'undefined' && globalThis[ctorName]) || null;
    } catch (e) {
      Ctor = null;
    }
    if (Ctor && Ctor.prototype && el instanceof Ctor) return Ctor.prototype;
    // 拿不到构造函数就沿着原型链自己往上找那一层的 value 描述符
    let p = Object.getPrototypeOf(el);
    while (p) {
      if (Object.prototype.hasOwnProperty.call(p, 'value')) return p;
      p = Object.getPrototypeOf(p);
    }
    return null;
  }

  function inputText(el) {
    if (!el) return '';
    if ('value' in el && typeof el.value === 'string') return el.value;
    return el.innerText || el.textContent || '';
  }

  /** 焦点现在在谁身上 —— 排查"回车敲给了谁"这类问题时全靠它 */
  function activeDesc() {
    try {
      const a = document.activeElement;
      if (!a) return '(null)';
      const cls = typeof a.className === 'string' ? a.className : '';
      return a.tagName.toLowerCase() + (cls ? '.' + cls.split(/\s+/).slice(0, 2).join('.') : '');
    } catch (e) {
      return '(读不到)';
    }
  }

  /**
   * 发送按钮的描述 —— 只进诊断信息，不作判据。
   *
   * 传了 el 就描述那一个（实际会点的那个），否则描述排序后的第一名。
   * 附带把**候选总数**也报出来：候选有 5 个说明排序在替我们挑，
   * 候选只有一个说明选择器命中面太窄。
   */
  function sendButtonDesc(p, el) {
    const list = findSendCandidates(p, lastInputEl);
    const btn = el || list[0];
    if (!btn) return '(没找到发送按钮)';
    const cls = typeof btn.className === 'string' ? btn.className : '';
    const aria = (btn.getAttribute && btn.getAttribute('aria-label')) || '';
    return btn.tagName.toLowerCase() +
      (cls ? '.' + cls.split(/\s+/).slice(0, 2).join('.') : '') +
      (aria ? ' "' + aria.slice(0, 20) + '"' : '') +
      ' aria-disabled=' + (btn.getAttribute && btn.getAttribute('aria-disabled')) +
      ' disabled=' + (!!btn.disabled) +
      ' 候选=' + list.length;
  }

  // ── 塞字 / 发送 ──────────────────────────────────────────

  function focusedOn(el) {
    try {
      return document.activeElement === el || el.contains(document.activeElement);
    } catch (e) {
      return false;
    }
  }

  /**
   * 把焦点弄到输入框上。
   *
   * 点一下是为了让受控组件进入"聚焦态"（站点靠这个点亮发送按钮），
   * `el.focus()` 是兜底 —— 点击可能被别的扩展的遮挡层接走，
   * 而键盘事件只认焦点。
   */
  async function focusInput(el) {
    const pt = absolutePoint(el);
    if (pt) {
      realClick(el);
      await jitter(120, 0.4);
    }
    return refocus(el);
  }

  /** 只走 DOM focus（不点击），用于按回车之前的补焦 */
  async function refocus(el) {
    if (focusedOn(el)) return true;
    try {
      if (el.focus) el.focus();
    } catch (e) { /* noop */ }
    await sleep(60);
    return focusedOn(el);
  }

  async function typePrompt(el, prompt) {
    const want = prompt.replace(/\s+/g, '').length;
    if (want < 8) return '';

    // 每条路径之后都用"塞进去多少字"复核，不认"我调过 API 了"
    const ok = (tag) => {
      const got = inputText(el).replace(/\s+/g, '').length;
      return got >= Math.min(want, 40) ? tag : '';
    };

    // 路径 A：原生 setter / textContent + input 事件。
    //
    // 放在第一位是因为它**不需要焦点** —— 而焦点恰恰是最容易被抢走的东西：
    // 点了发送按钮、页面自己重渲染、被别的扩展的遮挡层接走点击，都会让
    // 原先的焦点不在了。React 的受控 textarea 必须走原生 setter，
    // 直接 el.value = x 会被它的状态机在下一帧冲掉。
    try {
      if ('value' in el && typeof el.value === 'string' && el.tagName === 'TEXTAREA') {
        // ⚠ 不能用 `el instanceof HTMLTextAreaElement`：
        // 这个构造函数不保证在当前作用域里存在（扩展重载后的旧世界、
        // 某些沙箱环境里都是 undefined），直接写会抛 ReferenceError，
        // 而它一旦抛出去，后面的路径全部连坐。
        const proto = safeProto(el, 'HTMLTextAreaElement');
        const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, prompt);
        else el.value = prompt;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // contenteditable：把内容写进去再补一发 input，
        // 让 Quill / ProseMirror 这类编辑器知道"内容变了"
        el.textContent = prompt;
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true, data: prompt, inputType: 'insertText',
          }));
        } catch (e2) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await jitter(140, 0.4);
      const via = ok('dom');
      if (via) return via;
    } catch (e) { /* 落到路径 B */ }

    // 路径 B：CDP 塞字。浏览器层面为真，React 的受控组件天然跟得上，
    // 但它是往**当前焦点**里写 —— 所以只在焦点确实在输入框上时才值得试。
    if (focusedOn(el)) {
      const okCdp = await cdpInsertText(prompt);
      if (okCdp) {
        await jitter(140, 0.4);
        const via = ok('cdp');
        if (via) return via;
      }
    }

    // 路径 C：execCommand —— 已弃用，但 contenteditable 站点上仍然是
    // 唯一能让它们「收到用户输入」的兼容手段（它会自己处理选区）
    try {
      await refocus(el);
      if (typeof document.execCommand === 'function') {
        document.execCommand('selectAll');
        document.execCommand('insertText', false, prompt);
      }
      await jitter(140, 0.4);
      const via = ok('execCommand');
      if (via) return via;
    } catch (e) { /* 全挂了 */ }

    return '';
  }

  /**
   * 提交（会一直轮着试，直到确认发出去或时间用完）。
   *
   * 踩过三次坑，第三次就是这条需求本身：**"字打进去了但发不出去"**。
   * 站点的发送按钮要么一直不点亮（受控组件没收到真正的输入事件），
   * 要么被别的扩展的遮挡层吃掉点击，要么在点击之后**焦点被抢走** ——
   * 这时候往"当前焦点"敲回车是敲给了别人，输入框里的字一动不动。
   *
   * 所以提交是一圈一圈轮着来的，每一圈都先确保焦点在输入框上：
   *
   *   ① 点发送按钮
   *   ② 重新聚焦输入框 → 敲原生回车
   *   ③ 再聚焦 → 敲"纯键盘序列"（rawKeyDown + insertText('\r') + keyUp）
   *   ④ 回到 ①，直到 sendDeadline 用完
   *
   * 三路都试不出来的情况很少见，但真遇到时**不能无限试下去**：
   * 弹窗还开着、视频还被 hold 着，卡在这儿等于整节课停摆。
   * 所以用一个独立的 sendDeadline 兜住，到点就带着诊断信息返回。
   *
   * 判据看「回答条数」「回答区有没有出现我们那段文字」「输入框清没清空」，
   * 不看按钮状态 —— 按钮的禁用态每种站点都不一样，用它是自找麻烦。
   *
   * @returns {Promise<{ok:boolean, via?:string, trail:string[], why?:string}>}
   */
  async function submit(p, el, deadline, promptText, opts) {
    const o = opts || {};
    const cleared = () => inputText(el).trim().length === 0;
    // 兜底信号：有些站点发出消息后输入框不清空、回答区也还没渲染，
    // 但消息正文已经出现在页面上 —— 拿题目前 12 个字去页面上找一找
    const probe = String(promptText || '').replace(/\s+/g, '').slice(0, 12);
    const echoed = () => {
      if (probe.length < 6) return false;
      try {
        return (document.body.innerText || '').replace(/\s+/g, '').indexOf(probe) !== -1;
      } catch (e) {
        return false;
      }
    };

    // 发送前的"回答区指纹"。
    //
    // 为什么不用"数条数"当唯一判据：站点的回答是**流式渲染**的，
    // 同一屏里"最内层"元素的数量会在渲染过程中忽增忽减（先出现外层容器、
    // 再长出内层 markdown），所以"条数涨了吗"会时灵时不灵 ——
    // 这正是"问题明明发出去了、插件却说没发出去"的头号原因。
    // 指纹看两件更稳的事：最后一条回答换了节点，或者它的文字开始变长。
    const anchor = o.anchor || replyAnchor(p, el);
    const moved = () => {
      const now = replyAnchor(p, el);
      if (now.count > anchor.count) return true;
      if (now.node && now.node !== anchor.node) return true;
      if (now.last && anchor.last && now.last.length > anchor.last.length + 2) return true;
      return false;
    };
    const landed = () => moved() || cleared() || echoed();

    // ── 把总预算切成「发」和「读」两段 ──
    //
    // 这两段是此消彼长的，而且代价不对称：
    //   · **发不出去是致命的** —— 这一级整个白跑，只能落回题库；
    //   · 读得短一点还有机会 —— 回包通常比我们保守估计的快。
    // 所以发送段给得宽，而且**必须随用户设置的预算一起变**。
    //
    // ⚠ 这里踩过坑：以前的写法把发送段的上限**写死成 15 秒**
    //   （`Math.min(15000, 剩余 * 0.45)`）。后果是用户把「应答等待」
    //   调到 60s 甚至 180s，发送阶段仍然只试 15 秒就放弃、报"问题没发出去" ——
    //   从用户角度看就是"我明明调长了，它还是那么快就失败"，也就是
    //   「时间分配有问题」。
    // 现在按比例切：一半给"发"（下限 10s、上限 60s），
    // 同时保证给"读"留至少 30%（最多 20s）。
    const budget = Math.max(3000, deadline - Date.now());
    const reserveForRead = Math.min(20000, Math.floor(budget * 0.3));
    const sendWindow = Math.max(
      10000,
      Math.min(Math.floor(budget / 2), budget - reserveForRead, 60000)
    );
    const sendStartedAt = Date.now();
    const sendDeadline = sendStartedAt + sendWindow;
    const spent = () => Date.now() > sendDeadline;
    // trail 可以由调用方传进来 —— handleAsk 想在 "等停止按钮" 那一段也记东西，
    // 而那段发生在 submit 之前，所以得共用同一个数组
    const trail = o.trail || [];
    trail.push('budget:总预算 ' + Math.round(budget / 1000) + 's → 发送段 ' +
      Math.round(sendWindow / 1000) + 's，留给读 ' +
      Math.round((budget - sendWindow) / 1000) + 's');

    const snap = (tag) => {
      trail.push(tag + ':focus=' + activeDesc() + ',left=' + inputText(el).length +
        ',replies=' + replyAnchor(p, el).count);
    };

    // 输入框是空的：要么字数下限没满足，要么我们塞字那一步其实没成功。
    // 无论是哪种，在这儿反复敲回车都没用。
    //
    // ⚠ 例外：**贴了图的时候，空文本是正常状态**。
    // 原来这里无条件判空 —— 于是"只发图片"这条路每轮都在这被判 empty、直接放弃，
    // 外层再重试、又贴一张图 …… 实测堆了 7 张缩略图一张都没发出去。
    if (!o.allowEmpty && cleared()) return { ok: false, trail, why: 'empty' };
    trail.push('anchor:replies=' + anchor.count + ',lastLen=' + (anchor.last || '').length);

    let round = 0;
    while (!spent()) {
      round++;

      // ── 等发送按钮变"能按"，然后**不管等没等到都要点** ──
      //
      // 两个独立的教训叠在这儿：
      //  ① 「第一次点只把题目打进了输入框」—— 站点把我们的字收进自己的状态
      //     之前按钮是禁用的，这时候点它等于什么都没发生。所以要**先等**。
      //  ② ⚠ **等不到也必须点**。以前这里写的是 `if (btn && ready)`，
      //     等不到就整轮跳过点击 —— 而"禁用"的判据（aria-disabled / disabled /
      //     半透明）不一定挂在真正能点的那个元素上（可能挂在外层容器），
      //     真按钮的透明度也可能在过渡动画中途。判据一误伤，唯一有效的那一路
      //     就被自己关掉了，越修越坏。点击很便宜（几毫秒），**等是优化，拒绝点击是事故**。
      //
      // 等待的时长：第一轮给足 2.5 秒（页面刚起来、字刚进去，按钮点亮得慢），
      // 后面几轮缩短 —— 到那时还没点亮，多半是别的原因，不值得一直等。
      const ready = await waitSendable(p, round === 1 ? 2500 : 1200, el);
      // 候选按"像不像发送键"排序；**每轮换下一个**。
      // 这样即使排序猜错了（把某个模式开关排在前面），下一轮会自动换一个试，
      // 而不是"每轮都忠实地去点同一个没用的东西"。
      const cands = findSendCandidates(p, el);
      const btn = cands.length ? cands[Math.min(round - 1, cands.length - 1)] : null;
      if (round === 1 || (round === 2 && cands.length > 1)) {
        trail.push('sendBtn#' + round + '=' + sendButtonDesc(p, btn) +
          (ready ? '' : ' [等不到"能按"状态，仍照点]') +
          (cands.length > 1 ? '（共 ' + cands.length + ' 个候选）' : ''));
      }

      // ① 点发送按钮。点完**不判成败就跑下一路** ——
      //    站点对这个点击的反应可能要几百毫秒，而点它和敲回车本来就是
      //    同一个动作的两种表达，连着做比分开试成功率高得多。
      if (btn) {
        realClick(btn);
        await jitter(220, 0.4);
        if (landed()) {
          return { ok: true, via: 'button' + (round > 1 ? '#' + round : ''), trail };
        }
      }
      if (round === 1) snap('after-click');
      if (spent()) break;

      // ② 键盘：回车。KeyboardEvent 是发给 activeElement 的 ——
      //    焦点丢了回车就敲给了别人，所以这一路必须先确认焦点在输入框上；
      //    要不到焦点就跳过，省下这一轮的时间去试别的路（别在这儿空耗）。
      if (focusedOn(el) || await refocus(el)) {
        await cdpKey('Enter');
        await jitter(340, 0.4);
        if (landed()) return { ok: true, via: 'enter#' + round, trail };
        if (spent()) break;

        // ③ 换纯键盘序列（rawKeyDown + insertText('\r') + keyUp），
        //    给那些把"发送"挂在 input / beforeinput 上的站点
        await refocus(el);
        await cdpKey('Enter', true);
        await jitter(340, 0.4);
        if (landed()) return { ok: true, via: 'raw-enter#' + round, trail };
      } else {
        trail.push('round' + round + ':焦点要不到，跳过键盘两路');
      }

      // ④ 兜底：把内容**重新塞一遍**再回车。
      //    站点可能在第一次尝试里把自己的输入状态回滚了（受控组件常见），
      //    这时敲多少次回车都没用 —— 得先把字重新放回去。
      //    走的是 typePrompt 里那条不需要焦点的 DOM 路径。
      if (!cleared()) {
        await typePrompt(el, promptText);
        await jitter(160, 0.4);
        // 同样是"等到就点、等不到也点"
        await waitSendable(p, 1000, el);
        await clickSend(p, el);
        await jitter(180, 0.4);
        if (landed()) return { ok: true, via: 'retype-button#' + round, trail };

        await refocus(el);
        await cdpKey('Enter');
        await jitter(340, 0.4);
        if (landed()) return { ok: true, via: 'retype-enter#' + round, trail };
      }

      snap('round' + round);
    }

    return {
      ok: false,
      trail,
      why: cleared() ? 'cleared-but-no-reply' : 'no-effect',
      rounds: round,
      // 发送段实际花了多久 / 一共允许多久 —— 失败报告里要显示这个。
      // 不然用户只看到"没发出去"，分不清是"时间用完了"还是"被提前掐掉了"。
      usedMs: Date.now() - sendStartedAt,
      sendWindow,
    };
  }

  // ── 等回包 ───────────────────────────────────────────────

  /**
   * 等一条新回答，并判断它写完了没有。
   *
   * 结束判据是两条同时成立：
   *   ① 「停止生成」按钮不可见（没有这个按钮的站点直接跳过）
   *   ② 文本连续 stableMs 没有增长
   * 只用 ① 不够：按钮有动画/延迟，可能在流式输出中途先消失；
   * 只用 ② 也不够：模型卡顿时「没增长」不等于「写完了」。
   */
  async function readReply(p, anchor, deadline, stableMs, isCancelled, inputEl) {
    // 「等到了一条新回答」= 条数涨了，或者最后一条换了节点。
    // 光看条数不够：站点是流式渲染的，同一屏里"最内层"元素的数量会忽增忽减。
    const anchorCount = (anchor && anchor.count) || 0;
    const isNew = (list) => {
      if (list.length > anchorCount) return true;
      const last = list[list.length - 1];
      return !!(last && anchor && anchor.node && last !== anchor.node);
    };

    const waitForNew = async () => {
      while (Date.now() < deadline) {
        if (isCancelled()) return null;
        const list = countReplies(p, inputEl);
        if (isNew(list)) return list[list.length - 1];
        await sleep(250);
      }
      return null;
    };

    let node = await waitForNew();
    if (!node) return null;

    let lastText = '';
    let lastChange = Date.now();
    let lastNodeText = '';

    while (Date.now() < deadline) {
      if (isCancelled()) return null;

      // 站点偶尔会在重新渲染时换掉节点，跟着走
      const list = countReplies(p, inputEl);
      if (isNew(list)) node = list[list.length - 1];

      const t = textOf(node);
      if (t !== lastNodeText) {
        lastNodeText = t;
        if (t.length !== lastText.length) lastChange = Date.now();
        lastText = t;
      }

      const streaming = !!findStop(p);
      const stable = Date.now() - lastChange >= stableMs;
      if (!streaming && stable && lastText.trim().length >= 2) return lastText;

      await sleep(300);
    }
    // 超时也把已经拿到的半截回包交出去：多半已经包含「答案：X」那一行
    return lastText.trim().length >= 2 ? lastText : null;
  }

  // ── 主入口 ───────────────────────────────────────────────

  let busy = false;
  let cancelled = false;

  async function handleAsk(msg) {
    const q = (msg && msg.question) || {};
    const provider = WA.providerForUrl(location.href) || WA.getProvider(q.provider);
    if (!provider) {
      return { ok: false, msg: '当前页面不是已支持的 AI 站点（Gemini/豆包/DeepSeek/Kimi/通义/元宝）' };
    }

    const cfg = NS.config ? NS.config.get() : {};
    const timeoutMs = Math.max(8000, Number(msg.timeoutMs) || 45000);
    // ⚠ 截止时刻从**进入页面处理**这一刻算起，而不是从后台发起问询那一刻。
    // 后台找标签页/新开标签页/等高保真通道就绪，可能先花掉几秒到十几秒；
    // 那些时间不该从"给模型思考的预算"里扣。
    // 更糟的是：如果标签页是后台刚新建的，页面要等一会儿才有 DOM 可操作，
    // 而 deadline 早就到了 —— 表现就是"问题已经发出去了，插件却说没发出去"。
    const deadline = Date.now() + timeoutMs;
    const stableMs = Math.max(600, Number(cfg.askStableMs) || 1400);
    const wantShot = msg.wantShot === true;

    if (busy) return { ok: false, msg: '这个 AI 标签页正在处理上一个问题' };
    busy = true;
    cancelled = false;

    try {
      // 登录页 / 验证页：直接说清楚，别让上层白等 45 秒
      const path = location.pathname || '';
      if (/login|signin|passport|verify|captcha/i.test(path)) {
        return { ok: false, msg: provider.name + ' 需要先登录（当前停在 ' + path + '）' };
      }

      let input = findInput(provider);
      if (!input) {
        return {
          ok: false,
          msg: '没找到 ' + provider.name + ' 的输入框（站点可能改版了）',
          wantShot: !!wantShot,
        };
      }

      // ── 每次提问都从"干净的输入框"开始 ──
      //
      // 这一句是「二次提问发不出去」的修法。第一次提问之所以正常，
      // 就是因为那时输入框是空的；只要保证每次都是空的，
      // 后面每一问走的就是和第一问**完全相同**的路径。
      // （上一问的重试可能把文字留在了里面 —— 不清掉就会和这一问的题目连在一起。）
      // 从这一步开始就开一条 trail：失败时它是唯一能看出"卡在哪一步"的东西，
      // 而且 submit 也会往同一个数组里写，所以要在这里建、传下去。
      //
      // ⚠ 必须建在**下面那些用到它的代码之前** —— 我上一版把"贴图"那段
      // 放在了 trail 声明之前（为了凑"先图后字"的顺序），结果直接抛
      // `Cannot access 'trail' before initialization`（TDZ），
      // 整次提问在 0.8 秒内失败。**顺序要顾，但声明必须在前。**
      const trail = [];

      // ── 图像方案：先把题目截图塞进上传入口，再发提示词 ──
      //
      // 顺序很重要：**先图后字**。站点上先打字再传图，有些版本会把输入框重置。
      // 而且这条路完全绕开了"从 DOM 读题干"—— 那件事已经在真实作业页上
      // 磨了十几轮没稳住（多题共存、toast 覆盖、标签枚举、DOM 顺序 ≠ 屏幕顺序…）。
      if (msg.image) {
        const up = await attachImage(provider, msg.image);
        trail.push('上传题目截图：' + (up.ok ? '成功' : '失败') + '（' + up.msg + '）');
        if (!up.ok) {
          // 上传失败不直接放弃 —— 文字题干还在，退回老路
          trail.push('退回文字题干');
        } else {
          await jitter(900, 0.3);      // 等缩略图渲染出来
        }
      }

      const wasDirty = inputText(input).trim().length > 0;
      if (wasDirty) {
        const cleaned = await clearComposer(input);
        // 用 debug：这是正常的自愈，不是故障，别用 warn 吓人
        // eslint-disable-next-line no-console
        console.log('[知到助手] 输入框里有残留文字，已清空=' + cleaned);
      }

      // ── 上一轮还在生成：**主动把它停掉**，而不是死等 ──
      //
      // 用户报的现象：「连续提交时，后面的提交不上」——
      // 第一问正常（回包也读到了），第二问的字进了输入框却发不出去。
      //
      // 原因就在这儿：上一轮的回答还在流式输出时，composer 上那个按钮
      // 是**「停止生成」**，不是「发送」。这时候点它只会把上一条回答掐掉，
      // 敲回车也不发消息 —— 于是字一直留在输入框里。
      // 以前这里只是"等 3 秒"，而模型还在写，3 秒根本不够；
      // 等完接着点，点到的是停止键，白折腾一轮又一轮。
      //
      // ⚠ 先**等它自然答完**（最多 45 秒），等不住才掐。
      //
      // 这一段原来直接就"点掉停止键"。那个改法当时救了"二次提问发不出去"，
      // 但埋了另一个坑 —— 用户的观察把因果说得非常清楚：
      //   「第 6 题 AI 还在分析图片，第 7 题截图已经进了对话框」
      // 也就是说：**第 6 题的回答还没写完，就被第 7 题的发送掐掉了。**
      // 于是第 6 题拿不到答案、被跳过，一路错位（"3/6 没填上"就是这么来的）。
      //
      // 掐断上一轮应当是**最后手段**，不是第一步：
      //   · 先等（模型正常写一条答案只要十几秒）→ 上一题的答案保住
      //   · 等不住再掐 → 至少不会卡死
      const graceMs = 45000;
      if (findStop(provider)) {
        trail.push('上一个回答还在生成 → 先等它答完（最多 ' + Math.round(graceMs / 1000) + ' 秒）');
        const graceUntil = Date.now() + graceMs;
        while (findStop(provider) && Date.now() < graceUntil) {
          if (cancelled) return { ok: false, msg: '已取消' };
          await sleep(400);
        }
        if (!findStop(provider)) trail.push('上一轮已自然答完');
      }

      // 等不住才掐（判据用严格的：必须明确写着"停止/Stop"，因为这一下真的会点下去）
      const streamer = findStopStrict(provider);
      if (streamer) {
        trail.push('等不住 → 点掉停止键');
        realClick(streamer);
        const until = Date.now() + 6000;
        while (findStop(provider) && Date.now() < until) {
          if (cancelled) return { ok: false, msg: '已取消' };
          await sleep(250);
        }
        trail.push(findStop(provider) ? '停止键还在（点了没用），先往下走' : '已回到可发送状态');
      } else if (findStop(provider)) {
        trail.push('停止键还在（宽判据），不再等，先往下走');
      }

      // 回答区的指纹要在**动手之前**就抓下来，而且**必须把输入框传进去** ——
      // 选择器全军覆没时，结构兜底要靠它去定位"对话那一列"。
      // 抓晚了（比如点了发送按钮之后才抓）会把新出现的用户消息算进基线，
      // 于是"条数涨了吗"永远为假 —— 这是"发出去了却说没发出去"的另一半原因。
      const anchor = replyAnchor(provider, input);
      // 有图就用**看图专用提示词**。
      //
      // 别把文字题干一起发过去：换图像方案的前提就是"题干从 DOM 读不准"——
      // 把一段错的题干和一张对的图一起发，模型大概率被那段字带偏。
      // 图里什么都有（题号、题型、题干、四个选项），直接让它看图答。
      const prompt = msg.image
        ? '直接说出答案，不用解析。\n看图片里的这道题，最后只回一行：答案：<单个字母>'
        : WA.buildPrompt(q, { attempt: q.attempt });

      await focusInput(input);
      let via = await typePrompt(input, prompt);

      // ── 贴图之后输入框可能被**重挂**了 ──
      //
      // 实测现场：输入框里堆了 7 张缩略图、**一个字都没打进去**、也没发送 ——
      // 循环重试，每轮再贴一张。原因是贴上图片后站点会重渲染 composer，
      // 手里那个 `input` 已经是**脱离文档的旧节点**：字打给了空气，
      // 发送按钮也点不着。
      //
      // 所以打不进去时**重新找一个输入框**再试一次，而不是直接报失败。
      if (!via && msg.image) {
        const again = findInput(provider);
        if (again && again !== input) {
          trail.push('贴图后输入框被换了，重新找了一个再打');
          input = again;
          await focusInput(input);
          via = await typePrompt(input, prompt);
        }
      }
      if (!via) {
        // 图已经贴上去了 —— 那本身就是一条合法消息，**照样可以发**。
        // 宁可发一条"只有图、没有字"的，也别卡在这里无限重试（重试会再贴一张图）。
        if (msg.image) {
          trail.push('打字失败，但图已贴上 ⇒ 按"只有图"发送');
          const sres2 = await submit(provider, input, deadline, '', { trail, anchor, allowEmpty: true });
          if (sres2 && sres2.ok) {
            return {
              ok: true,
              msg: '已按"只看图"发出（文字没打进去）',
              provider: provider.id,
              via: sres2.via,
              trail,
              panelVersion: 'probe-3',
            };
          }
        }
        trail.push('type-failed:focus=' + activeDesc() + ',left=' + inputText(input).length);
        return {
          ok: false,
          msg: '字没能进到输入框（' + provider.name + '）—— 三条塞字路径都没成功',
          provider: provider.id,
          trail,
          focusAt: activeDesc(),
          wantShot: !!wantShot,
        };
      }
      trail.push('typed-via=' + via);

      const gotIn = inputText(input);
      const sres = await submit(provider, input, deadline, prompt, { trail, anchor });
      if (!sres || !sres.ok) {
        const used = sres && sres.usedMs ? (sres.usedMs / 1000).toFixed(1) : '?';
        const cap = sres && sres.sendWindow ? Math.round(sres.sendWindow / 1000) : '?';
        return {
          ok: false,
          msg: '问题没发出去（' + provider.name + '：' +
            (sres && sres.why === 'empty'
              ? '输入框里没字，塞字那一步其实失败了'
              : '试了 ' + ((sres && sres.rounds) || 1) + ' 轮 / 用了 ' + used +
                's（发送段上限 ' + cap + 's），四条路都没生效') + '）',
          provider: provider.id,
          typedChars: gotIn.length,
          leftChars: inputText(input).length,
          sendButton: sendButtonDesc(provider),
          focusAt: activeDesc(),
          trail,
          via,
          // 页面上此刻长什么样 —— 后台会拿这个 key 去抓一张截图
          wantShot: true,
        };
      }
      trail.push('sent-via=' + sres.via);

      // ⚠ 最后这个参数是输入框，**必须传** ——
      // 选择器全军覆没时，"结构兜底"要靠它去定位对话那一列。
      // 这里曾经漏传过一次：readReply 的签名里没有 el，而函数体里用了它，
      // 于是发送成功、刚开始等回答的那一刻就抛 `el is not defined`，
      // 整条链路报「在 DeepSeek 上出错」。
      const raw = await readReply(provider, anchor, deadline, stableMs,
        () => cancelled, input);
      if (cancelled) return { ok: false, msg: '已取消' };
      if (!raw) return { ok: false, msg: '等待 ' + provider.name + ' 回复超时' };

      // ⚠ 读到「正在分析图片」这类**状态文字**时，不能当成回答 —— 它还没写完。
      //
      // 实测（图像方案上线后）：reply 区域里最先出现的就是这句状态提示，
      // 我们的读回包立刻把它当成回复 ⇒ parseReply 解析不出 ⇒ 3 秒就放弃，
      // 而模型其实还在看图。日志里那句「AI 原话：正在分析图片 正在分析图片」
      // 就是这么来的 —— 每次提问都被它顶掉，于是整卷漏答。
      //
      // 处理：认出这类"还在忙"的文字就**继续等**，直到等到真回答或到点。
      let rawReady = raw;
      let waitRound = 0;
      while (PLACEHOLDER_REPLY_RE.test(rawReady) && Date.now() < deadline
             && !cancelled && waitRound < 60) {
        waitRound++;
        if (waitRound === 1) trail.push('读到的是状态提示（' + rawReady.trim().slice(0, 20) + '）→ 继续等');
        await sleep(1000);
        const again = await readReply(provider, anchor, deadline, stableMs,
          () => cancelled, input);
        if (again) rawReady = again;
      }
      if (cancelled) return { ok: false, msg: '已取消' };
      if (waitRound) trail.push('等到了真回答（等了 ' + waitRound + ' 秒）');
      const rawFinal = rawReady;

      const parsed = WA.parseReply(rawFinal, (q.options || []).length, {
        allowBoolean: !q.multi,
      });
      if (!parsed) {
        // ⚠ 把 AI 的**原话**放进消息里 —— 它才是定位这件事的唯一线索。
        //
        // 实测日志只有一行 `AI 没给出可用答案（拿不到可用答案，3.1s）`：
        // 知道它失败了，但**不知道 AI 到底回了什么** —— 而回答就在 raw 里，
        // 之前只当作返回值带出去，没写进日志，等于白抓。
        return {
          ok: false,
          msg: '拿不到可用答案 · AI 原话：' + String(rawFinal).replace(/\s+/g, ' ').slice(0, 160),
          provider: provider.id,
          raw: rawFinal.slice(0, 200),
        };
      }

      return {
        ok: true,
        answer: parsed.answer,
        letters: parsed.letters,
        provider: provider.id,
        providerName: provider.name,
        source: parsed.source,
        reason: parsed.reason || parsed.raw.slice(0, 40),
        raw: rawFinal.slice(0, 300),
        via: via,
        ms: timeoutMs - (deadline - Date.now()),
        // 成功也把轨迹带上：排障时"成功这一轮是怎么走通的"和失败一样有用，
        // 而且测试要靠它验证"连续提问时先停掉了上一轮的生成"这类行为
        trail: trail,
      };
    } catch (e) {
      return { ok: false, msg: '在 ' + provider.name + ' 上出错：' + String(e && e.message || e) };
    } finally {
      busy = false;
    }
  }

  const driver = {
    handleAsk,
    countReplies,
    findInput,
    findProvider: () => WA.providerForUrl(location.href),
    // 排障后门：把提交环节单独暴露出来，好在测试里直接驱动它
    // （整条 handleAsk 需要真的站点页面，只测"发出去没"太贵）
    _test: {
      submit, typePrompt, refocus, countReplies, replyAnchor, isVisible,
      findSendCandidates, sendable, findSend, findInput, attachImage,
    },
  };
  NS.webAIDriver = driver;

  // 只在第一次加载时挂监听。这个文件虽然由 manifest 注入（同一文档只会跑一次），
  // 但开发时用「重注入脚本」或手动 executeScript 会再跑一遍 ——
  // 监听器一叠，一条 ZHS_AI_ASK 就会有两个实例同时去输入框里打字。
  function install() {
    if (!NS.webAIDriver || NS.webAIDriver._installed) return;
    NS.webAIDriver._installed = true;

    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (!msg) return undefined;

      // background 新开标签页后会轮询这个，确认 content script 已经挂上来了
      if (msg.type === 'ZHS_AI_PING') {
        reply({
          ok: true,
          url: location.href,
          provider: (WA.providerForUrl(location.href) || {}).id || null,
        });
        return true;
      }

      if (msg.type === 'ZHS_AI_ASK') {
        if (!WA) { reply({ ok: false, msg: 'web-ai 模块未加载' }); return true; }
        handleAsk(msg)
          .then((r) => reply(r))
          .catch((e) => reply({ ok: false, msg: String(e && e.message || e) }));
        return true;
      }

      if (msg.type === 'ZHS_AI_CANCEL') {
        cancelled = true;
        return undefined;
      }

      return undefined;
    });
  }

  try { install(); } catch (e) { /* 扩展上下文失效 */ }
})();
