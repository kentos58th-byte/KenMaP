/* =========================================================
   心電図道場 — 波形エンジン / モニター / 音
   画像は使わず、P・Q・R・S・T をガウス曲線の足し合わせで作る。
   単位: 時間は秒、電位は mV。紙送りは 25mm/秒、10mm = 1mV。
   ========================================================= */
(function (global) {
  'use strict';

  const g = (x, mu, s, a) => { const d = (x - mu) / s; return a * Math.exp(-0.5 * d * d); };

  /* ---------- 1拍の時間配置 (拍の開始 = P波の立ち上がり付近) ---------- */
  function timing(rr) {
    const qt = Math.min(0.48, Math.max(0.30, 0.40 * Math.sqrt(rr))); // 心拍数に応じたQT
    const qrsOn = 0.16;
    const tPeak = qrsOn + qt - 0.09;
    return {
      pOn: 0.01, pPeak: 0.06, pOff: 0.11,
      qrsOn: qrsOn, rPeak: qrsOn + 0.035, qrsOff: qrsOn + 0.08,
      tOn: tPeak - 0.097, tPeak: tPeak, tOff: tPeak + 0.097,
      qt: qt
    };
  }

  /* ---------- 洞調律 1拍の形 ---------- */
  function beatShape(tau, rr) {
    if (tau < -0.05 || tau > 0.9) return 0;
    const t = timing(rr);
    let v = 0;
    v += g(tau, t.pPeak, 0.022, 0.15);           // P
    v += g(tau, t.qrsOn + 0.012, 0.007, -0.10);  // Q
    v += g(tau, t.rPeak, 0.009, 1.10);           // R
    v += g(tau, t.qrsOn + 0.057, 0.009, -0.28);  // S
    v += g(tau, t.tPeak, 0.042, 0.32);           // T
    return v;
  }

  /* 規則的な洞調律の電位 (静止図用・状態なし) */
  function sinusAt(t, hr, offset) {
    const rr = 60 / hr;
    const s = t - (offset || 0);
    const k = Math.floor(s / rr);
    const tau = s - k * rr;
    return beatShape(tau, rr) + beatShape(tau + rr, rr) + beatShape(tau - rr, rr);
  }

  /* VF: 不規則で振幅の揺れる波 */
  function vfAt(t) {
    const env = 0.55 + 0.35 * Math.sin(2 * Math.PI * 0.27 * t) + 0.1 * Math.sin(2 * Math.PI * 0.71 * t);
    const w = 0.42 * Math.sin(2 * Math.PI * 5.3 * t + 0.6 * Math.sin(2 * Math.PI * 0.9 * t))
            + 0.22 * Math.sin(2 * Math.PI * 7.4 * t + 1.3)
            + 0.14 * Math.sin(2 * Math.PI * 3.1 * t + 0.4);
    return env * w;
  }
  /* 心静止: ほぼ平坦 (わずかな基線の揺れ) */
  function asystoleAt(t) {
    return 0.025 * Math.sin(2 * Math.PI * 0.23 * t) + 0.01 * Math.sin(2 * Math.PI * 1.7 * t);
  }

  const ALARM_RHYTHMS = ['vf', 'asystole'];

  /* ---------- 連続生成器 (モニター用・心拍数を途中で変えても途切れない) ---------- */
  class Generator {
    constructor(hr, rhythm) {
      this.hr = hr; this.rhythm = rhythm || 'sinus';
      this.beatStart = 0; this.rr = 60 / hr;
      this.prevStart = -10; this.prevRR = this.rr;
      this.rFired = false;
    }
    setHR(hr) { this.hr = hr; }
    setRhythm(r) { this.rhythm = r; }
    /* t(秒) の電位を返す。R波を通過したら onR を呼ぶ */
    sample(t, onR) {
      if (this.rhythm === 'vf') return vfAt(t);
      if (this.rhythm === 'asystole') return asystoleAt(t);
      while (t >= this.beatStart + this.rr) {
        this.prevStart = this.beatStart; this.prevRR = this.rr;
        this.beatStart += this.rr;
        this.rr = 60 / this.hr;
        this.rFired = false;
      }
      const tau = t - this.beatStart;
      if (!this.rFired && tau >= timing(this.rr).rPeak) { this.rFired = true; if (onR) onR(); }
      return beatShape(tau, this.rr) + beatShape(t - this.prevStart, this.prevRR);
    }
  }

  /* =========================================================
     音 (Web Audio API) — 最初は消音。ボタンを押したときに初めて準備する
     ========================================================= */
  const Sound = {
    ctx: null, on: false, pitch: 880, alarmTimer: null, listeners: [],
    ensure() {
      if (!this.ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(freq, dur, type, vol, when) {
      const ctx = this.ensure(); if (!ctx) return;
      const t0 = ctx.currentTime + (when || 0);
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      gn.gain.setValueAtTime(0.0001, t0);
      gn.gain.exponentialRampToValueAtTime(vol || 0.25, t0 + 0.008);
      gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(gn).connect(ctx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    },
    beep() { if (this.on && !this.alarmTimer) this.tone(this.pitch, 0.075, 'sine', 0.22); },
    test() { this.ensure(); this.tone(this.pitch, 0.09, 'sine', 0.22); },
    alarmStart() {
      if (this.alarmTimer || !this.on) return;
      const ring = () => {
        this.tone(988, 0.16, 'triangle', 0.2, 0);
        this.tone(784, 0.16, 'triangle', 0.2, 0.2);
        this.tone(988, 0.16, 'triangle', 0.2, 0.4);
      };
      ring(); this.alarmTimer = setInterval(ring, 1400);
    },
    alarmStop() { if (this.alarmTimer) { clearInterval(this.alarmTimer); this.alarmTimer = null; } },
    setOn(v) {
      this.on = v;
      if (v) this.ensure(); else this.alarmStop();
      this.listeners.forEach(f => f(v));
    },
    onChange(f) { this.listeners.push(f); }
  };

  /* =========================================================
     ベッドサイドモニター (canvas スイープ表示)
     ========================================================= */
  const monitors = new Set();
  class Monitor {
    constructor(canvas, opts) {
      opts = opts || {};
      this.canvas = canvas; this.ctx = canvas.getContext('2d');
      this.gen = new Generator(opts.hr || 75, opts.rhythm || 'sinus');
      this.secondsOnScreen = opts.seconds || 4;
      this.onBeat = opts.onBeat || null;
      this.color = '#3DFF8E';
      this.running = false; this.visible = true;
      this.simT = 0; this.x = 0; this.lastY = null; this.lastFrame = null;
      this._frame = this._frame.bind(this);
      this.resize();
      this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(canvas);
      if ('IntersectionObserver' in global) {
        this._io = new IntersectionObserver(es => { this.visible = es[0].isIntersecting; if (this.visible) this._kick(); });
        this._io.observe(canvas);
      }
      monitors.add(this);
      this._updateAlarm();
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      if (!r.width) return;
      this.w = r.width; this.h = r.height; this.dpr = dpr;
      this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.pxPerSec = this.w / this.secondsOnScreen;
      this.baseline = this.h * 0.64; this.pxPerMv = this.h * 0.38;
      this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.w, this.h);
      this.x = 0; this.lastY = null;
    }
    setHR(hr) { this.gen.setHR(hr); }
    setRhythm(r) { this.gen.setRhythm(r); this._updateAlarm(); }
    _updateAlarm() {
      if (ALARM_RHYTHMS.includes(this.gen.rhythm) && this.running) Sound.alarmStart();
      else if (![...monitors].some(m => m.running && ALARM_RHYTHMS.includes(m.gen.rhythm))) Sound.alarmStop();
    }
    start() { if (this.running) return; this.running = true; this.lastFrame = null; this._kick(); this._updateAlarm(); }
    stop() { this.running = false; this._updateAlarm(); }
    destroy() { this.stop(); monitors.delete(this); this._ro && this._ro.disconnect(); this._io && this._io.disconnect(); this._updateAlarm(); }
    _kick() { if (this.running && !this._raf) this._raf = requestAnimationFrame(this._frame); }
    _frame(now) {
      this._raf = null;
      if (!this.running || !this.visible || document.hidden || !this.w) { this.lastFrame = null; return; }
      if (this.lastFrame == null) this.lastFrame = now;
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this._advance(dt);
      this._raf = requestAnimationFrame(this._frame);
    }
    _advance(dt) {
      const c = this.ctx, step = 1; // 1px ごとに計算
      let px = dt * this.pxPerSec;
      c.lineWidth = 2; c.lineJoin = 'round'; c.lineCap = 'round'; c.strokeStyle = this.color;
      c.shadowColor = 'rgba(61,255,142,.55)'; c.shadowBlur = 4;
      while (px > 0) {
        const d = Math.min(step, px); px -= d;
        this.simT += d / this.pxPerSec;
        const v = this.gen.sample(this.simT, () => { Sound.beep(); if (this.onBeat) this.onBeat(); });
        const y = this.baseline - v * this.pxPerMv;
        const nx = this.x + d;
        // 描いた先を少し消す (スイープの消去帯)
        c.shadowBlur = 0; c.fillStyle = '#000';
        c.fillRect(Math.floor(nx), 0, 14, this.h);
        if (nx + 14 > this.w) c.fillRect(0, 0, nx + 14 - this.w, this.h);
        c.shadowBlur = 4;
        if (this.lastY != null) { c.beginPath(); c.moveTo(this.x, this.lastY); c.lineTo(nx, y); c.stroke(); }
        this.x = nx; this.lastY = y;
        if (this.x >= this.w) { this.x = 0; this.lastY = null; }
      }
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) Sound.alarmStop();
    monitors.forEach(m => { m._updateAlarm(); m._kick(); });
  });

  /* =========================================================
     静止図 (SVG) 用ヘルパー
     ========================================================= */
  /* 心電図の path を作る。x0: 開始x(px), pxPerSec, baseline(px), pxPerMv, t0..t1(秒) */
  function svgPath(fn, o) {
    const n = Math.max(2, Math.ceil((o.t1 - o.t0) * o.pxPerSec / (o.res || 1)));
    let d = '';
    for (let i = 0; i <= n; i++) {
      const t = o.t0 + (o.t1 - o.t0) * i / n;
      const x = (o.x0 || 0) + (t - o.t0) * o.pxPerSec;
      const y = o.baseline - fn(t) * o.pxPerMv;
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return d;
  }
  /* 方眼紙の pattern (pxPerMm で 1mm の大きさ) */
  let gridId = 0;
  function gridDefs(pxPerMm) {
    const id = 'ecg-grid-' + (++gridId);
    const s = pxPerMm, L = s * 5;
    return {
      id: id,
      defs: '<defs>'
        + '<pattern id="' + id + '-s" width="' + s + '" height="' + s + '" patternUnits="userSpaceOnUse">'
        + '<path d="M' + s + ' 0V' + s + 'H0" fill="none" stroke="#E9A99B" stroke-width="0.5"/></pattern>'
        + '<pattern id="' + id + '" width="' + L + '" height="' + L + '" patternUnits="userSpaceOnUse">'
        + '<rect width="' + L + '" height="' + L + '" fill="url(#' + id + '-s)"/>'
        + '<path d="M' + L + ' 0V' + L + 'H0" fill="none" stroke="#D2715E" stroke-width="1.1"/></pattern>'
        + '</defs>'
    };
  }

  global.ECG = { timing, beatShape, sinusAt, vfAt, asystoleAt, Generator, Monitor, Sound, svgPath, gridDefs, ALARM_RHYTHMS };
})(window);
