// ABCDEクエスト ゲーム本体
// 症例の中身（バイタル・所見・セリフ・振り返りなど）は cases/ フォルダの JSON にあります。
// このファイルには「どの症例でも共通の仕組み」だけを書いています。

'use strict';
const STORE_KEY = 'abcde-quest-v1';
const MAX_REPORT_DEFAULT = 4;

// ================= 共通の道具 =================
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 時間で変わる文章：[{from:0,text:"…"},{from:20,text:"…"}] から今の時刻のものを選ぶ
function at(list, t, field) {
  if (list == null) return '';
  if (typeof list === 'string') return list;
  let pick = list[0];
  for (const x of list) if (t >= (x.from || 0)) pick = x;
  return pick ? (field ? pick[field] : (pick.text !== undefined ? pick.text : pick)) : '';
}
function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { results: {} }; } catch (e) { return { results: {} }; } }
function saveStore(st) { try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch (e) {} }

let C = null;      // 今の症例データ
let S = null;      // 今のゲームの状態
let SEC_PER_MIN = 10;
let CASE_LIST = [];

// ================= 症例の読み込み =================
async function loadCaseList() {
  const r = await fetch('cases/index.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('cases/index.json を読み込めません');
  const j = await r.json();
  return j.cases || [];
}
async function loadCase(file) {
  const r = await fetch('cases/' + file, { cache: 'no-cache' });
  if (!r.ok) throw new Error('cases/' + file + ' を読み込めません');
  return r.json();
}

// ================= 状態 =================
function reset() {
  S = {
    t: 0, measured: {}, found: new Set(), done: new Set(), o2: false,
    reported: false, news: null, log: [], events: {}, over: true, paused: false, busy: false,
    chat: [], asked: 0, mode: 'talk', impression: null, impReason: '', doc: [],
    assess: { A: '', B: '', C: '', D: '', E: '', X: '' }, assessT: {}, result: null, timers: []
  };
  renderTick.rr = null;
}
const tm = () => Math.floor(S.t);
const pname = () => C.patient.name;

// 今のバイタル（症例のキーフレームを時間でなめらかにつなぐ）
function truth(t) {
  const KF = C.vitals.keyframes;
  let a = KF[0], b = KF[KF.length - 1];
  for (let i = 0; i < KF.length - 1; i++) { if (t >= KF[i].t && t <= KF[i + 1].t) { a = KF[i]; b = KF[i + 1]; break; } }
  if (t > b.t) a = b;
  const p = a === b ? 0 : (t - a.t) / (b.t - a.t), L = k => a[k] + (b[k] - a[k]) * p;
  const v = {
    rr: Math.round(L('rr')), spo2: Math.round(L('spo2')), sbp: Math.round(L('sbp')), dbp: Math.round(L('dbp')),
    hr: Math.round(L('hr')), temp: Math.round(L('temp') * 10) / 10,
    cons: at(C.vitals.consciousness, t, 'v') || 'A'
  };
  // 実施済みの介入の効果
  C.actions.forEach(act => {
    if (!act.effect || !S.done.has(act.id)) return;
    Object.entries(act.effect).forEach(([k, e]) => {
      if (typeof v[k] !== 'number') return;
      v[k] += e.add || 0;
      if (e.max !== undefined) v[k] = Math.min(e.max, v[k]);
      if (e.min !== undefined) v[k] = Math.max(e.min, v[k]);
    });
  });
  return v;
}
function oxyText() { const o = C.vitals.oxygen || {}; return S.o2 ? (o.on || '酸素投与中') : (o.off || '室内気'); }
function fill(tpl, v) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => {
    if (k === 'o2') return oxyText();
    if (k === 'temp') return v.temp.toFixed(1);
    return v[k] !== undefined ? v[k] : m;
  });
}

// ================= NEWS2 =================
const sc = {
  rr: v => v <= 8 ? 3 : v <= 11 ? 1 : v <= 20 ? 0 : v <= 24 ? 2 : 3,
  spo2: v => v <= 91 ? 3 : v <= 93 ? 2 : v <= 95 ? 1 : 0,
  o2: o => o ? 2 : 0,
  sbp: v => v <= 90 ? 3 : v <= 100 ? 2 : v <= 110 ? 1 : v <= 219 ? 0 : 3,
  hr: v => v <= 40 ? 3 : v <= 50 ? 1 : v <= 90 ? 0 : v <= 110 ? 1 : v <= 130 ? 2 : 3,
  cons: c => c === 'A' ? 0 : 3,
  temp: v => v <= 35 ? 3 : v <= 36 ? 1 : v <= 38 ? 0 : v <= 39 ? 1 : 2
};
function newsLevel(total, anyThree) {
  if (total >= 7) return { cls: 'ng', txt: '7点以上：緊急対応。直ちに医師へ報告し、RRS/救急対応チームの要請を。' };
  if (total >= 5) return { cls: 'mid', txt: '5〜6点：緊急の対応が必要。速やかに医師へ報告し、院内のRRS起動基準を確認。' };
  if (anyThree) return { cls: 'mid', txt: '単一項目3点：速やかに医師へ報告を。' };
  return { cls: 'ok', txt: '0〜4点：観察を継続し、必要に応じて報告。' };
}

// ================= 描画 =================
function renderTick() {
  $('clock').textContent = `${tm()}分`;
  const look = (C.looks || []).length ? (() => { let p = C.looks[0]; for (const x of C.looks) if (S.t >= x.from) p = x; return p; })() : null;
  if (look) {
    $('sweat').setAttribute('opacity', look.sweat ?? 0.6);
    $('face').setAttribute('fill', look.face || '#f4bfa0');
    $('mouth').setAttribute('d', look.mouth === 'grimace' ? 'M55 123 q8 -7 15 0' : 'M55 121 q8 -4 15 0');
  }
  const rr = truth(S.t).rr; if (rr !== renderTick.rr) { renderTick.rr = rr; $('breath').setAttribute('dur', (60 / rr).toFixed(2) + 's'); }
  const m = S.measured, age = x => x ? (tm() - Math.floor(x.t) === 0 ? 'たった今' : `${tm() - Math.floor(x.t)}分前`) : '未測定';
  const box = (lab, cls, val, x) => `<div class="vbox ${x && S.t - x.t >= 10 ? 'stale' : ''}"><div class="lab">${lab}</div><div class="val ${cls}">${val}</div><div class="age">${age(x)}</div></div>`;
  $('vitals').innerHTML =
    box('HR', 'c-hr', m.hr ? m.hr.v : '—', m.hr) +
    box('SpO2 %', 'c-sp', m.spo2 ? m.spo2.v : '—', m.spo2) +
    box('BP', 'c-bp', m.sbp ? `<span style="font-size:18px">${m.sbp.v}/${m.sbp.d}</span>` : '—', m.sbp) +
    box('RR', 'c-rr', m.rr ? m.rr.v : '—', m.rr) +
    box('体温 ℃', 'c-t', m.temp ? m.temp.v.toFixed(1) : '—', m.temp) +
    box('意識', 'c-c', m.cons ? m.cons.v : '—', m.cons);
}
function renderChat() {
  $('chat').innerHTML = S.chat.map(c => `<div class="msg ${c.who}${c.typing ? ' typing' : ''}"${c.who === 'p' ? ` data-n="${esc(pname())}"` : ''}>${esc(c.text)}</div>`).join('');
  $('chat').scrollTop = $('chat').scrollHeight;
}
function addLog(kind, txt) { S.log.push({ t: tm(), kind, txt }); }
function setMode(m) {
  S.mode = m;
  document.querySelectorAll('#mode button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  $('cform').classList.toggle('obs', m === 'obs');
  $('cinput').placeholder = m === 'talk' ? `${pname()}に話しかける` : '何を観察・ケアしますか？（例：呼吸数を数える）';
}
$('mode').onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); };

// ================= 時間 =================
let lastTs = null;
function loop(ts) {
  if (lastTs !== null && S && C && !S.over && !S.paused) {
    S.t += ((ts - lastTs) / 1000) / SEC_PER_MIN;
    checkEvents(); renderTick();
  }
  lastTs = ts; requestAnimationFrame(loop);
}
function checkEvents() {
  (C.events || []).forEach((ev, i) => {
    if (S.t >= ev.t && !S.events[i]) {
      S.events[i] = 1;
      if (ev.patient) patientSays(ev.patient);
      if (ev.system) sysSay(ev.system);
      if (ev.log) addLog('event', ev.log);
    }
  });
  if (S.t >= (C.timeLimit || 40) && !S.reported && !S.over) endGame(false);
}
function setPaused(p) { S.paused = p; $('bPause').textContent = p ? '▶' : '⏸'; $('pausedBanner').classList.toggle('show', p && !S.over); }
$('bPause').onclick = () => { if (!S.over) setPaused(!S.paused); };
document.addEventListener('visibilitychange', () => { if (document.hidden && S && !S.over) setPaused(true); });

let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200); }
function openSheet(html) { $('sheet').innerHTML = html; $('ov').classList.add('show'); $('sheet').scrollTop = 0; }
function closeSheet() { $('ov').classList.remove('show'); }
$('ov').addEventListener('click', e => { if (e.target.id === 'ov' && S && !S.over && !S.busy) closeSheet(); });
function later(fn, ms) { const id = setTimeout(fn, ms); S.timers.push(id); return id; }

// ================= 音声 =================
let TTS = null, voiceOn = true, AI = null, DICT = null;
const synth = window.speechSynthesis || null;
function speak(text) {
  if (!voiceOn || !text || /^…+$/.test(text)) return;
  const ring = $('speakRing');
  const vc = (C && C.patient.voice) || {};
  if (TTS) {
    ring.setAttribute('opacity', 1);
    TTS.speak(text, { voice: 'rounded', language: 'ja', rate: vc.rate || 0.9 }).catch(() => {}).finally(() => ring.setAttribute('opacity', 0));
    return;
  }
  if (synth) {
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP'; u.rate = vc.rate || 0.9; u.pitch = vc.pitch || 1;
      const jv = synth.getVoices().filter(v => v.lang && v.lang.startsWith('ja'));
      const want = vc.gender === 'female' ? /kyoko|female|女|o-ren|haruka|nanami/i : /otoya|ichiro|male|男|keita/i;
      const hit = jv.find(v => want.test(v.name));
      if (hit) u.voice = hit; else if (jv[0]) u.voice = jv[0];
      u.onstart = () => ring.setAttribute('opacity', 1);
      u.onend = u.onerror = () => ring.setAttribute('opacity', 0);
      synth.speak(u);
    } catch (e) {}
  }
}
function stopVoice() { try { TTS && TTS.stop(); } catch (e) {} try { synth && synth.cancel(); } catch (e) {} }
$('bVoice').onclick = () => { voiceOn = !voiceOn; $('bVoice').textContent = voiceOn ? '🔊' : '🔇'; if (!voiceOn) stopVoice(); };

// ================= 会話 =================
const stageDesc = () => at(C.patient.stages, S.t, 'desc');
function patientPrompt() {
  const hist = S.chat.filter(c => ['n', 'p', 'a'].includes(c.who) && !c.typing).slice(-16)
    .map(c => (c.who === 'n' ? '看護師' : c.who === 'a' ? '（看護師の行動）' : pname()) + '：' + c.text).join('\n');
  return `あなたは看護師教育用シミュレーションの「患者役」です。以下の設定で、患者本人として返事だけを書いてください。

【患者設定】
${C.patient.profile}
【今の状態】${stageDesc()}
【話し方のルール】
${(C.patient.speechRules || []).map(r => '- ' + r).join('\n')}
- 出力は${pname()}のセリフのみ。ト書きや（ ）での動作説明は書かない。

【これまでの様子】
${hist}

${pname()}の返事：`;
}
function fallbackReply(q) {
  for (const r of (C.patient.replies || [])) {
    try { if (new RegExp(r.match, 'i').test(q)) return at(r.say, S.t); } catch (e) {}
  }
  return at(C.patient.defaultReply, S.t) || '…';
}
function patientSays(text) { S.chat.push({ who: 'p', text }); renderChat(); speak(text); }
function sysSay(text) { S.chat.push({ who: 's', text }); renderChat(); }
async function talk(q) {
  S.chat.push({ who: 'n', text: q }); S.asked++;
  try { if (C.patient.orientationMatch && new RegExp(C.patient.orientationMatch).test(q)) S.found.add('talk'); } catch (e) {}
  const typing = { who: 'p', text: '…', typing: true }; S.chat.push(typing); renderChat();
  let reply = null;
  if (AI) {
    try {
      const r = await AI(patientPrompt(), { cache: false, modelTier: 'quick' });
      const nm = pname().replace(/さん$/, '');
      reply = (r.text || '').replace(new RegExp('^' + nm + '[さん]*[：:]\\s*'), '').replace(/[（(][^）)]*[）)]/g, '').trim();
    } catch (e) { if (e && e.code === 'not_granted') { AI = null; setAiNote(); } }
  }
  if (!reply) reply = fallbackReply(q);
  S.chat.splice(S.chat.indexOf(typing), 1);
  if (S.over && S.result !== null) return;
  addLog('talk', `「${q}」→ ${pname()}「${reply}」`);
  patientSays(reply);
}

// ================= 観察・ケア（自由入力） =================
function matchByRegex(q) {
  const ids = [];
  C.actions.forEach(a => { try { if (new RegExp(a.match, 'i').test(q)) ids.push(a.id); } catch (e) {} });
  return ids;
}
async function observe(q) {
  if (S.busy) return;
  if (/報告|ドクター|医師|ドクターコール|RRS|主治医|当直/.test(q) && !/準備/.test(q)) { sbarSheet(); return; }
  S.chat.push({ who: 'a', text: q }); renderChat();
  S.busy = true;
  let ids = [], other = '';
  if (AI) {
    const list = C.actions.map(a => `${a.id}: ${a.desc}`).join('\n');
    try {
      const r = await AI.json(`看護師教育シミュレーションです。看護師が入力した「観察・ケアの内容」を、下の行動IDに対応づけてください。

【行動ID一覧】
${list}

【看護師の入力】
${q}

ルール：
- 入力に含まれる行動を、該当するIDすべて（順番どおり）ids に入れる。
- どのIDにも当てはまらない観察・ケアが含まれていれば、下の患者情報をもとに、その所見だけを other に1〜2文で書く（看護記録の文体）。患者情報にないことは「特記すべき異常なし」とする。数値のバイタルサインは other に書かない。
- 観察やケアとして意味をなさない入力なら ids を空にし、other に「何を観察・実施するか、もう少し具体的に入力してください。」と書く。

【患者情報（other の所見を書くときだけ使う）】
${C.truth.diagnosis} 今の様子：${stageDesc()} ${at(C.zones && C.zones.arm, S.t)}
${C.extraFacts || ''}

JSONのみ：{"ids":["..."],"other":""}`, { cache: false, modelTier: 'quick' });
      if (r && Array.isArray(r.ids)) ids = r.ids.filter(id => C.actions.some(a => a.id === id));
      if (r && typeof r.other === 'string') other = r.other.trim();
    } catch (e) { if (e && e.code === 'not_granted') { AI = null; setAiNote(); } ids = matchByRegex(q); }
  } else {
    ids = matchByRegex(q);
  }
  ids = [...new Set(ids)];
  if (!ids.length && !other) {
    S.busy = false;
    sysSay(AI ? 'うまく読み取れませんでした。何を観察・実施するか、もう少し具体的に入力してください。' : 'うまく読み取れませんでした。観察する項目やケアの内容を具体的に入力してください。（例：呼吸数を数える、血圧を測る、腹部を観察する）');
    return;
  }
  const acts = ids.map(id => C.actions.find(a => a.id === id));
  const sec = Math.max(2, acts.reduce((s, a) => s + (a.sec || 2), 0) + (other ? 2 : 0));
  openSheet(`<h3>🩺 実施中…</h3><p>${esc(q)}</p><div class="prog"><i id="pg"></i></div><p class="hint">観察している間も、時間は流れています。</p>`);
  requestAnimationFrame(() => { const pg = $('pg'); if (pg) { pg.style.transitionDuration = sec + 's'; pg.style.width = '100%'; } });
  later(() => {
    S.busy = false; closeSheet(); if (S.over) return;
    acts.forEach(a => {
      if (a.oxygen) S.o2 = true;
      S.done.add(a.id);
      const v = truth(S.t);
      if (a.measure) {
        const k = a.measure;
        S.measured[k] = k === 'sbp' ? { v: v.sbp, d: v.dbp, t: S.t } : { v: v[k], t: S.t };
      }
      const txt = fill(at(a.findings, S.t), v);
      if (a.key) S.found.add(a.key);
      S.chat.push({ who: 'f', text: txt }); addLog('obs', txt);
    });
    if (other) { S.chat.push({ who: 'f', text: other }); addLog('obs', other); }
    renderChat(); renderTick();
    const withReply = acts.find(a => a.patientReply);
    if (withReply) later(() => { if (!S.over) patientSays(withReply.patientReply); }, 900);
  }, sec * 1000);
}
$('cform').addEventListener('submit', e => {
  e.preventDefault(); if (!S || S.over) return;
  const v = $('cinput').value.trim(); if (!v) return; $('cinput').value = '';
  if (S.mode === 'talk') talk(v); else observe(v);
});
function setAiNote() { $('aiNote').textContent = AI ? `AIが${pname()}を演じます` : ''; }

// 体のタップ＝見た目（視診）
document.addEventListener('click', e => {
  if (!S || S.over || !C) return;
  const z = e.target.closest('.zone'); if (!z) return;
  const txt = at(C.zones && C.zones[z.dataset.zone], S.t); if (!txt) return;
  S.chat.push({ who: 'f', text: '（見た目）' + txt }); addLog('look', txt); renderChat();
});

// 音声入力（claude.ai 上で動かしたときだけ使える）
let micOn = false, micTarget = null;
function micToggle(target) {
  if (!DICT) return;
  if (micOn) { DICT.stop().catch(() => {}); return; }
  micTarget = target;
  DICT.start().catch(err => { if (err && err.code === 'not_granted') { DICT = null; document.querySelectorAll('.mic').forEach(b => b.hidden = true); } });
}
function setupDictation() {
  DICT.onPartial(({ text }) => { if (micTarget && micTarget.tagName === 'INPUT') micTarget.placeholder = text; });
  DICT.onFinal(({ text }) => { if (micTarget) micTarget.value = (micTarget.value ? micTarget.value + ' ' : '') + text; });
  DICT.onState(({ state }) => {
    micOn = state === 'listening'; document.querySelectorAll('.mic').forEach(b => b.classList.toggle('on', micOn));
    if (!micOn && micTarget && micTarget.id === 'cinput') { setMode(S.mode); if (micTarget.value.trim()) $('cform').requestSubmit(); }
  });
}
$('bMic').onclick = () => micToggle($('cinput'));

// ================= NEWS2（任意） =================
function newsSheet() {
  if (S.over) return;
  const m = S.measured;
  const rows = [
    ['rr', '呼吸数', m.rr ? `${m.rr.v}回/分` : null, [0, 1, 2, 3]],
    ['spo2', 'SpO2（スケール1）', m.spo2 ? `${m.spo2.v}%` : null, [0, 1, 2, 3]],
    ['o2', '酸素投与', S.o2 ? `あり（${oxyText()}）` : 'なし（室内気）', [0, 2]],
    ['sbp', '収縮期血圧', m.sbp ? `${m.sbp.v} mmHg` : null, [0, 1, 2, 3]],
    ['hr', '脈拍', m.hr ? `${m.hr.v}回/分` : null, [0, 1, 2, 3]],
    ['cons', '意識（ACVPU）', m.cons ? m.cons.v : null, [0, 3]],
    ['temp', '体温', m.temp ? `${m.temp.v.toFixed(1)}℃` : null, [0, 1, 2, 3]]
  ];
  const sel = {};
  openSheet(`<h3>NEWS2を計算（任意）</h3><p class="hint">測った項目だけで計算できます。報告するのにNEWS2の計算は必須ではありません。</p>
    <div id="nrows">${rows.map(r => `<div class="nrow"><div><div class="nm">${r[1]}</div><div class="mv">${r[2] ?? '未測定'}</div></div>
    <div class="pts">${r[3].map(p => `<button class="pt" data-k="${r[0]}" data-p="${p}" ${r[2] ? '' : 'disabled'}>${p}</button>`).join('')}</div></div>`).join('')}</div>
    <div id="nres"></div>
    <button class="btn wide" id="nGo">答え合わせ</button>
    <button class="btn sec wide" id="cl" style="margin-top:8px">閉じる</button>`);
  $('cl').onclick = closeSheet;
  $('nrows').onclick = e => {
    const b = e.target.closest('.pt'); if (!b || b.disabled) return;
    sel[b.dataset.k] = +b.dataset.p;
    document.querySelectorAll(`.pt[data-k="${b.dataset.k}"]`).forEach(x => x.classList.toggle('on', x === b));
  };
  $('nGo').onclick = () => {
    const avail = rows.filter(r => r[2]);
    if (avail.some(r => sel[r[0]] === undefined)) { $('nres').innerHTML = `<div class="result mid">測定済みの項目の点数を選んでください。</div>`; return; }
    const fn = { rr: () => sc.rr(m.rr.v), spo2: () => sc.spo2(m.spo2.v), o2: () => sc.o2(S.o2), sbp: () => sc.sbp(m.sbp.v), hr: () => sc.hr(m.hr.v), cons: () => sc.cons(m.cons.v), temp: () => sc.temp(m.temp.v) };
    let total = 0, anyThree = false, allOk = true;
    avail.forEach(r => {
      const k = r[0], right = fn[k](); total += right; if (right === 3) anyThree = true;
      document.querySelectorAll(`.pt[data-k="${k}"]`).forEach(x => {
        x.disabled = true; x.classList.remove('on');
        const p = +x.dataset.p; if (p === right) x.classList.add('right'); else if (p === sel[k]) { x.classList.add('wrong'); allOk = false; }
      });
    });
    const missing = rows.filter(r => !r[2]).map(r => r[1]);
    const lv = newsLevel(total, anyThree);
    S.news = { t: tm(), total, partial: missing.length > 0, allOk };
    addLog('news', `NEWS2を計算：${total}点${missing.length ? '（未測定項目あり）' : ''}`);
    $('nres').innerHTML = `<div class="result info">${allOk ? '計算どおりです。' : '緑が正しい点数です。'}</div>
      <div style="font-size:20px;font-weight:700">合計 ${total}点${missing.length ? ' 以上' : ''}</div>
      ${missing.length ? `<p class="hint">未測定：${missing.join('、')}。測ればさらに点数が上がる可能性があります。</p>` : ''}
      <div class="result ${lv.cls}">${lv.txt}</div>`;
    $('nGo').hidden = true;
  };
}

// ================= 報告（いつでも可） =================
const doctor = () => (C.report && C.report.doctor) || '医師';
const maxTries = () => (C.report && C.report.maxTries) || MAX_REPORT_DEFAULT;
function sbarSheet() {
  if (S.over) return;
  if (AI) return sbarFree();
  return sbarChoice();
}
function measuredSummary() {
  const m = S.measured, f = (x, s) => x ? s : '未測定';
  const extra = (C.keyFindings || []).filter(k => !['rr', 'spo2', 'hr', 'sbp', 'temp', 'cons', 'talk'].includes(k.key))
    .map(k => `${k.label}:${S.found.has(k.key) ? '確認済み' : '未確認'}`).join(' / ');
  return `呼吸数:${f(m.rr, m.rr && m.rr.v)} / SpO2:${f(m.spo2, m.spo2 && m.spo2.v + '%')} / 血圧:${f(m.sbp, m.sbp && m.sbp.v + '/' + m.sbp.d)} / 脈拍:${f(m.hr, m.hr && m.hr.v)} / 体温:${f(m.temp, m.temp && m.temp.v)} / 意識:${f(m.cons, m.cons && m.cons.v)}${extra ? ' / ' + extra : ''}`;
}
function renderThread() {
  return S.doc.map(d => d.who === 'me' ? `<div class="me">${esc(d.text)}</div>` : `<div class="dr" data-n="${esc(doctor())}">${esc(d.text)}</div>`).join('');
}
function sbarFree() {
  const MAX = maxTries();
  openSheet(`<h3>📞 ${esc(doctor())}へ報告</h3>
    <p class="hint">電話で伝えるつもりで、自由に書いてください。情報が足りなければ医師が聞き返します。いったん閉じて観察してから、続きを伝えることもできます。${MAX}回伝えると、医師が診察に来て振り返りに進みます。</p>
    <div class="thread" id="thread">${renderThread()}</div>
    <textarea id="sText" placeholder="${S.doc.length ? '医師への返答・補足' : esc(C.report.placeholder || '')}"></textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn sec mic" id="sMic" ${DICT ? '' : 'hidden'} style="flex:none;width:56px">🎤</button>
      <button class="btn red" id="sGo" style="flex:1">伝える</button>
    </div>
    <button class="btn sec wide" id="cl" style="margin-top:8px">いったん閉じて観察を続ける</button>`);
  $('cl').onclick = closeSheet;
  if (DICT) $('sMic').onclick = () => micToggle($('sText'));
  $('sGo').onclick = async () => {
    const txt = $('sText').value.trim(); if (!txt) return;
    S.doc.push({ who: 'me', text: txt }); $('thread').innerHTML = renderThread(); $('sText').value = '';
    $('sGo').disabled = true; $('sGo').textContent = '医師が聞いています…';
    const v = truth(S.t);
    const conv = S.doc.map(d => (d.who === 'me' ? '看護師' : '医師') + '：' + d.text).join('\n');
    const prompt = `あなたは看護師教育シミュレーションの「${doctor()}」役です。病棟看護師からの電話報告を受けています。医師として返答してください。

【患者の実際の状態（看護師はまだ全部は知らない）】
${C.patient.profile}
${C.truth.diagnosis}
現在：呼吸数${v.rr}、SpO2 ${v.spo2}%、血圧${v.sbp}/${v.dbp}、脈拍${v.hr}、体温${v.temp}℃、意識${v.cons === 'A' ? '清明' : '新たな混乱など（' + v.cons + '）'}。${C.truth.hiddenFindings || ''}

【看護師がこれまでに測定・観察したこと】
${measuredSummary()}

【電話のやりとり】
${conv}

【返答のしかた】
- 医師らしい口語で、1〜2文。
- 看護師が測っていない重要な情報（呼吸数・血圧・脈拍・体温・意識・この症例で大事な所見など）が報告に必要なら、1つか2つに絞って「血圧はいくつ？」のように聞き返す。看護師が「測っていない」「これから測る」と言った場合は「測って折り返して」と言ってよい。
- 患者が誰で、何が起きていて、看護師がどう判断し、何をしてほしいかが、おおむね伝わったら ok=true にして「すぐ行きます」と、具体的な指示（${C.report.orders || '必要な検査や処置の準備'}）を伝える。完璧な用語や形式は求めない。
- 看護師の判断が「様子見でよい」など明らかに危険なら、医師として状態をもう少し詳しく聞き返す。

JSONのみ：{"ok":true/false,"reply":"医師の返答"}`;
    let res = null;
    try { res = await AI.json(prompt, { cache: false }); } catch (e) { if (e && e.code === 'not_granted') { AI = null; setAiNote(); } }
    $('sGo').disabled = false; $('sGo').textContent = '伝える';
    if (!res || typeof res.ok !== 'boolean' || !res.reply) {
      S.doc.pop(); $('thread').innerHTML = renderThread(); $('sText').value = txt;
      if (!AI) { sbarChoice(); return; }
      toast('通信がうまくいきませんでした。もう一度送ってください。'); return;
    }
    S.doc.push({ who: 'dr', text: res.reply }); $('thread').innerHTML = renderThread();
    addLog('report', `医師へ報告「${txt}」→ 医師「${res.reply}」`);
    if (res.ok) { S.reported = true; $('sGo').disabled = true; later(() => { closeSheet(); endGame(true); }, 2600); return; }
    const tries = S.doc.filter(d => d.who === 'me').length;
    if (tries >= MAX) {
      S.reported = true; $('sGo').disabled = true;
      S.doc.push({ who: 'dr', text: 'わかった、とりあえず今から見に行くよ。' }); $('thread').innerHTML = renderThread();
      addLog('report', 'やりとりを重ねたのち、医師が診察に来ることになった');
      later(() => { closeSheet(); endGame('partial'); }, 2600);
    } else {
      $('sText').placeholder = `医師への返答・補足（あと${MAX - tries}回で医師が来ます）`;
    }
  };
}
function sbarChoice() {
  const SB = C.report.choices || [];
  const MAX = maxTries();
  const sel = {};
  openSheet(`<h3>📞 ${esc(doctor())}へ報告</h3><p class="hint">伝える内容を選んでください。</p>
    ${SB.map(s => `<div class="sbar-q"><div><span class="k">${s.k}</span><b>${esc(s.q)}</b></div>${s.options.map((o, i) => `<button class="opt" data-k="${s.k}" data-i="${i}">${esc(o.text)}</button>`).join('')}</div>`).join('')}
    <div id="sres"></div><button class="btn red wide" id="sGo">伝える</button>
    <button class="btn sec wide" id="cl" style="margin-top:8px">いったん閉じて観察を続ける</button>`);
  $('cl').onclick = closeSheet;
  document.querySelectorAll('.opt[data-k]').forEach(b => b.onclick = () => {
    sel[b.dataset.k] = +b.dataset.i;
    document.querySelectorAll(`.opt[data-k="${b.dataset.k}"]`).forEach(x => x.classList.toggle('on', x === b));
  });
  $('sGo').onclick = () => {
    if (Object.keys(sel).length < SB.length) { $('sres').innerHTML = `<div class="result mid">${SB.map(s => s.k).join('・')}それぞれ選んでください。</div>`; return; }
    const wrong = SB.filter(s => !s.options[sel[s.k]].ok).map(s => s.k);
    const said = SB.map(s => s.options[sel[s.k]].text).join(' ');
    if (!wrong.length) { S.reported = true; S.doc.push({ who: 'me', text: said }); addLog('report', `医師へ報告「${said}」→ すぐ診察に来ることに`); closeSheet(); endGame(true); return; }
    const msg = wrong.includes('A') || wrong.includes('R') ? '医師：「で、どう判断していて、何をしてほしいの？」' : '医師：「状況がよくわからないな。もう少し詳しく教えて。」';
    addLog('report', `医師へ報告「${said}」→ ${msg}`);
    S.doc.push({ who: 'me', text: said }, { who: 'dr', text: msg.replace(/^医師：/, '') });
    const tries = S.doc.filter(d => d.who === 'me').length;
    if (tries >= MAX) {
      S.reported = true; $('sGo').disabled = true;
      $('sres').innerHTML = `<div class="result mid">医師：「わかった、とりあえず今から見に行くよ。」</div>`;
      later(() => { closeSheet(); endGame('partial'); }, 2200); return;
    }
    $('sres').innerHTML = `<div class="result mid">${msg}<br><small>あと${MAX - tries}回で医師が来ます</small></div>`;
  };
}

// ================= アセスメント =================
const AS_ROWS = [
  ['A', 'Airway（気道）'],
  ['B', 'Breathing（呼吸）'],
  ['C', 'Circulation（循環）'],
  ['D', 'Disability（意識）'],
  ['E', 'Exposure（全身・その他）'],
  ['X', '総合：何が起きていると考える？どうする？']
];
const asPh = k => (C.assessment && C.assessment.placeholders && C.assessment.placeholders[k]) || '';
const asEx = k => (C.assessment && C.assessment.expert && C.assessment.expert[k]) || '';
function assessSheet(final) {
  if (S.over && !final) return;
  openSheet(`<h3>✍️ アセスメント${final ? '（最後に）' : ''}</h3>
    <p class="hint">${final ? '振り返りの前に、今のあなたの考えを書いてみましょう。書けるところだけで大丈夫です。' : '「〇〇だから△△」と、根拠と判断を短く書いてみましょう。書いている間も時間は流れます。いつでも書き足せます。'}</p>
    ${AS_ROWS.map(r => `<div class="asrow"><label for="as${r[0]}"><span class="k">${r[0] === 'X' ? '★' : r[0]}</span>${r[1]} ${S.assessT[r[0]] !== undefined ? `<span class="ts">（${S.assessT[r[0]]}分に記入）</span>` : ''}</label>
      <textarea id="as${r[0]}" placeholder="${esc(asPh(r[0]))}">${esc(S.assess[r[0]])}</textarea></div>`).join('')}
    <button class="btn wide" id="asSave">${final ? '振り返りへ' : '保存して戻る'}</button>
    ${final ? '' : '<button class="btn sec wide" id="cl" style="margin-top:8px">保存せずに閉じる</button>'}`);
  if (!final) $('cl').onclick = closeSheet;
  $('asSave').onclick = () => {
    const changed = [];
    AS_ROWS.forEach(([k]) => { const v = $('as' + k).value.trim(); if (v !== S.assess[k]) { S.assess[k] = v; S.assessT[k] = tm(); if (v) changed.push(k === 'X' ? '総合' : k); } });
    if (changed.length) addLog('assess', `アセスメントを記入（${changed.join('・')}）`);
    closeSheet();
    if (final) showReflection(S.result);
  };
}
$('bAs').onclick = () => assessSheet(false);
function asCard(r, fb) {
  const k = r[0], mine = S.assess[k], f = fb && fb[k];
  return `<div class="ascard"><div class="hd"><span class="k">${k === 'X' ? '★' : k}</span>${r[1]}</div>
    <div class="mine">${mine ? esc(mine) : '<span class="hint">（未記入）</span>'}</div>
    ${f && f.seen ? `<div class="seen">${esc(f.seen)}</div>` : ''}
    ${f && f.next ? `<div class="nx">${esc(f.next)}</div>` : ''}
    <details><summary>熟練看護師のアセスメント例</summary>${esc(asEx(k))}</details></div>`;
}
async function assessFeedback() {
  if (!AI || !AS_ROWS.some(([k]) => S.assess[k])) return;
  const box = $('asBox'); if (!box) return;
  box.insertAdjacentHTML('afterbegin', '<p class="hint" id="asLoading">あなたのアセスメントを読んでいます…</p>');
  const obsLog = S.log.filter(l => ['obs', 'look', 'talk'].includes(l.kind)).map(l => `${l.t}分 ${l.txt}`).join('\n');
  const notes = AS_ROWS.map(([k, n]) => `${k}（${n}）：${S.assess[k] || '（未記入）'}`).join('\n');
  try {
    const r = await AI.json(`あなたは急性期病棟の、あたたかく経験豊富な教育担当看護師です。シミュレーション学習者が書いたABCDEごとのアセスメントを読み、思考の流れ（根拠→判断）がどこまで見えているかを伝えてください。点数はつけません。

【症例の正解情報】
${C.truth.diagnosis}
${AS_ROWS.map(([k]) => k + '：' + asEx(k)).join('\n')}

【学習者が実際に観察・聴取したこと】
${obsLog || '（記録なし）'}

【学習者のアセスメント】
${notes}

各項目（A,B,C,D,E,X）について：
- seen：学習者の記述から読み取れる、根拠と判断のつながりを具体的に認める（1文）。未記入なら空文字。
- next：さらによくなる視点を1つ、やさしく問いかける形で（1文）。観察していない値を根拠にしている、根拠が書かれていない、判断が飛んでいる、などがあればここで穏やかに触れる。未記入なら、その項目で注目するとよい点を1文で。
- 「できていない」「間違い」などの否定的な言葉は使わない。

JSONのみ：{"A":{"seen":"","next":""},"B":{"seen":"","next":""},"C":{"seen":"","next":""},"D":{"seen":"","next":""},"E":{"seen":"","next":""},"X":{"seen":"","next":""}}`, { cache: false });
    const el = $('asBox'); if (el && r) el.innerHTML = AS_ROWS.map(row => asCard(row, r)).join('');
  } catch (e) { const l = $('asLoading'); if (l) l.textContent = 'コメントを作成できませんでした。熟練看護師の例と見比べてみてください。'; }
}

// ================= 振り返り =================
function endGame(success) {
  S.over = true; S.result = success; setPaused(false); $('pausedBanner').classList.remove('show');
  if (!success) patientSays('…………');
  // 進み具合を保存（一覧画面のマークに使う）
  const st = loadStore(); const prev = st.results[C.id];
  const rank = { true: 3, partial: 2, false: 1 };
  if (!prev || rank[String(success)] >= rank[String(prev.result)]) st.results[C.id] = { result: success, date: new Date().toISOString().slice(0, 10) };
  saveStore(st);
  const msg = success === true ? `${doctor()}がすぐに診察に来ることになりました。` : success === 'partial' ? `何度かやりとりをして、${doctor()}が診察に来ることになりました。` : `${pname()}の状態が悪くなり、救急対応チームが呼ばれました。`;
  openSheet(`<h3>${success === true ? '📞 報告が伝わりました' : success === 'partial' ? '📞 医師が来ることになりました' : '⚠️ 状態が変化しました'}</h3><div class="result ${success === true ? 'ok' : 'mid'}">${msg}</div>
    <p>振り返りの前に、あなたのアセスメントを整理してみましょう。</p>
    <button class="btn wide" id="toAs">アセスメントを書く</button>
    <button class="btn sec wide" id="skipAs" style="margin-top:8px">このまま振り返りへ</button>`);
  $('toAs').onclick = () => assessSheet(true);
  $('skipAs').onclick = () => { closeSheet(); showReflection(success); };
}
function showReflection(success) {
  const E = C.endings || {};
  const head = success === true ? `<div class="result ok">${esc(E.success || '')}</div>`
    : success === 'partial' ? `<div class="result info">${esc(E.partial || '')}</div>`
    : `<div class="result mid">${esc(E.fail || '')}</div>`;
  const impTxt = { stable: '安定している', odd: 'なんか変（すぐに観察が必要）', call: '今すぐ人を呼ぶべき' }[S.impression] || '—';
  const mine = S.log.length ? S.log.map(l => `<li><b>${l.t}分</b>${esc(({ talk: '💬 ', obs: '🩺 ', look: '👀 ', news: '🧮 ', report: '📞 ', event: '⚠️ ', assess: '✍️ ' }[l.kind] || '') + l.txt)}</li>`).join('') : '<li><b>—</b>記録はありません</li>';
  const KF = C.keyFindings || [];
  const got = KF.filter(k => S.found.has(k.key)).map(k => `<li>${esc(k.label)}</li>`).join('') || '<li>次回は、気になったところから確認してみましょう。</li>';
  const notYet = KF.filter(k => !S.found.has(k.key)).map(k => `<li><b>${esc(k.label)}</b>：${esc(k.hint)}</li>`).join('');
  const sx = C.sbarExample || {};
  const sbarHtml = ['S', 'B', 'A', 'R'].filter(k => sx[k]).map(k => `<p style="margin:4px 0"><b>${k}</b>：${esc(sx[k])}</p>`).join('')
    + (sx.note ? `<p class="hint" style="margin:6px 0 0">${esc(sx.note)}</p>` : '');
  openSheet(`<h3>振り返り</h3>${head}
    <h4>あなたの第一印象</h4>
    <div>${impTxt}${S.impReason ? `<div class="hint">理由：${esc(S.impReason)}</div>` : ''}</div>
    <h4>あなたが確かめられたこと</h4><ul class="good">${got}</ul>
    ${notYet ? `<h4>次に確かめてみたいこと</h4><ul class="good next">${notYet}</ul>` : ''}
    ${S.doc.length ? `<h4>医師とのやりとり</h4><div class="thread">${renderThread()}</div>` : ''}
    ${sbarHtml ? `<details class="ascard" ${success === 'partial' ? 'open' : ''}><summary style="font-weight:700;color:var(--navy);font-size:14px">📞 報告（SBAR）の例</summary>
      <div style="font-size:13.5px;margin-top:6px">${sbarHtml}</div></details>` : ''}
    <h4>アセスメントの振り返り</h4>
    <div id="asBox">${AS_ROWS.map(r => asCard(r, null)).join('')}</div>
    <div id="aiBox">${AI ? '<h4>指導者からのコメント</h4><div class="aifb" id="aiFb">コメントを作成しています…</div>' : ''}</div>
    <h4>あなたの動き</h4><ul class="tl">${mine}</ul>
    <h4>熟練看護師の動きの一例</h4><ul class="tl exp">${(C.expert || []).map(e => `<li><b>${esc(e.t)}</b>${esc(e.text)}</li>`).join('')}</ul>
    <h4>この症例のポイント</h4>
    <ul style="padding-left:18px;font-size:14px;margin-top:0">${(C.points || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul>
    <button class="btn wide" id="again" style="margin-top:12px">もう一度やってみる</button>
    <button class="btn sec wide" id="toList" style="margin-top:8px">症例の一覧へ</button>`);
  $('again').onclick = () => { closeSheet(); startCase(); };
  $('toList').onclick = () => { closeSheet(); location.hash = '#/'; };
  assessFeedback();
  if (AI) {
    const logTxt = S.log.map(l => `${l.t}分 [${l.kind}] ${l.txt}`).join('\n');
    AI(`あなたは急性期病棟の、あたたかく経験豊富な教育担当看護師です。看護師がシミュレーションで、次の患者を担当しました：${C.truth.diagnosis} 点数や時間で評価せず、本人が次も挑戦したくなるような振り返りコメントを書いてください。

【結果】${success === true ? '医師へ報告し、早期の診察につながった' : success === 'partial' ? '医師への報告で何度か聞き返されたのち、医師が診察に来ることになった' : '報告前に患者の状態が悪化し、救急対応チームが呼ばれた'}
【第一印象】${impTxt}${S.impReason ? '（理由：' + S.impReason + '）' : ''}
【行動の記録】
${logTxt || '（記録なし）'}
【本人のアセスメント】
${AS_ROWS.map(([k, n]) => n + '：' + (S.assess[k] || '未記入')).join('\n')}

書き方：
- 日本語、やさしい口調、全体で250字程度。見出しや記号の装飾は使わない。
- 1段落目：この人ならではの、よかった気づきや行動を具体的に1〜2つ認める。
- 2段落目：「気づき→判断→行動」の流れで、次に意識するとさらによくなることを1〜2つ、問いかけの形も交えて伝える。
- 「できなかった」「不足」などの否定的な言葉は使わない。`, { cache: false }).then(r => { const el = $('aiFb'); if (el) el.textContent = (r.text || '').trim(); })
      .catch(() => { const b = $('aiBox'); if (b) b.innerHTML = ''; });
  }
}
$('bNews').onclick = newsSheet; $('bRep').onclick = sbarSheet;

// ================= 症例の開始 =================
function startCase() {
  stopCase();
  reset(); setPaused(false); setMode('talk'); renderTick(); renderChat(); setAiNote();
  $('caseTitle').textContent = `症例${C.number || ''}：${C.title}`;
  $('ptName').textContent = pname();
  document.title = `${C.title}｜ABCDEクエスト`;
  let spd = SEC_PER_MIN;
  const I = C.intro || {};
  openSheet(`<h3>症例${C.number || ''}：${esc(C.title)}</h3>
    <p>${(C.tags || []).map(t => `<span class="pill">${esc(t)}</span>`).join('')}</p>
    ${(I.paragraphs || []).map(p => `<p>${esc(p)}</p>`).join('')}
    <p>${esc(pname())}と話したり、気になるところを観察したりしながら、必要だと思ったらいつでも医師へ報告してください。決まった手順や正解の順番はありません。</p>
    <p>考えたことは「✍️ アセスメント」に、「〇〇だから△△」と短く書いておきましょう。</p>
    <div class="result info">時間はリアルタイムで流れ、${esc(pname())}の状態も変化していきます。右上の⏸で一時停止できます。</div>
    <div class="hint">時間の速さ</div>
    <div class="speed"><button class="btn sec ${spd === 10 ? 'on' : ''}" data-s="10">ゆっくり<br><small>1分＝10秒</small></button><button class="btn sec ${spd === 6 ? 'on' : ''}" data-s="6">標準<br><small>1分＝6秒</small></button></div>
    <button class="btn wide" id="go">部屋に入る</button>
    <button class="btn sec wide" id="back" style="margin-top:8px">症例の一覧へ戻る</button>`);
  document.querySelectorAll('.speed button').forEach(b => b.onclick = () => { spd = +b.dataset.s; document.querySelectorAll('.speed button').forEach(x => x.classList.toggle('on', x === b)); });
  $('back').onclick = () => { closeSheet(); location.hash = '#/'; };
  $('go').onclick = () => {
    SEC_PER_MIN = spd;
    speak(I.openingLine);
    impressionSheet();
  };
}
function impressionSheet() {
  const I = C.intro || {};
  // firstScene は症例ファイルに書いた <br> だけ改行として使う
  const scene = esc(I.firstScene || '').replace(/&lt;br\s*\/?&gt;/g, '<br>');
  openSheet(`<h3>👀 部屋に入った瞬間</h3>
    <div class="scene">${scene}</div>
    <p style="margin:12px 0 4px"><b>第一印象は？</b></p>
    <button class="opt" data-v="stable">安定している</button>
    <button class="opt" data-v="odd">なんか変（すぐに観察が必要）</button>
    <button class="opt" data-v="call">今すぐ人を呼ぶべき</button>
    <p style="margin:12px 0 4px" class="hint">そう感じた理由（任意）</p>
    <textarea id="impR" style="min-height:70px" placeholder="例：呼吸が浅くて速い、話し方がいつもと違う"></textarea>
    <button class="btn wide" id="impGo" disabled style="margin-top:10px">${esc(pname())}のそばへ</button>`);
  document.querySelectorAll('.opt[data-v]').forEach(b => b.onclick = () => {
    S.impression = b.dataset.v;
    document.querySelectorAll('.opt[data-v]').forEach(x => x.classList.toggle('on', x === b)); $('impGo').disabled = false;
  });
  $('impGo').onclick = () => {
    S.impReason = $('impR').value.trim();
    addLog('look', `第一印象：${{ stable: '安定している', odd: 'なんか変', call: '今すぐ人を呼ぶべき' }[S.impression]}${S.impReason ? '（' + S.impReason + '）' : ''}`);
    S.over = false; closeSheet();
    if (I.enterMessage) sysSay(I.enterMessage);
    if (I.openingLine) S.chat.push({ who: 'p', text: I.openingLine });
    sysSay('「💬 話しかける」と「🩺 観察・ケアをする」を切り替えて入力できます。体をタップすると見た目の様子がわかります。');
    renderChat();
  };
}
// 途中で一覧に戻るときなど：時間・音・予約した処理を止める
function stopCase() {
  if (S) { S.over = true; S.busy = false; (S.timers || []).forEach(clearTimeout); S.timers = []; }
  stopVoice(); closeSheet();
}

// ================= 症例の一覧画面 =================
const DIFF = n => '★'.repeat(n || 1) + '☆'.repeat(Math.max(0, 3 - (n || 1)));
function renderList() {
  const st = loadStore();
  const mark = r => !r ? '' : r.result === true ? '<span class="badge ok">報告できた</span>' : r.result === 'partial' ? '<span class="badge mid">医師が来た</span>' : '<span class="badge try">挑戦済み</span>';
  $('caseList').innerHTML = CASE_LIST.length ? CASE_LIST.map(c => `
    <a class="case-card" href="#/case/${encodeURIComponent(c.id)}">
      <div class="case-no">症例 ${esc(c.number || '')}</div>
      <div class="case-body">
        <div class="case-title">${esc(c.title)} ${mark(st.results[c.id])}</div>
        <div class="case-sum">${esc(c.summary || '')}</div>
        <div class="case-tags">${(c.tags || []).map(t => `<span class="pill">${esc(t)}</span>`).join('')}<span class="diff" title="難しさ">${DIFF(c.difficulty)}</span></div>
      </div>
      <span class="case-go" aria-hidden="true">›</span>
    </a>`).join('') : '<p class="hint">症例がまだありません。</p>';
}

// ================= 画面の切り替え =================
async function route() {
  const m = location.hash.match(/^#\/case\/(.+)$/);
  if (!m) {
    stopCase();
    document.body.classList.remove('playing');
    document.title = 'ABCDEクエスト';
    renderList();
    window.scrollTo(0, 0);
    return;
  }
  const id = decodeURIComponent(m[1]);
  const entry = CASE_LIST.find(c => c.id === id);
  if (!entry) { location.hash = '#/'; return; }
  try {
    C = await loadCase(entry.file);
  } catch (e) {
    toast('症例ファイルを読み込めませんでした。JSON の書き方を確認してください。');
    location.hash = '#/'; return;
  }
  document.body.classList.add('playing');
  window.scrollTo(0, 0);
  startCase();
}
$('bList').onclick = () => {
  if (S && !S.over && !confirm('症例を中断して一覧に戻りますか？')) return;
  location.hash = '#/';
};
window.addEventListener('hashchange', route);

// ================= 起動 =================
(async () => {
  requestAnimationFrame(loop);
  try {
    CASE_LIST = await loadCaseList();
  } catch (e) {
    $('caseList').innerHTML = '<div class="result ng">症例の一覧（cases/index.json）を読み込めませんでした。</div>';
    return;
  }
  route();
  // claude.ai の上で動かしたときだけ、AI・音声入力が使える（KenMaP 上では簡易モード）
  try {
    if (!window.claude || !window.claude.use) return;
    const [ai, tts, dict] = await Promise.all([claude.use('sample'), claude.use('tts'), claude.use('dictation')]);
    AI = ai || null; TTS = tts || null; DICT = dict || null;
    if (C) setAiNote();
    if (DICT) { $('bMic').hidden = false; $('modeHint').textContent = '🎤ボタンで音声入力もできます。'; setupDictation(); }
  } catch (e) {}
})();
