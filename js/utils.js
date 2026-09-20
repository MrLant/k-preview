/* 工具函数:格式化、取值辅助 */
(function (global) {
  'use strict';

  const Utils = {
    $: function (id) { return document.getElementById(id); },

    clamp: function (v, min, max) { return v < min ? min : v > max ? max : v; },

    pad2: function (n) { return n < 10 ? '0' + n : '' + n; },

    /* 时间戳 -> YYYY-MM-DD */
    fmtDate: function (ts) {
      const d = new Date(ts);
      return d.getFullYear() + '-' + Utils.pad2(d.getMonth() + 1) + '-' + Utils.pad2(d.getDate());
    },

    /* 时间戳 -> YYYY-MM-DD HH:mm(分钟级K线用) */
    fmtDateTime: function (ts) {
      const d = new Date(ts);
      return Utils.fmtDate(ts) + ' ' + Utils.pad2(d.getHours()) + ':' + Utils.pad2(d.getMinutes());
    },

    /* 价格显示:按量级自适应小数位 */
    fmtPrice: function (v) {
      if (v == null || !isFinite(v)) return '--';
      return v >= 10000 ? Number(v).toFixed(1) : Number(v).toFixed(2);
    },

    /* 千分位数字,默认保留2位小数 */
    fmtNum: function (v, d) {
      if (v == null || !isFinite(v)) return '--';
      d = d == null ? 2 : d;
      return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
    },

    /* 带符号金额 */
    fmtSigned: function (v, d) {
      if (v == null || !isFinite(v)) return '--';
      d = d == null ? 2 : d;
      return (v >= 0 ? '+' : '') + Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
    },

    /* 百分比(带符号),入参为小数 */
    fmtPct: function (v, d) {
      if (v == null || !isFinite(v)) return '--';
      d = d == null ? 2 : d;
      return (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
    },

    /* 成交量缩写:万 / 亿 */
    fmtVol: function (v) {
      if (v == null || !isFinite(v)) return '--';
      if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
      if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
      return String(Math.round(v));
    },

    /* 根据数值返回涨跌样式类名 */
    cls: function (v) { return v > 0 ? 'up' : v < 0 ? 'down' : ''; }
  };

  global.Utils = Utils;
})(window);
