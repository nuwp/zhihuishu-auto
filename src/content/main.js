/**
 * main.js — 总协调 / 状态机
 *
 * 状态流转：
 *   IDLE ──▶ PLAYING ──(检测到弹题)──▶ QUIZZING ──(答对)──▶ PLAYING
 *                │
 *                └──(视频播完)──▶ SWITCHING ──▶ PLAYING
 *                                     │
 *                                     └──(无下一集)──▶ DONE
 *
 * 每个 frame 各跑一份实例：video 在哪一层，那一层就自己管；
 * 只有真正持有 <video> 或弹题浮层的 frame 才会干活，其余静默待命。
 */
(function () {
  'use strict';

  // 扩展重载后，旧 content script 的 chrome.runtime 已经失效，
  // 但它的 setInterval / MutationObserver / message listener 还在跑。
  // 重新注入时必须先把旧实例顶掉，否则会出现两套定时器抢着点页面。
  try {
    if (window.__ZHS_APP__ && typeof window.__ZHS_APP__.destroy === 'function') {
      window.__ZHS_APP__.destroy();
    }
  } catch (e) { /* noop */ }

  const NS = window.__ZHS;
  if (!NS || !NS.VideoController) return;

  const { sleep, isVisible, textOf } = NS.dom;

  const STATE = {
    IDLE: 'idle',
    PLAYING: 'playing',
    QUIZZING: 'quizzing',
    SWITCHING: 'switching',
    DONE: 'done',
  };

  const IS_TOP = (() => {
    try { return window === window.top; } catch (e) { return false; }
  })();

  const TICK_MS = 1200;

  function send(msg, cb) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      if (cb) chrome.runtime.sendMessage(msg, cb);
      else chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
    } catch (e) { /* 扩展被重载 / 上下文失效 */ }
  }

  class App {
    constructor() {
      this.state = STATE.IDLE;
      this.video = new NS.VideoController();
      this.playlist = new NS.Playlist();
      this.quiz = new NS.QuizSolver();

      this.chaptersPlayed = 0;
      this.watchMs = 0;
      this._lastTick = 0;
      this._lastReport = 0;
      this._url = location.href;
      this._timer = null;
      this._switching = false;
      this._quizCooldownUntil = 0;
      this._logs = [];
      this._audioCtx = null;
      this._keepAliveArmed = false;
      this._keepAliveListener = null;
      this._destroyed = false;
      this._booting = false;
      this._booted = false;

      this.video.setLogger((lv, m) => this.log(lv, m));
      this.playlist.setLogger((lv, m) => this.log(lv, m));
      this.quiz.setLogger((lv, m) => this.log(lv, m));
      this.quiz.setVideo(this.video);
      // 「能力提升」那套（整页卷子）。它和视频课是并列的两个场景，
      // 靠 cfg.mode 二选一 —— 见 boot() 里的模式闸门。
      this.ability = new NS.AbilitySolver();
      this.ability.setLogger((lv, m) => this.log(lv, m));
    }

    /** 当前模式是不是"视频课"那一套 */
    get isVideoMode() {
      return (NS.config.get().mode || 'video') === 'video';
    }

    /** 当前模式是不是"能力提升"那一套 */
    get isAbilityMode() {
      return (NS.config.get().mode || 'video') === 'ability';
    }

    // ── 日志 ─────────────────────────────────────────────

    log(level, msg) {
      const entry = { t: Date.now(), level: level || 'info', msg: String(msg), frame: IS_TOP ? 'top' : 'frame' };
      this._logs.push(entry);
      if (this._logs.length > 200) this._logs.shift();

      const cfg = NS.config.get();
      if (level === 'debug' && !cfg.verboseLog) return;
      const tag = { info: '[知到助手]', ok: '[✓]', warn: '[!]', debug: '[·]' }[level] || '[知到助手]';
      try {
        // eslint-disable-next-line no-console
        console.log(tag + ' ' + msg);
      } catch (e) { /* noop */ }
      send({ type: 'ZHS_LOG', entry });
    }

    setState(s) {
      if (this.state === s) return;
      this.state = s;
      void this.report(true);
    }

    // ── 后台标签页保活 ───────────────────────────────────

    /**
     * Chrome 会冻结「后台且无声」的标签页，冻结后 JS 全部停跑。
     * 这里挂一个 40Hz、增益极低的振荡器，让标签页保持 audible 状态而不被冻结。
     * 40Hz 低于绝大多数扬声器/耳机的低频下限，实际听不到。
     *
     * 注意 AudioContext 受自动播放策略约束：页面还没经历过任何用户手势时，
     * osc.start() 会被浏览器拦下，而 Chrome 会把那条警告记进扩展的错误列表 ——
     * chrome://extensions 上会冒出一个红色「错误」，看着吓人但完全无害。
     * 所以这里先挂起等第一次真实交互，等不到就放弃：
     * 视频本身在播时标签页一般也不会被冻结，保活只是额外一层保险。
     */
    startKeepAlive() {
      if (this._destroyed) return;
      if (this._audioCtx || this._keepAliveArmed) return;
      const cfg = NS.config.get();
      if (!cfg.keepFocus) return;

      let hasGesture = false;
      try {
        hasGesture = !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
      } catch (e) {
        hasGesture = false;
      }
      if (!hasGesture) {
        this.armKeepAliveOnGesture();
        return;
      }

      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 40;
        gain.gain.value = 0.0015;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        ctx.resume().catch(() => {});
        this._audioCtx = ctx;
        this._osc = osc;
        this.log('debug', '音频保活已启动（防止后台标签页冻结）');
      } catch (e) { /* 没有手势 / 不支持，静默降级 */ }
    }

    /** 等页面出现第一次真实交互后再启动保活 */
    armKeepAliveOnGesture() {
      if (this._keepAliveArmed || this._destroyed) return;
      this._keepAliveArmed = true;
      const onGesture = () => {
        document.removeEventListener('pointerdown', onGesture, true);
        document.removeEventListener('keydown', onGesture, true);
        this._keepAliveArmed = false;
        this.startKeepAlive();
      };
      this._keepAliveListener = onGesture;
      try {
        document.addEventListener('pointerdown', onGesture, true);
        document.addEventListener('keydown', onGesture, true);
      } catch (e) { /* noop */ }
    }

    stopKeepAlive() {
      try {
        if (this._osc) this._osc.stop();
        if (this._audioCtx) this._audioCtx.close();
      } catch (e) { /* noop */ }
      this._audioCtx = null;
      this._osc = null;
    }

    // ── 启动 ─────────────────────────────────────────────

    async boot() {
      if (this._booting || this._booted) return;
      this._booting = true;

      await NS.config.load();
      await NS.bank.load();

      NS.config.onChange((cfg) => {
        this.video.applyParams(true);
        if (cfg.enabled) {
          this.startKeepAlive();
          this.video.enforce();
        } else {
          this.stopKeepAlive();
        }
      });

      this.video.start();
      this.playlist.scan();

      // CDP 点击失败时的降级通知。最常见的失败原因是 DevTools 占着调试会话 ——
      // chrome.debugger.attach 会抛 "Another debugger is already attached"。
      // 这时会退回合成事件，功能还能用，但点击带着 isTrusted=false，平台会识破。
      NS.onCdpFallback = (detail) => {
        this.log('warn', 'CDP 点击失败，已退回合成事件（会被平台识破）：' + (detail || '未知原因'));
      };

      this.timer = null;
      this._timer = setInterval(() => {
        this.tick().catch(() => {});
      }, TICK_MS);

      this.startKeepAlive();

      const cfg = NS.config.get();
      this.log('info',
        '知到自动助手已就绪' +
        (IS_TOP ? '' : '（子框架）') +
        // 构建标记：**每次排障第一眼要看的就是它**。
        // 之前几轮返工白跑，有很大一部分原因是"截图里的日志到底是哪个版本"说不清 ——
        // 旧版本和新版本的行为不一样，猜错方向就白改一轮。
        // 有了这行，截图一看就知道代码新不新。
        ' · 构建 ' + NS.BUILD +
        ' · 模式=' + (cfg.mode === 'ability' ? '能力提升' : '视频') +
        ' · 自动连播=' + (cfg.autoNext ? '开' : '关') +
        ' · 自动答题=' + (cfg.autoQuiz ? '开' : '关') +
        ' · 题库 ' + NS.bank.size() + ' 题');
      // 模式是单选，必须一眼可见 —— 两套共用同一个网页端 AI，
      // 分不清当前在哪一套的话，会以为"插件随机不干活"。
      this.log('info',
        cfg.mode === 'ability'
          ? '当前模式「能力提升」：答整页卷子 · 自动提交=' + (cfg.abilityAutoSubmit ? '开' : '关') +
            ' · 视频那边的弹题探测**已停用**（两套不能同时跑）'
          : '当前模式「视频」：答课中弹题 · 能力提升那边的整套答题**已停用**（两套不能同时跑）');
      // 解题链路的顺序必须一眼可见：默认是 网页 AI → 题库 → 枚举。
      // 「网页 AI 开着但浏览器里一个 AI 站都没登录」是最常见的一档，
      // 与其让人猜为什么每题都慢十几秒，不如启动时就把顺序摊开。
      this.log('info',
        '解题链路：' +
        (cfg.askWebAI
          ? '网页 AI' + (cfg.webAIFirst ? '✓' : '✗') + '(' + (cfg.webAIProvider || 'auto') + ') → '
          : '') +
        '题库' + (cfg.useBank ? '✓' : '✗') +
        ' → ' +
        (cfg.askWebAI && !cfg.webAIFirst ? '网页 AI✓ → ' : '') +
        '枚举' + (cfg.bruteForce ? '✓' : '✗') +
        (cfg.askWebAI ? '' : '（网页 AI 已关）'));
      // 反检测是硬要求，它的开关状态必须一眼可见 —— 关着的话所有点击都会
      // 带着 isTrusted=false 出去，平台那两处判定立刻命中
      this.log(cfg.highFidelityClick ? 'info' : 'warn',
        '高保真点击（CDP）=' + (cfg.highFidelityClick ? '开' : '关') +
        ' · 配置版本=v' + cfg.configVersion +
        (cfg.highFidelityClick ? '' : ' ⚠ 合成事件会被平台判定为异常脚本'));

      // 就绪标志放在最后：外部（popup / 测试）看到 _booted 为真时，
      // 配置、题库、监听器、定时器一定都已经就位。
      this._booting = false;
      this._booted = true;

      this.setState(STATE.PLAYING);
      this.video.enforce();
      void this.report(true);
    }

    // ── 主循环 ───────────────────────────────────────────

    async tick() {
      const cfg = NS.config.get();
      const now = Date.now();

      // SPA 地址变化（content script 在 isolated world 里 hook 不到页面的
      // history.pushState，所以走轮询比对，1.2s 的延迟可以接受）
      if (location.href !== this._url) {
        this.onLocationChange();
      }

      if (!cfg.enabled) return;

      // 观看时长统计
      const dt = this._lastTick ? now - this._lastTick : 0;
      this._lastTick = now;
      const v = this.video.video;
      if (v && v.isConnected && !v.paused && !v.ended && dt > 0 && dt < 8000) {
        this.watchMs += dt;
      }

      this.video.attach();

      // ① 弹题优先处理 —— **只在「视频」模式下**。
      //
      // 这是模式隔离的第一道闸门：能力提升那套是一整页卷子，页面上
      // 到处是"像弹题"的东西（题干 + 一组选项 + 提交按钮），
      // 视频那套的探测器会把它们当成浮层弹题，于是两边同时在跑、
      // 同时去抢同一个网页端 AI。模式是单选，所以这里直接不进来。
      // ⚠ 也要看总开关（cfg.enabled）—— 这一侧原来同样无视它。
      if (this.isVideoMode && cfg.enabled && cfg.autoQuiz && !this.quiz.solving
        && now >= this._quizCooldownUntil) {
        const q = this.safeDetect();
        if (q) {
          if (this.quiz.isRecentlyPassed(q)) {
            // 这题刚答对过，弹窗还没被平台收掉 —— 放行视频，等它自己关闭，
            // 不要重复提交（真机上反复提交是明显的异常行为）
            this.video.release('quiz');
          } else {
            await this.handleQuiz(q);
            return;
          }
        }
      }

      // ①' 「能力提升」模式：整页卷子自己跑一轮（它自己会守 running 标志）
      //
      // ⚠ 这里**必须也看总开关（cfg.enabled）**。
      // 用户报的「总开关失效」就是这个：能力提升这一侧原来只看 mode + abilityAuto，
      // 把控制台最上面那个总开关**完全无视**了 —— 关掉它，卷子照答不误。
      if (this.isAbilityMode && cfg.enabled && cfg.abilityAuto && !this.ability.running) {
        if (this.ability.looksLikeAbilityPage()) {
          this.ability.run().catch((e) => this.log('warn', '整套答题异常：' + (e && e.message)));
          return;
        }
      }

      // ② 视频播完 → 切下一集
      if (cfg.autoNext && this.video.finished && !this._switching) {
        await this.nextChapter();
        return;
      }

      // ③ 兜底：确保在播
      this.video.enforce();

      // ③' 目录会"长"：折叠着的章节展开之后，里面的小章节才被渲染进 DOM。
      // 只在页面加载/切章时扫一次的话，小章节永远进不了列表
      //（诊断报告里的「命中 42 → 可见 4」就是这个状态）。
      // 所以隔 4 秒重扫一次，条目数变了就报一声，日志里能直接看到。
      if (cfg.autoNext) {
        const grew = this.playlist.refresh(4000);
        if (grew > 0) {
          this.log('info', '目录更新：多出 ' + grew + ' 条（折叠的章节展开了）· 共 ' +
            this.playlist.items.length + ' 条');
        }
      }

      // 状态回报（节流 1s）
      if (now - this._lastReport > 1000) void this.report();
    }

    safeDetect() {
      try {
        return this.quiz.detect();
      } catch (e) {
        this.log('debug', '弹题探测异常：' + (e && e.message));
        return null;
      }
    }

    onLocationChange() {
      this._url = location.href;
      this.log('debug', '页面路由变化 → ' + this._url.slice(0, 90));
      NS.bank.clearTried();
      this.quiz.clearPassed();
      this._quizCooldownUntil = 0;
      this.video.reset();
      this.playlist.scan();
      const [done, total] = this.playlist.stats();
      if (total) this.log('info', '目录更新：已完成 ' + done + '/' + total + ' 节');
    }

    // ── 弹题 ─────────────────────────────────────────────

    async handleQuiz(q) {
      this.setState(STATE.QUIZZING);
      this.video.hold('quiz');
      try {
        const ok = await this.quiz.solve(q);
        if (ok) {
          await this.quiz.dismiss();
          this.video.release('quiz');
          await sleep(300);
          this.video.enforce();
          this.setState(STATE.PLAYING);
        } else {
          // 没解决：弹窗还在就继续压着视频；弹窗没了就放行，等它重新弹
          const alive = q.dialog && q.dialog.isConnected && isVisible(q.dialog);
          if (!alive) this.video.release('quiz');
          // 冷却时长跟着「应答等待」走。
          //
          // 这里踩过坑：原来是写死的 8 秒，而等待上限一调到 90 秒以后，
          // 两者的节奏就对不上了 —— 弹题还在重试（每轮最长 90s），
          // 冷却却每 8 秒就放行一次，于是弹窗/视频反复抢控制权，看着像卡死。
          // 现在至少 8 秒，最多不超过一轮等待的时间（别忘了取值 —— 这里
          // 曾经漏了 `NS.config.get()`，一走到这条路就抛 cfg is not defined）。
          const quizCfg = NS.config.get();
          const waitMs = Number(quizCfg.askWaitMs) || 90000;
          const cd = Math.max(8000, Math.min(30000, waitMs / 3));
          this._quizCooldownUntil = Date.now() + cd;
          this.setState(alive ? STATE.QUIZZING : STATE.PLAYING);
        }
      } catch (e) {
        // 把栈也带上：只报 message 的时候，"cfg is not defined" 这种
        // 一眼看不出是哪个函数的问题，排查要多绕一圈
        this.log('warn', '答题流程异常：' + (e && e.message) +
          (e && e.stack ? ' @ ' + String(e.stack).split('\n')[1].trim() : ''));
        this.video.release('quiz');
        this._quizCooldownUntil = Date.now() + 15000;
      }
      void this.report(true);
    }

    // ── 连播 ─────────────────────────────────────────────

    async nextChapter() {
      if (this._switching) return;
      this._switching = true;
      this.setState(STATE.SWITCHING);
      this.video.hold('switch');

      const cfg = NS.config.get();
      try {
        this.log('info', '本章结束，' + Math.round(cfg.nextDelayMs / 1000) + ' 秒后切换');
        await sleep(cfg.nextDelayMs);

        this.playlist.scan();
        const cur = this.playlist.current();
        let next = this.playlist.next(cur);

        if (!next) {
          // 有些版本不暴露目录，只有播放器的"下一集"按钮
          if (this.playlist.clickPlayerNext()) {
            this.log('info', '已点击播放器「下一集」');
            await this.waitChapterChange();
            this.afterSwitch();
            return;
          }
          this.log('ok', '目录已全部完成，本次任务结束 🎉');
          this.setState(STATE.DONE);
          return;
        }

        const label = textOf(next).replace(/\s+/g, ' ').slice(0, 40);
        await this.playlist.activate(next);

        let changed = await this.waitChapterChange();
        if (!changed) {
          // ⚠ 第一次点没反应时，**先用另一种点法再试同一条**，再考虑换条目。
          //
          // 为什么：CDP 拟真点击和合成事件"哪条能生效"取决于页面当时的状态 ——
          // 页面在后台、DevTools 占着调试会话、站点校验 isTrusted……
          // 而且两种失败的日志长得一模一样（都只是"没反应"），分不出来。
          // 那就别赌：CDP 点过就换合成事件，反之亦然。
          const cdpOn = !!cfg.highFidelityClick;
          const otherWay = cdpOn ? { forceSynthetic: true } : { forceCdp: true };
          this.log('debug', '点了没反应，换成' + (cdpOn ? '合成事件' : 'CDP 拟真点击') + '再试同一条');
          await this.playlist.activate(next, otherWay);
          changed = await this.waitChapterChange();
        }

        if (!changed) {
          // 两种点法都不行才判定"点空了"：换下一个再试一次
          this.log('warn', '章节未切换成功，尝试下一个');
          this.playlist.scan();
          const retry = this.playlist.next(next);
          if (retry) {
            await this.playlist.activate(retry);
            changed = await this.waitChapterChange();
          }
        }

        if (changed) {
          this.log('ok', '已切换 → ' + label);
          this.afterSwitch();
        } else {
          this.log('warn', '切换超时，保持当前状态继续重试');
        }
      } catch (e) {
        this.log('warn', '切换流程异常：' + (e && e.message));
      } finally {
        this.video.release('switch');
        this._switching = false;
      }
    }

    afterSwitch() {
      const cfg = NS.config.get();
      this.chaptersPlayed++;
      this.video.reset();
      NS.bank.clearTried();
      this.quiz.clearPassed();
      this._quizCooldownUntil = 0;
      this.setState(STATE.PLAYING);
      this.video.enforce();
      if (cfg.maxChapters > 0 && this.chaptersPlayed >= cfg.maxChapters) {
        this.log('warn', '已连续播放 ' + this.chaptersPlayed + ' 集，达到设定上限，停止');
        this.setState(STATE.DONE);
      }
      void this.report(true);
    }

    /** 等待视频真的换源/重新起播 */
    async waitChapterChange() {
      const old = this.video.video;
      const oldSrc = old ? (old.currentSrc || old.src || '') : '';
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        await sleep(400);
        this.video.attach();
        const v = this.video.video;
        if (!v) continue;
        const src = v.currentSrc || v.src || '';
        if (src && oldSrc && src !== oldSrc) return true;
        if (v.isConnected && !v.paused && !v.ended) return true;
        if (v.isConnected && v.currentTime > 0.5 && v.currentTime < 4 && !v.ended) return true;
        this.video.enforce();
      }
      return false;
    }

    // ── 状态上报 ─────────────────────────────────────────

    report(force) {
      const now = Date.now();
      if (!force && now - this._lastReport < 1000) return;
      this._lastReport = now;

      const v = this.video.video;
      let playlistStat = [0, 0];
      try { playlistStat = this.playlist.stats(); } catch (e) { /* noop */ }

      send({
        type: 'ZHS_STATUS',
        payload: {
          state: this.state,
          isTop: IS_TOP,
          url: location.href,
          title: document.title,
          ratio: v ? this.video.ratio(v) : 0,
          currentTime: v && isFinite(v.currentTime) ? v.currentTime : 0,
          duration: v && isFinite(v.duration) ? v.duration : 0,
          paused: v ? v.paused : true,
          rate: v ? v.playbackRate : 1,
          hasVideo: !!v,
          chaptersPlayed: this.chaptersPlayed,
          watchMs: this.watchMs,
          playlist: { done: playlistStat[0], total: playlistStat[1] },
          quiz: Object.assign({}, this.quiz.stats),
          webAI: NS.aiBridge ? NS.aiBridge.getStatus() : null,
          bankSize: NS.bank.size(),
          ts: now,
        },
      });
    }

    // ── 手动指令（来自 popup） ───────────────────────────

    async command(action) {
      switch (action) {
        case 'play': {
          this.video.hold('manual');
          await sleep(50);
          this.video.release('manual');
          await this.video.enforce();
          return { ok: true, msg: '已尝试恢复播放' };
        }
        case 'pause': {
          this.video.hold('manual');
          if (this.video.video) this.video.video.pause();
          return { ok: true, msg: '已暂停（自动恢复被挂起）' };
        }
        case 'next': {
          this.video.finished = true;
          await this.nextChapter();
          return { ok: true, msg: '已触发切集' };
        }
        case 'solve': {
          if (this.quiz.solving) return { ok: false, msg: '正在答题中，请稍候' };
          const q = this.safeDetect();
          if (!q) return { ok: false, msg: '当前没有检测到弹题' };
          NS.bank.clearTried();
          this._quizCooldownUntil = 0;
          await this.handleQuiz(q);
          return { ok: true, msg: '已重新答题' };
        }
        case 'rescan': {
          NS.bank.clearTried();
          this.playlist.items = [];
          this.playlist.scan();
          const [d, t] = this.playlist.stats();
          return { ok: true, msg: '目录已重扫：' + d + '/' + t };
        }
        case 'dumpPlaylist': {
          // 排障用：目录是怎么被读出来的。"小章节读不到"这类问题全靠它分辨
          // 是"没匹配到"还是"匹配到又被当成容器丢了"。
          const info = this.playlist.debugScan();
          return {
            ok: true,
            msg: '目录读到 ' + info.当前条目数 + ' 条 · 进度 ' + info.进度,
            detail: info,
          };
        }
        case 'probe': {
          const q = this.safeDetect();
          const ai = NS.aiBridge ? await NS.aiBridge.probe() : null;
          return {
            ok: true,
            msg: q
              ? '发现弹题：' + q.stem.slice(0, 40) + ' / ' + q.options.length + ' 选项 / ' + (q.multi ? '多选' : '单选')
              : '当前没有弹题浮层',
            detail: {
              quiz: q ? { stem: q.stem, options: q.options.map(textOf), multi: q.multi } : null,
              webAI: ai,
              stats: this.quiz.stats,
            },
          };
        }
        case 'dumpQuiz': {
          // 排障用：把当前探测到的题干原文（不截断）和它的来源 DOM 结构摊出来。
          // 「题干认错了」这种问题，光看日志里截断的 40 个字判断不了 ——
          // 需要看到完整原文 + 它落在哪个 class 上。
          const q = this.safeDetect();
          if (!q) return { ok: false, msg: '当前没有检测到弹题' };
          const stem = q.stem;
          const dlg = q.dialog;
          const cls = (el) => {
            const c = el && el.className;
            return typeof c === 'string' ? c.split(/\s+/).slice(0, 3).join('.') : '';
          };
          // 题干是从哪个元素里抠出来的？往回找第一层"文本等于题干"的节点
          let owner = null;
          try {
            const all = dlg.querySelectorAll('*');
            for (const el of all) {
              if (textOf(el) === stem) { owner = el; break; }
            }
          } catch (e) { owner = null; }
          return {
            ok: true,
            msg: '题干 ' + stem.length + ' 字 · ' + q.options.length + ' 选项',
            detail: {
              stem,
              options: q.options.map(textOf),
              multi: q.multi,
              dialogClass: cls(dlg),
              dialogTag: dlg.tagName,
              ownerTag: owner ? owner.tagName : null,
              ownerClass: owner ? cls(owner) : null,
              ownerParentClass: owner && owner.parentElement ? cls(owner.parentElement) : null,
              belongsToPlaylist: typeof NS.quizUtils.belongsToPlaylist === 'function'
                ? NS.quizUtils.belongsToPlaylist(dlg) : null,
            },
          };
        }
        case 'askAI': {
          // 排障用：不碰弹题，单纯把当前这道题问一次 AI，把回包原样摊出来
          if (!NS.aiBridge) return { ok: false, msg: 'AI 通道未加载（刷新页面或重载扩展）' };
          const cur = this.safeDetect();
          if (!cur) return { ok: false, msg: '当前没有检测到弹题' };
          const answer = await NS.aiBridge.ask({
            stem: cur.stem,
            options: cur.options.map(textOf),
            multi: cur.multi,
          });
          return {
            ok: !!answer,
            msg: answer
              ? 'AI 给出 [' + answer.map((i) => NS.webAI.letter(i)).join('') + ']'
              : 'AI 没有给出可用答案（看日志里的具体原因）',
            detail: {
              stem: cur.stem,
              options: cur.options.map(textOf),
              answer,
              status: NS.aiBridge.getStatus(),
            },
          };
        }
        case 'aiSendTest': {
          // 排障用：不碰弹题，直接让 AI 把那道题发出去一次，把每一步都摊出来。
          // 「发不出去」这条链路里最缺的就是"现场长什么样" —— 这个指令
          // 会带回：出站报文、AI 页面的 DOM 结构探测、失败那一刻的截图。
          if (!NS.aiBridge) return { ok: false, msg: 'AI 通道未加载（刷新页面或重载扩展）' };
          const q = this.safeDetect();
          const probe = {
            stem: q ? q.stem : '这是一个连通性自检：请只回一行「答案：A」。',
            options: q ? q.options.map(textOf) : ['甲', '乙'],
            multi: q ? q.multi : false,
          };
          const r = await NS.aiBridge.diagnose(q ? {
            stem: q.stem,
            options: q.options.map(textOf),
            multi: q.multi,
          } : probe);
          return {
            ok: !!(r && r.ok),
            msg: (r && r.ok)
              ? 'AI 页面那边收到了并作答：' + (r.letters || '')
              : '没发出去 —— 看下面的 detail（含页面 DOM 探测与截图）',
            detail: r,
          };
        }
        case 'snapshot': {
          return { ok: true, msg: '快照已获取', detail: this.snapshot() };
        }
        default:
          return { ok: false, msg: '未知指令 ' + action };
      }
    }

    snapshot() {
      const v = this.video.video;
      return {
        state: this.state,
        url: location.href,
        hasVideo: !!v,
        videoHtml: v ? v.outerHTML.slice(0, 400) : null,
        playlistCount: this.playlist.items.length,
        playlistSample: this.playlist.items.slice(0, 3).map((el) => ({
          cls: typeof el.className === 'string' ? el.className : '',
          text: textOf(el).replace(/\s+/g, ' ').slice(0, 60),
        })),
        logs: this._logs.slice(-40),
      };
    }

    // ── 消息监听 ─────────────────────────────────────────

    installMessageListener(buildQuery) {
      this._onMessage = (msg, sender, reply) => {
        if (!msg || typeof msg.type !== 'string') return undefined;
        if (msg.type === 'ZHS_QUERY') {
          reply({ ok: true, payload: buildQuery(this) });
          return true;
        }
        if (msg.type === 'ZHS_ACTION') {
          this.command(msg.action)
            .then((r) => reply(r))
            .catch((e) => reply({ ok: false, msg: String(e && e.message) }));
          return true;
        }
        return undefined;
      };
      try {
        chrome.runtime.onMessage.addListener(this._onMessage);
      } catch (e) { /* noop */ }
    }

    removeMessageListener() {
      try {
        if (this._onMessage) {
          chrome.runtime.onMessage.removeListener(this._onMessage);
        }
      } catch (e) { /* noop */ }
      this._onMessage = null;
    }

    // ── 销毁（被新实例接管时调用） ───────────────────────

    destroy() {
      this._destroyed = true;
      try { if (this._timer) clearInterval(this._timer); } catch (e) { /* noop */ }
      this._timer = null;
      this.removeMessageListener();
      if (this._keepAliveListener) {
        try {
          document.removeEventListener('pointerdown', this._keepAliveListener, true);
          document.removeEventListener('keydown', this._keepAliveListener, true);
        } catch (e) { /* noop */ }
        this._keepAliveListener = null;
      }
      this._keepAliveArmed = false;
      this.stopKeepAlive();
      try { this.video.stop(); } catch (e) { /* noop */ }
      this._booted = false;
      this._booting = false;
    }
  }

  const app = new App();
  NS.app = app;
  window.__ZHS_APP__ = app;

  // ── 与 background / popup 通信 ──────────────────────────
  app.installMessageListener(buildQueryPayload);

  function buildQueryPayload(a) {
    const v = a.video.video;
    let playlistStat = [0, 0];
    try { playlistStat = a.playlist.stats(); } catch (e) { /* noop */ }

    return {
      ready: true,
      isTop: IS_TOP,
      state: a.state,
      url: location.href,
      title: document.title,
      hasVideo: !!v,
      ratio: v ? a.video.ratio(v) : 0,
      paused: v ? v.paused : true,
      duration: v && isFinite(v.duration) ? v.duration : 0,
      currentTime: v && isFinite(v.currentTime) ? v.currentTime : 0,
      chaptersPlayed: a.chaptersPlayed,
      watchMs: a.watchMs,
      playlist: { done: playlistStat[0], total: playlistStat[1] },
      quiz: Object.assign({}, a.quiz.stats),
      webAI: NS.aiBridge ? NS.aiBridge.getStatus() : null,
      // 失败现场的截图 —— 只有失败后那一两轮会带，取走即清，别反复往 popup 里塞
      shot: takeShot(),
      bankSize: NS.bank.size(),
      logs: a._logs.slice(-60),
    };
  }

  let pendingShot = null;
  function takeShot() {
    const s = pendingShot;
    pendingShot = null;
    return s;
  }
  NS.setAiShot = (s) => { pendingShot = s || null; };

  // ── 引导 ────────────────────────────────────────────────
  const start = () => {
    app.boot().catch((e) => {
      try { console.warn('[知到助手] 启动失败', e); } catch (e2) { /* noop */ }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // 顶层框架额外扛一个标签页保活设置
  if (IS_TOP) {
    send({ type: 'ZHS_HELLO' });
  }
})();
