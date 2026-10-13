/**
 * video.js — 播放器接管
 *
 * 职责：
 *   1. 定位并绑定 <video>（SPA 换集时元素会被替换，需要重绑）
 *   2. 播放参数下发（静音 / 倍速）
 *   3. 进度监控 + 播完判定
 *   4. 「暂停保持」锁：弹题期间平台会暂停视频，此时禁止自动恢复
 *
 * 设计要点：以事件驱动为主（ended / timeupdate / pause），定时器只做兜底心跳。
 * 后台标签页的 setInterval 会被 Chrome 节流到 ~1 次/分钟，
 * 但媒体播放中的 timeupdate 不受节流影响，所以心跳丢了也不影响主流程。
 */
(function () {
  'use strict';

  const NS = (window.__ZHS = window.__ZHS || {});
  const { sleep, isVisible, textOf } = NS.dom;

  const FINISH_TAIL = 1.5;   // 距片尾 1.5s 内视为播完
  const HEARTBEAT_MS = 2000;

  /**
   * 倍速硬上限 —— 这条红线由平台划的，不是我们定的。
   *
   * 学习页的播放进度回调里有这么一段：
   *   document.querySelector('#container video').playbackRate > 1.8
   *     && (pause(), alert('检测到异常脚本…'),
   *         setTimeout(() => location.replace('https://www.zhihuishu.com'), 3000))
   *
   * 也就是超过 1.8 会被直接判定异常并踢回首页。所以这里无条件兜住，
   * 不接受任何来自配置或外部的越界值。
   */
  const MAX_SAFE_RATE = 1.8;
  const MIN_SAFE_RATE = 0.5;

  class VideoController {
    constructor() {
      this.video = null;
      this.holds = new Set();
      this.finished = false;
      this.lastEmitRatio = -1;
      this.boundSet = new WeakSet();
      this.handlers = { progress: [], finished: [], attached: [] };
      this._hb = null;
      this._lastEl = null;
      this._lastRate = null;
      this._lastMute = null;
      this._emitThrottle = 0;
      this.started = false;
      this._moPending = false;
      this._mo = null;
      this._logger = null;
    }

    /** 注入日志出口，main.js 启动时设置 */
    setLogger(fn) {
      this._logger = fn;
    }

    log(level, msg) {
      if (this._logger) this._logger(level, msg);
    }

    on(evt, fn) {
      if (!this.handlers[evt]) this.handlers[evt] = [];
      this.handlers[evt].push(fn);
      return () => {
        this.handlers[evt] = this.handlers[evt].filter((f) => f !== fn);
      };
    }

    emit(evt, payload) {
      (this.handlers[evt] || []).forEach((fn) => {
        try { fn(payload); } catch (e) { /* noop */ }
      });
    }

    // ── 元素定位 ──────────────────────────────────────────────

    /**
     * 选出当前"该被控制"的 video：
     * 优先正在播放/未播完/面积最大的那个。
     */
    findVideo() {
      const all = Array.from(document.querySelectorAll('video')).filter(
        (v) => v.isConnected && v.readyState > 0
      );
      if (!all.length) {
        const raw = Array.from(document.querySelectorAll('video'));
        return raw.length ? raw[0] : null;
      }
      if (all.length === 1) return all[0];

      const scored = all.map((v) => {
        let s = 0;
        if (!v.paused && !v.ended) s += 1000;
        if (!v.ended) s += 200;
        const d = isFinite(v.duration) ? v.duration : 0;
        s += Math.min(d, 6000) / 10;
        const r = v.getBoundingClientRect();
        s += Math.min((r.width * r.height) / 1000, 400);
        if (isVisible(v)) s += 100;
        return { v, s };
      });
      scored.sort((a, b) => b.s - a.s);
      return scored[0].v;
    }

    attach() {
      const v = this.findVideo();
      if (!v) return null;

      if (v !== this._lastEl) {
        this._lastEl = v;
        this.video = v;
        this.finished = false;
        this.lastEmitRatio = -1;
        this.log('info', '已接管播放器 video，时长 ' + fmtTime(v.duration));
        this.emit('attached', v);
      } else {
        this.video = v;
      }

      if (!this.boundSet.has(v)) {
        this.boundSet.add(v);
        this.bind(v);
      }
      this.applyParams(true);
      return v;
    }

    bind(v) {
      const onEnded = () => {
        if (v !== this._lastEl) return;
        this.finished = true;
        this.log('ok', '本章视频播放结束');
        this.emit('finished', { video: v, reason: 'ended' });
      };

      const onTime = () => {
        if (v !== this._lastEl) return;
        this.tick(v);
      };

      const onPause = () => {
        if (v !== this._lastEl) return;
        // 平台/弹题触发的暂停：留一个微任务窗口再判断，避免和 ended 抢跑
        setTimeout(() => {
          if (v !== this._lastEl) return;
          this.enforce();
        }, 400);
      };

      const onError = () => {
        if (v !== this._lastEl) return;
        this.log('warn', 'video error: ' + (v.error && v.error.code));
      };

      v.addEventListener('ended', onEnded);
      v.addEventListener('timeupdate', onTime);
      v.addEventListener('pause', onPause);
      v.addEventListener('error', onError);
      v.addEventListener('loadedmetadata', () => this.applyParams(true));
      v.addEventListener('play', () => { if (v === this._lastEl) this.finished = false; });
    }

    // ── 播放参数 ─────────────────────────────────────────────

    applyParams(force) {
      const cfg = NS.config.get();
      const v = this.video;
      if (!v) return;

      const wantMute = !!cfg.mute;
      if (force || this._lastMute !== wantMute) {
        this._lastMute = wantMute;
        v.muted = wantMute;
        if (wantMute) v.volume = 0;
      }

      const wantRate = clamp(Number(cfg.playbackRate) || 1, MIN_SAFE_RATE, MAX_SAFE_RATE);
      if (force || this._lastRate !== wantRate) {
        this._lastRate = wantRate;
        try {
          v.playbackRate = wantRate;
          if (v.defaultPlaybackRate !== undefined) v.defaultPlaybackRate = wantRate;
        } catch (e) { /* noop */ }
      }

      // 兜底守卫：外部（用户控制台、其它脚本、播放器自身）把速率推过红线时压回来。
      // play() 之前的窗口期拦不住，但心跳和每次 timeupdate 都会修正。
      if (v.playbackRate > MAX_SAFE_RATE) {
        try {
          v.playbackRate = MAX_SAFE_RATE;
          this._lastRate = MAX_SAFE_RATE;
        } catch (e) { /* noop */ }
      }
    }

    // ── 播放保持锁 ───────────────────────────────────────────

    hold(reason) {
      this.holds.add(reason);
    }

    release(reason) {
      this.holds.delete(reason);
      this.enforce();
    }

    isHeld() {
      return this.holds.size > 0;
    }

    /** 无人持锁时，把被暂停的播放拉回来 */
    async enforce() {
      const cfg = NS.config.get();
      if (!cfg.enabled || !cfg.autoPlay) return;
      if (this.isHeld()) return;

      const v = this.video || this.attach();
      if (!v || !v.isConnected) return;
      if (v.ended) return;
      if (!v.paused) return;
      if (v.readyState < 1) return;

      try {
        this.applyParams(false);
        const p = v.play();
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            // 自动播放被拦：补一次静音兜底
            if (err && /NotAllowed/i.test(err.name || err.message || '')) {
              v.muted = true;
              v.volume = 0;
              v.play().catch(() => {});
            }
          });
        }
      } catch (e) { /* noop */ }
    }

    // ── 进度 ─────────────────────────────────────────────────

    ratio(v) {
      const el = v || this.video;
      if (!el || !isFinite(el.duration) || el.duration < 1) return 0;
      return Math.min(el.currentTime / el.duration, 1);
    }

    isFinished(v) {
      const el = v || this.video;
      if (!el) return false;
      if (el.ended) return true;
      if (!isFinite(el.duration) || el.duration < 1) return false;
      // 片尾容差按比例收缩：1 小时的课给 1.5s，6 秒的测试片段只给 0.12s
      const tail = Math.min(FINISH_TAIL, el.duration * 0.02);
      return el.currentTime >= el.duration - tail;
    }

    tick(v) {
      const el = v || this.video;
      if (!el) return;
      const r = this.ratio(el);

      // 每 1% 或 2 秒刷一次状态
      const now = Date.now();
      if (r - this.lastEmitRatio > 0.01 || now - this._emitThrottle > 2000) {
        this.lastEmitRatio = r;
        this._emitThrottle = now;
        this.emit('progress', {
          ratio: r,
          currentTime: el.currentTime,
          duration: isFinite(el.duration) ? el.duration : 0,
          paused: el.paused,
          rate: el.playbackRate,
        });
      }

      if (!this.finished && this.isFinished(el)) {
        this.finished = true;
        this.log('ok', '进度已达片尾（' + Math.round(r * 100) + '%），判定本章完成');
        this.emit('finished', { video: el, reason: 'tail' });
      }
    }

    start() {
      if (this.started) return;
      this.started = true;

      this.attach();
      this._hb = setInterval(() => {
        try {
          this.attach();
          this.applyParams(false);
          this.enforce();
          if (this.video) this.tick(this.video);
        } catch (e) { /* noop */ }
      }, HEARTBEAT_MS);

      // SPA 切集后 video 元素整体替换，MutationObserver 立刻重绑
      try {
        this._mo = new MutationObserver(() => {
          if (this._moPending) return;
          this._moPending = true;
          setTimeout(() => {
            this._moPending = false;
            this.attach();
          }, 300);
        });
        this._mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) { /* noop */ }
    }

    stop() {
      if (this._hb) clearInterval(this._hb);
      this._hb = null;
      if (this._mo) this._mo.disconnect();
      this._mo = null;
      this.started = false;
    }

    /** 重置完成标记（换集时调用） */
    reset() {
      this.finished = false;
      this.lastEmitRatio = -1;
      this.attach();
    }
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec <= 0) return '--:--';
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s);
  }

  NS.VideoController = VideoController;
  NS.fmtTime = fmtTime;
})();
