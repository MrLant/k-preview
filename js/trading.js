/* 期货交易模拟:双向持仓(多/空)、保证金占用、按手手续费、风险度强平 */
(function (global) {
  'use strict';

  class FuturesSim {
    /**
     * @param {Object} cfg
     *  initialCapital   初始资金(元)
     *  multiplier       合约乘数(每手对应的标的数量)
     *  marginRate       保证金率(小数,如 0.13 = 13%)
     *  feePerLot        每手手续费(元/手,开平均收)
     *  autoLiquidate    风险度达到 100% 时是否自动强平
     *
     * 记账模型:
     *  cash = 初始资金 + 已实现净盈亏(平仓毛盈亏 - 手续费) - 开仓手续费
     *  equity(动态权益) = cash + 浮动盈亏
     *  marginUsed = 多头保证金 + 空头保证金(按开仓均价计)
     *  available(可用资金) = equity - marginUsed
     *  riskRatio(风险度) = marginUsed / equity,达到 100% 触发强平
     */
    constructor(cfg) {
      this.cfg = Object.assign({
        initialCapital: 200000,
        multiplier: 10,
        marginRate: 0.13,
        feePerLot: 4,
        autoLiquidate: true
      }, cfg || {});
      this.reset();
    }

    reset() {
      this.cash = this.cfg.initialCapital;
      this.long = { qty: 0, avg: 0 };    // 多头持仓 {qty: 手数, avg: 开仓均价}
      this.short = { qty: 0, avg: 0 };   // 空头持仓
      this.trades = [];                  // [{time, date, action, price, lots, amount, fee, realized}]
      this.realizedPnl = 0;              // 已实现净盈亏(含手续费)
      this.totalFees = 0;
    }

    /* ================= 费用与保证金 ================= */

    fee(price, lots) { return this.cfg.feePerLot * lots; }

    marginFor(price, lots) { return price * lots * this.cfg.multiplier * this.cfg.marginRate; }

    marginUsed() {
      const m = this.cfg.multiplier * this.cfg.marginRate;
      return this.long.qty * this.long.avg * m + this.short.qty * this.short.avg * m;
    }

    /* ================= 账户查询 ================= */

    unrealized(p) {
      const mu = this.cfg.multiplier;
      return (p - this.long.avg) * this.long.qty * mu + (this.short.avg - p) * this.short.qty * mu;
    }

    equity(p) { return this.cash + this.unrealized(p); }

    available(p) { return this.equity(p) - this.marginUsed(); }

    riskRatio(p) {
      const e = this.equity(p);
      return e > 0 ? this.marginUsed() / e : Infinity;
    }

    /* 可用资金支持的最大开仓手数(保证金 + 手续费均需覆盖) */
    maxOpenLots(p) {
      if (!(p > 0)) return 0;
      const per = p * this.cfg.multiplier * this.cfg.marginRate + this.cfg.feePerLot;
      let lots = Math.floor(this.available(p) / per);
      while (lots > 0 && this.marginFor(p, lots) + this.fee(p, lots) > this.available(p) + 1e-6) lots--;
      return Math.max(0, lots);
    }

    /* ================= 开平仓 ================= */

    openLong(p, lots, time, dateStr) {
      lots = Math.floor(lots);
      if (!(p > 0) || !(lots > 0)) return { ok: false, msg: '请输入有效的开仓手数' };
      const fee = this.fee(p, lots);
      const margin = this.marginFor(p, lots);
      if (margin + fee > this.available(p) + 1e-6) {
        return { ok: false, msg: '可用资金不足,当前最大可开 ' + this.maxOpenLots(p) + ' 手' };
      }
      this.cash -= fee;
      this.totalFees += fee;
      const L = this.long;
      L.avg = (L.avg * L.qty + p * lots) / (L.qty + lots);
      L.qty += lots;
      const t = {
        time: time, date: dateStr, action: 'open_long', price: p, lots: lots,
        amount: p * lots * this.cfg.multiplier, fee: fee, realized: null
      };
      this.trades.push(t);
      return { ok: true, msg: '开多 ' + lots + ' 手 @ ' + Utils.fmtPrice(p) + ',占用保证金 ' + Utils.fmtNum(margin, 0) + ' 元', trade: t };
    }

    openShort(p, lots, time, dateStr) {
      lots = Math.floor(lots);
      if (!(p > 0) || !(lots > 0)) return { ok: false, msg: '请输入有效的开仓手数' };
      const fee = this.fee(p, lots);
      const margin = this.marginFor(p, lots);
      if (margin + fee > this.available(p) + 1e-6) {
        return { ok: false, msg: '可用资金不足,当前最大可开 ' + this.maxOpenLots(p) + ' 手' };
      }
      this.cash -= fee;
      this.totalFees += fee;
      const S = this.short;
      S.avg = (S.avg * S.qty + p * lots) / (S.qty + lots);
      S.qty += lots;
      const t = {
        time: time, date: dateStr, action: 'open_short', price: p, lots: lots,
        amount: p * lots * this.cfg.multiplier, fee: fee, realized: null
      };
      this.trades.push(t);
      return { ok: true, msg: '开空 ' + lots + ' 手 @ ' + Utils.fmtPrice(p) + ',占用保证金 ' + Utils.fmtNum(margin, 0) + ' 元', trade: t };
    }

    closeLong(p, lots, time, dateStr) {
      lots = Math.floor(lots);
      if (!(lots > 0)) return { ok: false, msg: '请输入有效的平仓手数' };
      if (this.long.qty <= 0) return { ok: false, msg: '当前无多头持仓' };
      if (lots > this.long.qty) return { ok: false, msg: '超出多头持仓(当前持有 ' + this.long.qty + ' 手)' };
      const fee = this.fee(p, lots);
      const gross = (p - this.long.avg) * lots * this.cfg.multiplier;
      this.cash += gross - fee;
      this.totalFees += fee;
      this.realizedPnl += gross - fee;
      this.long.qty -= lots;
      if (this.long.qty <= 0) this.long = { qty: 0, avg: 0 };
      const realized = gross - fee;
      const t = {
        time: time, date: dateStr, action: 'close_long', price: p, lots: lots,
        amount: p * lots * this.cfg.multiplier, fee: fee, realized: realized
      };
      this.trades.push(t);
      return { ok: true, msg: '平多 ' + lots + ' 手 @ ' + Utils.fmtPrice(p) + ',盈亏 ' + Utils.fmtSigned(realized) + ' 元', trade: t };
    }

    closeShort(p, lots, time, dateStr) {
      lots = Math.floor(lots);
      if (!(lots > 0)) return { ok: false, msg: '请输入有效的平仓手数' };
      if (this.short.qty <= 0) return { ok: false, msg: '当前无空头持仓' };
      if (lots > this.short.qty) return { ok: false, msg: '超出空头持仓(当前持有 ' + this.short.qty + ' 手)' };
      const fee = this.fee(p, lots);
      const gross = (this.short.avg - p) * lots * this.cfg.multiplier;
      this.cash += gross - fee;
      this.totalFees += fee;
      this.realizedPnl += gross - fee;
      this.short.qty -= lots;
      if (this.short.qty <= 0) this.short = { qty: 0, avg: 0 };
      const realized = gross - fee;
      const t = {
        time: time, date: dateStr, action: 'close_short', price: p, lots: lots,
        amount: p * lots * this.cfg.multiplier, fee: fee, realized: realized
      };
      this.trades.push(t);
      return { ok: true, msg: '平空 ' + lots + ' 手 @ ' + Utils.fmtPrice(p) + ',盈亏 ' + Utils.fmtSigned(realized) + ' 元', trade: t };
    }

    /* 以当前价全部平仓,返回消息列表 */
    closeAll(p, time, dateStr) {
      const msgs = [];
      if (this.long.qty > 0) {
        const r = this.closeLong(p, this.long.qty, time, dateStr);
        if (r.ok) msgs.push(r.msg);
      }
      if (this.short.qty > 0) {
        const r = this.closeShort(p, this.short.qty, time, dateStr);
        if (r.ok) msgs.push(r.msg);
      }
      return msgs;
    }

    /* 每根K线后的强平检查:风险度达到 100% 或权益不大于 0 时,以当前价全部平仓 */
    checkLiquidation(p, time, dateStr) {
      if (!this.cfg.autoLiquidate) return null;
      if (this.long.qty <= 0 && this.short.qty <= 0) return null;
      const ratio = this.riskRatio(p);
      if (ratio >= 1 || this.equity(p) <= 0) {
        this.closeAll(p, time, dateStr);
        return { msg: '风险度已达 ' + Math.round(ratio * 100) + '%,触发强制平仓', msgs: [] };
      }
      return null;
    }
  }

  global.FuturesSim = FuturesSim;
})(window);
