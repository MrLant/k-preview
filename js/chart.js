/* 图表模块:Canvas 蜡烛图 + 均线 + 成交量 + 买卖标记 + 十字光标 + 缩放平移 */
(function (global) {
  'use strict';

  const FONT = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
  const MA_DEFS = [
    { period: 5, color: '#f5c542' },
    { period: 10, color: '#4fa3ff' },
    { period: 20, color: '#c77dff' },
    { period: 60, color: '#8b93a7' }
  ];

  function calcMA(bars, period) {
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= period) sum -= bars[i - period].close;
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  class KChart {
    constructor(canvas, tooltip) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.tooltip = tooltip || null;
      this.bars = [];
      this.ma = {};
      this.cursor = -1;        // 当前回放位置(已揭示的最后一根)
      this.viewStart = 0;      // 可见窗口起始索引
      this.barWidth = 7;       // 每根K线占宽(像素)
      this.rightAxisW = 64;
      this.bottomAxisH = 22;
      this.volRatio = 0.18;    // 成交量副图高度占比
      this.markers = [];       // [{index, side: open_long/open_short/close_long/close_short, price}]
      this.costLines = { long: null, short: null };  // 多/空持仓成本线
      this.showMA = true;
      this.flip = false;       // false=红涨绿跌 true=绿涨红跌
      this.hover = null;       // {index, x, y}
      this.linkedHover = null; // 联动十字光标 {time, price|null}(由其他窗口同步)
      this.onHoverChange = null; // 本窗口光标变化回调(用于多窗联动)
      this.legendLimit = 0;    // 均线图例最多显示条数(0=全部,多窗小图可设2)
      this._liveIdx = null;        // "进行中"K线所在索引(截断聚合,随回放逐步成形)
      this._liveOriginal = null;   // 被替换前的完整聚合K线(切换位置时恢复)
      this._range = { hi: 1, lo: 0, vMax: 1 };
      this._drag = null;
      this._raf = null;
      this._fallbackTimer = null;
      this.w = 0; this.h = 0; this.dpr = 1;
      this._bindEvents();
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas.parentElement);
      this._resize();
    }

    /* ================= 对外接口 ================= */

    setData(bars) {
      this.bars = bars.slice(); // 复制一份:内部live替换不污染外部聚合缓存
      this._liveIdx = null;
      this._liveOriginal = null;
      this.ma = {};
      for (const def of MA_DEFS) this.ma[def.period] = calcMA(this.bars, def.period);
      this.cursor = bars.length - 1;
      this.viewStart = Math.max(0, this.cursor - Math.floor(this.plotW / this.barWidth) + 8);
      this.hover = null;
      this._hideTooltip();
      this.requestDraw();
    }

    /* 设置"进行中"K线(多周期回放:截至当前时刻的截断聚合,不泄露未来):
       idx 处替换为 bar;原完整K线自动暂存,位置变化时恢复,保证历史K线始终完整 */
    setLiveBar(idx, bar) {
      if (idx < 0 || idx >= this.bars.length || !bar) return;
      if (this._liveIdx != null && this._liveIdx !== idx) {
        this.bars[this._liveIdx] = this._liveOriginal;
      }
      if (this._liveIdx !== idx) {
        this._liveOriginal = this.bars[idx];
        this._liveIdx = idx;
      }
      this.bars[idx] = bar;
      this._recalcMA();
      this.requestDraw();
    }

    /* 清除进行中K线(恢复完整聚合形态) */
    clearLiveBar() {
      if (this._liveIdx == null) return;
      this.bars[this._liveIdx] = this._liveOriginal;
      this._liveIdx = null;
      this._liveOriginal = null;
      this._recalcMA();
      this.requestDraw();
    }

    /* 全量重算均线(live替换/恢复后调用) */
    _recalcMA() {
      for (const def of MA_DEFS) this.ma[def.period] = calcMA(this.bars, def.period);
    }

    setCursor(i) {
      if (this.cursor === i) return;
      this.cursor = i;
      this._clampView();
      this.requestDraw();
    }

    setMarkers(m) { this.markers = m || []; this.requestDraw(); }

    /* 替换数据但保持当前视图与光标(无限回放追加数据场景):
       清除进行中K线还原完整形态,按光标K线时间在新数据中重定位,视图起始位置不动 */
    reloadData(bars) {
      const keepTime = this.cursor >= 0 && this.bars[this.cursor] ? this.bars[this.cursor].time : null;
      this.bars = bars.slice();
      this._liveIdx = null;
      this._liveOriginal = null;
      this._recalcMA();
      if (keepTime != null) this.cursor = this.indexForTime(keepTime);
      this._clampView();
      this.requestDraw();
    }

    setCostLines(lines) {
      const l = lines || {};
      this.costLines = {
        long: l.long != null && isFinite(l.long) ? l.long : null,
        short: l.short != null && isFinite(l.short) ? l.short : null
      };
      this.requestDraw();
    }
    setFlip(f) { this.flip = !!f; this.requestDraw(); }

    /* 播放时自动跟随:光标靠近右缘时前移;跳回历史(重置/回溯)光标将滑出左缘时后移 */
    follow() {
      if (this.cursor < 0) return;
      const visible = Math.max(5, Math.floor(this.plotW / this.barWidth));
      const desired = Math.max(0, this.cursor - visible + 10);
      if (desired > this.viewStart) {
        this.viewStart = desired;
      } else if (this.viewStart > this.cursor - 3) {
        this.viewStart = desired; // 光标快滑出左缘,视图回退
      } else {
        return;
      }
      this._clampView();
      this.requestDraw();
    }

    /* 双击:显示全部已揭示K线 */
    fitAll() {
      if (this.cursor < 0) return;
      this.barWidth = Utils.clamp(this.plotW / (this.cursor + 12), 2, 40);
      this.viewStart = 0;
      this.requestDraw();
    }

    /* ================= 几何与坐标 ================= */

    get plotW() { return Math.max(10, this.w - this.rightAxisW); }
    get plotH() { return Math.max(10, this.h - this.bottomAxisH); }
    get mainH() { return this.plotH * (1 - this.volRatio); }
    get volTop() { return this.mainH; }
    get volH() { return this.plotH * this.volRatio; }

    xOfIndex(i) { return (i - this.viewStart + 0.5) * this.barWidth; }

    /* 可见窗口最后一根(不超过回放光标,未来数据不可见) */
    viewEndIndex() {
      const byWidth = this.viewStart + Math.ceil(this.plotW / this.barWidth) - 1;
      return Math.min(this.cursor, byWidth, this.bars.length - 1);
    }

    priceToY(p) {
      const r = this._range;
      return (r.hi - p) / (r.hi - r.lo) * this.mainH;
    }

    yToPrice(y) {
      const r = this._range;
      return r.hi - y / this.mainH * (r.hi - r.lo);
    }

    upColor() { return this.flip ? '#26a69a' : '#ef5350'; }
    downColor() { return this.flip ? '#ef5350' : '#26a69a'; }

    _clampView() {
      if (this.cursor < 0) { this.viewStart = 0; return; }
      const maxStart = Math.max(0, Math.min(this.cursor, this.bars.length - 1));
      this.viewStart = Utils.clamp(this.viewStart, 0, maxStart);
    }

    /* 调度重绘:rAF 优先;若 rAF 受限不执行,120ms 后用定时器兜底 */
    requestDraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this.draw(); });
      if (this._fallbackTimer) clearTimeout(this._fallbackTimer);
      this._fallbackTimer = setTimeout(() => {
        this._fallbackTimer = null;
        if (this._raf != null) {  // rAF 尚未执行 -> 环境受限,立即绘制
          cancelAnimationFrame(this._raf);
          this._raf = null;
          this.draw();
        }
      }, 120);
    }

    _resize() {
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth, h = parent.clientHeight;
      if (!w || !h) return;
      this.dpr = window.devicePixelRatio || 1;
      this.w = w; this.h = h;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.requestDraw();
    }

    /* ================= 绘制主流程 ================= */

    draw() {
      const ctx = this.ctx;
      ctx.fillStyle = '#0d1017';
      ctx.fillRect(0, 0, this.w, this.h);
      if (!this.bars.length || this.cursor < 0) return this._drawEmpty('暂无数据');
      const vs = this.viewStart;
      const ve = this.viewEndIndex();
      if (ve < vs) return this._drawEmpty('拖动下方进度条开始回放');

      // 计算可见区间的价格/成交量范围
      let hi = -Infinity, lo = Infinity, vMax = 0;
      for (let i = vs; i <= ve; i++) {
        const b = this.bars[i];
        if (b.high > hi) hi = b.high;
        if (b.low < lo) lo = b.low;
        if (b.volume > vMax) vMax = b.volume;
      }
      if (this.costLines.long != null) {
        hi = Math.max(hi, this.costLines.long);
        lo = Math.min(lo, this.costLines.long);
      }
      if (this.costLines.short != null) {
        hi = Math.max(hi, this.costLines.short);
        lo = Math.min(lo, this.costLines.short);
      }
      const pad = (hi - lo) * 0.08 || hi * 0.02;
      hi += pad;
      lo = Math.max(0, lo - pad);
      if (!vMax) vMax = 1;
      this._range = { hi: hi, lo: lo, vMax: vMax };

      this._drawGrid(vs, ve, hi, lo);
      this._drawVolume(vs, ve);
      this._drawCandles(vs, ve);
      if (this.showMA) this._drawMA(vs, ve);
      this._drawCostLines();
      this._drawMarkers(vs, ve);
      this._drawLastPrice();
      this._drawAxes(vs, ve, hi, lo);
      this._drawHover();
      this._drawLinkedHover();
    }

    _drawEmpty(msg) {
      const ctx = this.ctx;
      ctx.fillStyle = '#5c6784';
      ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(msg, this.w / 2, this.h / 2);
    }

    /* 时间轴刻度间隔:约每 90px 一个标签,取整数刻度 */
    _timeStep() {
      const n = 90 / this.barWidth;
      const nice = [1, 2, 5, 10, 20, 50, 100, 200];
      for (const s of nice) if (s >= n) return s;
      return 200;
    }

    _fmtPrice(p) {
      if (p >= 10000) return p.toFixed(0);
      if (p >= 100) return p.toFixed(1);
      return p.toFixed(2);
    }

    _drawGrid(vs, ve, hi, lo) {
      const ctx = this.ctx;
      ctx.strokeStyle = '#1a2130';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 1; k < 5; k++) {
        const y = Math.round(k / 5 * this.mainH) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(this.plotW, y);
      }
      const vt = Math.round(this.volTop) + 0.5;
      ctx.moveTo(0, vt);
      ctx.lineTo(this.plotW, vt);
      const step = this._timeStep();
      for (let i = vs; i <= ve; i++) {
        if (i % step !== 0) continue;
        const x = Math.round(this.xOfIndex(i)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.plotH);
      }
      ctx.stroke();
    }

    _drawVolume(vs, ve) {
      const ctx = this.ctx;
      const up = this.upColor(), down = this.downColor();
      const w = Math.max(1, Math.floor(this.barWidth * 0.72) - (this.barWidth >= 6 ? 1 : 0));
      const base = this.plotH;
      const vMax = this._range.vMax;
      ctx.globalAlpha = 0.55;
      for (let i = vs; i <= ve; i++) {
        const b = this.bars[i];
        const h = b.volume / vMax * (this.volH * 0.9);
        ctx.fillStyle = b.close >= b.open ? up : down;
        ctx.fillRect(Math.round(this.xOfIndex(i) - w / 2), base - h, w, Math.max(1, h));
      }
      ctx.globalAlpha = 1;
    }

    _drawCandles(vs, ve) {
      const ctx = this.ctx;
      const bodyW = Math.max(1, Math.floor(this.barWidth * 0.72) - (this.barWidth >= 6 ? 1 : 0));
      const up = this.upColor(), down = this.downColor();
      for (let i = vs; i <= ve; i++) {
        const b = this.bars[i];
        const color = b.close >= b.open ? up : down;
        const x = this.xOfIndex(i);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        // 影线
        const xc = Math.round(x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xc, this.priceToY(b.high));
        ctx.lineTo(xc, this.priceToY(b.low));
        ctx.stroke();
        // 实体
        if (bodyW >= 2) {
          const yo = this.priceToY(b.open), yc = this.priceToY(b.close);
          const top = Math.min(yo, yc);
          const h = Math.max(1, Math.abs(yc - yo));
          ctx.fillRect(Math.round(x - bodyW / 2), Math.round(top), bodyW, Math.round(h));
        }
      }
    }

    _drawMA(vs, ve) {
      const ctx = this.ctx;
      ctx.lineWidth = 1;
      for (const def of MA_DEFS) {
        const arr = this.ma[def.period];
        if (!arr) continue;
        ctx.strokeStyle = def.color;
        ctx.beginPath();
        let started = false;
        for (let i = vs; i <= ve; i++) {
          const v = arr[i];
          if (v == null) { started = false; continue; }
          const x = this.xOfIndex(i), y = this.priceToY(v);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // 左上角均线图例(多窗小图可通过 legendLimit 限制条数防溢出)
      ctx.font = FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      let x = 8;
      let shown = 0;
      for (const def of MA_DEFS) {
        if (this.legendLimit > 0 && shown >= this.legendLimit) break;
        const last = this.ma[def.period][ve];
        const txt = 'MA' + def.period + ' ' + (last != null ? last.toFixed(2) : '--');
        ctx.fillStyle = def.color;
        ctx.fillText(txt, x, 14);
        x += ctx.measureText(txt).width + 14;
        shown++;
      }
    }

    /* 多/空持仓成本虚线(价格接近时标签自动错位) */
    _drawCostLines() {
      const ctx = this.ctx;
      const items = [];
      if (this.costLines.long != null) items.push({ p: this.costLines.long, color: '#f0b429', label: '多 ' });
      if (this.costLines.short != null) items.push({ p: this.costLines.short, color: '#4dd0e1', label: '空 ' });
      if (!items.length) return;
      const ys = items.map(it => Math.round(this.priceToY(it.p)) + 0.5);
      for (let k = 1; k < ys.length; k++) {
        if (Math.abs(ys[k] - ys[k - 1]) < 17) ys[k] = ys[k - 1] + 17;
      }
      items.forEach((it, k) => {
        const y = ys[k];
        ctx.strokeStyle = it.color;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(this.plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = it.label + Utils.fmtPrice(it.p);
        ctx.font = FONT;
        const w = ctx.measureText(label).width + 10;
        ctx.fillStyle = it.color;
        ctx.fillRect(this.plotW + 1, y - 8, Math.max(w, this.rightAxisW - 2), 16);
        ctx.fillStyle = '#0d1017';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, this.plotW + 6, y);
      });
    }

    /* 开平仓标记:买方向(开多/平空)在K线下方画上箭头,卖方向(开空/平多)在K线上方画下箭头;同根K线多个标记水平错开 */
    _drawMarkers(vs, ve) {
      const ctx = this.ctx;
      const STYLE = {
        open_long: { buy: true, label: '多开' },
        close_short: { buy: true, label: '空平' },
        open_short: { buy: false, label: '空开' },
        close_long: { buy: false, label: '多平' }
      };
      // 按K线索引分组
      const byIdx = {};
      for (const m of this.markers) {
        if (m.index < vs || m.index > ve) continue;
        (byIdx[m.index] = byIdx[m.index] || []).push(m);
      }
      for (const key in byIdx) {
        const idx = +key;
        const b = this.bars[idx];
        if (!b) continue;
        const list = byIdx[key];
        list.forEach((m, j) => {
          const st = STYLE[m.side] || { buy: true, label: '' };
          const x = this.xOfIndex(idx) + (j - (list.length - 1) / 2) * 15;
          const color = st.buy ? this.upColor() : this.downColor();
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.font = 'bold 9px "Segoe UI", "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          if (st.buy) {
            const y = this.priceToY(b.low) + 5;
            ctx.moveTo(x, y);
            ctx.lineTo(x - 5, y + 8);
            ctx.lineTo(x + 5, y + 8);
            ctx.closePath();
            ctx.fill();
            ctx.fillText(st.label, x, y + 19);
          } else {
            const y = this.priceToY(b.high) - 5;
            ctx.moveTo(x, y);
            ctx.lineTo(x - 5, y - 8);
            ctx.lineTo(x + 5, y - 8);
            ctx.closePath();
            ctx.fill();
            ctx.fillText(st.label, x, y - 11);
          }
        });
      }
    }

    /* 当前K线收盘价虚线与右轴价签 */
    _drawLastPrice() {
      const b = this.bars[this.cursor];
      if (!b) return;
      const ctx = this.ctx;
      const y = Math.round(this.priceToY(b.close)) + 0.5;
      const prev = this.bars[this.cursor - 1];
      const color = prev ? (b.close >= prev.close ? this.upColor() : this.downColor()) : this.upColor();
      ctx.strokeStyle = color;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillRect(this.plotW + 1, y - 8, this.rightAxisW - 2, 16);
      ctx.fillStyle = '#fff';
      ctx.font = FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(this._fmtPrice(b.close), this.plotW + 6, y);
    }

    /* 坐标轴:右侧价格刻度、底部日期、成交量参考值 */
    _drawAxes(vs, ve, hi, lo) {
      const ctx = this.ctx;
      ctx.fillStyle = '#0d1017';
      ctx.fillRect(this.plotW, 0, this.rightAxisW, this.h);
      ctx.fillRect(0, this.plotH, this.w, this.bottomAxisH);
      ctx.strokeStyle = '#1a2130';
      ctx.beginPath();
      ctx.moveTo(this.plotW + 0.5, 0);
      ctx.lineTo(this.plotW + 0.5, this.h);
      ctx.moveTo(0, this.plotH + 0.5);
      ctx.lineTo(this.w, this.plotH + 0.5);
      ctx.stroke();

      ctx.fillStyle = '#5c6784';
      ctx.font = FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let k = 0; k <= 5; k++) {
        const p = hi - (hi - lo) * k / 5;
        const y = Utils.clamp(k / 5 * this.mainH, 7, this.mainH - 7);
        ctx.fillText(this._fmtPrice(p), this.plotW + 6, y);
      }
      // 成交量峰值(加"量"前缀与价格刻度区分)
      ctx.fillStyle = '#48536e';
      ctx.fillText('量' + Utils.fmtVol(this._range.vMax), this.plotW + 6, this.volTop + this.volH / 2);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const step = this._timeStep();
      for (let i = vs; i <= ve; i++) {
        if (i % step !== 0) continue;
        const b = this.bars[i];
        ctx.fillStyle = '#5c6784';
        ctx.fillText(b.dateStr.slice(5), this.xOfIndex(i), this.plotH + 15);
      }
    }

    /* 十字光标与轴标签 */
    _drawHover() {
      if (!this.hover) return;
      const { index, x, y } = this.hover;
      const vs = this.viewStart, ve = this.viewEndIndex();
      if (index < vs || index > ve) return;
      const ctx = this.ctx;
      ctx.strokeStyle = '#6b7694';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      const xc = Math.round(this.xOfIndex(index)) + 0.5;
      ctx.moveTo(xc, 0);
      ctx.lineTo(xc, this.plotH);
      if (y != null && y >= 0 && y <= this.mainH) {
        const yc = Math.round(y) + 0.5;
        ctx.moveTo(0, yc);
        ctx.lineTo(this.plotW, yc);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      if (y != null && y >= 0 && y <= this.mainH) {
        ctx.fillStyle = '#2a3247';
        ctx.fillRect(this.plotW + 1, y - 8, this.rightAxisW - 2, 16);
        ctx.fillStyle = '#d7dce6';
        ctx.font = FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(this._fmtPrice(this.yToPrice(y)), this.plotW + 6, y);
      }
      const b = this.bars[index];
      if (b) {
        const tw = 110;
        const lx = Utils.clamp(xc, tw / 2, this.plotW - tw / 2);
        ctx.fillStyle = '#2a3247';
        ctx.fillRect(lx - tw / 2, this.plotH + 1, tw, this.bottomAxisH - 2);
        ctx.fillStyle = '#d7dce6';
        ctx.textAlign = 'center';
        ctx.fillText(b.dateStr, lx, this.plotH + 13);
      }
    }

    /* ================= 多窗联动 ================= */

    /* 二分查找:最后一根 time <= t 的K线索引 */
    indexForTime(t) {
      const bars = this.bars;
      if (!bars.length) return -1;
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

    /* 设置联动十字光标(info={time,price|null} 或 null 清除);与本地 hover 互斥 */
    setLinkedHover(info) {
      const sig = info ? info.time + '|' + (info.price != null ? info.price.toFixed(3) : '-') : null;
      if (this._linkedSig === sig) return;
      this._linkedSig = sig;
      this.linkedHover = info;
      this.requestDraw();
    }

    /* 联动十字光标绘制(来自其他窗口同步:同时间竖线+同价格横线,弱化样式,不弹提示框) */
    _drawLinkedHover() {
      if (this.hover || !this.linkedHover || !this.bars.length) return;
      const info = this.linkedHover;
      const i = this.indexForTime(info.time);
      if (i < 0) return;
      const vs = this.viewStart, ve = this.viewEndIndex();
      if (i < vs || i > ve) return;
      const ctx = this.ctx;
      ctx.strokeStyle = '#4a5570';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      const xc = Math.round(this.xOfIndex(i)) + 0.5;
      ctx.moveTo(xc, 0);
      ctx.lineTo(xc, this.plotH);
      let yc = null;
      if (info.price != null) {
        const y = Math.round(this.priceToY(info.price)) + 0.5;
        if (y >= 0 && y <= this.mainH) {
          yc = y;
          ctx.moveTo(0, y);
          ctx.lineTo(this.plotW, y);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (yc != null) {
        ctx.fillStyle = '#232b3d';
        ctx.fillRect(this.plotW + 1, yc - 8, this.rightAxisW - 2, 16);
        ctx.fillStyle = '#8b93a7';
        ctx.font = FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(this._fmtPrice(info.price), this.plotW + 6, yc);
      }
      const b = this.bars[i];
      if (b) {
        const tw = 110;
        const lx = Utils.clamp(xc, tw / 2, this.plotW - tw / 2);
        ctx.fillStyle = '#232b3d';
        ctx.fillRect(lx - tw / 2, this.plotH + 1, tw, this.bottomAxisH - 2);
        ctx.fillStyle = '#8b93a7';
        ctx.textAlign = 'center';
        ctx.fillText(b.dateStr, lx, this.plotH + 13);
      }
    }

    /* 向外发出本窗口光标状态(供多窗联动同步;null=离开) */
    _emitHover() {
      if (!this.onHoverChange) return;
      if (!this.hover || !this.bars[this.hover.index]) return this.onHoverChange(null);
      const y = this.hover.y;
      const price = (y != null && y >= 0 && y <= this.mainH) ? this.yToPrice(y) : null;
      this.onHoverChange({ time: this.bars[this.hover.index].time, price: price });
    }

    /* ================= 提示框 ================= */

    _updateTooltip(x, y) {
      if (!this.tooltip) return;
      const i = this.hover.index;
      const b = this.bars[i];
      if (!b) { this._hideTooltip(); return; }
      const prev = this.bars[i - 1];
      const chg = prev ? (b.close - prev.close) / prev.close : 0;
      const c1 = b.close >= b.open ? 'up' : 'down';
      const c2 = chg >= 0 ? 'up' : 'down';
      let maHtml = '';
      if (this.showMA) {
        maHtml = '<div class="tt-ma">' + MA_DEFS.map(function (d) {
          const v = this.ma[d.period][i];
          return '<span style="color:' + d.color + '">MA' + d.period + ':' + (v != null ? v.toFixed(2) : '--') + '</span>';
        }, this).join('') + '</div>';
      }
      this.tooltip.innerHTML =
        '<div class="tt-date">' + b.dateStr + '</div>' +
        '<div>开 <b class="' + c1 + '">' + b.open.toFixed(2) + '</b>　高 <b class="' + c1 + '">' + b.high.toFixed(2) + '</b></div>' +
        '<div>低 <b class="' + c1 + '">' + b.low.toFixed(2) + '</b>　收 <b class="' + c1 + '">' + b.close.toFixed(2) + '</b></div>' +
        '<div>涨跌 <b class="' + c2 + '">' + Utils.fmtPct(chg) + '</b>　量 <b>' + Utils.fmtVol(b.volume) + '</b></div>' +
        maHtml;
      this.tooltip.hidden = false;
      const bw = this.tooltip.offsetWidth || 180;
      const bh = this.tooltip.offsetHeight || 120;
      let left = x + 18;
      if (left + bw > this.w - 4) left = x - bw - 18;
      let top = y + 14;
      if (top + bh > this.h - 4) top = Math.max(4, y - bh - 14);
      this.tooltip.style.left = left + 'px';
      this.tooltip.style.top = top + 'px';
    }

    _hideTooltip() {
      if (this.tooltip) this.tooltip.hidden = true;
    }

    /* ================= 交互事件 ================= */

    _bindEvents() {
      const c = this.canvas;

      // 滚轮缩放(以鼠标位置为锚点)
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        if (mx > this.plotW || this.cursor < 0) return;
        const old = this.barWidth;
        this.barWidth = Utils.clamp(this.barWidth * (e.deltaY < 0 ? 1.18 : 1 / 1.18), 2, 40);
        if (this.barWidth !== old) {
          const anchorIdx = this.viewStart + mx / old - 0.5;
          this.viewStart = Math.round(anchorIdx + 0.5 - mx / this.barWidth);
          this._clampView();
          this.requestDraw();
        }
      }, { passive: false });

      // 拖拽平移
      c.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        this._drag = { x: e.clientX, start: this.viewStart };
        c.style.cursor = 'grabbing';
      });
      window.addEventListener('mousemove', (e) => {
        if (!this._drag) return;
        const dx = e.clientX - this._drag.x;
        const dBars = Math.round(-dx / this.barWidth);
        this.viewStart = this._drag.start + dBars;
        this._clampView();
        this.requestDraw();
      });
      window.addEventListener('mouseup', () => {
        if (!this._drag) return;
        this._drag = null;
        c.style.cursor = 'crosshair';
      });

      // 十字光标
      c.addEventListener('mousemove', (e) => {
        if (this._drag) return;
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        if (x > this.plotW || y > this.plotH || x < 0 || y < 0) {
          if (this.hover) { this.hover = null; this._hideTooltip(); this._emitHover(); this.requestDraw(); }
          return;
        }
        const i = Math.round(this.viewStart + x / this.barWidth - 0.5);
        const ve = this.viewEndIndex();
        if (i < this.viewStart || i > ve || !this.bars[i]) {
          if (this.hover) { this.hover = null; this._hideTooltip(); this._emitHover(); this.requestDraw(); }
          return;
        }
        this.hover = { index: i, x: x, y: y };
        this._updateTooltip(x, y);
        this._emitHover();
        this.requestDraw();
      });

      c.addEventListener('mouseleave', () => {
        this.hover = null;
        this._hideTooltip();
        this._emitHover();
        this.requestDraw();
      });

      c.addEventListener('dblclick', () => this.fitAll());
    }
  }

  global.KChart = KChart;
})(window);



