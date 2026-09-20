/* 回放引擎:基于定时器的逐根推进、播放/暂停/单步/变速/跳转 */
(function (global) {
  'use strict';

  class ReplayPlayer {
    /**
     * @param {Object} opts
     * @param {Function} opts.onTick   (index) 每当回放位置变化时触发
     * @param {Function} opts.onState  (playing) 播放/暂停状态变化
     * @param {Function} opts.onEnd    播放到最后一根时触发
     */
    constructor(opts) {
      this.onTick = opts.onTick || null;
      this.onState = opts.onState || null;
      this.onEnd = opts.onEnd || null;
      this.index = 0;
      this.total = 0;
      this.playing = false;
      this.speed = 1;          // 倍速
      this.baseInterval = 700; // 1x 时每根K线的毫秒数
      this._timer = null;      // setTimeout 定时器(不依赖 rAF,受限环境也能推进)
      this._lastT = 0;
      this._acc = 0;
      this._loop = this._loop.bind(this);
    }

    load(total, startIndex) {
      this.pause();
      this.total = total;
      this.index = Utils.clamp(startIndex | 0, 0, Math.max(0, total - 1));
      this._acc = 0;
      if (this.onTick) this.onTick(this.index);
    }

    get interval() { return this.baseInterval / this.speed; }

    play() {
      if (this.playing || this.total === 0) return;
      if (this.index >= this.total - 1) return;
      this.playing = true;
      this._acc = 0;
      this._lastT = performance.now();
      this._loop();
      if (this.onState) this.onState(true);
    }

    pause() {
      if (!this.playing) return;
      this.playing = false;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      if (this.onState) this.onState(false);
    }

    toggle() { this.playing ? this.pause() : this.play(); }

    /* 单步推进(正数前进,负数后退) */
    step(delta) { this.setIndex(this.index + delta); }

    /* 更新总长度(无限回放追加数据场景):不打断播放、不触发 onTick、不重置计时 */
    setTotal(total) {
      this.total = Math.max(1, total | 0);
    }

    setIndex(i) {
      i = Utils.clamp(Math.round(i), 0, Math.max(0, this.total - 1));
      if (i === this.index) return;
      this.index = i;
      this._acc = 0;
      if (this.onTick) this.onTick(this.index);
    }

    setSpeed(s) {
      this.speed = s;
      this._acc = 0;
    }

    _loop() {
      if (!this.playing) return;
      const now = performance.now();
      const dt = now - this._lastT;
      this._lastT = now;
      this._acc += dt;
      const iv = this.interval;
      while (this._acc >= iv && this.index < this.total - 1) {
        this.index++;
        this._acc -= iv;
        if (this.onTick) this.onTick(this.index);
      }
      if (this.index >= this.total - 1) {
        this.pause();
        if (this.onEnd) this.onEnd();
        return;
      }
      // 轮询间隔:不超过半根K线时长,限制在 16~50ms
      this._timer = setTimeout(this._loop, Utils.clamp(iv / 2, 16, 50));
    }
  }

  global.ReplayPlayer = ReplayPlayer;
})(window);
