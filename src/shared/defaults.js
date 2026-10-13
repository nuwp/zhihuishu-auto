/**
 * defaults.js — 配置默认值（content script 与 popup 共用）
 *
 * content script 里挂到 window.__ZHS.DEFAULTS
 * 普通页面（popup）里挂到 window.ZHS_DEFAULTS
 * 两边同源，避免默认值漂移。
 */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    // 配置结构版本。每次默认值语义发生不兼容变化时 +1，
    // 由 config.js 的 migrate() 处理老配置的升级。
    configVersion: 2,

    // 总开关
    enabled: true,

    // ── 播放控制 ──
    autoPlay: true,          // 被误暂停时自动恢复播放
    mute: true,              // 静音播放
    playbackRate: 1.0,       // 倍速，上限见下方 MAX_PLAYBACK_RATE
    keepFocus: true,         // 音频保活，防止后台标签页被 Chrome 冻结

    // ── 自动连播 ──
    autoNext: true,          // 播完自动点下一集
    nextDelayMs: 3000,       // 播完停顿
    maxChapters: 0,          // 本次最多连播几集，0 = 不限

    // ── 模式 ────────────────────────────────────────────────
    //
    // 知到有两套完全不同的答题场景，页面结构和操作方式都不一样：
    //   video   —— 视频课：看着看着弹一道题（浮层），答完关掉继续播
    //   ability —— 能力提升：一整套卷子（整页），一题一题翻、最后统一提交
    //
    // **两者必须互斥**：它们共用同一个网页端 AI 标签页，同时问会互相踩
    // （一处刚把题目打进去，另一处把输入框清了）。所以模式是个单选开关，
    // 不是两个独立开关 —— 从配置层面就把"同时开"这件事堵死。
    mode: 'video',           // video | ability

    // ── 自动答题 ──
    autoQuiz: true,
    useBank: true,           // 优先查题库
    // 组合枚举：**默认关闭**。
    //
    // 关掉的理由不是"它不好用"，而是**它依赖的那个前提已经没了**：
    // 智能体的网页版对同一道题只会认真答一次，后面再问要么不答、要么回
    // "这个问题我已经回答过了"。而枚举的本质就是把同一道题反复提交 ——
    // 在"AI 答错一次"和"平台判错回退重播"之间来回打转，既费时间又容易
    // 把视频反复拖回去。
    // 代码留着（`bruteForce` 打开就恢复），但默认路线是
    // **网页 AI → 题库**，两级都不中就交给你手动答，而不是空转。
    bruteForce: false,
    maxComboTries: 0,        // 单题最多尝试组合数，0 = 不限
    maxComboSize: 3,         // 多选枚举的最大组合长度
    maxAskAttempts: 2,       // 同一道题最多问 AI 几次（每次都会换个说法，见 web-ai）

    // ── 能力提升（整页卷子）──
    abilityAuto: true,       // 进到这类页面就自动整套答
    abilityAutoSubmit: true, // 答完自动点「提交」
    abilityMaxQuestions: 30, // 一次最多答几题（防止页面异常时无限翻页）
    abilityStepMs: 1400,     // 翻到下一题之后等页面稳定的时间
    pickDelayMs: 600,        // 勾选与提交之间的间隔
    resultWaitMs: 3500,      // 提交后等待判定的最长时间
    retryOnWrong: true,      // 答错后清空重选
    learnAnswers: true,      // 判定通过后写回题库
    autoClosePassed: true,   // 答对后自动关掉弹窗

    // ── 网页版 AI 抢答 ──
    //
    // 解题顺序默认是「网页 AI → 题库 → 组合枚举」：
    //   AI 优先 —— 不依赖"这题以前做过"，第一遍出来的课也能一次答对；
    //              代价是每题要多等十几秒（答案得现问）。
    //   题库优先 —— 已做过的题零成本秒过，代价是没见过的题要多等一次枚举。
    // 两种顺序都能用 webAIFirst 切换，AI 失败都只是落到下一级，不会结束解题。
    //
    // 另外说清楚一件事：AI 优先**不等于**"每次都问"。
    // 后台那边有应答缓存，同一道题第二次弹出来是直接命中缓存的，
    // 不会真的再去骚扰一次 AI 站点。
    //
    // 前提：需要一个已登录的 AI 网页版（豆包 / DeepSeek / Kimi / 通义 / 元宝）。
    // 扩展会复用你已经打开的标签页，没有就悄悄新开一个（active:false，不抢焦点）。
    askWebAI: true,               // 用网页版 AI 答题（关掉就回到「题库 → 枚举」）
    webAIFirst: true,             // AI 排在题库前面（关掉 = 题库优先，已做过的题秒过）
    webAIProvider: 'auto',        // auto / gemini / deepseek / doubao / kimi / tongyi / yuanbao

    // 等 AI 回包的上限。
    //
    // 90 秒是有意给宽的：免费的 DeepSeek 在想复杂一点的题时经常要 40~70 秒，
    // 而"等得久"和"等不到"是两种完全不同的代价 ——
    // 等得久只是慢，等不到就要落回组合枚举（多选最坏二十几次提交，
    // 平台还会把视频回退重播）。所以这里宁可等。
    //
    // 超时本身不会把流程卡死：到点就返回、落回下一级，提交阶段还有独立的
    // 12 秒上限兜着（见 src/ai/web-ai.js 的 sendDeadline）。
    askWaitMs: 90000,
    askNewTab: true,              // 没打开就新开一个 AI 标签页
    askStableMs: 1400,            // 回包文本静止多久算写完（流式输出的结束判据）
    askCache: true,               // 同一道题第二次弹出来直接用上一次的答案

    // ── 高级 ──
    // 用 chrome.debugger 走 CDP 派发点击，事件在浏览器层面就是真的（isTrusted = true）。
    // 这是唯一能绕开平台 isTrusted 检测的方式：Chrome 把 isTrusted 定义在每个事件
    // 实例自己身上且 configurable:false，JS 侧既改不了原型也改不了实例。
    // 代价是顶部会常驻一条「正在调试此浏览器」提示条，且期间打不开 DevTools。
    highFidelityClick: true,
    verboseLog: false,

    // ── 选择器覆盖（留空 = 自动探测） ──
    selDialog: '',
    selOption: '',
    selSubmit: '',
    selPlaylistItem: '',
    selNextButton: '',
  });

  /**
   * 倍速硬上限。
   *
   * 这不是经验值，是平台写死的判定线 —— 学习页的播放进度回调里有：
   *   video.playbackRate > 1.8 && (暂停 + 弹「检测到异常脚本」+ 3 秒后踢回首页)
   *
   * 所以 popup 滑块、配置归一化、实际下发三处都必须收在这个值以内，
   * 任何一处漏掉都会被判定异常。
   */
  const MAX_PLAYBACK_RATE = 1.8;
  const CONFIG_VERSION = 2;

  /** 网页 AI 站点白名单（与 src/shared/web-ai.js 的 PROVIDERS 对应） */
  const AI_PROVIDERS = ['auto', 'gemini', 'deepseek', 'doubao', 'kimi', 'tongyi', 'yuanbao'];

  /**
   * 两种答题场景。**必须互斥** —— 它们共用同一个网页端 AI 标签页，
   * 同时问会互相踩（一处刚把题目打进去，另一处把输入框清了）。
   */
  const MODES = ['video', 'ability'];
  const MODE_LABEL = { video: '视频', ability: '能力提升' };

  /**
   * 收紧越界值。
   * 历史配置、手改 storage、旧版本残留都可能带着超过平台红线的倍速，
   * 在读取路径上统一压回来，避免它流到 video.playbackRate 上。
   */
  function sanitizeConfig(cfg) {
    const r = Number(cfg.playbackRate);
    if (!isFinite(r) || r <= 0) cfg.playbackRate = DEFAULTS.playbackRate;
    else if (r > MAX_PLAYBACK_RATE) cfg.playbackRate = MAX_PLAYBACK_RATE;
    else if (r < 0.5) cfg.playbackRate = 0.5;

    // 站点 id 写错了就直接回落到自动：宁可让 background 自己挑，
    // 也别拿着一个不存在的 id 去开标签页
    if (AI_PROVIDERS.indexOf(String(cfg.webAIProvider)) < 0) {
      cfg.webAIProvider = DEFAULTS.webAIProvider;
    }

    // 模式写错了就回落到视频 —— 那是最常用的那一个
    if (MODES.indexOf(String(cfg.mode)) < 0) cfg.mode = DEFAULTS.mode;

    const n = Number(cfg.abilityMaxQuestions);
    if (!isFinite(n) || n < 1) cfg.abilityMaxQuestions = DEFAULTS.abilityMaxQuestions;
    else if (n > 200) cfg.abilityMaxQuestions = 200;

    const stMs = Number(cfg.abilityStepMs);
    if (!isFinite(stMs) || stMs < 300) cfg.abilityStepMs = DEFAULTS.abilityStepMs;
    else if (stMs > 8000) cfg.abilityStepMs = 8000;

    const w = Number(cfg.askWaitMs);
    if (!isFinite(w) || w <= 0) cfg.askWaitMs = DEFAULTS.askWaitMs;
    else if (w < 8000) cfg.askWaitMs = 8000;
    else if (w > 300000) cfg.askWaitMs = 300000;

    const st = Number(cfg.askStableMs);
    if (!isFinite(st) || st <= 0) cfg.askStableMs = DEFAULTS.askStableMs;
    else if (st < 600) cfg.askStableMs = 600;
    else if (st > 5000) cfg.askStableMs = 5000;

    return cfg;
  }

  /**
   * 老配置迁移。
   *
   * 关键的一条：v1 里 highFidelityClick 默认 false，用户本地存的那份自然也是 false。
   * 但 v2 把反检测方案换成了 CDP 点击 —— 这个字段从「可选增强」变成了「必需项」，
   * 关掉它意味着每一次点击都带着 isTrusted=false 出去，平台立刻识破。
   *
   * 而 `Object.assign(DEFAULTS, 用户配置)` 里用户配置写在后面，会把新默认值盖掉，
   * 所以光改 DEFAULTS 不起作用 —— 必须显式迁移一次。迁移过后用户可自由开关。
   *
   * @param {object} cfg         已合并默认值的配置
   * @param {number} rawVersion  从**原始存储**里读到的版本号
   *                             （不能用 cfg.configVersion —— 合并后它已经被
   *                              DEFAULTS 的当前版本号顶掉了，迁移会永远不触发）
   */
  function migrateConfig(cfg, rawVersion) {
    const v = Number(rawVersion) || Number(cfg.configVersion) || 1;
    if (v < CONFIG_VERSION) {
      cfg.highFidelityClick = true;
      cfg.configVersion = CONFIG_VERSION;
    }
    return cfg;
  }

  /** 读取路径的统一入口：合并默认值 → 收紧 → 迁移 */
  function normalizeConfig(raw) {
    const src = raw || {};
    const rawVersion = Number(src.configVersion) || 1;
    return migrateConfig(sanitizeConfig(Object.assign({}, DEFAULTS, src)), rawVersion);
  }

  // defaults.js 排在所有模块之前加载，此刻 window.__ZHS 还不存在。
  // 由它先把命名空间占上，后面的 dom.js / config.js 才能直接往里挂东西。
  if (!root.__ZHS) root.__ZHS = {};

  /**
   * 构建标记 —— 每个日志截图的第一眼就是这个。
   *
   * 为什么值得单独做一个常量：这轮排障里反复出现"截图里的日志到底是哪个版本"
   * 说不清的情况（旧版本和新版本行为不一样，猜错方向就白改一轮）。
   * 有了它，一眼就能看出浏览器里跑的是不是刚改的那份代码。
   *
   * ⚠ 改完代码记得把 BUILD_ID 往后挪一位。
   */
  const BUILD_ID = 'b85';
  root.__ZHS.BUILD = BUILD_ID + ' (' + DEFAULTS.configVersion + ')';
  root.ZHS_BUILD = root.__ZHS.BUILD;
  root.__ZHS.DEFAULTS = DEFAULTS;
  root.__ZHS.MAX_PLAYBACK_RATE = MAX_PLAYBACK_RATE;
  root.__ZHS.CONFIG_VERSION = CONFIG_VERSION;
  root.__ZHS.AI_PROVIDERS = AI_PROVIDERS;
  root.__ZHS.sanitizeConfig = sanitizeConfig;
  root.__ZHS.migrateConfig = migrateConfig;
  root.__ZHS.normalizeConfig = normalizeConfig;

  // 普通页面（popup）侧的等价出口
  root.ZHS_DEFAULTS = DEFAULTS;
  root.ZHS_MAX_PLAYBACK_RATE = MAX_PLAYBACK_RATE;
  root.ZHS_CONFIG_VERSION = CONFIG_VERSION;
  root.ZHS_AI_PROVIDERS = AI_PROVIDERS;
  root.ZHS_MODES = MODES;
  root.ZHS_MODE_LABEL = MODE_LABEL;
  root.ZHS_sanitizeConfig = sanitizeConfig;
  root.ZHS_migrateConfig = migrateConfig;
  root.ZHS_normalizeConfig = normalizeConfig;
})(typeof window !== 'undefined' ? window : self);
