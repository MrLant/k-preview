/* 数据模块:期货分钟行情生成、周期聚合(1/5/30分钟)、CSV/JSON 导入解析 */
(function (global) {
  'use strict';

  /* 国内常见期货品种预设:乘数/保证金率/每手手续费/基准价/最小变动价位,参数贴近实盘量级 */
  const FUTURES_PRESETS = [
    { code: 'RB', name: '螺纹钢', mult: 10, marginRate: 0.13, feePerLot: 4.0, price: 3600, tick: 1, vol: 0.0011 },
    { code: 'HC', name: '热轧卷板', mult: 10, marginRate: 0.13, feePerLot: 4.2, price: 3800, tick: 1, vol: 0.0011 },
    { code: 'I', name: '铁矿石', mult: 100, marginRate: 0.15, feePerLot: 7.5, price: 820, tick: 0.5, vol: 0.0016 },
    { code: 'CU', name: '沪铜', mult: 5, marginRate: 0.12, feePerLot: 12.5, price: 72000, tick: 10, vol: 0.0009 },
    { code: 'AL', name: '沪铝', mult: 5, marginRate: 0.12, feePerLot: 5.0, price: 19500, tick: 5, vol: 0.0009 },
    { code: 'AU', name: '沪金', mult: 1000, marginRate: 0.10, feePerLot: 10.0, price: 560, tick: 0.02, vol: 0.0008 },
    { code: 'AG', name: '沪银', mult: 15, marginRate: 0.12, feePerLot: 6.0, price: 7200, tick: 1, vol: 0.0013 },
    { code: 'M', name: '豆粕', mult: 10, marginRate: 0.12, feePerLot: 3.0, price: 3100, tick: 1, vol: 0.0010 },
    { code: 'P', name: '棕榈油', mult: 10, marginRate: 0.12, feePerLot: 2.5, price: 8600, tick: 2, vol: 0.0012 },
    { code: 'IF', name: '沪深300股指', mult: 300, marginRate: 0.12, feePerLot: 28.0, price: 3900, tick: 0.2, vol: 0.0007 }
  ];

  /* 白盘交易时段:[起始分钟, 1分钟K线根数] 9:00-10:15 / 10:30-11:30 / 13:30-15:00,共225根/交易日 */
  const SESSIONS = [[540, 75], [630, 60], [810, 90]];

  /* 价格贴合最小变动价位 */
  function snap(v, tick) {
    if (!(tick > 0)) tick = 1;
    const r = Math.round(v / tick) * tick;
    return parseFloat(r.toPrecision(12));
  }

  /**
   * 创建有状态的随机行情生成器:价格/趋势/波动状态延续,可多次调用 generateDays 增量生成
   * @param {Object} opts {preset, seed}
   * 返回 {preset, generateDays(n), lastTime}
   */
  function createMarketSim(opts) {
    opts = opts || {};
    const preset = opts.preset || FUTURES_PRESETS[0];
    let seed = (opts.seed != null ? opts.seed : Date.now()) >>> 0;
    const rnd = function () {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const gauss = function () {
      let u = 0, v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const baseVol = preset.vol || 0.001;
    let price = preset.price;
    let trend = 0;
    let vol = baseVol;
    let lastTime = null; // 已生成的最后一根1分钟K线时间(null=尚未开始)

    /* 生成一个交易日的全部1分钟K线(从当前价格状态延续),自带 dateStr */
    function genDay(dayStart) {
      const bars = [];
      for (const ses of SESSIONS) {
        const startMin = ses[0], count = ses[1];
        for (let k = 0; k < count; k++) {
          const t = dayStart + (startMin + k) * 60000;
          if (rnd() < 0.004) trend = (rnd() - 0.5) * baseVol * 0.35; // 偶发切换趋势
          vol = Math.max(baseVol * 0.45, vol * 0.985 + Math.abs(gauss()) * baseVol * 0.02);
          const change = trend + gauss() * vol;
          const open = price;
          const close = Math.max(preset.tick, open * (1 + change));
          const wick = rnd() * vol * 0.9;
          const high = Math.max(open, close) * (1 + wick * 0.6);
          const low = Math.min(open, close) * (1 - wick * 0.6);
          const volume = Math.round(80 + rnd() * 300 + Math.abs(change) / vol * 120);
          bars.push({
            time: t,
            open: snap(open, preset.tick),
            high: snap(high, preset.tick),
            low: snap(low, preset.tick),
            close: snap(close, preset.tick),
            volume: volume,
            dateStr: Utils.fmtDateTime(t)
          });
          price = close;
          lastTime = t;
        }
      }
      return bars;
    }

    /* from 之后的下一个交易日0点(跳过周末) */
    function nextDayStart(from) {
      let d = new Date(from);
      d.setHours(0, 0, 0, 0);
      do { d = new Date(d.getTime() + 864e5); } while (d.getDay() === 0 || d.getDay() === 6);
      return d.getTime();
    }

    /**
     * 增量生成 n 个交易日的1分钟K线:
     * 首次调用从若干天前起凑满 n 个交易日;之后每次从上次结束的下一交易日继续,
     * 价格与趋势/波动状态延续(用于"先看2天走势、后续数据无限生成"的回放模式)
     */
    function generateDays(n) {
      n = n || 1;
      const out = [];
      if (lastTime == null) {
        let day = new Date();
        day.setHours(0, 0, 0, 0);
        day = new Date(day.getTime() - Math.ceil(n * 1.5) * 864e5);
        let made = 0;
        while (made < n) {
          if (day.getDay() !== 0 && day.getDay() !== 6) {
            const dayBars = genDay(day.getTime());
            for (const b of dayBars) out.push(b);
            made++;
          }
          day = new Date(day.getTime() + 864e5);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const dayBars = genDay(nextDayStart(lastTime));
          for (const b of dayBars) out.push(b);
        }
      }
      return out;
    }

    return {
      preset: preset,
      generateDays: generateDays,
      get lastTime() { return lastTime; }
    };
  }

  /**
   * 一次性生成随机1分钟期货K线(基于 createMarketSim 的兼容包装,生成后状态即丢弃)
   * @param {Object} opts {days, preset, seed}
   */
  function generateRandomMinuteBars(opts) {
    opts = opts || {};
    const sim = createMarketSim(opts);
    const bars = sim.generateDays(opts.days || 2);
    if (bars.length < 60) throw new Error('有效K线不足 60 根,无法回放');
    return bars;
  }

  /* 依据品种预设生成主力合约代码:品种代码 + 年份后两位 + 3个月后的月份(如 RB2612) */
  function contractCode(preset) {
    const now = new Date();
    const mm = Utils.pad2(((now.getMonth() + 3) % 12) + 1);
    return preset.code + String(now.getFullYear()).slice(2) + mm;
  }

  /* 随机生成一个演示期货合约(品种 + 合约月份代码) */
  function randomFuturesSymbol() {
    const p = FUTURES_PRESETS[Math.floor(Math.random() * FUTURES_PRESETS.length)];
    return { name: p.name, code: contractCode(p), preset: p };
  }

  /**
   * 周期聚合:将1分钟K线按每 n 分钟聚合成更大周期
   * 时段边界检测(相邻K线时间差 > 90秒视为跨时段/跨日),每时段内从第一根起每 n 根一组,
   * 与行情软件的分段对齐方式一致(如30分钟:9:00-9:30, 9:30-10:00, 10:00-10:15,...)
   */
  function aggregate(bars, n) {
    if (!n || n <= 1) return bars.slice();
    const out = [];
    let grp = null;
    let prevTime = null;
    const pushGrp = function () {
      if (grp) {
        grp.dateStr = Utils.fmtDateTime(grp.time);
        out.push(grp);
      }
    };
    for (const b of bars) {
      const newSession = prevTime == null || b.time - prevTime > 90000;
      if (newSession || grp.count >= n) {
        pushGrp();
        grp = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, count: 0 };
      }
      grp.high = Math.max(grp.high, b.high);
      grp.low = Math.min(grp.low, b.low);
      grp.close = b.close;
      grp.volume += b.volume;
      grp.count++;
      prevTime = b.time;
    }
    pushGrp();
    return out;
  }

  /* 解析数字文本:兼容千分位逗号与"万/亿"后缀 */
  function parseNumber(s) {
    if (typeof s === 'number') return s;
    if (s == null) return NaN;
    s = String(s).trim().replace(/,/g, '');
    let mul = 1;
    if (/万$/.test(s)) { mul = 1e4; s = s.replace(/万$/, ''); }
    else if (/亿$/.test(s)) { mul = 1e8; s = s.replace(/亿$/, ''); }
    if (s === '' || s === '-') return NaN;
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n * mul;
  }

  /* 解析日期时间:支持时间戳(秒/毫秒)、YYYY-MM-DD [HH:mm[:ss]]、YYYY/MM/DD、YYYYMMDD 等 */
  function parseDateToken(s) {
    if (typeof s === 'number') {
      if (s > 1e12) return s;
      if (s > 1e9) return s * 1000;
      return NaN;
    }
    if (s == null) return NaN;
    s = String(s).trim();
    if (/^\d{13}$/.test(s)) return +s;
    if (/^\d{10}$/.test(s)) return +s * 1000;
    let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (m) return new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?$/);
    if (m) return new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
    const t = Date.parse(s);
    return isNaN(t) ? NaN : t;
  }

  /**
   * 规范化K线数组:过滤无效行、修正高低价、按时间升序、去重、附 dateStr(分钟级)
   */
  function normalizeBars(raw) {
    const valid = [];
    for (const r of raw || []) {
      const time = r.time;
      const open = +r.open, close = +r.close;
      if (!isFinite(time) || !isFinite(open) || !isFinite(close) || open <= 0 || close <= 0) continue;
      let high = +r.high, low = +r.low;
      if (!isFinite(high)) high = Math.max(open, close);
      if (!isFinite(low)) low = Math.min(open, close);
      high = Math.max(open, close, high);
      low = Math.min(open, close, low);
      const volume = isFinite(+r.volume) ? +r.volume : 0;
      valid.push({
        time: time,
        open: parseFloat(open.toPrecision(12)),
        high: parseFloat(high.toPrecision(12)),
        low: parseFloat(low.toPrecision(12)),
        close: parseFloat(close.toPrecision(12)),
        volume: Math.max(0, volume)
      });
    }
    if (valid.length < 60) throw new Error('有效K线不足 60 根,无法回放');
    valid.sort((a, b) => a.time - b.time);
    const bars = [];
    for (const b of valid) {
      if (bars.length && bars[bars.length - 1].time === b.time) bars[bars.length - 1] = b;
      else bars.push(b);
    }
    for (const b of bars) b.dateStr = Utils.fmtDateTime(b.time);
    return bars;
  }

  /* 依据表头关键字定位列序号 */
  function mapColumns(header) {
    const find = function (names) {
      return header.findIndex(function (h) {
        return names.some(function (n) { return h.indexOf(n) >= 0; });
      });
    };
    const date = find(['date', 'time', 'datetime', '日期', '时间']);
    const open = find(['open', '开盘']);
    const high = find(['high', '最高']);
    const low = find(['low', '最低']);
    const close = find(['close', '收盘']);
    let volume = find(['volume', 'vol', '成交量', '持仓']);
    if (date < 0 || open < 0 || high < 0 || low < 0 || close < 0) {
      throw new Error('表头缺少必要列(需要包含:日期时间/开盘/最高/最低/收盘)');
    }
    if (volume < 0) volume = -1;
    return { date: date, open: open, high: high, low: low, close: close, volume: volume };
  }

  /* 解析CSV文本 */
  function parseCSV(text) {
    text = String(text).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) throw new Error('CSV 内容为空或只有一行');
    const delim = [',', '\t', ';']
      .map(function (d) { return { d: d, n: lines[0].split(d).length }; })
      .sort(function (a, b) { return b.n - a.n; })[0].d;
    const rows = lines.map(function (l) { return l.split(delim).map(function (s) { return s.trim(); }); });

    const first = rows[0];
    const looksHeader = first.some(function (c) {
      return c && isNaN(parseNumber(c)) && !/^\d{4}[-\/.]/.test(c) && !/^\d{8,}$/.test(c);
    });
    let cols, start;
    if (looksHeader) {
      cols = mapColumns(first.map(function (h) { return h.toLowerCase(); }));
      start = 1;
    } else {
      cols = { date: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
      start = 0;
    }
    const raw = [];
    for (let i = start; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 5) continue;
      raw.push({
        time: parseDateToken(row[cols.date]),
        open: parseNumber(row[cols.open]),
        high: parseNumber(row[cols.high]),
        low: parseNumber(row[cols.low]),
        close: parseNumber(row[cols.close]),
        volume: cols.volume >= 0 && row[cols.volume] != null ? parseNumber(row[cols.volume]) : 0
      });
    }
    return normalizeBars(raw);
  }

  /* 解析JSON文本:支持对象数组、[time,o,h,l,c,v]数组、字符串行 */
  function parseJSON(text) {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data
      : (data && Array.isArray(data.data)) ? data.data
      : (data && Array.isArray(data.bars)) ? data.bars
      : (data && Array.isArray(data.klines)) ? data.klines
      : null;
    if (!arr) throw new Error('JSON 需为K线数组,或包含 data/bars/klines 数组字段');
    const raw = arr.map(function (item) {
      if (typeof item === 'string') item = item.split(',');
      if (Array.isArray(item)) {
        return {
          time: parseDateToken(item[0]),
          open: parseNumber(item[1]), high: parseNumber(item[2]),
          low: parseNumber(item[3]), close: parseNumber(item[4]),
          volume: parseNumber(item[5])
        };
      }
      const o = item || {};
      const t = o.time != null ? o.time : (o.date != null ? o.date : (o.day != null ? o.day : (o.datetime != null ? o.datetime : o.timestamp)));
      return {
        time: parseDateToken(t),
        open: parseNumber(o.open), high: parseNumber(o.high),
        low: parseNumber(o.low), close: parseNumber(o.close),
        volume: parseNumber(o.volume != null ? o.volume : o.vol)
      };
    });
    return normalizeBars(raw);
  }

  global.KData = {
    FUTURES_PRESETS: FUTURES_PRESETS,
    createMarketSim: createMarketSim,
    generateRandomMinuteBars: generateRandomMinuteBars,
    randomFuturesSymbol: randomFuturesSymbol,
    contractCode: contractCode,
    aggregate: aggregate,
    parseCSV: parseCSV,
    parseJSON: parseJSON
  };
})(window);
