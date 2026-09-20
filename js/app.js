/* 主程序:状态管理、周期切换、模块装配、界面联动 */
(function () {
  'use strict';
  const $ = Utils.$;

  const DEFAULT_SETTINGS = {
    initialCapital: 200000, // 初始资金(元)
    multiplier: 10,         // 合约乘数
    marginRatePct: 13,      // 保证金率(%)
    feePerLot: 4,           // 每手手续费(元)
    autoLiquidate: true,    // 风险度100%自动强平
    redUp: true             // 红涨绿跌
  };

  const PERIODS = [1, 5, 30];

  const state = {
    baseBars: [],        // 1分钟基准K线(全部历史)
    bars: [],            // 当前生效K线(单图=当前周期,联动=焦点周期)
    period: 5,           // 单图模式当前周期(分钟)
    mode: 'single',      // 'single' 单图 | 'linked' 多窗联动
    focus: 5,            // 联动模式焦点周期(决定步进粒度与进度条)
    symbol: '演示合约',
    code: 'RB9999',
    marketSim: null,    // 有状态行情生成器(随机会话;null=导入数据,不可无限延伸)
    sessionPresetIdx: null, // 当前行情数据的品种预设索引(null=导入/自定义数据)
    startTime: 0,        // 回放起点时间锚(跨周期保持同一时刻)
    lastTime: null,      // 当前回放揭示时刻(全局唯一,焦点/周期/模式切换均保持)
    pendingAnchor: null, // 待应用的揭示时刻(焦点/周期/模式切换时保持原时刻,由handleTick消费)
    equityCurve: [],     // 资产曲线 [{time, date, equity}]
    summaryShown: false,
    settings: Object.assign({}, DEFAULT_SETTINGS)
  };

  let chart = null;        // 单图模式图表
  let multiCharts = null;  // 联动模式图表 {1: KChart, 5: KChart, 30: KChart}
  let barsByPeriod = { 1: [], 5: [], 30: [] }; // 三周期聚合缓存(联动共用)
  let player = null;
  let sim = null;

  /* ================= 配置 ================= */

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('futures-replay-settings'));
      if (saved && typeof saved === 'object') Object.assign(state.settings, saved);
    } catch (e) { /* 本地存储损坏时使用默认值 */ }
  }

  function saveSettings() {
    try { localStorage.setItem('futures-replay-settings', JSON.stringify(state.settings)); } catch (e) { /* 忽略 */ }
  }

  function settingsToSimCfg(s) {
    return {
      initialCapital: s.initialCapital,
      multiplier: s.multiplier,
      marginRate: s.marginRatePct / 100,
      feePerLot: s.feePerLot,
      autoLiquidate: s.autoLiquidate
    };
  }

  /* ================= 会话与周期 ================= */

  /* 从1分钟基准数据构建三周期聚合缓存,并刷新当前生效K线 */
  function rebuildAllBars() {
    barsByPeriod[1] = state.baseBars.slice();
    barsByPeriod[5] = KData.aggregate(state.baseBars, 5);
    barsByPeriod[30] = KData.aggregate(state.baseBars, 30);
    state.bars = barsByPeriod[state.mode === 'linked' ? state.focus : state.period];
  }

  /* 二分查找:bars 中最后一根 time <= t 的索引(跨周期时间对齐通用方法) */
  function idxOfTimeIn(bars, t) {
    if (!bars.length) return 0;
    if (t <= bars[0].time) return 0;
    if (t >= bars[bars.length - 1].time) return bars.length - 1;
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].time <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function idxOfTime(t) { return idxOfTimeIn(state.bars, t); }

  /* 截断聚合:用基准1分钟数据构建周期p从t0起、截至tEnd的"进行中"K线(只含已揭示数据,不泄露未来) */
  function buildLiveBar(p, t0, tEnd) {
    if (tEnd < t0) return null;
    const bb = state.baseBars;
    if (!bb.length) return null;
    const i0 = idxOfTimeIn(bb, t0);
    if (bb[i0] == null || bb[i0].time !== t0) return null;
    const i1 = idxOfTimeIn(bb, tEnd);
    let high = -Infinity, low = Infinity, vol = 0;
    for (let i = i0; i <= i1; i++) {
      const b = bb[i];
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      vol += b.volume;
    }
    return {
      time: t0, open: bb[i0].open, close: bb[i1].close,
      high: high, low: low, volume: vol, dateStr: bb[i1].dateStr
    };
  }

  /* 由播放位置推导回放揭示时刻:
     常规=焦点周期当前K线起始;到达最后一根时推进到数据末尾(完整揭示);
     焦点/周期/模式切换时保持原揭示时刻(pendingAnchor) */
  function derivedAnchorTime() {
    if (state.pendingAnchor != null) {
      const t = state.pendingAnchor;
      state.pendingAnchor = null;
      return t;
    }
    const idx = player ? player.index : 0;
    const bar = state.bars[idx];
    if (!bar) return state.lastTime || 0;
    const lastM1 = state.baseBars[state.baseBars.length - 1];
    return (idx >= state.bars.length - 1 && lastM1) ? Math.max(bar.time, lastM1.time) : bar.time;
  }

  /* 当前回放揭示时刻(handleTick 每次更新后的全局时刻) */
  function currentAnchorTime() {
    return state.lastTime != null ? state.lastTime : (state.bars.length ? state.bars[0].time : 0);
  }

  /* 用一组新数据开始新的复盘会话
     (marketSim=随机会话的生成器,可无限延伸;syncParams=false 时不以预设覆盖交易参数,保留用户微调值) */
  function newSession(baseBars, symbol, code, preset, syncParams, marketSim) {
    state.baseBars = baseBars;
    state.marketSim = marketSim || null;
    state.symbol = symbol || '演示合约';
    state.code = code || 'RB9999';
    $('symbol-name').value = state.symbol;
    $('symbol-code').textContent = state.code;
    // 记录当前行情对应的品种预设索引(导入数据为 null)
    const pi = preset ? KData.FUTURES_PRESETS.indexOf(preset) : -1;
    state.sessionPresetIdx = pi >= 0 ? pi : null;
    // 随机行情时同步品种交易参数
    if (preset && syncParams !== false) {
      state.settings.multiplier = preset.mult;
      state.settings.marginRatePct = Math.round(preset.marginRate * 1000) / 10;
      state.settings.feePerLot = preset.feePerLot;
      saveSettings();
    }
    rebuildAllBars();
    // 回放起点:
    // 随机会话(可无限延伸):初始数据(默认2天)全部直接可见,供确认走势趋势,回放从初始数据末尾开始
    // 导入数据(固定长度):5分钟线 min(60根, 总根数一半) 处,前段作历史参考,后段为回放内容
    if (state.marketSim) {
      state.startTime = state.baseBars[state.baseBars.length - 1].time;
    } else {
      const p5 = barsByPeriod[5];
      state.startTime = p5[Math.min(60, Math.floor(p5.length / 2))].time;
    }
    state.lastTime = null;
    state.pendingAnchor = null;
    state.summaryShown = false;
    state.equityCurve = [];
    sim.cfg = settingsToSimCfg(state.settings);
    sim.reset();
    // 数据应用:单图只刷当前周期,联动三窗全刷
    if (state.mode === 'linked' && multiCharts) {
      PERIODS.forEach(function (p) {
        const c = multiCharts[p];
        c.setData(barsByPeriod[p]);
        c.setMarkers([]);
        c.setCostLines({ long: null, short: null });
      });
    } else {
      chart.setData(state.bars);
      chart.setMarkers([]);
      chart.setCostLines({ long: null, short: null });
    }
    applyCursorAll(state.startTime);
    $('progress').max = String(state.bars.length - 1);
    player.load(state.bars.length, idxOfTime(state.startTime)); // 触发 handleTick 完成首屏刷新
    updatePeriodBtns();
    updateFocusStyles();
    updateTradesTable();
  }

  /* ================= 无限延伸(随机会话) ================= */

  /* 追加生成 n 个交易日数据(价格/趋势/波动状态延续),三周期缓存重建、图表保持视图、播放不打断 */
  function extendSession(days) {
    if (!state.marketSim || !state.baseBars.length) return false;
    const newBars = state.marketSim.generateDays(days);
    if (!newBars.length) return false;
    state.baseBars = state.baseBars.concat(newBars);
    rebuildAllBars();
    // 各激活图表重载数据(保持视图与光标,不打断当前观察位置)
    if (state.mode === 'linked' && multiCharts) {
      PERIODS.forEach(function (p) { multiCharts[p].reloadData(barsByPeriod[p]); });
    } else {
      chart.reloadData(state.bars);
    }
    player.setTotal(state.bars.length); // 不触发 onTick、不重置播放计时
    $('progress').max = String(state.bars.length - 1);
    applyCursorAll(currentAnchorTime()); // 重设光标与进行中K线(三窗同步)
    updateMiniQuotes();
    updateProgress(player.index);
    return true;
  }

  /* 播放/单步前进:到达当前数据末尾时自动追加(仅随机会话) */
  function ensureExtendable() {
    if (player.index < player.total - 1) return true;
    return extendSession(2);
  }

  /* 切换周期:单图模式切换显示周期;联动模式切换焦点窗口。
     均保持当前揭示时刻不变(时间锚不回退、交易不回溯),仅重映射播放位置 */
  function switchPeriod(p) {
    if (!state.baseBars.length || !PERIODS.includes(p)) return;
    const anchorTime = currentAnchorTime();
    if (state.mode === 'linked') {
      if (p === state.focus) return;
      state.focus = p;
      state.bars = barsByPeriod[p];
      $('progress').max = String(state.bars.length - 1);
      state.pendingAnchor = anchorTime;
      player.load(state.bars.length, idxOfTimeIn(state.bars, anchorTime));
      updatePeriodBtns();
      updateFocusStyles();
      toast('焦点已切换至 ' + p + ' 分钟窗口', 'ok');
    } else {
      if (p === state.period) return;
      state.period = p;
      state.bars = barsByPeriod[p];
      chart.setData(state.bars);
      $('progress').max = String(state.bars.length - 1);
      state.pendingAnchor = anchorTime;
      player.load(state.bars.length, idxOfTimeIn(state.bars, anchorTime));
      updatePeriodBtns();
      toast('已切换至 ' + p + ' 分钟K线', 'ok');
    }
  }

  function updatePeriodBtns() {
    const active = state.mode === 'linked' ? state.focus : state.period;
    document.querySelectorAll('#period-group .btn').forEach(function (btn) {
      btn.classList.toggle('active', parseInt(btn.dataset.period, 10) === active);
    });
  }

  /* ================= 多窗联动 ================= */

  /* 当前激活的图表实例数组(单图=[chart],联动=三窗) */
  function allCharts() {
    return state.mode === 'linked' && multiCharts
      ? [multiCharts[1], multiCharts[5], multiCharts[30]]
      : [chart];
  }

  /* 当前持仓成本线(多空均价) */
  function currentCostLines() {
    return {
      long: sim.long.qty > 0 ? sim.long.avg : null,
      short: sim.short.qty > 0 ? sim.short.avg : null
    };
  }

  /* 成本线应用到所有激活图表 */
  function setCostAll(lines) {
    allCharts().forEach(function (c) { c.setCostLines(lines); });
  }

  /* 以时间为锚设置所有激活图表的回放光标(联动核心:三窗停在同一时刻);
     大周期最后一根若仍在形成中,替换为截至该时刻的截断聚合K线(不泄露未来,随回放逐步成形) */
  function applyCursorAll(anchorTime) {
    const applyOne = function (c, bars, p) {
      const idx = idxOfTimeIn(bars, anchorTime);
      c.setCursor(idx);
      const next = bars[idx + 1];
      if (p > 1 && next && anchorTime < next.time) {
        const live = buildLiveBar(p, bars[idx].time, anchorTime);
        if (live) c.setLiveBar(idx, live);
        else c.clearLiveBar();
      } else {
        c.clearLiveBar();
      }
      c.follow();
    };
    if (state.mode === 'linked' && multiCharts) {
      PERIODS.forEach(function (p) { applyOne(multiCharts[p], barsByPeriod[p], p); });
    } else if (chart) {
      applyOne(chart, state.bars, state.period);
    }
  }

  /* 懒创建联动三窗图表实例(首次进入联动模式时) */
  function createMultiCharts() {
    const map = {};
    PERIODS.forEach(function (p) {
      const c = new KChart($('mc-canvas-' + p), $('mc-tip-' + p));
      c.legendLimit = 0; // 纵向全宽窗口,完整显示 MA5/10/20/60 均线图例
      c.onHoverChange = function (info) { syncHover(p, info); };
      // 点击任一窗口即切换焦点(焦点窗口决定步进粒度与进度条)
      $('mc-panel-' + p).addEventListener('mousedown', function () {
        if (state.mode === 'linked' && state.focus !== p) switchPeriod(p);
      });
      map[p] = c;
    });
    return map;
  }

  /* 十字光标跨窗同步:源窗口 hover -> 其余窗口显示同时间/同价格弱化十字线 */
  function syncHover(srcPeriod, info) {
    if (state.mode !== 'linked' || !multiCharts) return;
    PERIODS.forEach(function (p) {
      if (p !== srcPeriod) multiCharts[p].setLinkedHover(info);
    });
  }

  /* 联动模式各小窗表头行情:三窗统一显示最新揭示价,涨跌幅相对各自周期前一根收盘 */
  function updateMiniQuotes() {
    if (state.mode !== 'linked' || !multiCharts) return;
    const b = currentBar();
    if (!b) return;
    const price = b.close;             // 三窗一致的最新价
    const anchorTime = currentAnchorTime();
    PERIODS.forEach(function (p) {
      const bars = barsByPeriod[p];
      const i = idxOfTimeIn(bars, anchorTime);
      const prev = bars[i - 1];
      if (!bars[i]) return;
      const chg = prev ? (price - prev.close) / prev.close : 0;
      const cls = chg >= 0 ? 'up' : 'down';
      $('mc-quote-' + p).innerHTML =
        '<b class="' + (price >= b.open ? 'up' : 'down') + '">' + Utils.fmtPrice(price) + '</b>' +
        '<span class="' + cls + '">' + Utils.fmtPct(chg) + '</span>';
    });
  }

  /* 焦点窗口高亮(联动模式) */
  function updateFocusStyles() {
    PERIODS.forEach(function (p) {
      const el = $('mc-panel-' + p);
      if (el) el.classList.toggle('focus', state.mode === 'linked' && state.focus === p);
    });
    const btn = $('btn-link');
    if (btn) {
      btn.classList.toggle('primary', state.mode === 'linked');
      btn.classList.toggle('ghost', state.mode !== 'linked');
      btn.textContent = state.mode === 'linked' ? '单图模式' : '多窗联动';
    }
  }

  /* 单图 <-> 多窗联动模式切换(揭示时刻/交易/持仓全部保留) */
  function setMode(mode) {
    if (mode === state.mode || !state.baseBars.length) return;
    const anchorTime = currentAnchorTime();
    state.mode = mode;
    if (mode === 'linked') {
      if (!multiCharts) multiCharts = createMultiCharts();
      $('chart-wrap').hidden = true;
      $('chart-multi').hidden = false;
      state.bars = barsByPeriod[state.focus];
      PERIODS.forEach(function (p) {
        const c = multiCharts[p];
        c.setFlip(!state.settings.redUp);
        c.setData(barsByPeriod[p]);
      });
      rebuildMarkers();
      setCostAll(currentCostLines());
      applyCursorAll(anchorTime);
      updateMiniQuotes();
      toast('已开启多窗联动:1/5/30分钟同屏,点击窗口或按 1/2/3 切换焦点', 'ok');
    } else {
      $('chart-multi').hidden = true;
      $('chart-wrap').hidden = false;
      state.bars = barsByPeriod[state.period];
      chart.setFlip(!state.settings.redUp);
      chart.setData(state.bars);
      rebuildMarkers();
      setCostAll(currentCostLines());
      applyCursorAll(anchorTime);
      toast('已切换为单图模式', 'ok');
    }
    $('progress').max = String(state.bars.length - 1);
    state.pendingAnchor = anchorTime;
    player.load(state.bars.length, idxOfTimeIn(state.bars, anchorTime));
    updatePeriodBtns();
    updateFocusStyles();
  }

  /* ================= 回放联动 ================= */

  /* 回放位置变化回调(播放、单步、进度条拖动、周期/焦点/模式切换均会触发) */
  function handleTick(idx) {
    const bar = state.bars[idx];
    if (!bar) return;
    const anchorTime = derivedAnchorTime();
    // 时间回溯:揭示时刻后退时,自动撤销该时刻之后发生的交易
    if (state.lastTime == null || anchorTime < state.lastTime) rollbackToTime(anchorTime);
    state.lastTime = anchorTime;
    const lb = currentBar(); // 焦点周期进行中K线(close=最新揭示价)
    recordEquity();
    // 强平检查:风险度达到100%时以当前价全部平仓
    const liq = sim.checkLiquidation(lb.close, anchorTime, lb.dateStr);
    applyCursorAll(anchorTime); // 联动模式:三窗光标同步停在同一时刻
    updateBarInfo();
    updateMiniQuotes();
    if (liq) {
      toast(liq.msg, 'err');
      rebuildMarkers();
      updateTradesTable();
    }
    updateAccount();
    updateStats();
    updateProgress(idx);
    updateTradeHint();
    // 无限回放:播放推进到接近数据末尾时自动追加2天(仅随机会话,导入数据播完自然结束)
    if (player.playing && player.index >= player.total - 30) extendSession(2);
  }

  /* 时间回溯:保留该时刻之前的交易,按序重放重建账户状态 */
  function rollbackToTime(cutTime) {
    const kept = sim.trades.filter(function (t) { return t.time <= cutTime; });
    sim.reset();
    for (const t of kept) {
      if (t.action === 'open_long') sim.openLong(t.price, t.lots, t.time, t.date);
      else if (t.action === 'open_short') sim.openShort(t.price, t.lots, t.time, t.date);
      else if (t.action === 'close_long') sim.closeLong(t.price, t.lots, t.time, t.date);
      else sim.closeShort(t.price, t.lots, t.time, t.date);
    }
    state.equityCurve = state.equityCurve.filter(function (p) { return p.time <= cutTime; });
    state.summaryShown = false;
    rebuildMarkers();
    updateTradesTable();
  }

  /* 记录当前时刻账户权益(同一时刻则覆盖旧值);时刻取回放锚定,价格取最新揭示价 */
  function recordEquity() {
    const b = currentBar();
    if (!b) return;
    const pt = { time: currentAnchorTime(), date: b.dateStr, equity: sim.equity(b.close) };
    const last = state.equityCurve[state.equityCurve.length - 1];
    if (last && last.time === pt.time) state.equityCurve[state.equityCurve.length - 1] = pt;
    else state.equityCurve.push(pt);
  }

  /* ================= 界面刷新 ================= */

  /* 当前焦点周期K线的"实时"形态:
     1分钟=当前bar本身;大周期=截至揭示时刻的截断聚合(进行中K线,不泄露未来),
     close 即三窗一致的最新揭示价 */
  function currentBar() {
    const idx = player ? player.index : 0;
    const bars = state.bars;
    const b = bars[idx];
    if (!b) return null;
    const p = state.mode === 'linked' ? state.focus : state.period;
    if (p === 1) return b;
    const next = bars[idx + 1];
    const t = state.lastTime != null ? state.lastTime : b.time; // 揭示时刻
    if (!next || t >= next.time) return b;        // 已收完(含数据末尾)
    return buildLiveBar(p, b.time, t) || b;       // 截断到揭示时刻
  }

  /* 顶栏行情信息条(焦点周期当前K线:进行中则为截断聚合形态) */
  function updateBarInfo() {
    const b = currentBar();
    if (!b) return;
    const idx = player ? player.index : 0;
    const prev = state.bars[idx - 1];
    const chg = prev ? (b.close - prev.close) / prev.close : 0;
    const cls = b.close >= b.open ? 'up' : 'down';
    const cls2 = chg >= 0 ? 'up' : 'down';
    $('bar-info').innerHTML =
      '<span class="bi-date">' + b.dateStr + '</span>' +
      '<span>开 <b class="' + cls + '">' + Utils.fmtPrice(b.open) + '</b></span>' +
      '<span>高 <b class="' + cls + '">' + Utils.fmtPrice(b.high) + '</b></span>' +
      '<span>低 <b class="' + cls + '">' + Utils.fmtPrice(b.low) + '</b></span>' +
      '<span>收 <b class="' + cls + '">' + Utils.fmtPrice(b.close) + '</b></span>' +
      '<span>涨跌 <b class="' + cls2 + '">' + Utils.fmtPct(chg) + '</b></span>' +
      '<span>量 <b>' + Utils.fmtVol(b.volume) + '</b></span>';
    const tp = $('trade-price');
    tp.textContent = Utils.fmtPrice(b.close);
    tp.className = cls2;
  }

  /* 账户总览面板 */
  function updateAccount() {
    const b = currentBar();
    if (!b) return;
    const eq = sim.equity(b.close);
    const init = sim.cfg.initialCapital;
    const ret = (eq - init) / init;
    const avail = sim.available(b.close);
    const mu = sim.marginUsed();
    const risk = eq > 0 ? mu / eq : Infinity;
    const unreal = sim.unrealized(b.close);
    const riskTxt = isFinite(risk) ? (risk * 100).toFixed(1) + '%' : '--';
    const riskCls = risk >= 1 ? 'down' : risk >= 0.8 ? 'up' : '';
    const rows = [
      ['账户权益', Utils.fmtNum(eq) + ' 元', Utils.cls(eq - init)],
      ['总收益率', Utils.fmtPct(ret), Utils.cls(ret)],
      ['可用资金', Utils.fmtNum(avail) + ' 元', ''],
      ['占用保证金', Utils.fmtNum(mu) + ' 元', ''],
      ['风险度', riskTxt, riskCls],
      ['多头持仓', sim.long.qty > 0 ? sim.long.qty + ' 手' : '空', sim.long.qty > 0 ? 'up' : ''],
      ['多头均价', sim.long.qty > 0 ? Utils.fmtPrice(sim.long.avg) : '--', ''],
      ['空头持仓', sim.short.qty > 0 ? sim.short.qty + ' 手' : '空', sim.short.qty > 0 ? 'down' : ''],
      ['空头均价', sim.short.qty > 0 ? Utils.fmtPrice(sim.short.avg) : '--', ''],
      ['浮动盈亏', Utils.fmtSigned(unreal), Utils.cls(unreal)],
      ['已实现盈亏', Utils.fmtSigned(sim.realizedPnl), Utils.cls(sim.realizedPnl)],
      ['累计手续费', Utils.fmtNum(sim.totalFees) + ' 元', '']
    ];
    $('account-grid').innerHTML = rows.map(function (r) {
      return '<div class="kv"><span>' + r[0] + '</span><b class="' + r[2] + '">' + r[1] + '</b></div>';
    }).join('');
    setCostAll(currentCostLines());
  }

  /* 复盘统计面板与资产曲线 */
  function updateStats() {
    const b = currentBar();
    if (!b) return;
    const startPrice = state.baseBars[idxOfTimeIn(state.baseBars, state.startTime)].close;
    const s = KReview.computeStats(sim.trades, state.equityCurve, sim.cfg.initialCapital,
      startPrice, b.close);
    const pf = s.profitFactor == null ? '--' : (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2));
    const rows = [
      ['胜率', s.winRate == null ? '--' : (s.winRate * 100).toFixed(1) + '%', ''],
      ['盈亏比', pf, ''],
      ['最大回撤', (s.maxDrawdownPct * 100).toFixed(2) + '%', s.maxDrawdownPct > 0.0001 ? 'down' : ''],
      ['买入持有', s.buyHoldReturn == null ? '--' : Utils.fmtPct(s.buyHoldReturn), Utils.cls(s.buyHoldReturn || 0)],
      ['交易次数', String(s.tradeCount), ''],
      ['手续费', Utils.fmtNum(s.fees) + ' 元', '']
    ];
    $('stats-grid').innerHTML = rows.map(function (r) {
      return '<div class="kv"><span>' + r[0] + '</span><b class="' + r[2] + '">' + r[1] + '</b></div>';
    }).join('');
    KReview.drawEquityCurve($('equity-curve'), state.equityCurve, sim.cfg.initialCapital, themeColors());
  }

  /* 交易记录表 */
  function updateTradesTable() {
    const tbody = $('trades-table').querySelector('tbody');
    const rows = sim.trades.slice().reverse().map(function (t) {
      const name = KReview.ACTION_NAMES[t.action] || t.action;
      const dirCls = KReview.isBuySide(t.action) ? 'long' : 'short';
      const pnl = t.realized != null
        ? '<td class="' + Utils.cls(t.realized) + '">' + Utils.fmtSigned(t.realized) + '</td>'
        : '<td>--</td>';
      return '<tr><td>' + t.date + '</td>' +
        '<td><span class="dir ' + dirCls + '">' + name + '</span></td>' +
        '<td>' + Utils.fmtPrice(t.price) + '</td><td>' + t.lots + '</td>' + pnl + '</tr>';
    });
    tbody.innerHTML = rows.length ? rows.join('')
      : '<tr><td colspan="5" class="empty">暂无交易记录,按 B 开多 / S 开空</td></tr>';
    $('trade-count').textContent = String(sim.trades.length);
  }

  function updateProgress(idx) {
    $('progress').value = String(idx);
    $('replay-pos').textContent = (idx + 1) + ' / ' + state.bars.length;
  }

  /* 交易面板的可开/持仓提示 */
  function updateTradeHint() {
    const b = currentBar();
    if (!b) return;
    $('trade-hint').innerHTML =
      '最大可开 <b>' + sim.maxOpenLots(b.close) + '</b> 手 · 持多 <b>' + sim.long.qty +
      '</b> 手 · 持空 <b>' + sim.short.qty + '</b> 手';
  }

  function updatePlayBtn(playing) {
    $('btn-play').textContent = playing ? '暂停' : '播放';
  }

  function themeColors() {
    const css = getComputedStyle(document.documentElement);
    return {
      up: (css.getPropertyValue('--up') || '#ef5350').trim(),
      down: (css.getPropertyValue('--down') || '#26a69a').trim()
    };
  }

  /* ================= 交易操作 ================= */

  function lotsInput() { return parseInt($('lots-input').value, 10) || 0; }

  function doOpenLong() {
    const b = currentBar();
    if (!b) return;
    const res = sim.openLong(b.close, lotsInput(), b.time, b.dateStr);
    if (!res.ok) return toast(res.msg, 'err');
    toast(res.msg, 'buy');
    afterTrade();
  }

  function doOpenShort() {
    const b = currentBar();
    if (!b) return;
    const res = sim.openShort(b.close, lotsInput(), b.time, b.dateStr);
    if (!res.ok) return toast(res.msg, 'err');
    toast(res.msg, 'sell');
    afterTrade();
  }

  function doCloseLong() {
    const b = currentBar();
    if (!b) return;
    const res = sim.closeLong(b.close, lotsInput(), b.time, b.dateStr);
    if (!res.ok) return toast(res.msg, 'err');
    toast(res.msg, 'sell');
    afterTrade();
  }

  function doCloseShort() {
    const b = currentBar();
    if (!b) return;
    const res = sim.closeShort(b.close, lotsInput(), b.time, b.dateStr);
    if (!res.ok) return toast(res.msg, 'err');
    toast(res.msg, 'buy');
    afterTrade();
  }

  function doCloseAll() {
    const b = currentBar();
    if (!b) return;
    if (sim.long.qty <= 0 && sim.short.qty <= 0) return toast('当前无持仓', 'err');
    const msgs = sim.closeAll(b.close, b.time, b.dateStr);
    msgs.forEach(function (m) { toast(m, 'ok'); });
    afterTrade();
  }

  function afterTrade() {
    rebuildMarkers();
    recordEquity();
    updateAccount();
    updateStats();
    updateTradesTable();
    updateTradeHint();
  }

  /* 依据成交记录重建图上开平仓标记(交易时刻按各图表周期分别映射到K线索引) */
  function rebuildMarkers() {
    const mk = function (bars) {
      return sim.trades.map(function (t) {
        return { index: idxOfTimeIn(bars, t.time), side: t.action, price: t.price };
      });
    };
    if (state.mode === 'linked' && multiCharts) {
      PERIODS.forEach(function (p) { multiCharts[p].setMarkers(mk(barsByPeriod[p])); });
    } else {
      chart.setMarkers(mk(state.bars));
    }
  }

  /* ================= 复盘报告与重置 ================= */

  function handleReplayEnd() {
    player.pause();
    if (state.summaryShown) return;
    state.summaryShown = true;
    showSummary();
  }

  function showSummary() {
    const b = currentBar();
    if (!b) return;
    const startPrice = state.baseBars[idxOfTimeIn(state.baseBars, state.startTime)].close;
    const s = KReview.computeStats(sim.trades, state.equityCurve, sim.cfg.initialCapital,
      startPrice, b.close);
    const pf = s.profitFactor == null ? '--' : (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2));
    const avg = (s.avgWin != null ? '+' + s.avgWin.toFixed(0) : '--') + ' / ' +
      (s.avgLoss != null ? s.avgLoss.toFixed(0) : '--') + ' 元';
    const rows = [
      ['期末账户权益', Utils.fmtNum(s.finalEquity) + ' 元', Utils.cls(s.totalReturn)],
      ['总收益率', Utils.fmtPct(s.totalReturn), Utils.cls(s.totalReturn)],
      ['买入持有对比', s.buyHoldReturn == null ? '--' : Utils.fmtPct(s.buyHoldReturn), Utils.cls(s.buyHoldReturn || 0)],
      ['交易次数', s.tradeCount + ' 次(平仓 ' + s.closedCount + ' 次)', ''],
      ['平多 / 平空', s.longClosed + ' 次 / ' + s.shortClosed + ' 次', ''],
      ['胜率', s.winRate == null ? '--' : (s.winRate * 100).toFixed(1) + '%', ''],
      ['盈亏比', pf, ''],
      ['平均盈亏', avg, ''],
      ['最大回撤', (s.maxDrawdownPct * 100).toFixed(2) + '% (' + Utils.fmtNum(s.maxDrawdown) + ' 元)', ''],
      ['累计手续费', Utils.fmtNum(s.fees) + ' 元', '']
    ];
    $('summary-body').innerHTML = '<div class="kv-grid">' + rows.map(function (r) {
      return '<div class="kv"><span>' + r[0] + '</span><b class="' + r[2] + '">' + r[1] + '</b></div>';
    }).join('') + '</div>';
    $('modal-summary').hidden = false;
    KReview.drawEquityCurve($('summary-equity'), state.equityCurve, sim.cfg.initialCapital, themeColors());
  }

  /* 重置:清空交易、恢复初始资金、回到复盘起点 */
  function resetSession() {
    player.pause();
    $('modal-summary').hidden = true;
    state.summaryShown = false;
    state.lastTime = null;
    state.pendingAnchor = null;
    state.equityCurve = [];
    sim.reset();
    rebuildMarkers();
    setCostAll({ long: null, short: null });
    player.setIndex(idxOfTime(state.startTime));
    handleTick(player.index); // 索引未变化时也强制刷新首屏
    toast('已重置:资金恢复,交易清空,回到起点', 'ok');
  }

  /* ================= 数据导入 ================= */

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const text = String(reader.result);
        const t = text.trim();
        const bars = (t.charAt(0) === '{' || t.charAt(0) === '[')
          ? KData.parseJSON(text)
          : KData.parseCSV(text);
        const name = file.name.replace(/\.[^.]+$/, '') || '导入合约';
        newSession(bars, name, name.toUpperCase().slice(0, 12), null);
        toast('已导入 ' + bars.length + ' 根1分钟K线:' + name, 'ok');
      } catch (err) {
        toast('导入失败:' + err.message, 'err');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ================= 设置与主题 ================= */

  function initPresetSelect() {
    const sel = $('set-preset');
    sel.innerHTML = '<option value="-1">自定义参数(保持当前品种)</option>' +
      KData.FUTURES_PRESETS.map(function (p, i) {
        return '<option value="' + i + '">' + p.name + ' (' + p.code + ' ×' + p.mult + ')</option>';
      }).join('');
    sel.addEventListener('change', function () {
      const i = parseInt(sel.value, 10);
      const p = i >= 0 ? KData.FUTURES_PRESETS[i] : null;
      if (!p) return;
      $('set-mult').value = p.mult;
      $('set-margin').value = Math.round(p.marginRate * 1000) / 10;
      $('set-fee').value = p.feePerLot;
    });
  }

  function openSettings() {
    const s = state.settings;
    $('set-capital').value = s.initialCapital;
    $('set-mult').value = s.multiplier;
    $('set-margin').value = s.marginRatePct;
    $('set-fee').value = s.feePerLot;
    $('set-liq').checked = !!s.autoLiquidate;
    $('set-redup').checked = !!s.redUp;
    // 下拉框定位到当前行情对应的品种(导入数据显示"自定义")
    $('set-preset').value = String(state.sessionPresetIdx != null ? state.sessionPresetIdx : -1);
    $('modal-settings').hidden = false;
  }

  function applySettings() {
    const capital = parseFloat($('set-capital').value);
    const mult = parseFloat($('set-mult').value);
    const margin = parseFloat($('set-margin').value);
    const fee = parseFloat($('set-fee').value);
    if (!(capital >= 10000)) return toast('初始资金至少为 1 万元', 'err');
    if (!(mult >= 1)) return toast('合约乘数至少为 1', 'err');
    if (!(margin > 0) || margin > 100) return toast('保证金率需在 0~100 之间', 'err');
    if (!(fee >= 0)) return toast('手续费不能为负数', 'err');
    state.settings.initialCapital = capital;
    state.settings.multiplier = mult;
    state.settings.marginRatePct = margin;
    state.settings.feePerLot = fee;
    state.settings.autoLiquidate = $('set-liq').checked;
    state.settings.redUp = $('set-redup').checked;
    saveSettings();
    applyTheme();
    $('modal-settings').hidden = true;

    const presetIdx = parseInt($('set-preset').value, 10);
    const preset = presetIdx >= 0 ? KData.FUTURES_PRESETS[presetIdx] : null;
    if (preset && state.sessionPresetIdx !== presetIdx) {
      // 切换品种:重新生成该品种随机行情(初始2天,可无限延伸),顶栏名称/代码同步切换,账户与回放全部重置
      const code = KData.contractCode(preset);
      startRandomSession(preset, 2, false); // false=不覆盖用户在弹窗中微调后的参数
      toast('已切换至 ' + preset.name + ' ' + code + ' 行情,参数已应用,账户已重置', 'ok');
    } else {
      sim.cfg = settingsToSimCfg(state.settings);
      resetSession();
      toast('设置已应用,账户已重置', 'ok');
    }
  }

  /* 红涨绿跌 / 绿涨红跌主题切换(同步CSS变量与画布配色) */
  function applyTheme() {
    const redUp = state.settings.redUp;
    const root = document.documentElement.style;
    root.setProperty('--up', redUp ? '#ef5350' : '#26a69a');
    root.setProperty('--down', redUp ? '#26a69a' : '#ef5350');
    allCharts().forEach(function (c) { c.setFlip(!redUp); });
  }

  /* ================= 导出与通知 ================= */

  function exportTrades() {
    if (!sim.trades.length) return toast('暂无交易记录可导出', 'err');
    const csv = KReview.tradesToCSV(sim.trades);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.symbol || 'trades') + '_交易记录.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'ok');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 320);
    }, 2600);
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    // K线周期切换(单图=切换周期,联动=切换焦点窗口)
    document.querySelectorAll('#period-group .btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchPeriod(parseInt(btn.dataset.period, 10));
      });
    });

    // 单图 <-> 多窗联动模式切换
    $('btn-link').addEventListener('click', function () {
      setMode(state.mode === 'linked' ? 'single' : 'linked');
    });

    // 回放控制
    $('btn-play').addEventListener('click', function () {
      if (player.playing) { player.pause(); return; }
      if (!ensureExtendable()) {
        toast('回放已结束,可点击"重置复盘"重新开始', 'ok');
        return;
      }
      player.play();
    });
    $('btn-step-fwd').addEventListener('click', function () {
      if (!ensureExtendable()) return;
      player.step(1);
    });
    $('btn-step-back').addEventListener('click', function () { player.step(-1); });
    $('btn-home').addEventListener('click', function () { player.setIndex(idxOfTime(state.startTime)); });
    $('btn-end').addEventListener('click', function () {
      player.setIndex(state.bars.length - 1);
      handleReplayEnd(); // 跳到末尾同样展示复盘报告
    });
    $('speed-select').addEventListener('change', function (e) {
      player.setSpeed(parseFloat(e.target.value) || 1);
    });
    $('progress').addEventListener('input', function (e) {
      player.setIndex(parseInt(e.target.value, 10));
    });

    // 期货交易:开多 / 开空 / 平多 / 平空 / 全平
    $('btn-open-long').addEventListener('click', doOpenLong);
    $('btn-open-short').addEventListener('click', doOpenShort);
    $('btn-close-long').addEventListener('click', doCloseLong);
    $('btn-close-short').addEventListener('click', doCloseShort);
    $('btn-close-all').addEventListener('click', doCloseAll);

    // 开仓手数快捷按钮:按可用资金最大可开手数折算
    document.querySelectorAll('[data-open]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const b = currentBar();
        const pct = parseFloat(btn.getAttribute('data-open'));
        const lots = Math.floor(sim.maxOpenLots(b.close) * pct);
        if (lots <= 0) return toast('可用资金不足', 'err');
        $('lots-input').value = lots;
      });
    });

    // 数据
    $('btn-random').addEventListener('click', function () {
      const sym = startRandomSession(null, 2);
      toast('已生成 ' + sym.name + ' ' + sym.code + ' 随机行情(初始2天,回放中自动延续)', 'ok');
    });
    $('btn-import').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      if (f) importFile(f);
      e.target.value = '';
    });
    $('symbol-name').addEventListener('change', function (e) {
      state.symbol = e.target.value.trim() || '演示合约';
    });

    // 设置
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-close-settings').addEventListener('click', function () { $('modal-settings').hidden = true; });
    $('btn-apply-settings').addEventListener('click', applySettings);

    // 复盘
    $('btn-report').addEventListener('click', showSummary);
    $('btn-export').addEventListener('click', exportTrades);
    $('btn-reset').addEventListener('click', resetSession);
    $('btn-summary-close').addEventListener('click', function () { $('modal-summary').hidden = true; });
    $('btn-replay-again').addEventListener('click', resetSession);

    // 点击遮罩关闭弹窗
    ['modal-settings', 'modal-summary'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        if (e.target === $(id)) $(id).hidden = true;
      });
    });

    // 键盘快捷键
    document.addEventListener('keydown', function (e) {
      const tag = (e.target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          $('btn-play').click();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (ensureExtendable()) player.step(1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          player.step(-1);
          break;
        case '1': switchPeriod(1); break;
        case '2': switchPeriod(5); break;
        case '3': switchPeriod(30); break;
        case 'm': case 'M':
          setMode(state.mode === 'linked' ? 'single' : 'linked');
          break;
        case 'b': case 'B': doOpenLong(); break;
        case 's': case 'S': doOpenShort(); break;
        case 'l': case 'L': doCloseLong(); break;
        case 'c': case 'C': doCloseShort(); break;
        case 'x': case 'X': doCloseAll(); break;
        case 'r': case 'R': resetSession(); break;
        case 'Home':
          e.preventDefault();
          player.setIndex(idxOfTime(state.startTime));
          break;
        case 'End':
          e.preventDefault();
          player.setIndex(state.bars.length - 1);
          handleReplayEnd();
          break;
      }
    });

    // 窗口尺寸变化时重绘资产曲线
    window.addEventListener('resize', function () { updateStats(); });
  }

  /* ================= 启动 ================= */

  function init() {
    loadSettings();
    sim = new FuturesSim(settingsToSimCfg(state.settings));
    chart = new KChart($('chart'), $('tooltip'));
    player = new ReplayPlayer({
      onTick: handleTick,
      onState: updatePlayBtn,
      onEnd: handleReplayEnd
    });
    initPresetSelect();
    applyTheme();
    bindEvents();
    startRandomSession(null, 2);
  }

  /* 开始一个随机行情会话:初始生成 initDays 天(默认2天)全部可见,回放从其末尾开始无限延伸 */
  function startRandomSession(preset, initDays, syncParams) {
    const sym = preset ? { name: preset.name, code: KData.contractCode(preset), preset: preset }
      : KData.randomFuturesSymbol();
    const sim = KData.createMarketSim({ preset: sym.preset });
    newSession(sim.generateDays(initDays || 2), sym.name, sym.code, sym.preset, syncParams, sim);
    return sym;
  }

  init();
})();
