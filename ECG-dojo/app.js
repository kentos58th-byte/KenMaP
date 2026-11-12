/* =========================================================
   心電図道場 — 画面と進行
   教材の文章は data/<帯>.json にある。ここは画面の組み立てだけ。
   ========================================================= */
(function () {
  'use strict';
  const { Monitor, Sound, svgPath, gridDefs, sinusAt, timing, beatShape, Rhythm, R_AT } = window.ECG;

  /* ---------- 段位 ---------- */
  const BELTS = [
    { id: 'shiro',  name: '白帯', sub: '心電図の基礎',         obi: '#FFFFFF', topics: '刺激伝導系・P/QRS/Tの意味・記録紙の読み方・心拍数の計算', ready: true },
    { id: 'cha',    name: '茶帯', sub: '基本の不整脈',         obi: '#7A4A2A', topics: '洞調律・洞性頻脈/徐脈・AF・AFL・PAC・PVC', ready: true },
    { id: 'kuro',   name: '黒帯', sub: '致死性不整脈とブロック', obi: '#1E1B18', topics: 'VT・VF・PEA・心静止・房室ブロック1〜3度', ready: true },
    { id: 'shihan', name: '師範', sub: '応用',                 obi: '#C23B22', topics: 'ST変化と責任冠動脈・高K血症・QT延長・ペースメーカー', ready: false }
  ];
  const beltById = id => BELTS.find(b => b.id === id);

  /* ---------- 保存 (端末内) ---------- */
  const STORE_KEY = 'ecg-dojo-v1';
  function load() {
    try { return Object.assign({ passed: {}, best: {}, pitch: 880 }, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
    catch (e) { return { passed: {}, best: {}, pitch: 880 }; }
  }
  let state = load();
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }
  Sound.pitch = state.pitch || 880;
  function isUnlocked(id) {
    const i = BELTS.findIndex(b => b.id === id);
    return i === 0 || !!state.passed[BELTS[i - 1].id];
  }

  /* ---------- 教材データ ---------- */
  const cache = {};
  async function getBelt(id) {
    if (cache[id]) return cache[id];
    const res = await fetch('data/' + id + '.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    cache[id] = await res.json();
    return cache[id];
  }

  /* ---------- 小道具 ---------- */
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl = s => esc(s).replace(/\n/g, '<br>');
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const MARKS = ['壱', '弐', '参', '肆'];
  const hashStr = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const vibrate = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };

  let cleanups = [];
  const onCleanup = f => cleanups.push(f);
  function setHeader(title, crumb) {
    $('#title').textContent = title;
    $('#crumb').textContent = crumb || 'KenMaP';
    document.title = title === '心電図道場' ? '心電図道場' : title + ' | 心電図道場';
  }

  /* ---------- 音ボタン (下部バー・モニター共通) ---------- */
  const ICON_MUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>';
  const ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 010 7"/><path d="M18.5 5.5a9 9 0 010 13"/></svg>';
  function paintSound() {
    $('#nav-sound-icon').innerHTML = Sound.on ? ICON_ON : ICON_MUTE;
    $('#nav-sound-label').textContent = Sound.on ? '音あり' : '消音中';
    $('#nav-sound').classList.toggle('is-on', Sound.on);
    document.querySelectorAll('[data-sound-btn]').forEach(b => {
      b.innerHTML = Sound.on ? ICON_ON : ICON_MUTE;
      b.classList.toggle('on', Sound.on);
      b.setAttribute('aria-pressed', Sound.on ? 'true' : 'false');
      b.setAttribute('aria-label', Sound.on ? '音を消す' : '音を出す');
    });
  }
  Sound.onChange(paintSound);
  document.addEventListener('click', e => {
    if (e.target.closest('[data-sound-btn], #nav-sound')) Sound.setOn(!Sound.on);
  });

  /* ---------- モニター部品 ---------- */
  function monitorHTML(o) {
    return '<div class="monitor">'
      + '<div class="screen"><span class="lead">II</span>'
      + '<div class="hud"><div class="lbl">HR</div><div><span class="heart">&#9829;</span><span class="hr">' + o.hr + '</span></div></div>'
      + '<canvas aria-label="心電図モニター 心拍数' + o.hr + '回/分" role="img"></canvas></div>'
      + '<div class="ctrl">'
      + (o.slider ? '<span>心拍数</span><input type="range" min="30" max="180" step="1" value="' + o.hr + '" aria-label="心拍数">' : '<span style="flex:1">洞調律 ・ II誘導</span>')
      + '<button type="button" class="icon-btn" data-sound-btn></button>'
      + '</div></div>';
  }
  function mountMonitor(root, o) {
    const canvas = $('canvas', root), heart = $('.heart', root), hrEl = $('.hr', root);
    const m = new Monitor(canvas, {
      hr: o.hr, rhythm: o.rhythm || 'sinus', spec: o.spec, seconds: o.seconds || 4,
      onBeat: () => { heart.classList.add('beat'); setTimeout(() => heart.classList.remove('beat'), 120); }
    });
    m.start();
    onCleanup(() => m.destroy());
    const range = $('input[type=range]', root);
    const api = {
      monitor: m,
      setHR(hr) { m.setHR(hr); hrEl.textContent = hr; canvas.setAttribute('aria-label', '心電図モニター 心拍数' + hr + '回/分'); if (range) range.value = hr; },
      setRhythm(spec) {
        m.setRhythm(spec);
        const hr = m.gen.hr, irregular = spec.type === 'af' || spec.type === 'wenck' || spec.type === 'mobitz';
        const noRate = spec.type === 'vf' || spec.type === 'asystole';
        hrEl.textContent = noRate ? '---' : (irregular ? '~' : '') + hr;
        $('.hud', root).classList.toggle('alarm', noRate);
        canvas.setAttribute('aria-label', noRate ? '心電図モニター 心拍数測定不能' : '心電図モニター 心拍数' + hr + '回/分');
      }
    };
    if (o.spec) api.setRhythm(o.spec);
    if (range) range.addEventListener('input', () => { api.setHR(+range.value); if (o.onHR) o.onHR(+range.value); });
    paintSound();
    return api;
  }

  /* ---------- 記録紙の心電図 (SVG) ----------
     spec: { type, hr, ratio, every } または心拍数の数字。最初のR波を太い線(0.4秒)に合わせる */
  function stripSVG(spec, seconds, pxPerMm, heightMm, opts) {
    opts = opts || {};
    if (typeof spec === 'number') spec = { type: 'sinus', hr: spec };
    const pxPerSec = 25 * pxPerMm, pxPerMv = 10 * pxPerMm;
    const W = Math.round(seconds * pxPerSec), H = heightMm * pxPerMm;
    const baseline = Math.round(H * 0.7 / (pxPerMm * 5)) * pxPerMm * 5; // 太い線の上に基線
    const rhythm = new Rhythm(spec, { t0: 0.4 - R_AT, seed: opts.seed || 7 });
    const grid = gridDefs(pxPerMm);
    const d = svgPath(t => rhythm.value(t), { t0: 0, t1: seconds, pxPerSec, baseline, pxPerMv });
    const rs = rhythm.rTimes().filter(t => t >= 0 && t < seconds);
    let extra = '';
    if (opts.markR) rs.forEach(t => { extra += '<circle cx="' + (t * pxPerSec).toFixed(1) + '" cy="' + (baseline - 1.1 * pxPerMv - 6) + '" r="' + Math.max(2.5, pxPerMm * 0.7) + '" fill="#C23B22"/>'; });
    if (opts.bracket && rs.length > 1) {
      const x1 = rs[0] * pxPerSec, x2 = rs[1] * pxPerSec, y = H - pxPerMm * 2;
      extra += '<g stroke="#1E1B18" stroke-width="1.5" fill="none"><path d="M' + x1 + ' ' + (y - 5) + 'V' + (y + 5) + 'M' + x2 + ' ' + (y - 5) + 'V' + (y + 5) + 'M' + x1 + ' ' + y + 'H' + x2 + '"/></g>'
        + '<text x="' + ((x1 + x2) / 2) + '" y="' + (y - 6) + '" text-anchor="middle" font-size="' + Math.max(11, pxPerMm * 2.6) + '" font-weight="700" fill="#1E1B18">RR</text>';
    }
    return {
      svg: '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="心電図の記録紙">' + grid.defs
        + '<rect width="' + W + '" height="' + H + '" fill="#FFF8F1"/><rect width="' + W + '" height="' + H + '" fill="url(#' + grid.id + ')"/>'
        + '<path d="' + d + '" fill="none" stroke="#1E1B18" stroke-width="' + Math.max(1.4, pxPerMm * 0.35) + '" stroke-linejoin="round"/>' + extra + '</svg>',
      rCount6: rs.filter(t => t < 6).length
    };
  }

  /* =========================================================
     画面: 道場トップ
     ========================================================= */
  function viewHome(view) {
    setHeader('心電図道場', 'KenMaP');
    let html = '<div class="hero"><div class="kanban">心電図道場</div><div>'
      + '<div class="kicker">ECG DOJO</div>'
      + '<p>白帯から師範まで、段位を上げながら心電図を身につける稽古場。昇段試験で8割以上とれば、次の帯が開きます。</p></div></div>';
    html += monitorHTML({ hr: 72, slider: true });
    html += '<div class="section-title">段位</div><div class="belts">';
    BELTS.forEach(b => {
      const open = isUnlocked(b.id), passed = !!state.passed[b.id], best = state.best[b.id];
      let stateHTML;
      if (passed) stateHTML = '<span class="badge ok">合格</span>';
      else if (!open) stateHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg><br>未解放';
      else if (!b.ready) stateHTML = '<span class="badge ghost">教材準備中</span>';
      else stateHTML = best ? '最高 ' + best.score + '/' + best.total : '<span class="badge">修行中</span>';
      const tag = open && b.ready ? 'a href="#/belt/' + b.id + '"' : 'div';
      html += '<' + tag + ' class="belt' + (open ? '' : ' locked') + '">'
        + '<div class="obi" style="background:' + b.obi + '"></div>'
        + '<div class="body"><div class="name">' + b.name + '</div><div class="sub">' + b.sub + '</div><div class="topics">' + esc(b.topics) + '</div></div>'
        + '<div class="state">' + stateHTML + '</div>'
        + '</' + tag.split(' ')[0] + '>';
    });
    html += '</div><p class="notice">本アプリは学習用です。実際の患者の判断・対応は、所属施設のプロトコルと医師の指示に従ってください。</p>';
    view.innerHTML = html;
    mountMonitor($('.monitor', view), { hr: 72, slider: true });
  }

  /* =========================================================
     画面: 帯のページ
     ========================================================= */
  async function viewBelt(view, id) {
    const b = beltById(id);
    if (!b || !isUnlocked(id) || !b.ready) { location.hash = '#/'; return; }
    setHeader(b.name, '心電図道場');
    const data = await getBelt(id);
    const best = state.best[id];
    let html = '<p class="lead-text">' + esc(data.subtitle) + '。まず稽古で型を覚え、試合で腕試し、最後に昇段試験に挑みます。</p>';
    html += '<div class="modes">'
      + '<a class="mode" href="#/match/' + id + '"><div class="kanji">試</div><div><h3>試合</h3><p>4択で腕試し。正解で一本、不正解は解説で振り返り。</p></div><span class="arrow">&rsaquo;</span></a>'
      + '<a class="mode primary" href="#/exam/' + id + '"><div class="kanji">昇</div><div><h3>昇段試験</h3><p>' + Math.round(data.passRate * 100) + '%以上で合格。'
      + (state.passed[id] ? '<b>合格済み</b>' : best ? '最高 ' + best.score + '/' + best.total : '未受験') + '</p></div><span class="arrow">&rsaquo;</span></a>'
      + '</div>';
    html += '<div class="section-title">稽古</div><div class="lesson-list">';
    data.lessons.forEach((l, i) => {
      html += '<a href="#/lesson/' + id + '/' + l.id + '"><span class="no">其の' + MARKS[i] + '</span><span class="t">' + esc(l.title) + '</span></a>';
    });
    html += '</div>';
    view.innerHTML = html;
  }

  /* =========================================================
     画面: 稽古
     ========================================================= */
  async function viewLesson(view, id, lessonId) {
    const b = beltById(id);
    if (!b || !isUnlocked(id)) { location.hash = '#/'; return; }
    const data = await getBelt(id);
    const idx = data.lessons.findIndex(l => l.id === lessonId);
    const lesson = data.lessons[idx];
    if (!lesson) { location.hash = '#/belt/' + id; return; }
    setHeader(lesson.title, b.name + ' ・ 稽古 其の' + MARKS[idx]);

    let html = '<p class="lead-text">' + esc(lesson.lead) + '</p><div id="lesson-body"></div>';
    html += '<div class="chips" role="group" aria-label="部位を選ぶ">' + lesson.parts.map(p => '<button type="button" class="chip" data-part="' + p.id + '">' + esc(p.label) + '</button>').join('') + '</div>';
    html += '<div class="explain empty" id="explain">図の部分か、上のボタンをタップしてください。</div>';
    const prev = data.lessons[idx - 1], next = data.lessons[idx + 1];
    html += '<div class="pager">'
      + (prev ? '<a href="#/lesson/' + id + '/' + prev.id + '">&lsaquo; ' + esc(prev.title) + '</a>' : '<a href="#/belt/' + id + '">&lsaquo; ' + b.name + 'へ</a>')
      + (next ? '<a class="next" href="#/lesson/' + id + '/' + next.id + '">' + esc(next.title) + ' &rsaquo;</a>' : '<a class="next" href="#/match/' + id + '">試合へ &rsaquo;</a>')
      + '</div>';
    view.innerHTML = html;

    const body = $('#lesson-body', view);
    const figKey = lesson.figure || lesson.id;
    const fig = LESSON_FIGURES[figKey] ? LESSON_FIGURES[figKey](body, lesson) : { select() {} };
    const explain = $('#explain', view);
    function select(pid) {
      const p = lesson.parts.find(x => x.id === pid); if (!p) return;
      view.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.part === pid));
      explain.classList.remove('empty');
      explain.innerHTML = '<h3>' + esc(p.label) + '</h3><p>' + nl(p.text) + '</p>';
      fig.select(pid);
    }
    view.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => select(c.dataset.part)));
    body.addEventListener('click', e => { const g = e.target.closest('[data-part]'); if (g) select(g.dataset.part); });
    body.addEventListener('ecgpick', e => select(e.detail));
  }

  /* ---------- 稽古の図 ---------- */
  const LESSON_FIGURES = {
    /* 其の壱: 刺激伝導系 (模式図) + 同期する1拍 */
    conduction(root) {
      // 後に書いたものほど上になる (小さい結節を太い線より上に置き、タップしやすくする)
      const P = {
        purkinje: '<path d="M138 232 Q118 240 98 214 M120 238 Q94 216 84 172 M98 214 Q86 206 79 190"/><path d="M182 228 Q202 236 218 208 M204 230 Q228 202 230 162 M218 208 Q228 198 232 184"/>',
        bundle: '<path d="M156 152 Q140 190 138 232"/><path d="M156 152 Q176 188 182 228"/>',
        his: '<path d="M153 130 L156 152"/>',
        av: '<circle cx="152" cy="122" r="7"/>',
        sa: '<circle cx="100" cy="70" r="9"/>'
      };
      const LBL = { sa: [60, 58, '洞結節', 'start'], av: [164, 116, '房室結節', 'start'], his: [146, 150, 'ヒス束', 'end'], bundle: [104, 204, '右脚', 'start'], purkinje: [186, 284, 'プルキンエ線維', 'start'] };
      const HITW = { purkinje: 18, bundle: 18, his: 14, av: 20, sa: 22 };
      let svg = '<svg viewBox="0 0 300 300" role="img" aria-label="刺激伝導系の模式図">'
        + '<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>'
        + '<path id="atria" d="M66 118 C60 80 70 46 104 40 C126 36 142 46 150 56 C160 44 182 36 206 40 C236 46 244 84 238 118 Z" fill="#F5DCD2" fill-opacity="0" stroke="#1E1B18" stroke-width="2"/>'
        + '<path id="vent" d="M64 124 L240 124 C246 175 210 232 158 272 C108 236 60 182 64 124 Z" fill="#F5DCD2" fill-opacity="0" stroke="#1E1B18" stroke-width="2"/>'
        + '<path d="M157 126 L160 262" stroke="#857B6E" stroke-width="1" stroke-dasharray="3 4"/>'
        + '<text x="76" y="104" font-size="11" fill="#857B6E">右心房</text><text x="196" y="78" font-size="11" fill="#857B6E">左心房</text>'
        + '<text x="72" y="146" font-size="11" fill="#857B6E">右心室</text><text x="198" y="160" font-size="11" fill="#857B6E">左心室</text>'
        + '<path d="M100 70 Q118 108 150 120" fill="none" stroke="#C23B22" stroke-width="1.5" stroke-dasharray="2 4" opacity=".7"/>'
        + '<text x="150" y="298" text-anchor="middle" font-size="10" fill="#857B6E">※ 模式図（正面から見た図。向かって左が右心系）</text>';
      Object.keys(P).forEach(k => {
        svg += '<g class="part" data-part="' + k + '">'
          + '<g class="hit" fill="transparent" stroke="transparent" stroke-width="' + HITW[k] + '">' + P[k] + '</g>'
          + '<g class="vis" fill="' + (k === 'sa' || k === 'av' ? '#1E1B18' : 'none') + '" stroke="#1E1B18" stroke-width="3.5" stroke-linecap="round">' + P[k] + '</g>'
          + '<text x="' + LBL[k][0] + '" y="' + LBL[k][1] + '" text-anchor="' + LBL[k][3] + '" font-size="12" font-weight="700" fill="#1E1B18">' + LBL[k][2] + '</text>'
          + '</g>';
      });
      svg += '<text x="186" y="206" font-size="12" font-weight="700" fill="#1E1B18" pointer-events="none">左脚</text></svg>';

      // 同期する1拍 (HR60)
      const pxs = 300, base = 70, pmv = 52;
      const beat = svgPath(t => beatShape(t, 1), { t0: 0, t1: 1, pxPerSec: pxs, baseline: base, pxPerMv: pmv });
      const grid = gridDefs(pxs / 25);
      const strip = '<svg viewBox="0 0 300 100" role="img" aria-label="同期する心電図1拍">' + grid.defs
        + '<rect width="300" height="100" fill="#FFF8F1"/><rect width="300" height="100" fill="url(#' + grid.id + ')"/>'
        + '<path d="' + beat + '" fill="none" stroke="#1E1B18" stroke-width="2"/>'
        + '<rect id="cur-band" x="0" y="0" width="0" height="100" fill="#C23B22" opacity=".12"/>'
        + '<line id="cur" x1="0" y1="0" x2="0" y2="100" stroke="#C23B22" stroke-width="2"/>'
        + '<text id="cur-lbl" x="296" y="14" text-anchor="end" font-size="12" font-weight="700" fill="#A52F1A"></text></svg>';
      root.innerHTML = '<div class="figure">' + svg + '</div><div class="figure" style="padding:6px">' + strip + '</div>';

      const atria = $('#atria', root), vent = $('#vent', root), cur = $('#cur', root), band = $('#cur-band', root), lbl = $('#cur-lbl', root);
      const parts = {}; root.querySelectorAll('.part').forEach(g => parts[g.dataset.part] = $('.vis', g));
      const T = timing(1);
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let raf, t0 = null, selected = null, lastBeat = -1;
      function paint(tau) {
        const on = (a, b) => tau >= a && tau < b;
        const live = { sa: on(0, 0.05), av: on(0.09, 0.165), his: on(0.155, 0.185), bundle: on(0.17, 0.215), purkinje: on(0.195, 0.25) };
        Object.keys(parts).forEach(k => {
          const el = parts[k], sel = selected === k;
          el.setAttribute('stroke', live[k] || sel ? '#C23B22' : '#1E1B18');
          if (k === 'sa' || k === 'av') el.setAttribute('fill', live[k] || sel ? '#C23B22' : '#1E1B18');
          el.setAttribute('filter', live[k] ? 'url(#glow)' : '');
          el.setAttribute('stroke-width', sel ? 5 : 3.5);
        });
        const aOp = on(0.01, 0.12) ? 0.85 : 0;
        let vOp = 0;
        if (on(0.2, T.tOn)) vOp = 0.85; else if (on(T.tOn, T.tOff)) vOp = 0.85 * (1 - (tau - T.tOn) / (T.tOff - T.tOn));
        atria.setAttribute('fill-opacity', aOp); vent.setAttribute('fill-opacity', vOp.toFixed(2));
        const x = tau * pxs;
        cur.setAttribute('x1', x); cur.setAttribute('x2', x);
        let seg = '', a = 0, b2 = 0;
        if (on(T.pOn, T.pOff)) { seg = 'P波：心房の興奮'; a = T.pOn; b2 = T.pOff; }
        else if (on(T.pOff, T.qrsOn)) { seg = '房室結節で待機'; a = T.pOff; b2 = T.qrsOn; }
        else if (on(T.qrsOn, T.qrsOff)) { seg = 'QRS：心室の興奮'; a = T.qrsOn; b2 = T.qrsOff; }
        else if (on(T.qrsOff, T.tOn)) { seg = 'ST：心室全体が興奮中'; a = T.qrsOff; b2 = T.tOn; }
        else if (on(T.tOn, T.tOff)) { seg = 'T波：心室の回復'; a = T.tOn; b2 = T.tOff; }
        band.setAttribute('x', a * pxs); band.setAttribute('width', (b2 - a) * pxs);
        lbl.textContent = seg;
      }
      function loop(now) {
        if (t0 == null) t0 = now;
        const s = (now - t0) / 1000, beatNo = Math.floor(s), tau = s - beatNo;
        if (beatNo !== lastBeat && tau >= T.rPeak) { lastBeat = beatNo; Sound.beep(); }
        paint(tau);
        raf = requestAnimationFrame(loop);
      }
      if (reduce) paint(0.2); else raf = requestAnimationFrame(loop);
      onCleanup(() => cancelAnimationFrame(raf));
      return { select(k) { selected = k; if (reduce) paint(0.2); } };
    },

    /* 其の弐: 1拍の拡大図 */
    beat(root) {
      const pxPerMm = 18, pxs = 25 * pxPerMm, base = 240, pmv = 10 * pxPerMm, t0 = -0.04;
      const T = timing(1);
      const X = t => (t - t0) * pxs;
      const grid = gridDefs(pxPerMm);
      const d = svgPath(t => beatShape(t, 1), { t0: t0, t1: 0.63, pxPerSec: pxs, baseline: base, pxPerMv: pmv });
      const waves = { p: [T.pOn, T.pOff], qrs: [T.qrsOn, T.qrsOff], st: [T.qrsOff, T.tOn], t: [T.tOn, T.tOff] };
      const spans = { pr: [T.pOn, T.qrsOn], qt: [T.qrsOn, T.tOff] };
      let svg = '<svg viewBox="0 0 300 300" role="img" aria-label="心電図1拍の拡大図">' + grid.defs
        + '<rect width="300" height="300" fill="#FFF8F1"/><rect width="300" height="300" fill="url(#' + grid.id + ')"/>'
        + '<rect id="hl" x="0" y="0" width="0" height="300" fill="#C23B22" opacity=".14"/>'
        + '<g id="br" stroke="#A52F1A" stroke-width="2" fill="none"></g><text id="br-l" font-size="14" font-weight="800" fill="#A52F1A" text-anchor="middle"></text>'
        + '<path d="' + d + '" fill="none" stroke="#1E1B18" stroke-width="2.6" stroke-linejoin="round"/>';
      const letters = [['P', T.pPeak, 0.15], ['Q', T.qrsOn + 0.012, -0.1], ['R', T.rPeak, 1.1], ['S', T.qrsOn + 0.057, -0.28], ['T', T.tPeak, 0.32]];
      letters.forEach(([c, t, v]) => {
        const y = v >= 0 ? base - v * pmv - 10 : base - v * pmv + 22;
        svg += '<text x="' + X(t) + '" y="' + y + '" text-anchor="middle" font-family="Shippori Mincho, serif" font-size="17" font-weight="800" fill="#1E1B18" pointer-events="none">' + c + '</text>';
      });
      Object.keys(waves).forEach(k => {
        svg += '<rect class="part" data-part="' + k + '" x="' + X(waves[k][0]) + '" y="0" width="' + (X(waves[k][1]) - X(waves[k][0])) + '" height="300" fill="transparent"/>';
      });
      svg += '</svg>';
      root.innerHTML = '<div class="figure">' + svg + '</div>';
      const hl = $('#hl', root), br = $('#br', root), brl = $('#br-l', root);
      return {
        select(k) {
          const w = waves[k], s = spans[k];
          if (w) { hl.setAttribute('x', X(w[0])); hl.setAttribute('width', X(w[1]) - X(w[0])); br.innerHTML = ''; brl.textContent = ''; }
          if (s) {
            const x1 = X(s[0]), x2 = X(s[1]), y = 24;
            hl.setAttribute('x', x1); hl.setAttribute('width', x2 - x1);
            br.innerHTML = '<path d="M' + x1 + ' ' + (y - 7) + 'V' + (y + 7) + 'M' + x2 + ' ' + (y - 7) + 'V' + (y + 7) + 'M' + x1 + ' ' + y + 'H' + x2 + '"/>';
            brl.setAttribute('x', (x1 + x2) / 2); brl.setAttribute('y', y + 22);
            brl.textContent = k === 'pr' ? 'PR ' + (s[1] - s[0]).toFixed(2) + '秒' : 'QT ' + (s[1] - s[0]).toFixed(2) + '秒';
          }
        }
      };
    },

    /* 其の参: 記録紙 */
    paper(root) {
      const s = 10, W = 320, H = 160, base = 130;
      const grid = gridDefs(s);
      const ecg = svgPath(t => sinusAt(t, 75, 0.15), { t0: 0, t1: 0.9, pxPerSec: 25 * s, baseline: base, pxPerMv: 10 * s, x0: 95 });
      const areas = {
        calib: [15, 25, 60, 110],
        small: [210, 20, 10, 10],
        large: [250, 50, 50, 50],
        second: [70, 0, 250, 18]
      };
      let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="心電図記録紙の目盛り">' + grid.defs
        + '<rect width="' + W + '" height="' + H + '" fill="#FFF8F1"/><rect width="' + W + '" height="' + H + '" fill="url(#' + grid.id + ')"/>'
        + '<path d="M0 ' + base + 'H20V30H70V' + base + 'H95" fill="none" stroke="#1E1B18" stroke-width="2.2"/>'
        + '<path d="' + ecg + '" fill="none" stroke="#1E1B18" stroke-width="2"/>'
        + '<g id="hl"></g>'
        + '<g stroke="#1E1B18" stroke-width="1.2" fill="none" opacity=".55"><path d="M70 9H320M70 4V14M320 4V14"/></g>'
        + '<text x="195" y="15" text-anchor="middle" font-size="10" fill="#4A443D">← 25mm →</text>';
      Object.keys(areas).forEach(k => { const a = areas[k]; svg += '<rect class="part" data-part="' + k + '" x="' + a[0] + '" y="' + a[1] + '" width="' + a[2] + '" height="' + a[3] + '" fill="transparent"/>'; });
      svg += '</svg>';
      root.innerHTML = '<div class="figure">' + svg + '</div>';
      const hl = $('#hl', root);
      const draw = {
        small: '<rect x="210" y="20" width="10" height="10" fill="#C23B22" fill-opacity=".45" stroke="#A52F1A" stroke-width="1.5"/><text x="226" y="29" font-size="11" font-weight="800" fill="#A52F1A">0.04秒×0.1mV</text>',
        large: '<rect x="250" y="50" width="50" height="50" fill="#C23B22" fill-opacity=".25" stroke="#A52F1A" stroke-width="2"/><text x="275" y="44" text-anchor="middle" font-size="11" font-weight="800" fill="#A52F1A">0.2秒×0.5mV</text>',
        second: '<rect x="70" y="0" width="250" height="160" fill="#C23B22" fill-opacity=".10"/><path d="M70 9H320M70 3V15M320 3V15" stroke="#A52F1A" stroke-width="2.5"/><rect x="160" y="20" width="70" height="18" rx="4" fill="#FBF7EC"/><text x="195" y="34" text-anchor="middle" font-size="12" font-weight="800" fill="#A52F1A">1秒＝25mm</text>',
        calib: '<path d="M20 ' + base + 'V30H70V' + base + '" fill="none" stroke="#C23B22" stroke-width="3.5"/><text x="74" y="62" font-size="11" font-weight="800" fill="#A52F1A">10mm＝1mV</text>',
        speed: '<path d="M100 150H300" stroke="#A52F1A" stroke-width="2.5"/><path d="M292 145L302 150L292 155" fill="none" stroke="#A52F1A" stroke-width="2.5"/><rect x="140" y="138" width="120" height="16" rx="4" fill="#FBF7EC"/><text x="200" y="151" text-anchor="middle" font-size="11" font-weight="800" fill="#A52F1A">紙送り 25mm/秒</text>'
      };
      return { select(k) { hl.innerHTML = draw[k] || ''; } };
    },

    /* リズム図: モニター + 6秒の記録紙 + 見分け表 (茶帯以降で使う) */
    rhythm(root, lesson) {
      const first = lesson.parts[0];
      root.innerHTML = '<div id="rh-mon"></div><div class="figure" style="padding:6px" id="rh-strip"></div><div class="calc" id="rh-check"></div>';
      const mon = $('#rh-mon', root);
      mon.innerHTML = monitorHTML({ hr: (first.rhythm && first.rhythm.hr) || 75 });
      $('.ctrl span', mon).id = 'rh-name';
      const m = mountMonitor($('.monitor', mon), { hr: 75, spec: first.rhythm || { type: 'sinus', hr: 75 } });
      const stripEl = $('#rh-strip', root), check = $('#rh-check', root), nameEl = $('#rh-name', root);
      function show(part) {
        const spec = part.rhythm || { type: 'sinus', hr: 75 };
        m.setRhythm(spec);
        nameEl.textContent = part.label;
        stripEl.innerHTML = stripSVG(spec, 6, 4, 20, { seed: hashStr(lesson.id + part.id) }).svg
          + '<div style="font-size:11.5px;color:#857B6E;padding:4px 4px 0">6秒間の記録（紙送り25mm/秒）</div>';
        const c = part.check || {};
        check.innerHTML = Object.keys(c).map(k => '<div class="row"><span class="k">' + esc(k) + '</span><span class="f" style="color:var(--sumi)">' + esc(c[k]) + '</span></div>').join('');
      }
      setTimeout(() => root.dispatchEvent(new CustomEvent('ecgpick', { detail: first.id })), 0);
      return { select(k) { const p = lesson.parts.find(x => x.id === k); if (p) show(p); } };
    },

    /* 其の肆: 心拍数の計算 */
    rate(root) {
      let hr = 75;
      root.innerHTML = '<div id="rate-mon"></div>'
        + '<div class="slider-row"><span>心拍数</span><input type="range" id="rate-range" min="30" max="180" step="1" value="75" aria-label="心拍数"><output id="rate-out">75回/分</output></div>'
        + '<div class="quick" id="rate-quick">' + [300, 150, 100, 75, 60, 50].map((v, i) => v <= 180 ? '<button type="button" data-hr="' + v + '">大マス' + (i + 1) + '個 = ' + v + '</button>' : '').join('') + '</div>'
        + '<div class="figure" style="padding:6px" id="rate-strip"></div>'
        + '<div class="calc" id="rate-calc"></div>';
      const mon = $('#rate-mon', root);
      mon.innerHTML = monitorHTML({ hr: 75 });
      const m = mountMonitor($('.monitor', mon), { hr: 75 });
      const range = $('#rate-range', root), out = $('#rate-out', root), stripEl = $('#rate-strip', root), calc = $('#rate-calc', root);
      let picked = null;
      function render() {
        out.textContent = hr + '回/分';
        m.setHR(hr);
        const st = stripSVG(hr, 6, 4, 20, { markR: true, bracket: true });
        stripEl.innerHTML = st.svg + '<div style="font-size:11.5px;color:#857B6E;padding:4px 4px 0">6秒間（大マス30個）の記録。朱の点がR波。</div>';
        const rr = 60 / hr, big = rr / 0.2, small = rr / 0.04;
        const f1 = v => (Math.round(v * 10) / 10).toString();
        const row = (id, k, f, v) => '<div class="row" data-part="' + id + '" style="' + (picked === id ? 'border-color:#C23B22' : '') + '"><span class="k">' + k + '</span><span class="f">' + f + '</span><span class="v">' + v + '</span></div>';
        calc.innerHTML = row('m300', '300法', '300 ÷ ' + f1(big) + '（大マス）', Math.round(300 / big))
          + row('m1500', '1500法', '1500 ÷ ' + f1(small) + '（小マス）', Math.round(1500 / small))
          + row('m6', '6秒法', st.rCount6 + '個 × 10', st.rCount6 * 10);
        root.querySelectorAll('#rate-quick button').forEach(b => b.classList.toggle('active', +b.dataset.hr === hr));
      }
      range.addEventListener('input', () => { hr = +range.value; render(); });
      root.querySelectorAll('#rate-quick button').forEach(b => b.addEventListener('click', () => { hr = +b.dataset.hr; range.value = hr; render(); }));
      render();
      return { select(k) { picked = k; render(); } };
    }
  };

  /* =========================================================
     画面: 試合 / 昇段試験
     ========================================================= */
  function stampShow(big, small, ms) {
    const layer = document.createElement('div');
    layer.className = 'stamp-layer';
    layer.innerHTML = '<div class="stamp"><span class="big">' + big + '</span>' + (small ? '<span class="small">' + small + '</span>' : '') + '</div>';
    document.body.appendChild(layer);
    vibrate(30);
    setTimeout(() => { layer.classList.add('out'); setTimeout(() => layer.remove(), 320); }, ms || 900);
  }

  function prepQuestion(q, shuffleChoices) {
    const order = shuffleChoices ? shuffle(q.choices.map((_, i) => i)) : q.choices.map((_, i) => i);
    return { q, order, answer: order.indexOf(q.answer) };
  }

  function questionHTML(item, no, total, dots) {
    const q = item.q;
    let html = '<div class="q-head"><span>' + no + ' / ' + total + '</span><div class="dots">' + dots + '</div></div>';
    html += '<div class="q-card"><div class="qno">第' + no + '問</div><p class="qtext">' + nl(q.question) + '</p>';
    if (q.strip) html += stripSVG(q.strip, q.strip.seconds || 3, q.strip.seconds > 4 ? 4 : 5, 20, { seed: q.strip.seed || hashStr(q.id) }).svg;
    html += '</div><div class="choices">';
    item.order.forEach((orig, i) => {
      html += '<button type="button" class="choice" data-i="' + i + '"><span class="mark">' + MARKS[i] + '</span><span>' + esc(q.choices[orig]) + '</span></button>';
    });
    html += '</div><div class="feedback" id="fb"></div>';
    return html;
  }

  async function viewMatch(view, id) {
    const b = beltById(id);
    if (!b || !isUnlocked(id)) { location.hash = '#/'; return; }
    setHeader('試合', b.name);
    const data = await getBelt(id);
    const items = shuffle(data.questions).map(q => prepQuestion(q, true));
    const results = [];
    let i = 0;
    function dots() { return items.map((_, k) => '<i class="' + (k < i ? (results[k] ? 'ok' : 'ng') : k === i ? 'now' : '') + '"></i>').join(''); }
    function show() {
      if (i >= items.length) return finish();
      view.innerHTML = questionHTML(items[i], i + 1, items.length, dots());
      view.querySelectorAll('.choice').forEach(btn => btn.addEventListener('click', () => answer(+btn.dataset.i)));
      window.scrollTo({ top: 0 });
    }
    function answer(sel) {
      const it = items[i], ok = sel === it.answer;
      results[i] = ok;
      view.querySelectorAll('.choice').forEach(btn => {
        const k = +btn.dataset.i; btn.disabled = true;
        if (k === it.answer) btn.classList.add('correct');
        else if (k === sel) btn.classList.add('wrong');
        else btn.classList.add('dim');
      });
      if (ok) stampShow('一本', '', 850);
      else vibrate([20, 40, 20]);
      $('#fb', view).innerHTML = '<div class="explain"><p class="verdict ' + (ok ? 'ok' : 'ng') + '" style="font-family:var(--mincho);font-weight:800;font-size:18px;margin:0 0 6px">' + (ok ? '一本！' : '惜しい。正解は「' + esc(it.q.choices[it.q.answer]) + '」') + '</p><p>' + nl(it.q.explanation) + '</p></div>'
        + '<button type="button" class="btn" id="next">' + (i + 1 < items.length ? '次の問題へ' : '結果を見る') + '</button>';
      $('.q-head .dots', view).innerHTML = (i++, dots());
      $('#next', view).addEventListener('click', show);
      setTimeout(() => $('#fb', view).scrollIntoView({ behavior: 'smooth', block: 'nearest' }), ok ? 700 : 50);
    }
    function finish() {
      const score = results.filter(Boolean).length;
      view.innerHTML = '<div class="result"><div class="score">' + score + '<small> / ' + items.length + '</small></div>'
        + '<p class="msg">' + (score === items.length ? '全問一本。見事です。昇段試験に挑みましょう。' : score / items.length >= data.passRate ? '昇段試験の合格ラインに届いています。' : '稽古で型を見直して、もう一度。') + '</p></div>'
        + '<a class="btn shu" href="#/exam/' + id + '">昇段試験へ</a>'
        + '<button type="button" class="btn ghost" id="again">もう一度試合</button>'
        + '<a class="btn ghost" href="#/belt/' + id + '">' + b.name + 'に戻る</a>';
      $('#again', view).addEventListener('click', () => viewMatch(view, id));
    }
    show();
  }

  async function viewExam(view, id) {
    const b = beltById(id);
    if (!b || !isUnlocked(id)) { location.hash = '#/'; return; }
    setHeader('昇段試験', b.name);
    const data = await getBelt(id);
    const need = Math.ceil(data.questions.length * data.passRate - 1e-9);
    view.innerHTML = '<div class="q-card"><div class="qno">' + b.name + ' 昇段試験</div>'
      + '<p class="qtext">全' + data.questions.length + '問。' + need + '問以上の正解（' + Math.round(data.passRate * 100) + '%以上）で合格です。</p>'
      + '<p style="font-size:13.5px;color:#4A443D;margin:8px 0 0">試験中は正誤を表示しません。解説は最後にまとめて確認できます。</p></div>'
      + '<button type="button" class="btn shu" id="start">試験を始める</button>'
      + '<a class="btn ghost" href="#/belt/' + id + '">やめる</a>';
    $('#start', view).addEventListener('click', run);

    function run() {
      const items = shuffle(data.questions).map(q => prepQuestion(q, true));
      const picks = [];
      let i = 0;
      const dots = () => items.map((_, k) => '<i class="' + (k < i ? 'done' : k === i ? 'now' : '') + '"></i>').join('');
      function show() {
        if (i >= items.length) return finish();
        view.innerHTML = questionHTML(items[i], i + 1, items.length, dots());
        view.querySelectorAll('.choice').forEach(btn => btn.addEventListener('click', () => {
          view.querySelectorAll('.choice').forEach(x => x.disabled = true);
          btn.style.background = 'var(--washi-2)';
          picks[i] = +btn.dataset.i; i++;
          setTimeout(show, 220);
        }));
        window.scrollTo({ top: 0 });
      }
      function finish() {
        const correct = items.map((it, k) => picks[k] === it.answer);
        const score = correct.filter(Boolean).length, total = items.length;
        const pass = score >= need;
        const prevBest = state.best[id];
        if (!prevBest || score > prevBest.score) state.best[id] = { score, total };
        const firstPass = pass && !state.passed[id];
        if (pass) state.passed[id] = true;
        save();
        const nextBelt = BELTS[BELTS.findIndex(x => x.id === id) + 1];
        let html = '<div class="result">'
          + (pass ? '<div class="stamp"><span class="big">合格</span><span class="small">昇段</span></div>' : '')
          + '<div class="score">' + score + '<small> / ' + total + '</small></div>'
          + '<p class="msg">' + (pass ? (nextBelt ? nextBelt.name + 'が解放されました。' + (nextBelt.ready ? '' : '（教材は準備中です）') : '最高段位に到達しました。') : '合格まであと' + (need - score) + '問。稽古で見直してから再挑戦を。') + '</p></div>';
        html += '<div class="review">';
        items.forEach((it, k) => {
          html += '<div class="item"><b>' + (k + 1) + '. ' + esc(it.q.question) + '</b>'
            + '<span class="' + (correct[k] ? 'ok' : 'ng') + '">' + (correct[k] ? '○ 正解' : '× 不正解') + '</span>　答え：' + esc(it.q.choices[it.q.answer])
            + (correct[k] ? '' : '<br>あなたの答え：' + esc(it.q.choices[it.order[picks[k]]]))
            + '<div style="margin-top:6px;color:#4A443D">' + nl(it.q.explanation) + '</div></div>';
        });
        html += '</div><a class="btn" href="#/">道場トップへ</a><button type="button" class="btn ghost" id="retry">もう一度受ける</button>';
        view.innerHTML = html;
        $('#retry', view).addEventListener('click', run);
        window.scrollTo({ top: 0 });
        if (firstPass) setTimeout(() => stampShow('昇段', nextBelt ? nextBelt.name + 'へ' : '', 1300), 200);
      }
      show();
    }
  }

  /* =========================================================
     画面: 設定
     ========================================================= */
  function viewSettings(view) {
    setHeader('設定', '心電図道場');
    view.innerHTML = '<div class="setting"><h3>同期音の高さ</h3><p>R波に合わせて鳴る「ピッ」の高さ。SpO2モニターのように、好みの高さに変えられます。</p>'
      + '<div class="row"><input type="range" id="pitch" min="440" max="1320" step="20" value="' + Sound.pitch + '" aria-label="音の高さ"><output id="pitch-out">' + Sound.pitch + ' Hz</output></div>'
      + '<div class="row" style="margin-top:10px"><button type="button" class="small-btn" id="pitch-test">試しに鳴らす</button><span style="font-size:12px;color:#857B6E">※iPhoneは消音スイッチがオンだと鳴りません</span></div></div>'
      + '<div class="setting"><h3>記録を消す</h3><p>合格した帯と最高点をすべて消して、白帯からやり直します。</p><button type="button" class="small-btn danger" id="reset">記録を消す</button></div>'
      + '<div class="setting"><h3>音について</h3><p>音は最初は消音です。下のスピーカーボタンでオン／オフを切り替えられます。心室細動・心静止の波形では、同期音の代わりにアラーム音が鳴ります。</p></div>';
    const pitch = $('#pitch', view), out = $('#pitch-out', view);
    pitch.addEventListener('input', () => { Sound.pitch = +pitch.value; out.textContent = pitch.value + ' Hz'; state.pitch = Sound.pitch; save(); });
    pitch.addEventListener('change', () => Sound.test());
    $('#pitch-test', view).addEventListener('click', () => Sound.test());
    $('#reset', view).addEventListener('click', () => {
      if (confirm('合格記録と最高点をすべて消します。よろしいですか？')) { state = { passed: {}, best: {}, pitch: Sound.pitch }; save(); location.hash = '#/'; }
    });
  }

  /* =========================================================
     ルーター
     ========================================================= */
  async function route() {
    cleanups.forEach(f => { try { f(); } catch (e) {} }); cleanups = [];
    const view = $('#view');
    view.classList.remove('view-enter'); void view.offsetWidth; view.classList.add('view-enter');
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
    try {
      if (!parts.length) viewHome(view);
      else if (parts[0] === 'belt') await viewBelt(view, parts[1]);
      else if (parts[0] === 'lesson') await viewLesson(view, parts[1], parts[2]);
      else if (parts[0] === 'match') await viewMatch(view, parts[1]);
      else if (parts[0] === 'exam') await viewExam(view, parts[1]);
      else if (parts[0] === 'settings') viewSettings(view);
      else viewHome(view);
    } catch (e) {
      console.error(e);
      view.innerHTML = '<div class="error"><b>教材を読み込めませんでした。</b><br>インターネットに接続して開き直してください。パソコンで index.html を直接ダブルクリックした場合は、教材ファイル（JSON）を読み込めません。</div>';
    }
    window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', route);

  $('#nav-back').addEventListener('click', () => {
    const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!p.length) { location.href = '../'; return; }           // 道場トップ → KenMaP
    if (p[0] === 'lesson' || p[0] === 'match' || p[0] === 'exam') location.hash = '#/belt/' + p[1];
    else location.hash = '#/';
  });

  paintSound();
  route();
})();
