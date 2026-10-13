/**
 * ai-bridge.js — 知到页 → 网页版 AI 的提问通道（content 侧）
 *
 * 只做三件事：
 *   1. 把 QuizSolver 的问题打包成 ZHS_AI_ASK 交给 background（由它找/开 AI 标签页）
 *   2. 管超时与取消 —— 等不到答案就老实返回 null，让上层退化到枚举
 *   3. 把「用哪家 AI、当前卡在哪一步」回吐成日志
 *
 * 关键取舍：**永远不阻塞主流程**。等待期间弹题窗口还开着、视频还被 hold 着，
 * 所以这里的超时是硬上限（配置项 + 8 秒兜底），到点必返回。
 *
 * 为什么不让知到页直接 fetch 那些站点的接口：
 *   - 拿不到登录态（cookie 不跨站），也过不了它们自己的风控签名
 *   → 只能开一个真标签页、用真人账号在网页里问，再把答案扣回来。
 */
(function () {
  'use strict';

  const NS = (window.__ZHS = window.__ZHS || {});

  // 「重注入脚本」会把整份文件再跑一遍。这里必须早退，否则会话内的
  // 应答缓存和统计会被清空 —— 同一道题答错重播时就会再问一遍 AI。
  if (NS.aiBridge && NS.aiBridge.__ready) return;

  // 配置与应答缓存由 background 持有（它比页面活得久），这里只放会话内的小状态
  const state = {
    inflight: null,     // { promise, abort, questionKey }
    asked: 0,
    answered: 0,
    failed: 0,
    lastError: '',
    lastProvider: '',
    lastDetail: null,   // 上一次失败时后台给的诊断（发不出去时全靠它）
    lastMs: 0,
    startedAt: 0,       // 本次问询的开始时间 —— popup 靠它显示"已经等了多久"
    phase: '',          // 当前阶段：找标签页 / 塞字 / 发送 / 等回包
    timeoutMs: 0,       // 本次允许等多久
  };

  // ── 串行闸门 ──────────────────────────────────────────────
  //
  // 同一时刻只允许一次问询在飞。
  //
  // 为什么必须**排队**，而不是"忙了就拒绝"：
  // 「视频」和「能力提升」两套答题共用**同一个网页端 AI 标签页**。
  // 一边刚把题目打进输入框、另一边也往里打 —— 输入框里两段文字混在一起发出去，
  // 或者一边把另一边的输入清掉了。两边都拿不到答案，还会污染对话。
  //
  // 后来的等前面的走完再上，而不是一撞上就报"AI 正在忙" ——
  // 那种失败会让上层白白落到题库/枚举，看起来就是"随机失败"。
  const AI_QUEUE_WAIT_MS = 90000;
  let aiChain = Promise.resolve();

  function withAiLock(fn, waitMs) {
    const limit = Math.max(1000, Number(waitMs) || AI_QUEUE_WAIT_MS);
    const run = aiChain.then(fn, fn);
    // 链本身不能因为某一次失败而断掉：只推进队列，不吞调用方的异常
    aiChain = run.then(() => {}, () => {});
    // 兜底：万一前一个问询永远不返回，别把后面的一起拖死
    return Promise.race([
      run,
      new Promise((resolve) => setTimeout(() => resolve(null), limit)),
    ]);
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.id) return finish(null);
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          finish(res || null);
        });
      } catch (e) {
        return finish(null);
      }
      // MV3 里 background 被回收 / 端口断开时回调可能永远不来
      setTimeout(() => finish(null), 60000);
    });
  }

  function log(level, msg) {
    const app = NS.app;
    if (app && typeof app.log === 'function') app.log(level, msg);
  }

  async function ask(opts) {
    const cfg = NS.config ? NS.config.get() : {};
    const o = opts || {};
    // 允许调用方覆盖等待时长 —— 看图作答比纯文字慢（要上传、要识别），
    // 用同一个预算会让它在"图刚传上去、模型还没开口"的时候被判超时。
    const timeoutMs = Math.max(5000, Number(o.timeoutMs) || Number(cfg.askWaitMs) || 45000);

    const payload = {
      stem: String(o.stem || '').slice(0, 500),
      options: (o.options || []).map((s) => String(s).slice(0, 200)),
      multi: !!o.multi,
      provider: cfg.webAIProvider || 'auto',
      // 第几次问这道题：AI 页面那边靠它换一句开场白，
      // 免得第二次提问被网页端当成"重复提问"顶回来
      attempt: Math.max(1, Number(o.attempt) || 1),
    };
    if (payload.options.length < 2) return null;

    // 同一道题被重复问到（答错回退重播）直接复用上一次的会话结果，
    // 不要每弹一次就去骚扰一遍 AI 站点
    const qk = NS.webAI.questionKey(payload.stem, payload.options.length, payload.multi);
    // 图像方案：有图就**不吃缓存**。
    // 缓存键是按题干文字算的，而看图作答时题干本来就不可信（这正是换方案的原因），
    // 拿它当键会把不同的题撞成同一条 —— 那样答错的代价比慢一次大得多。
    const useCache = !o.image;
    if (useCache && state.inflight && state.inflight.key === qk) {
      log('debug', '同一道题正在问 AI，复用本次等待');
      return state.inflight.promise;
    }
    if (useCache && state.cache && state.cache.has(qk)) {
      return state.cache.get(qk);
    }

    const t0 = Date.now();
    const promise = withAiLock(async () => {
      state.asked++;
      state.startedAt = t0;
      state.timeoutMs = timeoutMs;
      state.phase = '找 AI 标签页';
      const scope = cfg.askNewTab ? '必要时新开一个' : '只复用已打开的';
      log('info', '问 AI（' + (payload.provider === 'auto' ? '自动挑站点' : payload.provider) +
        '，' + scope + '，最多等 ' + Math.round(timeoutMs / 1000) + 's）：' +
        payload.stem.slice(0, 30) + '…');

      // 每 5 秒报一次进度。
      // 等待本身就该安静，但"在等"和"死等"必须能分辨 ——
      // 90 秒的预算下，一声不吭地干等会让人以为插件又卡了。
      const tick = setInterval(() => {
        const s = Math.round((Date.now() - t0) / 1000);
        if (s > 0 && s % 5 === 0) {
          log('debug', 'AI 等待中 ' + s + 's / ' + Math.round(timeoutMs / 1000) + 's（' +
            (state.phase || '等待') + '）');
        }
      }, 1000);

      const res = await sendMessage({
        type: 'ZHS_AI_ASK',
        question: payload,
        // 图像方案：题目截图的 dataURL。有它就说明这次是"看图作答"，
        // AI 页面那边会先把它塞进上传入口，再用一段看图专用的提示词。
        image: opts.image || null,
        timeoutMs,
      });

      clearInterval(tick);
      state.lastMs = Date.now() - t0;
      state.phase = '';

      if (!res || !res.ok || !Array.isArray(res.answer) || !res.answer.length) {
        state.failed++;
        state.lastError = (res && res.msg) || '没有拿到答案';
        state.lastDetail = (res && res.detail) || null;
        log('warn', 'AI 没给出可用答案（' + state.lastError + '，' +
          (state.lastMs / 1000).toFixed(1) + 's）');
        // 「发不出去」这类问题的关键信息全在 detail 里，别让它只留在后台；
        // 后台顺手抓的页面截图也一起挂出去，popup 那边好直接看到现场
        if (state.lastDetail) {
          log('debug', 'AI 阶段诊断：' + JSON.stringify(state.lastDetail));
        }
        if (res && res.shot && typeof NS.setAiShot === 'function') {
          NS.setAiShot(res.shot);
          log('info', '已抓下失败那一刻的页面截图，点控制台 AI 状态那一格看');
        }
        return null;
      }

      // 越界防御：AI 可能对着 5 个选项答出个 E，或者干脆答了个不存在的
      const n = payload.options.length;
      const answer = res.answer
        .map((i) => Number(i))
        .filter((i) => i >= 0 && i < n)
        .sort((a, b) => a - b);
      const uniq = answer.filter((v, i) => i === 0 || v !== answer[i - 1]);
      if (!uniq.length) {
        state.failed++;
        state.lastError = '答案下标越界';
        log('warn', 'AI 答案越界，已丢弃：' + JSON.stringify(res.answer));
        return null;
      }

      state.answered++;
      state.lastProvider = res.provider || '';
      const letters = uniq.map((i) => NS.webAI.letter(i)).join('');
      log('ok', 'AI 给出答案 [' + letters + ']（' + (res.provider || '?') +
        (res.cached ? ' · 缓存' : '') +
        '，' + (state.lastMs / 1000).toFixed(1) + 's' +
        (res.reason ? '，理由：' + String(res.reason).slice(0, 24) : '') + '）');

      return uniq;
    });

    state.inflight = {
      key: qk,
      abort: () => { try { sendMessage({ type: 'ZHS_AI_CANCEL' }); } catch (e) { /* noop */ } },
      promise,
    };

    try {
      const out = await promise;
      if (!state.cache) state.cache = new Map();
      // 会话缓存只留最近 30 题，别把整节课的题干都攒在内存里
      // （看图作答不写缓存 —— 理由同上，键不可信）
      if (useCache) {
        state.cache.set(qk, out);
        if (state.cache.size > 30) {
          const first = state.cache.keys().next().value;
          state.cache.delete(first);
        }
      }
      return out;
    } finally {
      if (state.inflight && state.inflight.promise === promise) state.inflight = null;
    }
  }

  /** 探测一次链路：让 background 报告标签页/权限状态，方便排障 */
  async function probe() {
    const res = await sendMessage({ type: 'ZHS_AI_PROBE' });
    return res || { ok: false, msg: 'background 无响应' };
  }

  /**
   * 排障专用：把一个问题真的发出去一次，并把每一步都拿回来。
   *
   * 和 ask() 的区别是它**不吃缓存、不写缓存**，而且要求后台把
   * 出站报文、AI 页面 DOM 探测、失败截图一起带回来 ——
   * 「发不出去」这种问题，缺的从来不是"失败"这两个字，而是现场。
   */
  async function diagnose(question) {
    const cfg = NS.config ? NS.config.get() : {};
    const res = await sendMessage({
      type: 'ZHS_AI_ASK',
      question: {
        stem: String(question.stem || '').slice(0, 500),
        options: (question.options || []).map((s) => String(s).slice(0, 200)),
        multi: !!question.multi,
        provider: cfg.webAIProvider || 'auto',
      },
      timeoutMs: Math.max(8000, Number(cfg.askWaitMs) || 45000),
      noCache: true,
      wantShot: true,
    });
    return res || { ok: false, msg: 'background 无响应' };
  }

  NS.aiBridge = {
    __ready: true,
    ask,
    probe,
    diagnose,
    stats: state,
    getStatus() {
      return {
        asked: state.asked,
        answered: state.answered,
        failed: state.failed,
        lastError: state.lastError,
        lastDetail: state.lastDetail,
        lastProvider: state.lastProvider,
        lastMs: state.lastMs,
        inflight: !!state.inflight,
        // 进行中的话，把"已经等了多久 / 最多等多久"也报上去
        waitedMs: state.inflight ? Date.now() - state.startedAt : 0,
        timeoutMs: state.inflight ? state.timeoutMs : 0,
        phase: state.inflight ? (state.phase || '等待') : '',
      };
    },
  };
})();
