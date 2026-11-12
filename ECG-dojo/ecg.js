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

  /* ---------- 拍の種類ごとの形 (どの拍も「開始から0.195秒」にR波の頂点が来る) ---------- */
  const R_AT = 0.195;
  function shapeOf(kind, tau, rr) {
    if (tau < -0.05 || tau > 0.95) return 0;
    if (kind === 'n') return beatShape(tau, rr);
    if (kind === 'np') return beatShape(tau, rr) - g(tau, 0.06, 0.022, 0.15);          // P波なし (AF)
    if (kind === 'fl') {                                                               // P波なし・T波はF波に埋もれる (AFL)
      const T = timing(rr);
      return beatShape(tau, rr) - g(tau, 0.06, 0.022, 0.15) - g(tau, T.tPeak, 0.042, 0.22);
    }
    if (kind === 'pac') return beatShape(tau, rr) - g(tau, 0.06, 0.022, 0.15)          // 形の違うP波
      + g(tau, 0.05, 0.02, 0.14) + g(tau, 0.1, 0.014, -0.06);
    if (kind === 'pvc') return g(tau, 0.185, 0.034, 1.05) + g(tau, 0.265, 0.03, -0.5)  // 幅広いQRS
      + g(tau, 0.47, 0.065, -0.36);                                                    // 逆向きのT波
    return 0;
  }

  /* 乱数 (同じ seed なら毎回同じ波形になる) */
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /* ---------- リズム生成器 ----------
     spec = { type: 'sinus' | 'af' | 'afl' | 'pac' | 'pvc' | 'vf' | 'asystole', hr, ratio(AFLの伝導比), every(期外収縮の間隔) }
     時間は増える方向にだけ問い合わせる (モニターも静止図も左から順に描くため) */
  class Rhythm {
    constructor(spec, opts) {
      opts = opts || {};
      this.rand = rng(opts.seed || 11);
      this.beats = []; this.rIdx = 0;
      this.nextStart = opts.t0 != null ? opts.t0 : 0;
      this.sinceEct = 0; this.ectNext = false; this.lastNormal = this.nextStart;
      this.set(spec);
    }
    set(spec) {
      this.spec = Object.assign({ type: 'sinus', hr: 75 }, typeof spec === 'string' ? { type: spec } : spec);
      if (this.spec.type === 'afl') this.spec.hr = Math.round(300 / (this.spec.ratio || 4));
      this.nextEct = (this.spec.every || 4) + Math.floor(this.rand() * 2);
      this.ectNext = false;
    }
    get hr() { return this.spec.hr; }
    _push() {
      const s = this.spec, base = 60 / s.hr;
      const start = this.nextStart;
      if (s.type === 'af') {
        const rr = base * (0.55 + 0.9 * this.rand());           // 絶対性不整
        this.beats.push({ start, kind: 'np', rr: base }); this.nextStart = start + rr; return;
      }
      if (s.type === 'afl') {
        const rr = 0.2 * (s.ratio || 4);                          // 粗動波 300/分 の整数倍
        this.beats.push({ start, kind: 'fl', rr }); this.nextStart = start + rr; return;
      }
      if (this.ectNext) {                                        // 期外収縮
        this.beats.push({ start, kind: s.type, rr: base });
        this.nextStart = s.type === 'pac' ? start + base * 1.04  // PAC: 洞結節がリセットされる
                                          : this.lastNormal + 2 * base; // PVC: 代償性休止
        this.ectNext = false; this.sinceEct = 0;
        this.nextEct = (s.every || 4) + Math.floor(this.rand() * 2);
        return;
      }
      this.beats.push({ start, kind: 'n', rr: base });
      this.lastNormal = start; this.sinceEct++;
      if ((s.type === 'pac' || s.type === 'pvc') && this.sinceEct >= this.nextEct) {
        this.ectNext = true;
        this.nextStart = start + base * (s.type === 'pac' ? 0.62 : 0.56);
      } else this.nextStart = start + base;
    }
    atrial(t) {
      const ty = this.spec.type;
      if (ty === 'af') return 0.05 * (Math.sin(2 * Math.PI * 5.7 * t + Math.sin(2 * Math.PI * 0.7 * t))
        + 0.7 * Math.sin(2 * Math.PI * 7.9 * t + 1.1) + 0.5 * Math.sin(2 * Math.PI * 4.3 * t + 2.0));
      if (ty === 'afl') {                                          // 鋸歯状波 (5Hz = 300/分)
        const ph = ((t * 5) % 1 + 1) % 1;
        return ph < 0.8 ? 0.13 - 0.33 * (ph / 0.8) : -0.2 + 0.33 * ((ph - 0.8) / 0.2);
      }
      return 0;
    }
    value(t, onR) {
      const ty = this.spec.type;
      if (ty === 'vf' || ty === 'asystole') { this.nextStart = Math.max(this.nextStart, t); this.rIdx = this.beats.length; return ty === 'vf' ? vfAt(t) : asystoleAt(t); }
      if (this.nextStart < t - 1) this.nextStart = t;               // 長く止まっていたら追いつく
      while (this.nextStart <= t + 0.05) this._push();
      while (this.rIdx < this.beats.length && this.beats[this.rIdx].start + R_AT <= t) { this.rIdx++; if (onR) onR(); }
      let v = this.atrial(t);
      for (let i = this.beats.length - 1; i >= 0; i--) {
        const b = this.beats[i];
        if (b.start < t - 1.0) break;
        v += shapeOf(b.kind, t - b.start, b.rr);
      }
      if (this.beats.length > 60) { this.beats.splice(0, 30); this.rIdx = Math.max(0, this.rIdx - 30); }
      return v;
    }
    rTimes() { return this.beats.map(b => b.start + R_AT); }
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
      this.gen = new Rhythm(Object.assign({ type: opts.rhythm || 'sinus', hr: opts.hr || 75 }, opts.spec || {}));
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
    setHR(hr) { this.gen.set(Object.assign({}, this.gen.spec, { hr: hr })); }
    setRhythm(spec) { this.gen.set(spec); this._updateAlarm(); }
    _updateAlarm() {
      if (ALARM_RHYTHMS.includes(this.gen.spec.type) && this.running) Sound.alarmStart();
      else if (![...monitors].some(m => m.running && ALARM_RHYTHMS.includes(m.gen.spec.type))) Sound.alarmStop();
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
        const v = this.gen.value(this.simT, () => { Sound.beep(); if (this.onBeat) this.onBeat(); });
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

  global.ECG = { timing, beatShape, sinusAt, vfAt, asystoleAt, Rhythm, R_AT, Monitor, Sound, svgPath, gridDefs, ALARM_RHYTHMS };
})(window);
