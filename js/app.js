// 画面と練習の流れ
import { bytesToMusicXml } from './mxl.js';
import { parseMusicXml, trackNotes, midiName, NOTE_NAMES_JA } from './musicxml.js';
import { PitchTracker, hzToMidi, QUIET_DB, TOO_QUIET_DB } from './pitch.js';
import { evaluateNotes, evaluateNote, summarize, rangeLabel } from './scoring.js';
import { AudioEngine, PIANO_GAIN } from './audio.js';
import { Roll } from './roll.js';
import { Minimap, hitEdge } from './minimap.js';
import { store, hashText, listTakes, putTake, removeTake, clearTakes } from './store.js';
import { ClipRecorder, makeTake, reviewFrames, reviewClips, adpcmDecode } from './recorder.js';
import { sections, sectionOf } from './marks.js';
import { mergeExpr, cueAt, entryHint, autoBreaths, snapToNoteHead, writeMarksToXml, DYN_PALETTE, levelOf, judgeBreath, judgeWedge, judgeDyn, judgeTargets } from './expr.js';
import { Fx, phraseWord } from './fx.js';
import {
  beatGrid, buildSnaps, snapQ, measureIndexAt, stepBeat, stepMeasure, posLabel, endLabel,
  setRangeEdge, dragRangeEdge, segmentsFrom, countInBeats, Inertia, releaseVelocity, joinLyrics, searchLyrics,
} from './nav.js';

const $ = (id) => document.getElementById(id);
const engine = new AudioEngine();
let roll = null, mini = null;

// ---------------- 設定（端末内の localStorage） ----------------
const DEFAULTS = {
  mode: 'alt', segLen: 2, tempo: 80, volMine: 100, volOthers: 35, volPiano: 35, volClick: 70,
  latencyMs: 0, listen: true, guide: false, clickThrough: false, preroll: true,
  record: true, reviewPiano: true, reviewBalance: 40, cues: true,
};
const settings = { ...DEFAULTS, ...readJSON('gassho-settings') };
// 合図と演出: karaoke（カラオケ風・はで）／calm（しずか: 帯と小さな札だけ）／off（出さない）
if (!['karaoke', 'calm', 'off'].includes(settings.fx)) {
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  settings.fx = settings.cues === false ? 'off' : reduce ? 'calm' : 'karaoke';
}
const cuesOn = () => settings.fx !== 'off';
const fx = new Fx();
const fxSeen = { breath: null, flash: null, lastQ: -1e9 };
function readJSON(k) { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (_) { return {}; } }
function saveSettings() { try { localStorage.setItem('gassho-settings', JSON.stringify(settings)); } catch (_) { /* 保存できなくても動く */ } }

// ---------------- 状態 ----------------
const S = {
  rec: null, score: null, track: null, octave: 0,
  notes: [], others: [], piano: [], measures: [], lyricTracks: [],
  sections: [], snaps: [], grid: [], totalQ: 0,
  range: { startQ: 0, endQ: 0 },   // 練習範囲（q = 四分音符いくつ分）
  view: 0,                         // 再生位置の線にある時刻（楽譜の秒）。止まっている間は「ここから始める」位置
  run: null,
  results: new Map(),
  voice: [],
  smooth: [],
  liveMidi: null, liveAt: 0,
  quiet: false,
  tracker: null,
  lastReport: null,
  inertia: null, anim: null, drag: null, dirty: true,
  takes: [], review: null, live: null, lastTakeId: null,
  expr: null,                      // 歌い方の記号（ファイル＋書きこみ＋休符の自動）。mergeExpr の結果
  editing: false, tool: 'breath', pendingWedge: null, undo: [],
};

const qToSec = (q) => S.score.timeline.qToSec(q);
const secToQ = (s) => S.score.timeline.secToQ(s);
const cursorQ = () => secToQ(S.view);
const rangeSec = () => ({ startSec: qToSec(S.range.startQ), endSec: qToSec(S.range.endQ) });
const firstSec = () => (S.measures.length ? S.measures[0].startSec : 0);
const lastSec = () => (S.measures.length ? S.measures[S.measures.length - 1].endSec : 0);
const clampView = (v) => Math.max(firstSec() - 1, Math.min(lastSec(), v));
// ※ 止まる位置（吸着）は最後の拍の頭まで。曲の終わりちょうどでは始められないため

// ---------------- 画面切り替え ----------------
function show(name) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== 'screen-' + name;
  for (const sh of document.querySelectorAll('.sheet')) sh.hidden = true;
  if (name === 'practice') requestAnimationFrame(() => { roll.resize(); mini.resize(); S.dirty = true; });
  if (name === 'home') renderSaved();
}
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { if (S.run) stopRun(false); show(go.dataset.go); }
  const close = e.target.closest('[data-close]');
  if (close) $(close.dataset.close).hidden = true;
  const open = e.target.closest('[data-open]');
  if (open) { $('sheet-report').hidden = true; $(open.dataset.open).hidden = false; }
  if (!e.target.closest('.search')) $('search-results').hidden = true;
});

let toastTimer = 0;
function toast(msg, ms = 3800) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------- はじめの画面 ----------------
if (!window.isSecureContext) $('insecure-note').hidden = false;

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openXml(bytesToMusicXml(bytes), file.name);
  } catch (err) {
    showHomeError(err);
  }
});

$('btn-sample').addEventListener('click', async () => {
  try {
    const res = await fetch('test/fixtures/renshu-4sei.musicxml');
    if (!res.ok) throw new Error('テスト用の楽譜が見つかりませんでした');
    await openXml(await res.text(), 'renshu-4sei.musicxml');
  } catch (err) { showHomeError(err); }
});

function showHomeError(err) {
  const el = $('home-error');
  el.textContent = err && err.message ? err.message : 'ファイルを読み込めませんでした。';
  el.hidden = false;
}

async function openXml(xml, fileName) {
  $('home-error').hidden = true;
  const score = parseMusicXml(xml); // 読めなければここで分かりやすいエラー
  if (!score.tracks.some((t) => !t.isPiano)) throw new Error('この楽譜には歌のパートが見つかりませんでした。');
  const id = hashText(xml);
  const old = await store.get(id).catch(() => null);
  const rec = old || { id, title: score.title, fileName, xml, addedAt: Date.now(), results: {}, octave: {}, pos: {} };
  rec.openedAt = Date.now();
  await store.put(rec).catch(() => toast('この端末には保存できませんでしたが、練習はできます。'));
  S.rec = rec;
  S.score = score;
  S.track = null;
  renderParts();
  show('parts');
}

async function renderSaved() {
  const list = await store.list();
  const ul = $('saved-list');
  ul.textContent = '';
  const mine = list.filter((r) => r.xml);
  $('saved-empty').hidden = mine.length > 0;
  for (const r of mine) {
    const li = document.createElement('li');
    const d = new Date(r.openedAt || r.addedAt);
    const title = document.createElement('span');
    title.className = 'saved-title';
    title.textContent = r.title;
    const date = document.createElement('span');
    date.className = 'saved-date';
    date.textContent = `${d.getMonth() + 1}月${d.getDate()}日に開いた・${r.fileName || ''}`;
    title.appendChild(date);
    const open = document.createElement('button');
    open.className = 'btn btn-primary';
    open.type = 'button';
    open.textContent = 'ひらく';
    open.onclick = () => openXml(r.xml, r.fileName).catch(showHomeError);
    const del = document.createElement('button');
    del.className = 'btn btn-quiet';
    del.type = 'button';
    del.textContent = '削除';
    del.onclick = async () => {
      if (!confirm(`「${r.title}」をこのiPadから削除しますか？（元のファイルは消えません）`)) return;
      await store.remove(r.id).catch(() => {});
      renderSaved();
    };
    li.append(title, open, del);
    ul.appendChild(li);
  }
}

// ---------------- パート選択 ----------------
const jaName = (m) => NOTE_NAMES_JA[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

function renderParts() {
  const sc = S.score;
  $('parts-title').textContent = sc.title;
  const warn = $('parts-warnings');
  warn.textContent = '';
  for (const w of sc.warnings) { const li = document.createElement('li'); li.textContent = w; warn.appendChild(li); }
  const list = $('track-list');
  list.textContent = '';
  for (const t of sc.tracks.filter((x) => !x.isPiano)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'track';
    b.dataset.guess = t.guess || '';
    const last = S.rec.results && S.rec.results[t.key];
    const range = `${midiName(t.low)}〜${midiName(t.high)}（${jaName(t.low)}〜${jaName(t.high)}）`;
    b.innerHTML = '<span class="track-color"></span><span><span class="track-name"></span><span class="track-meta"></span></span><span class="track-last"></span>';
    b.querySelector('.track-name').textContent = t.name;
    const sub = [range, `${t.noteIds.length}音`];
    if (t.name !== t.partName) sub.push(`楽譜では「${t.partName}」`);
    if (t.clefNote) sub.push(t.clefNote + '→実際の高さで表示');
    b.querySelector('.track-meta').textContent = sub.join('・');
    if (last) {
      const tl = b.querySelector('.track-last');
      const bb = document.createElement('b');
      bb.textContent = String(Number(last.score) || 0);
      tl.append('前回', document.createElement('br'), bb, '点');
    }
    b.addEventListener('click', () => chooseTrack(t));
    list.appendChild(b);
  }
  const pianos = sc.tracks.filter((x) => x.isPiano);
  $('piano-note').hidden = !pianos.length;
  $('piano-note').textContent = pianos.length ? `ピアノ伴奏（${pianos.map((p) => p.name).join('・')}）は、お手本や通しで小さく鳴ります。音量は「設定」で変えられます。` : '';
}

async function chooseTrack(t) {
  await engine.init(); // タップの中で音を出せる状態にする（iPad対策）
  S.track = t;
  S.octave = (S.rec.octave && S.rec.octave[t.key]) || 0;
  computeNotes();
  const saved = S.rec.pos && S.rec.pos[t.key];
  S.range = saved && saved.endQ <= S.totalQ + 1e-6 ? { startQ: saved.startQ, endQ: saved.endQ } : { startQ: 0, endQ: S.totalQ };
  S.view = qToSec(saved && Number.isFinite(saved.cursorQ) ? saved.cursorQ : S.range.startQ);
  S.results.clear();
  S.voice = [];
  S.lastReport = null;
  S.review = null; S.live = null;
  S.editing = false; S.pendingWedge = null; S.undo = [];
  syncExprBar();
  if (settings.mode === 'review') settings.mode = 'alt';
  $('btn-report').hidden = true;
  await refreshTakes();
  const prep = $('prep');
  prep.hidden = false;
  $('prep-fill').style.width = '0';
  $('prep-text').textContent = 'ピアノの音を読み込んでいます';
  for (const b of document.querySelectorAll('.track')) b.disabled = true;
  // ピアノは録音だけで鳴らす。全部そろうまで練習画面に進まない（合成音で代わりに鳴らさない）
  $('prep-text').textContent = 'ピアノの音を準備しています';
  const r = await engine.loadPiano([...S.notes, ...S.others, ...S.piano], (p, done, total) => {
    $('prep-fill').style.width = Math.round(p * 100) + '%';
    $('prep-text').textContent = `ピアノの音を準備しています（${done}/${total}）`;
  });
  for (const b of document.querySelectorAll('.track')) b.disabled = false;
  if (r.failed) {
    $('prep-text').textContent = `ピアノの音を${r.failed}個読み込めませんでした。通信のよい所で、もう一度パートを選んでください。`;
    $('prep-fill').style.width = '0';
    return;
  }
  prep.hidden = true;
  $('pr-part').textContent = t.name;
  $('pr-song').textContent = S.score.title;
  syncControls();
  show('practice');
}

function computeNotes() {
  const sc = S.score, tl = sc.timeline;
  S.measures = sc.measures.map((m) => ({ ...m, startSec: tl.qToSec(m.startQ), endSec: tl.qToSec(m.startQ + m.lengthQ) }));
  S.totalQ = sc.totalQ;
  S.notes = trackNotes(sc, S.track, S.octave);
  const mine = new Set(S.track.noteIds);
  const pianoIds = new Set(sc.tracks.filter((x) => x.isPiano).flatMap((x) => x.noteIds));
  S.others = sc.notes.filter((n) => !mine.has(n.id) && !pianoIds.has(n.id));
  S.piano = sc.notes.filter((n) => pianoIds.has(n.id));
  S.lyricTracks = [S.notes, ...sc.tracks.filter((t) => !t.isPiano && t.key !== S.track.key).map((t) => trackNotes(sc, t))];
  S.sections = sections(sc.marks || [], S.measures);
  S.grid = beatGrid(S.measures);
  S.snaps = buildSnaps(S.measures, S.notes);
  roll.setData(S.notes, S.measures, S.sections);
  mini.setData(S.measures, S.notes, S.sections);
  refreshExpr();
  renderMarks();
  S.dirty = true;
}

// ---------------- 歌い方の記号（息継ぎ・強弱） ----------------
const userMarks = () => (S.rec && S.rec.expr && S.rec.expr.marks) || [];
function refreshExpr() {
  if (!S.score || !S.track) return;
  S.expr = mergeExpr(S.score.expr, userMarks(), S.track, S.notes, { auto: !(S.rec.expr && S.rec.expr.noAuto) });
  roll.setExpr(S.expr, qToSec);
  S.dirty = true;
}
function setUserMarks(marks) {
  S.undo.push(JSON.stringify(userMarks()));
  if (S.undo.length > 40) S.undo.shift();
  S.rec.expr = { ...(S.rec.expr || {}), marks };
  clearTimeout(setUserMarks.t);
  setUserMarks.t = setTimeout(() => store.put(S.rec).catch(() => toast('この端末に保存できませんでした。')), 400);
  refreshExpr();
  syncExprBar();
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const near = (a, b) => Math.abs(a - b) < 1e-3;

const EXPR_HELP = {
  breath: '息を吸う所をタップ。「吸ったあとに歌い出す音」に V が付きます（もう一度タップで消えます）。このパートだけに入ります。',
  dyn: '強さが変わる所をタップ。全パート共通で入ります（同じ記号をもう一度タップで消えます）。',
  wedge: 'はじまりをタップ → おわりをタップ。全パート共通で入ります。',
  erase: '消したい記号（V・強弱・松葉）をタップ。楽譜ファイルにもとから書いてある記号は消せません。',
};
function syncExprBar() {
  $('btn-expr').setAttribute('aria-pressed', String(S.editing));
  $('expr-bar').hidden = !S.editing;
  $('screen-practice').classList.toggle('editing', S.editing);
  for (const b of $('expr-tools').children) b.setAttribute('aria-checked', String(b.dataset.tool === S.tool));
  const kind = S.tool === 'breath' ? 'breath' : S.tool === 'erase' ? 'erase' : S.tool === 'cresc' || S.tool === 'dim' ? 'wedge' : 'dyn';
  $('expr-help').textContent = S.pendingWedge ? 'つぎに、おわりの位置をタップしてください。' : EXPR_HELP[kind];
  $('btn-expr-undo').disabled = !S.undo.length;
  $('btn-expr-export').disabled = !userMarks().some((m) => m.type !== 'noauto');
  const autoOn = !(S.rec && S.rec.expr && S.rec.expr.noAuto);
  $('btn-expr-auto').textContent = autoOn ? '休符の V：自動' : '休符の V：なし';
  $('btn-expr-auto').setAttribute('aria-pressed', String(autoOn));
  requestAnimationFrame(() => { roll.resize(); mini.resize(); S.dirty = true; });
}
$('btn-expr').addEventListener('click', () => {
  if (S.run || !S.track) return;
  S.editing = !S.editing;
  S.pendingWedge = null;
  syncExprBar();
});
$('btn-expr-done').addEventListener('click', () => { S.editing = false; S.pendingWedge = null; syncExprBar(); });
$('expr-tools').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.tool = b.dataset.tool; S.pendingWedge = null; syncExprBar();
});
$('btn-expr-undo').addEventListener('click', () => {
  if (!S.undo.length) return;
  S.rec.expr = { ...(S.rec.expr || {}), marks: JSON.parse(S.undo.pop()) };
  store.put(S.rec).catch(() => {});
  S.pendingWedge = null;
  refreshExpr(); syncExprBar();
});
$('btn-expr-auto').addEventListener('click', () => {
  // 休符の所の自動の息継ぎを、入れる／入れない（書きこんだ V はそのまま）
  const on = !(S.rec.expr && S.rec.expr.noAuto);
  S.rec.expr = { ...(S.rec.expr || { marks: [] }), noAuto: on };
  store.put(S.rec).catch(() => {});
  refreshExpr(); syncExprBar();
  toast(on ? '休符の自動の息継ぎを消しました。自分で書きこんだ V だけが出ます。' : '休符の所に、自動で息継ぎ（V）を入れました。いらない所は V をタップで消せます。', 5000);
});
$('btn-expr-export').addEventListener('click', async () => {
  const marks = userMarks();
  if (!marks.length) return;
  let r;
  try { r = writeMarksToXml(S.rec.xml, S.score, marks); } catch (err) { toast('書き出せませんでした（' + err.message + '）', 6000); return; }
  const name = (S.score.title || '楽譜').replace(/[\\/:*?"<>|]/g, '_') + '_息継ぎ強弱つき.musicxml';
  const file = new File([r.xml], name, { type: 'application/vnd.recordare.musicxml+xml' });
  const msg = `息継ぎ${r.added.breath}・強弱${r.added.dyn}・松葉${r.added.wedge}を書きこんだ楽譜ファイルを作りました。` +
    'このファイルを配れば、ほかのiPadでも同じ合図が出ます。' + (r.skipped ? `（${r.skipped}個は置き場所が見つからず入れられませんでした）` : '');
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); toast(msg, 7000); return; }
  } catch (err) { if (err && err.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(msg, 7000);
});

/** 書きこみモードで黒板をタップした */
function editTap(p) {
  const q = secToQ(roll.secOfX(p.x, S.view));
  const marks = userMarks();
  const tool = S.tool;
  if (tool === 'erase') {
    const hit = roll.userMarkHit(p.x, S.view);
    if (!hit) { toast('消したい記号（V・強弱・松葉）の上をタップしてください。'); return; }
    if (hit.source === 'auto') { setUserMarks([...marks, { id: newId(), type: 'noauto', q: hit.q, track: S.track.key }]); return; }
    if (hit.source !== 'user') { toast('楽譜ファイルにもとから書いてある記号は消せません。'); return; }
    setUserMarks(marks.filter((m) => m.id !== hit.id));
    return;
  }
  if (tool === 'breath') {
    const qq = snapToNoteHead(S.notes, q);
    const mine = marks.find((m) => m.type === 'breath' && m.track === S.track.key && near(m.q, qq));
    if (mine) { setUserMarks(marks.filter((m) => m !== mine)); return; }
    if (S.expr.breaths.some((b) => b.source === 'file' && near(b.q, qq))) { toast('ここには楽譜ファイルに息継ぎが書いてあります。'); return; }
    if (S.expr.breaths.some((b) => b.source === 'auto' && near(b.q, qq))) { setUserMarks([...marks, { id: newId(), type: 'noauto', q: qq, track: S.track.key }]); return; } // 自動の V を消す
    setUserMarks([...marks, { id: newId(), type: 'breath', q: qq, track: S.track.key }]);
    return;
  }
  const qq = snapQ(S.snaps, q);
  if (tool === 'cresc' || tool === 'dim') {
    if (!S.pendingWedge) { S.pendingWedge = { q: qq, sec: qToSec(qq) }; syncExprBar(); S.dirty = true; return; }
    let a = S.pendingWedge.q, b = qq;
    S.pendingWedge = null;
    if (near(a, b)) { syncExprBar(); toast('はじまりと、おわりを別の所でタップしてください。'); return; }
    if (b < a) [a, b] = [b, a];
    setUserMarks([...marks, { id: newId(), type: 'wedge', q: a, endQ: b, value: tool }]);
    return;
  }
  if (DYN_PALETTE.includes(tool)) {
    const same = marks.find((m) => m.type === 'dyn' && near(m.q, qq));
    if (same && same.value === tool) { setUserMarks(marks.filter((m) => m !== same)); return; }
    const rest = marks.filter((m) => m !== same);
    setUserMarks([...rest, { id: newId(), type: 'dyn', q: qq, value: tool }]);
  }
}

function savePos() {
  if (!S.rec || !S.track) return;
  S.rec.pos = S.rec.pos || {};
  S.rec.pos[S.track.key] = { startQ: S.range.startQ, endQ: S.range.endQ, cursorQ: cursorQ() };
  clearTimeout(savePos.t);
  savePos.t = setTimeout(() => store.put(S.rec).catch(() => {}), 800);
}

// ---------------- 位置を動かす（ドラッグ・慣性・吸着・ジャンプ） ----------------
function animateTo(sec, ms = 200) {
  S.inertia = null;
  S.anim = { from: S.view, to: clampView(sec), t0: performance.now(), dur: ms };
  S.dirty = true;
}
function snapHere() { animateTo(qToSec(Math.min(snapQ(S.snaps, cursorQ()), lastBeatQ())), 160); }
function jumpToQ(q) { animateTo(qToSec(q), 260); }

function localXY(cv, e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

function setupRollGestures(cv) {
  cv.addEventListener('pointerdown', (e) => {
    if (S.run) return;
    S.inertia = null; S.anim = null;
    const p = localXY(cv, e);
    const edge = S.editing ? null : roll.hitHandle(p.x, p.y, rangeSec(), S.view);
    S.drag = edge ? { kind: 'edge', which: edge } : { kind: 'pan', x0: p.x, y0: p.y, view0: S.view, t0: performance.now(), moved: false, samples: [{ x: p.x, t: performance.now() }] };
    cv.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => {
    const d = S.drag;
    if (!d || S.run) return;
    const p = localXY(cv, e);
    if (d.kind === 'pan') {
      if (Math.abs(p.x - d.x0) > 6) d.moved = true;
      S.view = clampView(d.view0 - (p.x - d.x0) / roll.pxPerSec);
      d.samples.push({ x: p.x, t: performance.now() });
      if (d.samples.length > 12) d.samples.shift();
    } else {
      const q = snapQ(S.snaps, secToQ(roll.secOfX(p.x, S.view)));
      S.range = dragRangeEdge(S.range, d.which, q, S.totalQ);
    }
    S.dirty = true;
  });
  const end = (e) => {
    const d = S.drag;
    S.drag = null;
    if (!d || S.run) return;
    const p = localXY(cv, e);
    if (d.kind === 'edge') { savePos(); S.dirty = true; return; }
    if (!d.moved && performance.now() - d.t0 < 500 && S.editing) { editTap(p); return; }
    if (!d.moved && performance.now() - d.t0 < 500) {
      // タップ: 音符ならその頭、そうでなければ近い拍の頭へ
      const n = roll.noteHit(p.x, p.y, S.view);
      const sec = n ? n.startSec : qToSec(Math.min(snapQ(S.snaps, secToQ(roll.secOfX(p.x, S.view))), lastBeatQ()));
      animateTo(sec, 240);
      savePos();
      return;
    }
    const v = releaseVelocity(d.samples, performance.now());
    if (Math.abs(v) > 0.15) S.inertia = new Inertia(v); else snapHere();
    savePos();
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

function setupMiniGestures(cv) {
  cv.addEventListener('pointerdown', (e) => {
    if (S.run) return;
    S.inertia = null; S.anim = null;
    const p = localXY(cv, e);
    const sc = mini.scale;
    const edge = hitEdge(p.x, rangeSec(), sc);
    S.drag = edge ? { kind: 'medge', which: edge } : { kind: 'mscrub' };
    if (!edge) S.view = clampView(sc.secOf(p.x));
    cv.setPointerCapture(e.pointerId);
    S.dirty = true;
    e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => {
    const d = S.drag;
    if (!d || S.run || (d.kind !== 'medge' && d.kind !== 'mscrub')) return;
    const p = localXY(cv, e);
    const sec = mini.scale.secOf(p.x);
    if (d.kind === 'mscrub') S.view = clampView(sec);
    else S.range = dragRangeEdge(S.range, d.which, snapQ(S.snaps, secToQ(sec)), S.totalQ);
    S.dirty = true;
  });
  const end = () => {
    const d = S.drag;
    S.drag = null;
    if (!d || S.run) return;
    if (d.kind === 'mscrub') snapHere();
    savePos();
    S.dirty = true;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

document.querySelector('.nudge').addEventListener('click', (e) => {
  const b = e.target.closest('[data-nudge]');
  if (!b || S.run || !S.measures.length) return;
  const [kind, d] = [b.dataset.nudge[0], b.dataset.nudge.endsWith('+1') ? 1 : -1];
  const q = snapQ(S.snaps, cursorQ());
  const next = kind === 'm' ? stepMeasure(S.measures, q, d) : stepBeat(S.measures, q, d);
  animateTo(qToSec(Math.min(next, lastBeatQ())), 150);
  savePos();
});
$('btn-from').addEventListener('click', () => {
  if (S.run) return;
  S.range = setRangeEdge(S.range, 'start', snapQ(S.snaps, cursorQ()), S.totalQ);
  savePos(); syncControls();
});
$('btn-to').addEventListener('click', () => {
  if (S.run) return;
  S.range = setRangeEdge(S.range, 'end', snapQ(S.snaps, cursorQ()), S.totalQ);
  savePos(); syncControls();
});
$('btn-range-all').addEventListener('click', () => {
  if (S.run) return;
  S.range = { startQ: 0, endQ: S.totalQ };
  savePos(); syncControls();
});

// ---------------- 練習番号 ----------------
function renderMarks() {
  const nav = $('marks'), list = $('marks-list');
  list.textContent = '';
  nav.hidden = !S.sections.length;
  $('finder').hidden = !S.sections.length;
  requestAnimationFrame(() => { roll.resize(); mini.resize(); S.dirty = true; });
  for (const sec of S.sections) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mark';
    b.dataset.from = sec.fromIdx;
    b.append(sec.label);
    const sm = document.createElement('small');
    sm.textContent = S.measures[sec.fromIdx].number;
    b.appendChild(sm);
    b.setAttribute('aria-label', `練習番号${sec.label}へ（${S.measures[sec.fromIdx].number}小節）`);
    list.appendChild(b);
  }
}
$('marks-list').addEventListener('click', (e) => {
  const b = e.target.closest('.mark');
  if (!b || S.run) return;
  jumpToQ(S.measures[Number(b.dataset.from)].startQ);
  setTimeout(savePos, 300);
});
$('btn-mark-range').addEventListener('click', () => {
  if (S.run) return;
  const sec = sectionOf(S.sections, measureIndexAt(S.measures, cursorQ() + 1e-6));
  if (!sec) return;
  const a = S.measures[sec.fromIdx], b = S.measures[sec.toIdx];
  S.range = { startQ: a.startQ, endQ: b.startQ + b.lengthQ };
  jumpToQ(a.startQ);
  savePos(); syncControls();
});
function markLabel(a, b) {
  // 「26〜27小節（C）」のように、練習番号を添える
  const sa = sectionOf(S.sections, a), sb = sectionOf(S.sections, b);
  const base = rangeLabel(S.measures, a, b);
  if (!sa) return base;
  return base + `（${sa.label}${sb && sb !== sa ? '〜' + sb.label : ''}）`;
}

// ---------------- 歌詞でさがす ----------------
let searchTimer = 0;
$('lyric-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });
$('lyric-search').addEventListener('focus', () => { if ($('lyric-search').value) runSearch(); });
$('lyric-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); const first = $('search-results').querySelector('button'); if (first) first.click(); }
  if (e.key === 'Escape') $('search-results').hidden = true;
});
function runSearch() {
  const q = $('lyric-search').value;
  const ul = $('search-results');
  ul.textContent = '';
  if (!q.trim() || !S.lyricTracks.length) { ul.hidden = true; return; }
  const hits = searchLyrics(S.lyricTracks, q);
  if (!hits.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = '見つかりませんでした（ひらがなでも探せます）';
    ul.appendChild(li);
  }
  for (const h of hits) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const m = document.createElement('b');
    m.textContent = posLabel(S.measures, h.q);
    const t = document.createElement('span');
    t.textContent = h.text;
    b.append(m, t);
    b.onclick = () => {
      if (S.run) return;
      jumpToQ(h.q);
      ul.hidden = true;
      $('lyric-search').blur();
      setTimeout(savePos, 300);
    };
    li.appendChild(b);
    ul.appendChild(li);
  }
  ul.hidden = false;
}

/** 位置の近くの歌詞（ここから歌う言葉） */
function lyricsFrom(q) {
  for (const notes of S.lyricTracks) {
    const i = notes.findIndex((n) => n.lyric && n.startQ >= q - 1e-3);
    if (i < 0) continue;
    const ns = notes.slice(i, i + 12).filter((n) => n.lyric);
    if (ns.length && ns[0].startQ - q < 8) return joinLyrics(ns.map((n) => n.lyric));
  }
  return '';
}

// ---------------- 操作盤 ----------------
const MODE_HELP = {
  review: '録音した声を音程の線と一緒に聞き直します。録音はこのiPadの中だけに保存されます。',
  alt: '「お手本を聞く → カウント → 自分で歌う」を区切りごとにくり返します。歌う間はクリックだけ鳴るので、イヤホンなしで使えます。',
  through: '伴奏を鳴らしながら通して歌います。スピーカーの音をマイクが拾わないよう端末のエコーキャンセルに頼るため、うまく採点できないことがあります（試験的）。',
  listen: 'お手本を聞くだけです。マイクは使いません。',
};

function rangeText() {
  if (!S.measures.length) return '';
  const all = S.range.startQ <= 1e-6 && S.range.endQ >= S.totalQ - 1e-6;
  const a = measureIndexAt(S.measures, S.range.startQ), b = measureIndexAt(S.measures, S.range.endQ - 1e-3);
  const sa = sectionOf(S.sections, a), sb = sectionOf(S.sections, b);
  const marks = sa ? `（${sa.label}${sb && sb !== sa ? '〜' + sb.label : ''}）` : '';
  return (all ? '全体・' : '') + `${posLabel(S.measures, S.range.startQ)} 〜 ${endLabel(S.measures, S.range.endQ)}${marks}`;
}

function syncControls() {
  for (const b of $('mode-seg').children) b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode));
  for (const b of $('seglen-seg').children) b.setAttribute('aria-checked', String(Number(b.dataset.len) === settings.segLen));
  for (const b of $('oct-seg').children) b.setAttribute('aria-checked', String(Number(b.dataset.oct) === S.octave));
  $('mode-help').textContent = MODE_HELP[settings.mode];
  $('field-seglen').hidden = settings.mode === 'review';
  $('field-seglen').style.visibility = settings.mode === 'alt' ? 'visible' : 'hidden';
  $('review-panel').hidden = settings.mode !== 'review';
  $('mode-review').disabled = !S.takes.length || !!S.run;
  $('opt-record').checked = settings.record;
  $('opt-review-piano').checked = settings.reviewPiano;
  $('review-balance').value = settings.reviewBalance;
  $('tempo').value = settings.tempo; $('tempo-out').textContent = settings.tempo + '%';
  $('vol-mine').value = settings.volMine;
  $('vol-others').value = settings.volOthers;
  $('vol-piano').value = settings.volPiano;
  $('vol-click').value = settings.volClick;
  $('latency').value = settings.latencyMs; $('latency-out').textContent = (settings.latencyMs > 0 ? '+' : '') + settings.latencyMs + 'ms';
  $('opt-listen').checked = settings.listen;
  for (const b of $('fx-seg').children) b.setAttribute('aria-checked', String(b.dataset.fx === settings.fx));
  $('btn-expr').disabled = !!S.run;
  $('opt-guide').checked = settings.guide;
  $('opt-preroll').checked = settings.preroll;
  $('opt-click-through').checked = settings.clickThrough;
  $('oct-row').hidden = !S.track;
  $('range-text').textContent = rangeText();
  const running = !!S.run;
  for (const el of document.querySelectorAll('#mode-seg button, #seglen-seg button, .nudge button, #btn-range-all, #btn-mark-range, #tempo, #oct-seg button, .mark, #lyric-search')) el.disabled = running;
  applyGains();
  S.dirty = true;
}

const vol = (v, max) => Math.pow(v / 100, 2) * max;
/** いまの設定での各バスの音量 */
function busGains() {
  // 聞き直しでは「声 ↔ ピアノ」のつまみで、ピアノ全体と声の大きさを配分する
  const rv = settings.mode === 'review';
  const b = settings.reviewBalance / 100;
  const pianoK = rv ? Math.min(1, b * 2) : 1;
  return {
    mine: vol(settings.volMine, 1) * pianoK,
    others: vol(settings.volOthers, 0.8) * pianoK,
    piano: vol(settings.volPiano, 0.8) * pianoK,
    click: vol(settings.volClick, 1),
    voice: rv ? Math.min(1, (1 - b) * 2) : 1,
  };
}
function applyGains() {
  if (!engine.ctx) return;
  for (const [k, v] of Object.entries(busGains())) engine.setBusGain(k, v);
}

$('mode-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || S.run || b.disabled) return;
  if (b.dataset.mode === 'review') { const t = S.takes.find((x) => x.trackKey === (S.track && S.track.key)) || S.takes[0]; if (t) enterReview(t); return; }
  if (settings.mode === 'review') leaveReview();
  settings.mode = b.dataset.mode; saveSettings(); syncControls();
});
$('seglen-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || S.run) return;
  settings.segLen = Number(b.dataset.len); saveSettings(); syncControls();
});
$('oct-seg').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b || S.run || !S.track) return;
  S.octave = Number(b.dataset.oct);
  S.rec.octave = S.rec.octave || {};
  S.rec.octave[S.track.key] = S.octave;
  store.put(S.rec).catch(() => {});
  computeNotes();
  S.results.clear(); S.voice = [];
  const r = await engine.loadPiano(S.notes);
  if (r.failed) toast('ピアノの音を読み込めなかった高さがあります。通信のよい所で開き直してください。', 6000);
  syncControls();
});
const bindRange = (id, key) => $(id).addEventListener('input', (e) => { settings[key] = Number(e.target.value); saveSettings(); syncControls(); });
bindRange('tempo', 'tempo');
bindRange('vol-mine', 'volMine');
bindRange('vol-others', 'volOthers');
bindRange('vol-piano', 'volPiano');
bindRange('vol-click', 'volClick');
bindRange('latency', 'latencyMs');
$('latency').addEventListener('input', () => applyReviewOffset());
const bindCheck = (id, key) => $(id).addEventListener('change', (e) => { settings[key] = e.target.checked; saveSettings(); });
bindCheck('opt-listen', 'listen');
$('fx-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  settings.fx = b.dataset.fx; settings.cues = settings.fx !== 'off'; saveSettings(); syncControls();
});
bindCheck('opt-guide', 'guide');
bindCheck('opt-preroll', 'preroll');
bindCheck('opt-click-through', 'clickThrough');
bindCheck('opt-record', 'record');
bindCheck('opt-review-piano', 'reviewPiano');
$('review-balance').addEventListener('input', (e) => { settings.reviewBalance = Number(e.target.value); saveSettings(); applyGains(); });
$('take-select').addEventListener('change', (e) => { const t = S.takes.find((x) => x.id === e.target.value); if (t && !S.run) enterReview(t); });
$('btn-report').addEventListener('click', () => { if (S.lastReport) showReport(S.lastReport); });

$('btn-go').addEventListener('click', () => { if (S.run) stopRun(true); else startRun(); });

// ---------------- 練習の開始・終了 ----------------
function setGo(running) {
  const b = $('btn-go');
  b.textContent = running ? 'とめる' : 'はじめる';
  b.classList.toggle('stop', running);
  syncControls();
}

function askMicOnce() {
  if (localStorage.getItem('gassho-mic-ok') === '1') return Promise.resolve();
  return new Promise((resolve) => {
    $('modal-mic').hidden = false;
    $('btn-mic-ok').onclick = () => {
      $('modal-mic').hidden = true;
      try { localStorage.setItem('gassho-mic-ok', '1'); } catch (_) { /* 次回も出るだけ */ }
      resolve();
    };
  });
}

/** 始める位置 = 再生位置の線の所。終わり = 範囲の終わり（線が範囲の終わりより後ろなら曲の終わり） */
function startQFor() {
  return Math.min(snapQ(S.snaps, cursorQ()), lastBeatQ());
}
function endQFor(q0) {
  return q0 < S.range.endQ - 1e-6 ? S.range.endQ : S.totalQ;
}
function lastBeatQ() { return S.grid.length ? S.grid[S.grid.length - 1].q : 0; }

async function startRun(opts = {}) {
  fx.reset(); fxSeen.breath = null; fxSeen.flash = null; fxSeen.lastQ = -1e9;
  if (S.editing) { S.editing = false; S.pendingWedge = null; syncExprBar(); }
  await engine.init();
  applyGains();
  $('sheet-report').hidden = true;
  $('sheet-settings').hidden = true;
  $('search-results').hidden = true;
  S.inertia = null; S.anim = null; S.drag = null;
  const mode = opts.loop ? 'alt' : settings.mode;
  const q0 = opts.loop ? S.range.startQ : startQFor();
  const endQ = opts.loop ? S.range.endQ : endQFor(q0);
  S.origin = qToSec(q0); // とめたら、ここへ戻る
  savePos();
  if (mode === 'listen') { startListen(q0, endQ); return; }
  if (mode === 'review') { startReview(q0); return; }
  await askMicOnce();
  try {
    await openMic(mode === 'through');
  } catch (err) {
    micError(err);
    return;
  }
  if (mode === 'alt') startAlt(q0, endQ, !!opts.loop);
  else startThrough(q0, endQ);
}

async function openMic(echoCancel) {
  S.tracker = new PitchTracker(engine.ctx.sampleRate);
  const st = await engine.openMic(echoCancel, onMicData);
  const yes = (v) => (v === undefined ? '不明' : v ? 'オン' : 'オフ');
  $('mic-info').textContent =
    `マイク: 頼んだ設定＝エコーキャンセル${echoCancel ? 'オン' : 'オフ'}／端末の実際の設定＝エコーキャンセル${yes(st.echoCancellation)}・ノイズ抑制${yes(st.noiseSuppression)}・自動音量${yes(st.autoGainControl)}` +
    `・${engine.ctx.sampleRate}Hz・出力の遅れ約${Math.round(engine.outputDelay() * 1000)}ms` + (st.latency ? `・入力の遅れ約${Math.round(st.latency * 1000)}ms` : '');
}

function micError(err) {
  const name = err && err.name;
  if (err && err.message === 'INSECURE') toast('マイクは https:// か localhost で開いたときだけ使えます。配布されたURLから開いてください。', 7000);
  else if (name === 'NotAllowedError' || name === 'SecurityError') toast('マイクが許可されていません。iPadの「設定」→「Safari」→「マイク」を「許可」にしてから、もう一度「はじめる」を押してください。', 8000);
  else if (name === 'NotFoundError') toast('マイクが見つかりませんでした。', 6000);
  else toast('マイクを使えませんでした（' + (err && (err.message || name)) + '）', 7000);
}

function latency() { return engine.outputDelay() + engine.inputDelay() + settings.latencyMs / 1000; }

/** q の範囲 [fromQ, toQ) の拍にクリック。t0 = fromQ の音が鳴る時刻 */
function beatClicks(fromQ, toQ, t0, r) {
  const base = qToSec(fromQ);
  return S.grid.filter((g) => g.q >= fromQ - 1e-6 && g.q < toQ - 1e-6).map((g) => ({ kind: 'click', time: t0 + (qToSec(g.q) - base) / r, accent: g.down }));
}

/** 始める位置の前に1小節ぶんのカウント（拍の目盛りにそろえる） */
function countIn(q0, t0, r) {
  const beats = countInBeats(S.measures, q0);
  const base = qToSec(beats[0].q);
  const ev = beats.map((b) => ({ kind: 'click', time: t0 + (qToSec(b.q) - base) / r, accent: b.accent }));
  const end = t0 + (qToSec(q0) - base) / r;
  return { ev, beats: beats.length, beatSec: (end - t0) / beats.length, end, fromQ: beats[0].q };
}

function noteEvents(list, bus, fromQ, toQ, t0, r) {
  const base = qToSec(fromQ);
  const ev = [];
  for (const n of list) {
    if (n.startQ < fromQ - 1e-6 || n.startQ >= toQ - 1e-6) continue;
    ev.push({ kind: 'note', time: t0 + (n.startSec - base) / r, dur: (n.endSec - n.startSec) / r, midi: n.midi, bus, dyn: n.dyn || 'mf' });
  }
  return ev;
}

function buildSegments(q0, endQ, len) {
  const segs = [];
  for (const s of segmentsFrom(S.measures, q0, endQ, len)) {
    const notes = S.notes.filter((n) => n.startQ >= s.startQ - 1e-6 && n.startQ < s.endQ - 1e-6);
    if (!notes.length) continue; // 自分のパートが休みの区切りは飛ばす
    const startSec = qToSec(s.startQ), endSec = qToSec(s.endQ);
    const noteEnd = Math.max(endSec, ...notes.map((n) => n.endSec));
    const midStart = s.startQ > S.measures[s.fromIdx].startQ + 1e-6;
    const label = midStart ? `${posLabel(S.measures, s.startQ)}〜${S.measures[s.toIdx].number}小節` : markLabel(s.fromIdx, s.toIdx);
    segs.push({ ...s, startSec, endSec, noteEnd, notes, label });
  }
  return segs;
}

function clearSegmentDisplay(seg) {
  S.voice = S.voice.filter((v) => v.sec < seg.startSec - 0.3 || v.sec > seg.noteEnd + 0.3);
  for (const n of seg.notes) S.results.delete(n.id);
}

// ---- 交互練習 ----
function startAlt(q0, endQ, loop) {
  const len = loop ? S.measures.length : settings.segLen;
  const segs = buildSegments(q0, endQ, len);
  if (!segs.length) { engine.closeMic(); toast('ここから先の範囲には、自分のパートの音符がありません。'); return; }
  S.run = { kind: 'alt', loop, r: settings.tempo / 100, segs, segIdx: 0, segResults: new Map(), round: 1 };
  setGo(true);
  scheduleSegment();
}

function scheduleSegment() {
  const run = S.run, seg = run.segs[run.segIdx], r = run.r;
  $('seg-card').hidden = true;
  clearSegmentDisplay(seg);
  const t = engine.now + 0.25;
  const ev = [];
  let listenEnd = null;
  if (settings.listen) {
    ev.push(...noteEvents(S.notes, 'mine', seg.startQ, seg.endQ, t, r));
    ev.push(...noteEvents(S.others, 'others', seg.startQ, seg.endQ, t, r));
    ev.push(...noteEvents(S.piano, 'piano', seg.startQ, seg.endQ, t, r));
    listenEnd = t + (seg.noteEnd - seg.startSec) / r;
  }
  const countStart = listenEnd !== null ? listenEnd + 0.6 : t;
  const ci = countIn(seg.startQ, countStart, r);
  ev.push(...ci.ev);
  const singStart = ci.end;
  // 歌う間はクリックだけ（音程のある音は鳴らさない）
  ev.push(...beatClicks(seg.startQ, seg.endQ, singStart, r));
  const singEnd = singStart + (seg.noteEnd - seg.startSec) / r;
  engine.schedule(ev);
  run.phase = 'play';
  run.ph = { listenStart: t, listenEnd, countStart, singStart, singEnd, beatSec: ci.beatSec, beats: ci.beats };
  run.cap = { from: singStart - 0.3, to: singEnd + 0.25, ctx0: singStart, sec0: seg.startSec, frames: [], recent: [] };
  run.evalAt = singEnd + 0.3 + latency() + 0.1;
  prepJudges(run, seg);
}

// ---------------- 合図どおりに歌えたか（声で判定 → 演出とまとめ） ----------------
const beatSecAt = (sec) => { const q = secToQ(sec); const m = S.measures[measureIndexAt(S.measures, q)]; return (m ? 4 / m.beatType : 1) * 60 / S.score.timeline.bpmAt(q); };
const EMPTY_TALLY = () => ({ breath: [0, 0], wedge: [0, 0], dyn: [0, 0] });
function prepJudges(run, seg) {
  run.judge = cuesOn() ? { list: judgeTargets(roll.expr, seg.startSec, seg.noteEnd, beatSecAt), done: new Set() } : null;
  // 1音ずつの判定（歌い終わった直後に色がつく・コンボ）と、フレーズ（息継ぎ・休符まで）の一語
  const notes = [...seg.notes].sort((a, b) => a.startSec - b.startSec);
  const cuts = new Set((S.expr ? S.expr.breaths : []).map((b) => b.q.toFixed(4)));
  const phrases = [];
  let cur = [];
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    if (cur.length && (cuts.has(n.startQ.toFixed(4)) || n.startQ - (prev.startQ + prev.durQ) >= 0.5 - 1e-6)) { phrases.push(cur); cur = []; }
    cur.push(n);
  });
  if (cur.length) phrases.push(cur);
  run.live = {
    notes, idx: 0, from: 0, res: new Map(),
    phrases: phrases.map((ns) => ({ ids: ns.map((n) => n.id), last: notes.indexOf(ns[ns.length - 1]), done: false, lenQ: ns.reduce((a, n) => a + n.durQ, 0) })),
  };
  run.segExpr = run.segExpr || new Map();
  run.segExpr.set(run.segIdx, EMPTY_TALLY());
}
/** 歌い終わった音符から順に判定（採点と同じ関数なので、あとの ◎○△× と食い違わない） */
function checkLive(run) {
  const L = run.live, cap = run.cap;
  if (!L || !cap || !cap.frames.length) return;
  const upTo = cap.frames[cap.frames.length - 1].sec;
  const now = performance.now(), karaoke = settings.fx === 'karaoke';
  while (L.idx < L.notes.length && L.notes[L.idx].endSec + 0.1 * run.r <= upTo) {
    const n = L.notes[L.idx], prev = L.notes[L.idx - 1];
    const ev = evaluateNote(n, cap.frames, run.r, L.from, prev);
    L.from = ev.nextIdx;
    L.idx++;
    if (ev.status === 'nodata') continue;
    L.res.set(n.id, ev);
    S.results.set(n.id, ev);
    if (karaoke) fx.note(now, ev.grade, roll.xOf(n.endSec, S.view), roll.yOf(n.midi), fxBox());
  }
  for (const p of L.phrases) {
    if (p.done || p.last >= L.idx) continue; // フレーズの最後の音まで判定が済んだら
    p.done = true;
    const rs = p.ids.map((id) => L.res.get(id)).filter(Boolean);
    if (!rs.length || (p.ids.length < 2 && p.lenQ < 1)) continue;
    const w = rs.reduce((a, r) => a + r.weight, 0);
    const score = rs.reduce((a, r) => a + r.weight * (r.score || 0), 0) / w;
    p.score = score;
    if (karaoke) fx.phrase(now, phraseWord(score), fxBox());
  }
}

function checkJudges(run, final) {
  const J = run.judge, cap = run.cap;
  if (!J || !cap || !cap.frames.length) return;
  const upTo = cap.frames[cap.frames.length - 1].sec;
  const tally = run.segExpr.get(run.segIdx);
  for (const t of J.list) {
    if (J.done.has(t.key) || (!final && t.evalSec > upTo)) continue;
    J.done.add(t.key);
    const res = t.kind === 'breath' ? judgeBreath(cap.frames, t.zoneSec, t.sec, run.r, QUIET_DB)
      : t.kind === 'wedge' ? judgeWedge(cap.frames, t.startSec, t.endSec, t.wedge, QUIET_DB)
        : judgeDyn(cap.frames, t.sec, t.beatSec, t.from, t.to, QUIET_DB);
    if (!res) continue;
    tally[t.kind][1]++;
    if (res.ok) tally[t.kind][0]++;
    if (settings.fx === 'karaoke') fx.judge(performance.now(), t.kind, res.ok, t, fxBox());
    else if (res.ok) toast(t.kind === 'breath' ? 'ナイス息継ぎ！' : '強弱、決まった！', 1200);
  }
}
/** 区切りや通しの称号（太鼓の達人の王冠: 銀＝歌いきった／金＝全部○以上／虹＝全部◎） */
function titleOf(res) {
  const rs = (res || []).filter((x) => x.status !== 'nodata');
  if (!rs.length) return null;
  if (rs.every((x) => x.grade === '◎')) return { cls: 'rainbow', text: 'ALL PERFECT　全部ぴったり！' };
  if (rs.every((x) => x.grade === '◎' || x.grade === '○')) return { cls: 'gold', text: 'FULL COMBO　音程が全部つながった！' };
  if (rs.every((x) => x.status === 'sung')) return { cls: 'silver', text: '歌いきった！' };
  return null;
}
function setTitle(el, t) {
  el.hidden = !t || !cuesOn();
  if (!t) return;
  el.className = 'result-title title-' + t.cls;
  el.textContent = t.text;
}

function exprText(t) {
  if (!t) return '';
  const parts = [];
  if (t.breath[1]) parts.push(`息継ぎ ${t.breath[0]}/${t.breath[1]}`);
  if (t.wedge[1]) parts.push(`だんだん ${t.wedge[0]}/${t.wedge[1]}`);
  if (t.dyn[1]) parts.push(`強弱 ${t.dyn[0]}/${t.dyn[1]}`);
  if (!parts.length) return '';
  const ok = t.breath[0] + t.wedge[0] + t.dyn[0], all = t.breath[1] + t.wedge[1] + t.dyn[1];
  return '歌い方：' + parts.join('・') + (ok === all ? '　全部決まった！' : '');
}
function sumTally(run) {
  const out = EMPTY_TALLY();
  for (const [i, t] of run.segExpr || []) {
    if (!run.segResults.has(i)) continue;
    for (const k of Object.keys(out)) { out[k][0] += t[k][0]; out[k][1] += t[k][1]; }
  }
  return out;
}

/** いまの区切りの録音と音程の線を、補正前の時刻にして控える（聞き直し用） */
function keepClip(run, idx) {
  const cap = run.cap;
  if (!cap) return;
  run.clips = run.clips || new Map();
  const userShift = (settings.latencyMs / 1000) * run.r;
  const frames = cap.frames.map((f) => ({ sec: f.sec + userShift, midi: f.f0 > 0 ? hzToMidi(f.f0) : null }));
  let clip = null;
  if (cap.rec) {
    const c = cap.rec.finish();
    const sys = engine.outputDelay() + engine.inputDelay();
    clip = { sec0: cap.sec0 + (c.tStart - sys - cap.ctx0) * run.r, r: run.r, sr: c.sr, pcm: c.pcm };
  }
  run.clips.set(idx, { clip, frames });
}

function finishSegment() {
  const run = S.run, seg = run.segs[run.segIdx];
  keepClip(run, run.segIdx);
  const res = evaluateNotes(seg.notes, run.cap.frames, run.r);
  run.segResults.set(run.segIdx, res);
  for (const x of res) if (x.status !== 'nodata') S.results.set(x.id, x);
  S.voice.sort((a, b) => a.sec - b.sec);
  const sum = summarize(res, { measures: S.measures, allNotes: S.notes });
  run.phase = 'result';
  run.cap = null;
  run.resultView = seg.noteEnd;
  $('seg-label').textContent = seg.label + (run.loop ? `（${run.round}回目）` : `（${run.segIdx + 1}/${run.segs.length}）`);
  $('seg-score').textContent = sum.score;
  $('seg-grades').textContent = gradeText(sum.gradeCount);
  setTitle($('seg-title'), titleOf(res));
  const et = exprText(run.segExpr && run.segExpr.get(run.segIdx));
  $('seg-expr').textContent = et;
  $('seg-expr').hidden = !et;
  $('seg-comment').textContent = sum.comments[1] || sum.comments[0] || '';
  const last = !run.loop && run.segIdx === run.segs.length - 1;
  $('btn-seg-next').textContent = last ? '講評へ' : run.loop ? 'もう一回' : '次へ';
  $('btn-seg-again').hidden = !!run.loop;
  $('seg-card').hidden = false;
  run.autoFrom = performance.now();
  run.autoMs = last ? 4500 : 4000;
}

$('btn-seg-again').addEventListener('click', () => { if (S.run && S.run.phase === 'result') scheduleSegment(); });
$('btn-seg-next').addEventListener('click', () => { if (S.run && S.run.phase === 'result') advance(); });

function advance() {
  const run = S.run;
  if (run.loop) { run.round++; scheduleSegment(); return; }
  if (run.segIdx + 1 < run.segs.length) { run.segIdx++; scheduleSegment(); return; }
  finishRun();
}

function finishRun() {
  const run = S.run;
  const all = [...run.segResults.values()].flat();
  const segs = run.segs.filter((_, i) => run.segResults.has(i));
  stopRun(false);
  if (!all.length) return;
  const sum = summarize(all, { measures: S.measures, allNotes: S.notes });
  sum.rangeText = segs.length ? markLabel(segs[0].fromIdx, segs[segs.length - 1].toIdx) : '';
  sum.tempo = run.r;
  sum.modeText = run.kind === 'through' ? '通し（試験的）' : run.loop ? 'くり返し練習' : '交互練習';
  sum.exprText = exprText(sumTally(run));
  sum.title = titleOf(all);
  sum.takeId = null;
  showReport(sum, true);
  saveTake(run, sum);
}

async function saveTake(run, sum) {
  if (!settings.record || !run.clips || !S.rec || !S.track) return;
  const kept = [...run.clips.entries()].filter(([i]) => run.segResults.has(i)).map(([, v]) => v);
  const clips = kept.map((k) => k.clip).filter((c) => c && c.pcm.length);
  if (!clips.length) return;
  const take = makeTake({
    scoreId: S.rec.id, trackKey: S.track.key, trackName: S.track.name, mode: sum.modeText, tempo: run.r,
    rangeText: sum.rangeText, summary: sum, clips, frames: kept.flatMap((k) => k.frames), userOffsetMs: settings.latencyMs,
  });
  try {
    await putTake(take);
    S.lastTakeId = take.id;
    sum.takeId = take.id;
    $('report-take').hidden = false;
    $('report-take-note').textContent = `この回の声を録音しました（このiPadの中だけ・約${Math.max(1, Math.round(take.sizeBytes / 1024))}KB）。`;
    await refreshTakes();
  } catch (_) {
    toast('録音を保存できませんでした（空き容量が足りないかもしれません）。', 5000);
  }
}

// ---- 通し（試験的） ----
function startThrough(q0, endQ) {
  const r = settings.tempo / 100;
  const startSec = qToSec(q0), endSec = qToSec(endQ);
  const notes = S.notes.filter((n) => n.startQ >= q0 - 1e-6 && n.startQ < endQ - 1e-6);
  if (!notes.length) { engine.closeMic(); toast('ここから先の範囲には、自分のパートの音符がありません。'); return; }
  const noteEnd = Math.max(endSec, ...notes.map((n) => n.endSec));
  const t = engine.now + 0.25;
  const ci = countIn(q0, t, r);
  const playStart = ci.end;
  const ev = [...ci.ev];
  if (settings.preroll) {
    // 1小節前から伴奏（自分のパートは鳴らさない）
    ev.push(...noteEvents(S.others, 'others', ci.fromQ, q0, t, r));
    ev.push(...noteEvents(S.piano, 'piano', ci.fromQ, q0, t, r));
  }
  ev.push(...noteEvents(S.others, 'others', q0, endQ, playStart, r));
  ev.push(...noteEvents(S.piano, 'piano', q0, endQ, playStart, r));
  if (settings.guide) ev.push(...noteEvents(S.notes, 'mine', q0, endQ, playStart, r));
  if (settings.clickThrough) ev.push(...beatClicks(q0, endQ, playStart, r));
  engine.schedule(ev);
  const playEnd = playStart + (noteEnd - startSec) / r;
  for (const n of notes) S.results.delete(n.id);
  S.voice = S.voice.filter((v) => v.sec < startSec - 0.3 || v.sec > noteEnd + 0.3);
  const a = measureIndexAt(S.measures, q0), b = measureIndexAt(S.measures, endQ - 1e-3);
  const seg = { startQ: q0, endQ, fromIdx: a, toIdx: b, startSec, endSec, noteEnd, notes, label: markLabel(a, b) };
  S.run = {
    kind: 'through', r, segs: [seg], segIdx: 0, segResults: new Map(), phase: 'play',
    ph: { listenStart: t, listenEnd: null, countStart: t, singStart: playStart, singEnd: playEnd, beatSec: ci.beatSec, beats: ci.beats },
    cap: { from: playStart - 0.3, to: playEnd + 0.25, ctx0: playStart, sec0: startSec, frames: [], recent: [] },
    evalAt: playEnd + 0.3 + latency() + 0.1,
  };
  prepJudges(S.run, seg);
  setGo(true);
}

// ---- 聞くだけ ----
function startListen(q0, endQ) {
  const r = settings.tempo / 100;
  const t = engine.now + 0.2;
  const ev = [
    ...noteEvents(S.notes, 'mine', q0, endQ, t, r),
    ...noteEvents(S.others, 'others', q0, endQ, t, r),
    ...noteEvents(S.piano, 'piano', q0, endQ, t, r),
  ];
  engine.schedule(ev);
  const startSec = qToSec(q0), endSec = qToSec(endQ);
  const lastEnd = Math.max(endSec, ...S.notes.filter((n) => n.startQ < endQ && n.startQ >= q0).map((n) => n.endSec));
  S.run = { kind: 'listen', r, phase: 'play', startSec, t0: t, end: t + (lastEnd - startSec) / r + 0.4 };
  setGo(true);
}

function stopRun(report) {
  const run = S.run;
  engine.stopAll();
  engine.closeMic();
  $('seg-card').hidden = true;
  S.run = null;
  S.liveMidi = null;
  S.quiet = false;
  setGo(false);
  $('meter-fill').style.width = '0';
  if (S.origin != null) { animateTo(S.origin, 300); S.origin = null; } // 始めた位置へ戻る
  if (report && run && run.kind === 'through' && run.cap && run.cap.frames.length) {
    // 通しを途中でとめた: 歌い終わった音符だけ採点する
    const upTo = Math.max(...run.cap.frames.map((f) => f.sec));
    const seg = run.segs[0];
    const res = evaluateNotes(seg.notes.filter((n) => n.endSec <= upTo), run.cap.frames, run.r);
    keepClip(run, 0);
    if (res.length) {
      run.segResults.set(0, res);
      for (const x of res) if (x.status !== 'nodata') S.results.set(x.id, x);
    }
  }
  if (report && run && run.segResults && run.segResults.size) {
    S.run = run; // finishRun が参照する
    finishRun();
  }
}

document.addEventListener('visibilitychange', () => { if (document.hidden && S.run) stopRun(false); });

// ---------------- マイク → 音程 ----------------
function onMicData(data, t) {
  if (!S.tracker) return;
  // 聞き直し用の録音（歌う区間だけ・端末の中だけ）
  const run = S.run, cap = run && run.cap;
  if (cap && settings.record && run.kind !== 'listen') {
    const sys = engine.outputDelay() + engine.inputDelay();
    const tEnd = t + data.length / engine.ctx.sampleRate;
    if (tEnd - sys >= cap.from && t - sys <= cap.to) {
      if (!cap.rec) cap.rec = new ClipRecorder(engine.ctx.sampleRate, t);
      cap.rec.push(data);
    }
  }
  const frames = S.tracker.push(data, t);
  for (const f of frames) handleFrame(f);
}

function handleFrame(f) {
  S.level = f.db;
  const run = S.run;
  if (!run || !run.cap) return;
  const tc = f.t - latency();
  const cap = run.cap;
  if (tc < cap.from || tc > cap.to) return;
  const voiced = f.f0 > 0 && f.db > QUIET_DB;
  const sec = cap.sec0 + (tc - cap.ctx0) * run.r;
  cap.frames.push({ sec, f0: voiced ? f.f0 : 0, db: f.db });
  const m = voiced ? hzToMidi(f.f0) : null;
  S.smooth.push(m);
  if (S.smooth.length > 3) S.smooth.shift();
  let shown = null;
  if (m !== null) {
    const vs = S.smooth.filter((x) => x !== null).sort((a, b) => a - b);
    shown = vs[vs.length >> 1];
  }
  S.voice.push({ sec, midi: shown });
  if (shown !== null) { S.liveMidi = shown; S.liveAt = performance.now(); }
  // 「声が小さすぎ」の目安（歌う音符がある間に、0.8秒ずっと拾えていない）
  cap.recent.push({ voiced, db: f.db, want: !!roll.noteAt(sec) });
  if (cap.recent.length > 80) cap.recent.shift();
  const want = cap.recent.filter((x) => x.want);
  S.quiet = want.length >= 60 && !want.some((x) => x.voiced) && median(want.map((x) => x.db)) < TOO_QUIET_DB;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

// ---------------- 段階の表示 ----------------
let lastPhaseKey = '';
function updatePhase(phase, msg, warn) {
  const key = (phase || '-') + '|' + (msg || '') + '|' + !!warn + '|' + (S.run ? S.run.kind : settings.mode);
  if (key === lastPhaseKey) return;
  lastPhaseKey = key;
  const steps = $('phase-steps');
  steps.classList.toggle('off', !phase);
  const kind = S.run ? S.run.kind : settings.mode;
  const use = { alt: ['listen', 'count', 'sing', 'result'], through: ['count', 'sing'], listen: ['listen'], review: [] }[kind];
  for (const li of steps.children) {
    li.classList.toggle('on', li.dataset.p === phase);
    li.hidden = !use.includes(li.dataset.p);
  }
  const el = $('phase-msg');
  el.textContent = msg || '';
  el.classList.toggle('warn', !!warn);
}

/** 止まっている間の案内: どこから始まるか・そこからの歌詞 */
function idleMessage() {
  if (!S.measures.length) return '';
  const q0 = startQFor();
  const endQ = endQFor(q0);
  const toText = endQ >= S.totalQ - 1e-6 ? (S.range.endQ < S.totalQ - 1e-6 ? '曲の終わりまで（範囲の後ろです）' : '') : endLabel(S.measures, endQ).replace(/(まで)?$/, 'まで');
  const where = `${posLabel(S.measures, q0)}から始めます${toText ? '・' + toText : ''}`;
  const ly = lyricsFrom(q0);
  if (settings.mode === 'review' && S.review) {
    const t = S.review.take, d = new Date(t.createdAt);
    return `聞き直し：${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}の録音（${t.score}点）・${posLabel(S.measures, q0)}から`;
  }
  return ly ? `${where}｜${ly}` : where;
}

// ---------------- 描画ループ ----------------
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(50, now - lastT);
  lastT = now;
  if ($('screen-practice').hidden) return;
  const run = S.run;
  let count = null, countSub = '', clip = false, activeOn = false;
  if (run) {
    const a = engine.audibleTime(), ctxNow = engine.now;
    if (run.kind === 'listen' || run.kind === 'review') {
      S.view = run.startSec + Math.max(0, a - run.t0) * run.r;
      activeOn = true;
      if (run.kind === 'review') {
        clip = true;
        const f = nearestFrame(S.voice, S.view);
        S.liveMidi = f && f.midi != null ? f.midi : null; S.liveAt = performance.now();
        updatePhase(null, `聞き直しています：${posLabel(S.measures, secToQ(S.view))}`);
      } else updatePhase('listen', 'お手本を聞いています。');
      if (ctxNow > run.end) stopRun(false);
    } else if (run.phase === 'result') {
      S.view = run.resultView;
      updatePhase('result', `${run.segs[run.segIdx].label}の結果です。${run.loop ? '続けてもう一回歌います。' : '少しすると次へ進みます。'}`);
      const p = Math.min(1, (performance.now() - run.autoFrom) / run.autoMs);
      $('seg-timer').style.width = (p * 100).toFixed(1) + '%';
      if (p >= 1) advance();
    } else {
      const ph = run.ph, seg = run.segs[run.segIdx];
      const where = seg.label + (run.kind === 'alt' ? (run.loop ? `・${run.round}回目` : `・区切り ${run.segIdx + 1}/${run.segs.length}`) : '');
      if (ph.listenEnd !== null && a < ph.listenEnd + 0.2) {
        S.view = seg.startSec + Math.max(0, a - ph.listenStart) * run.r;
        activeOn = true;
        updatePhase('listen', `${where}：お手本を聞いてください。`);
      } else if (a < ph.singStart) {
        S.view = seg.startSec - (ph.singStart - a) * run.r;
        if (a >= ph.countStart) { count = String(Math.min(ph.beats, Math.floor((a - ph.countStart) / ph.beatSec) + 1)); countSub = cuesOn() ? entryHint(S.expr, seg.startQ) : ''; }
        updatePhase('count', `${where}：カウントのあと歌います。`);
      } else {
        S.view = seg.startSec + (a - ph.singStart) * run.r;
        clip = true; activeOn = true;
        if (S.quiet) updatePhase('sing', '声が小さすぎて音程が拾えません。もう少しiPadに近づいてみましょう。', true);
        else updatePhase('sing', run.kind === 'alt' ? `${where}：歌ってください（鳴るのはクリックだけ）` : `${where}：伴奏に合わせて歌ってください。`);
      }
      if (run.cap && cuesOn()) checkLive(run);
      if (run.cap) checkJudges(run, false);
      if (S.run && ctxNow >= run.evalAt) {
        if (run.cap) checkJudges(run, true);
        if (run.kind === 'alt') finishSegment();
        else {
          keepClip(run, 0);
          const res = evaluateNotes(seg.notes, run.cap.frames, run.r);
          run.segResults.set(0, res);
          for (const x of res) if (x.status !== 'nodata') S.results.set(x.id, x);
          S.voice.sort((p, q) => p.sec - q.sec);
          finishRun();
        }
      }
    }
    // マイクの音量メーター（-70〜-20dB）
    if (engine.mic && Number.isFinite(S.level)) $('meter-fill').style.width = Math.max(0, Math.min(100, ((S.level + 70) / 50) * 100)) + '%';
    if (performance.now() - S.liveAt > 150) S.liveMidi = null;
    draw({ count, countSub, clip, activeOn });
    return;
  }

  // 止まっている間: 慣性・吸着のアニメーション
  if (S.inertia) {
    const dx = S.inertia.step(dt);
    const next = clampView(S.view - dx / roll.pxPerSec);
    const hitWall = next !== S.view - dx / roll.pxPerSec;
    S.view = next;
    if (S.inertia.done || hitWall) { S.inertia = null; snapHere(); savePos(); }
    S.dirty = true;
  }
  if (S.anim) {
    const k = Math.min(1, (now - S.anim.t0) / S.anim.dur);
    const e = 1 - Math.pow(1 - k, 3);
    S.view = S.anim.from + (S.anim.to - S.anim.from) * e;
    if (k >= 1) S.anim = null;
    S.dirty = true;
  }
  if (S.dirty) {
    S.dirty = false;
    updatePhase(null, idleMessage());
    $('range-text').textContent = rangeText();
    const here = sectionOf(S.sections, measureIndexAt(S.measures, cursorQ() + 1e-6));
    for (const m of document.querySelectorAll('.mark')) m.classList.toggle('here', !!here && Number(m.dataset.from) === here.fromIdx);
    draw({});
  }
}

function draw(o = {}) {
  if (!roll || !S.measures.length) return;
  const run = S.run;
  const seg = run && run.segs ? run.segs[run.segIdx] : null;
  const act = o.activeOn ? roll.noteAt(S.view) : null;
  const idle = !run;
  const q = cursorQ();
  const m = S.measures[measureIndexAt(S.measures, q)];
  const cue = cuesOn() && S.expr ? cueAt(S.expr, q, m ? 4 / m.beatType : 1) : null;
  const running = !!run && run.phase !== 'result';
  const now = performance.now();
  const karaoke = settings.fx === 'karaoke' && running && !!cue;
  if (karaoke) {
    // 巻き戻った（お手本 → カウント → 歌う で同じ所をもう一度通る）ら、きっかけをもう一度出せるように
    if (q < fxSeen.lastQ - 0.05) { fxSeen.breath = null; fxSeen.flash = null; }
    fxSeen.lastQ = q;
    const b = cue.breath;
    if (b && b.state === 'now' && fxSeen.breath !== b.q) { fxSeen.breath = b.q; fx.breath(now, fxBox()); }
    const f = cue.dyn.flash;
    if (f && f.age < 0.5 && fxSeen.flash !== f.q) { fxSeen.flash = f.q; fx.slam(now, f.value, levelOf(f.value), fxBox()); }
  }
  roll.draw({
    view: S.view,
    cue,
    fx: settings.fx,
    gold: cuesOn() && run && run.cap && o.clip ? { r: run.r } : null,
    shake: karaoke ? fx.shake(now) : null,
    running,
    editing: S.editing,
    pendingWedge: S.pendingWedge,
    countSub: o.countSub,
    range: rangeSec(),
    segment: seg && run.kind === 'alt' ? { startSec: seg.startSec, endSec: seg.noteEnd } : null,
    results: S.results,
    voice: S.voice,
    clip: !!o.clip,
    count: o.count,
    liveMidi: o.clip ? S.liveMidi : null,
    activeId: act ? act.id : null,
    activeMidi: act ? Math.round(act.midi) : null,
    idle,
    handles: idle,
    cursorLabel: idle && !S.drag ? posLabel(S.measures, snapQ(S.snaps, cursorQ())) : idle ? posLabel(S.measures, cursorQ()) : null,
  });
  if (settings.fx === 'karaoke' && (running || fx.items.length || fx.parts.length)) {
    const b = cue && cue.breath;
    fx.draw(roll.g, fxBox(), now, { running: karaoke, breathSoon: b && b.state === 'soon' ? b : null, wedge: cue && cue.dyn.wedge });
    if (!running && (fx.items.length || fx.parts.length)) S.dirty = true; // 止めたあとも、残りの演出を消えるまで描く
  }
  mini.draw({ range: rangeSec(), view: roll.visibleSpan(S.view), cursorSec: S.view, playing: !idle });
}
function fxBox() { return { W: roll.w, H: roll.h, top: roll.noteTop, bot: roll.h - roll.lyricH, px: roll.playX, keyW: roll.keyW }; }

// ---------------- 聞き直し ----------------
const fmtDate = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

async function refreshTakes() {
  S.takes = S.rec ? await listTakes(S.rec.id) : [];
  const sel = $('take-select');
  sel.textContent = '';
  for (const t of S.takes) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = `${fmtDate(t.createdAt)}・${t.trackName}・${t.rangeText}・${t.score}点`;
    sel.appendChild(o);
  }
  if (S.review) sel.value = S.review.take.id;
  renderTakesList();
  if (settings.mode === 'review' && S.review && !S.takes.some((t) => t.id === S.review.take.id)) { leaveReview(); settings.mode = 'alt'; }
  syncControls();
}

function renderTakesList() {
  const ul = $('takes-list');
  ul.textContent = '';
  $('takes-empty').hidden = S.takes.length > 0;
  $('btn-takes-clear').hidden = !S.takes.length;
  for (const t of S.takes) {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'take-title';
    title.textContent = `${fmtDate(t.createdAt)}　${t.trackName}`;
    const meta = document.createElement('span');
    meta.className = 'take-meta';
    const secs = t.clips.reduce((a, c) => a + c.n / c.sr, 0);
    meta.textContent = `${t.rangeText}・${t.mode}・テンポ${Math.round(t.tempo * 100)}%・声 ${Math.round(secs)}秒（約${Math.max(1, Math.round(t.sizeBytes / 1024))}KB）`;
    title.appendChild(meta);
    const score = document.createElement('span');
    score.className = 'take-score';
    score.textContent = `${t.score}点`;
    const actions = document.createElement('span');
    const play = document.createElement('button');
    play.type = 'button'; play.className = 'btn btn-primary btn-small'; play.textContent = '聞き直す';
    play.onclick = () => { $('sheet-takes').hidden = true; enterReview(t); };
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'btn btn-quiet btn-small'; del.textContent = '削除';
    del.onclick = async () => {
      if (!confirm(`${fmtDate(t.createdAt)}の録音を消しますか？`)) return;
      await removeTake(t.id).catch(() => {});
      await refreshTakes();
    };
    actions.append(play, ' ', del);
    li.append(title, score, actions);
    ul.appendChild(li);
  }
}

$('btn-takes-clear').addEventListener('click', async () => {
  if (!S.rec || !confirm('この楽譜の録音を全部消しますか？（元に戻せません）')) return;
  if (S.run) stopRun(false);
  await clearTakes(S.rec.id).catch(() => {});
  await refreshTakes();
});
$('btn-review-this').addEventListener('click', () => {
  const t = S.takes.find((x) => x.id === (S.lastReport && S.lastReport.takeId));
  if (t) { $('sheet-report').hidden = true; enterReview(t); }
});

async function enterReview(take) {
  if (S.run) stopRun(false);
  if (!S.track || S.track.key !== take.trackKey) {
    const tr = S.score.tracks.find((x) => x.key === take.trackKey);
    if (!tr) { toast('この録音のパートが楽譜に見つかりませんでした。'); return; }
    await chooseTrack(tr);
  }
  if (!S.review) S.live = { results: S.results, voice: S.voice };
  const results = new Map();
  for (const [id, grade, status, cents, octave, score] of take.results) results.set(id, { id, grade, status, cents, octave, score });
  S.review = { take };
  S.results = results;
  settings.mode = 'review';
  applyReviewOffset();
  const first = take.startSec;
  if (Number.isFinite(first) && (S.view < first - 1 || S.view > take.endSec)) S.view = first;
  $('take-select').value = take.id;
  syncControls();
  S.dirty = true;
}

/** いまの「タイミングの補正」で、録音と声の線の位置を合わせ直す */
function applyReviewOffset() {
  if (!S.review) return;
  S.voice = reviewFrames(S.review.take, settings.latencyMs);
  S.review.clips = reviewClips(S.review.take, settings.latencyMs);
  S.dirty = true;
}

function leaveReview() {
  if (!S.review) return;
  if (S.live) { S.results = S.live.results; S.voice = S.live.voice; }
  S.review = null; S.live = null;
  S.dirty = true;
}

function nearestFrame(frames, sec) {
  let lo = 0, hi = frames.length - 1;
  if (hi < 0) return null;
  while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].sec < sec) lo = m + 1; else hi = m; }
  const f = frames[lo];
  return f && Math.abs(f.sec - sec) < 0.03 ? f : null;
}

function startReview(q0) {
  const rv = S.review;
  if (!rv) return;
  const r = rv.take.tempo || 1;
  const startSec = qToSec(q0);
  const clips = rv.clips.filter((c) => c.sec1 > startSec + 0.01);
  const endSec = Math.max(rv.take.endSec, ...rv.clips.map((c) => c.sec1));
  if (!clips.length && startSec >= endSec - 0.05) { toast('この位置より後ろには録音がありません。'); return; }
  applyGains();
  const t0 = engine.now + 0.2;
  if (!rv.decoded) {
    // 全部の区切りを1回だけ展開し、いちばん大きい所が −6dBFS 付近になるよう同じ倍率で持ち上げる（小声でも聞き取れるように）
    rv.decoded = new Map();
    let peak = 0;
    for (const c of rv.take.clips) { const x = adpcmDecode(c.data, c.n); rv.decoded.set(c.data, x); for (const v of x) peak = Math.max(peak, Math.abs(v)); }
    const g = peak > 0 ? Math.min(20, 0.5 / peak) : 1;
    for (const x of rv.decoded.values()) for (let i = 0; i < x.length; i++) x[i] *= g;
  }
  for (const c of clips) {
    const pcm = rv.decoded.get(c.data);
    const when = t0 + (c.sec0 - startSec) / r;
    engine.playVoice(pcm, c.sr, when < t0 ? t0 : when, when < t0 ? (t0 - when) : 0);
  }
  if (settings.reviewPiano) {
    const endQ = Math.min(S.totalQ, secToQ(endSec) + 1e-6);
    engine.schedule([
      ...noteEvents(S.notes, 'mine', q0, endQ, t0, r),
      ...noteEvents(S.others, 'others', q0, endQ, t0, r),
      ...noteEvents(S.piano, 'piano', q0, endQ, t0, r),
    ]);
  }
  S.run = { kind: 'review', r, phase: 'play', startSec, t0, end: t0 + (endSec - startSec) / r + 0.4 };
  setGo(true);
}

// ---------------- 講評 ----------------
function gradeText(c) {
  const parts = ['◎', '○', '△', '×'].map((g) => `${g}${c[g] || 0}`);
  if (c.octave) parts.push(`オクターブ違い${c.octave}`);
  if (c['－']) parts.push(`声なし${c['－']}`);
  return parts.join('　');
}

function showReport(sum, fresh) {
  S.lastReport = sum;
  $('report-take').hidden = !sum.takeId;
  $('btn-report').hidden = false;
  $('report-range').textContent = [sum.rangeText, sum.modeText, sum.tempo ? `テンポ${Math.round(sum.tempo * 100)}%` : ''].filter(Boolean).join('・');
  $('report-score').textContent = sum.score;
  $('report-grades').textContent = gradeText(sum.gradeCount);
  setTitle($('report-title-badge'), sum.title);
  $('report-expr').textContent = sum.exprText || '';
  $('report-expr').hidden = !sum.exprText;
  const ul = $('report-comments');
  ul.textContent = '';
  for (const c of sum.comments) { const li = document.createElement('li'); li.textContent = c; ul.appendChild(li); }
  const strip = $('measure-strip');
  strip.textContent = '';
  for (const m of sum.measureScores) {
    const b = document.createElement('button');
    b.type = 'button';
    const sc = Math.round(m.score);
    b.className = sc >= 90 ? 'm-great' : sc >= 75 ? 'm-good' : sc >= 55 ? 'm-fair' : 'm-miss';
    const sm = document.createElement('small');
    sm.textContent = `${m.number}小節`; // 小節番号は楽譜ファイル由来なので textContent で入れる
    const bb = document.createElement('b');
    bb.textContent = String(sc);
    b.append(sm, bb);
    b.setAttribute('aria-label', `${m.number}小節 ${sc}点。ここだけ練習する`);
    b.onclick = () => startLoop(m.measureIndex, m.measureIndex);
    strip.appendChild(b);
  }
  const wa = $('weak-actions');
  wa.textContent = '';
  const targets = sum.weak.slice(0, 3).map((w) => ({ ...w, note: `${Math.round(w.score)}点` }));
  for (const b of sum.biased || []) {
    if (targets.length >= 3 || targets.some((t) => t.fromIdx <= b.toIdx && b.fromIdx <= t.toIdx)) continue;
    targets.push({ ...b, note: `${b.sign < 0 ? '低め' : '高め'}` });
  }
  for (const w of targets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-primary';
    b.textContent = `${markLabel(w.fromIdx, w.toIdx)}だけくり返す（${w.note}）`;
    b.onclick = () => startLoop(w.fromIdx, w.toIdx);
    wa.appendChild(b);
  }
  $('sheet-settings').hidden = true;
  $('sheet-report').hidden = false;
  if (fresh && S.rec && S.track && sum.counted) {
    S.rec.results = S.rec.results || {};
    S.rec.results[S.track.key] = { score: sum.score, at: Date.now() };
    store.put(S.rec).catch(() => {});
  }
}

function startLoop(a, b) {
  if (S.run) stopRun(false);
  $('sheet-report').hidden = true;
  const ma = S.measures[a], mb = S.measures[b];
  S.range = { startQ: ma.startQ, endQ: mb.startQ + mb.lengthQ };
  S.anim = null;
  S.view = ma.startSec;
  syncControls();
  startRun({ loop: true });
}

// ---------------- 起動 ----------------
roll = new Roll($('roll'));
mini = new Minimap($('minimap'));
setupRollGestures($('roll'));
setupMiniGestures($('minimap'));
window.addEventListener('resize', () => { roll.resize(); mini.resize(); S.dirty = true; });
syncControls();
show('home');
requestAnimationFrame(frame);

// 動作確認用（コンソールから状態を見る・音を書き出して調べる。外部には何も送らない）
async function renderCheck(fromIdx, toIdx) {
  // 「聞くだけ」と同じ音（自分＋ほか＋伴奏・いまの音量）を書き出して、音割れと無音を数える
  const fromQ = S.measures[fromIdx].startQ, toQ = S.measures[toIdx].startQ + S.measures[toIdx].lengthQ;
  const ev = [...noteEvents(S.notes, 'mine', fromQ, toQ, 0.05, 1), ...noteEvents(S.others, 'others', fromQ, toQ, 0.05, 1), ...noteEvents(S.piano, 'piano', fromQ, toQ, 0.05, 1)];
  const buf = await engine.renderOffline(ev, qToSec(toQ) - qToSec(fromQ) + 1.5, { gains: busGains() });
  const x = buf.getChannelData(0);
  let peak = 0, e = 0, over = 0, silentBlocks = 0;
  const blk = Math.round(buf.sampleRate * 0.25);
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); peak = Math.max(peak, a); e += x[i] * x[i]; if (a >= 1) over++; }
  for (let b = 0; b + blk < x.length - buf.sampleRate; b += blk) { let m = 0; for (let i = b; i < b + blk; i++) m = Math.max(m, Math.abs(x[i])); if (m < 1e-4) silentBlocks++; }
  return { notes: ev.length, seconds: +(x.length / buf.sampleRate).toFixed(1), peakDb: +(20 * Math.log10(peak)).toFixed(2), rmsDb: +(10 * Math.log10(e / x.length)).toFixed(1), over, silentBlocks };
}
async function renderNote(midi, dur = 1.5, dyn = 'mf') {
  await engine.loadPiano([{ midi, dyn }]);
  const buf = await engine.renderOffline([{ kind: 'note', time: 0.02, dur, midi, bus: 'mine', dyn }], dur + 0.6, { reverb: false, gains: { mine: 1, others: 0, piano: 0, click: 0 }, channels: 1 });
  return buf.getChannelData(0);
}
/** 検証用: 伴奏（ピアノのパート）だけを書き出す。reverb=false なら fluidsynth（リバーブなし）と比べる用 */
async function renderPianoPart(fromIdx, toIdx, reverb) {
  const fromQ = S.measures[fromIdx].startQ, toQ = S.measures[toIdx].startQ + S.measures[toIdx].lengthQ;
  const ev = noteEvents(S.piano, 'piano', fromQ, toQ, 0.5, 1);
  await engine.loadPiano(S.piano);
  const buf = await engine.renderOffline(ev, qToSec(toQ) - qToSec(fromQ) + 3, { reverb, gains: { mine: 0, others: 0, piano: 1, click: 0 }, channels: 2 });
  const out = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c), b = new Uint8Array(d.buffer.slice(0));
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    out.push(btoa(s));
  }
  return { sr: buf.sampleRate, chans: out, notes: ev.length };
}
/** 検証用: 任意の音符の列を書き出す（比較スクリプトから、fluidsynth と同じ音符を渡すため） */
async function renderEvents(events, seconds, opts = {}) {
  await engine.loadPiano(events);
  const buf = await engine.renderOffline(events.map((e) => ({ kind: 'note', bus: 'piano', ...e })), seconds, { gains: { mine: 0, others: 0, piano: 1, click: 0 }, ...opts });
  const out = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const b = new Uint8Array(buf.getChannelData(c).buffer.slice(0));
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    out.push(btoa(s));
  }
  return { sr: buf.sampleRate, chans: out };
}
window.__gasshoRefresh = () => refreshTakes();
window.__gassho = { PIANO_GAIN, S, settings, engine, fx, renderCheck, renderNote, renderPianoPart, renderEvents, cursorQ, qToSec, secToQ, rollObj: roll, miniObj: mini };
