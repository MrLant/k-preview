/* 复盘分析模块:统计指标计算、资产曲线绘制、交易记录导出 */
(function (global) {
  'use strict';

  /* 期货操作名称映射 */
  const ACTION_NAMES = {
    open_long: '开多',
    open_short: '开空',
    close_long: '平多',
    close_short: '平空'
  };

  /* 买方向操作(开多/平空)用于表格配色 */
  function isBuySide(action) { return action === 'open_long' || action === 'close_short'; }

  /**
   * 计算复盘统计指标(期货版:平仓交易 = 平多 + 平空)
   * @param {Array} trades         成交记录 [{action, realized, fee, ...}]
   * @param {Array} equityCurve    资产曲线 [{time, date, equity}]
   * @param {Number} initialCapital 初始资金
   * @param {Number} firstClose    复盘起点收盘价(用于买入持有对比)
   * @param {Number} lastPrice     当前(最新)收盘价
   */
  function computeStats(trades, equityCurve, initialCapital, firstClose, lastPrice) {
    const closed = trades.filter(function (t) { return t.action === 'close_long' || t.action === 'close_short'; });
    const wins = closed.filter(function (t) { return t.realized > 0; });
    const losses = closed.filter(function (t) { return t.realized < 0; });
    const grossWin = wins.reduce(function (s, t) { return s + t.realized; }, 0);
    const grossLoss = Math.abs(losses.reduce(function (s, t) { return s + t.realized; }, 0));

    // 最大回撤(基于资产曲线)
    let peak = -Infinity, maxDD = 0, maxDDPct = 0;
    for (const p of equityCurve) {
      if (p.equity > peak) peak = p.equity;
      const dd = peak - p.equity;
      if (dd > maxDD) {
        maxDD = dd;
        maxDDPct = peak > 0 ? dd / peak : 0;
      }
    }

    const finalEquity = equityCurve.length
      ? equityCurve[equityCurve.length - 1].equity
      : initialCapital;

    return {
      tradeCount: trades.length,
      closedCount: closed.length,
      longClosed: closed.filter(function (t) { return t.action === 'close_long'; }).length,
      shortClosed: closed.filter(function (t) { return t.action === 'close_short'; }).length,
      winRate: closed.length ? wins.length / closed.length : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
      avgWin: wins.length ? grossWin / wins.length : null,
      avgLoss: losses.length ? -grossLoss / losses.length : null,
      maxDrawdown: maxDD,
      maxDrawdownPct: maxDDPct,
      fees: trades.reduce(function (s, t) { return s + t.fee; }, 0),
      realized: closed.reduce(function (s, t) { return s + t.realized; }, 0),
      finalEquity: finalEquity,
      totalReturn: (finalEquity - initialCapital) / initialCapital,
      buyHoldReturn: firstClose > 0 && lastPrice > 0 ? (lastPrice - firstClose) / firstClose : null
    };
  }

  /* 将画布尺寸对齐 CSS 尺寸(处理高分屏) */
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 280;
    const h = canvas.clientHeight || 90;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  /* 绘制资产曲线(含初始资金基准线与收益率标注) */
  function drawEquityCurve(canvas, curve, initial, colors) {
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#11151f';
    ctx.fillRect(0, 0, w, h);
    if (!curve || curve.length < 2) {
      ctx.fillStyle = '#5c6784';
      ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('资产曲线(开始回放后生成)', w / 2, h / 2);
      return;
    }
    colors = colors || { up: '#ef5350', down: '#26a69a' };
    let min = Infinity, max = -Infinity;
    for (const p of curve) {
      if (p.equity < min) min = p.equity;
      if (p.equity > max) max = p.equity;
    }
    min = Math.min(min, initial);
    max = Math.max(max, initial);
    const pad = (max - min) * 0.12 || max * 0.02;
    min -= pad; max += pad;
    const xOf = function (i) { return 6 + (w - 12) * (i / (curve.length - 1)); };
    const yOf = function (v) { return h - 8 - (h - 16) * ((v - min) / (max - min)); };

    // 初始资金基准线
    ctx.strokeStyle = '#5c6784';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(yOf(initial)) + 0.5);
    ctx.lineTo(w, Math.round(yOf(initial)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    const lastEq = curve[curve.length - 1].equity;
    const color = lastEq >= initial ? colors.up : colors.down;

    // 面积填充
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(curve[0].equity));
    for (let i = 1; i < curve.length; i++) ctx.lineTo(xOf(i), yOf(curve[i].equity));
    ctx.lineTo(xOf(curve.length - 1), h);
    ctx.lineTo(xOf(0), h);
    ctx.closePath();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;

    // 折线
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(curve[0].equity));
    for (let i = 1; i < curve.length; i++) ctx.lineTo(xOf(i), yOf(curve[i].equity));
    ctx.stroke();

    // 收益率标注
    const ret = (lastEq - initial) / initial;
    ctx.fillStyle = color;
    ctx.font = 'bold 12px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText((ret >= 0 ? '+' : '') + (ret * 100).toFixed(2) + '%', w - 8, 16);
  }

  /* 交易记录导出为CSV文本(期货版) */
  function tradesToCSV(trades) {
    const head = '时间,操作,价格,手数,成交额(元),手续费(元),平仓盈亏(元)';
    const rows = trades.map(function (t) {
      return [
        t.date,
        ACTION_NAMES[t.action] || t.action,
        t.price,
        t.lots,
        t.amount.toFixed(2),
        t.fee.toFixed(2),
        t.realized != null ? t.realized.toFixed(2) : ''
      ].join(',');
    });
    return [head].concat(rows).join('\n');
  }

  global.KReview = {
    computeStats: computeStats,
    fitCanvas: fitCanvas,
    drawEquityCurve: drawEquityCurve,
    tradesToCSV: tradesToCSV,
    ACTION_NAMES: ACTION_NAMES,
    isBuySide: isBuySide
  };
})(window);
