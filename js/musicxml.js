// MusicXML（score-partwise）→ 練習に使う形（パート×声部ごとの音符列・小節・テンポ）
// 時間はすべて「四分音符いくつ分」（q）で持つ。divisions が途中で変わっても q に直すので揺れない。

import { parseXml, kids, kid, txt, num } from './xml.js';

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const EPS = 1e-6;
export const NOTE_NAMES_JA = ['ド', 'ド♯', 'レ', 'ミ♭', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'シ♭', 'シ'];
export const NOTE_NAMES_EN = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
export const midiName = (m) => NOTE_NAMES_EN[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

export class ScoreError extends Error {}

export function parseMusicXml(xmlText) {
  let root;
  try {
    root = parseXml(xmlText);
  } catch (e) {
    throw new ScoreError('楽譜ファイルの形式が読めませんでした（' + e.message + '）');
  }
  if (root.name === 'score-timewise') throw new ScoreError('この楽譜は「score-timewise」形式で、まだ対応していません。作成ソフトから通常のMusicXMLで書き出してください。');
  if (root.name !== 'score-partwise') throw new ScoreError('MusicXMLの楽譜ではないようです（' + root.name + '）');

  const warnings = new Set();
  const credits = kids(root, 'credit');
  const titleCredit = credits.find((c) => txt(c, 'credit-type') === 'title') || credits[0];
  const title = txt(kid(root, 'work'), 'work-title') || txt(root, 'movement-title') ||
    (titleCredit ? txt(titleCredit, 'credit-words') : '') || '無題の楽譜';

  // パート情報
  const partList = kid(root, 'part-list');
  const partInfo = new Map();
  for (const sp of kids(partList, 'score-part')) {
    partInfo.set(sp.attrs.id, {
      id: sp.attrs.id,
      name: txt(sp, 'part-name') || sp.attrs.id,
      abbr: txt(sp, 'part-abbreviation'),
      keyboard: kids(sp, 'score-instrument').some((si) => /^keyboard\./.test(txt(si, 'instrument-sound'))) ||
        kids(sp, 'midi-instrument').some((mi) => { const pr = num(mi, 'midi-program', 0); return pr >= 1 && pr <= 8; }),
    });
  }

  const partEls = kids(root, 'part');
  if (!partEls.length) throw new ScoreError('楽譜にパートが1つもありません');

  const rawNotes = [];      // 小節内の相対位置で持つ
  const partMeasureLen = []; // [partIdx][measureIdx] = 長さ(q)
  const measureMeta = [];   // measureIdx -> {number, beats, beatType, implicit}
  const tempoRaw = [];      // {mi, relQ, bpm}
  const marksRaw = [];      // 練習番号 {mi, label}
  const exprRaw = [];       // 歌い方の記号 {type, pi, part, mi, relQ, ...}（息継ぎ・強弱・松葉・文字の指示・フェルマータ）
  const anchors = [];       // 書き戻し用: 音符・休符の要素の頭 {pi, mi, relQ, at, div}
  const clefByPart = new Map();
  const transposeByPart = new Map();

  partEls.forEach((partEl, pi) => {
    const pid = partEl.attrs.id;
    if (!partInfo.has(pid)) partInfo.set(pid, { id: pid, name: pid, abbr: '' });
    let divisions = 1;
    let dyn = 'mf'; // 強弱（ピアノの録音の段を選ぶのに使う）
    let transpose = { chromatic: 0, octave: 0 };
    let beats = 4, beatType = 4;
    const clefs = {};
    const lens = [];
    kids(partEl, 'measure').forEach((mEl, mi) => {
      let cursor = 0, maxCursor = 0, lastStart = 0;
      const toQ = (d) => d / divisions;
      for (const el of mEl.children) {
        switch (el.name) {
          case 'attributes': {
            const dv = num(el, 'divisions');
            if (dv > 0) divisions = dv;
            const time = kid(el, 'time');
            if (time) {
              const b = txt(time, 'beats'), bt = num(time, 'beat-type');
              // "3+2" のような複合拍子は合計
              const bs = b.split('+').map((x) => parseFloat(x)).filter(Number.isFinite);
              if (bs.length && bt > 0) { beats = bs.reduce((a, c) => a + c, 0); beatType = bt; }
            }
            for (const c of kids(el, 'clef')) {
              const staff = c.attrs.number || '1';
              clefs[staff] = { sign: txt(c, 'sign'), line: num(c, 'line', 0), octaveChange: num(c, 'clef-octave-change', 0) };
            }
            const tr = kid(el, 'transpose');
            if (tr) transpose = { chromatic: num(tr, 'chromatic', 0), octave: num(tr, 'octave-change', 0) };
            break;
          }
          case 'note': {
            if (kid(el, 'grace')) { warnings.add('装飾音（小さな音符）は練習の対象から外しています。'); break; }
            if (kid(el, 'cue')) break;
            const dur = toQ(num(el, 'duration', 0));
            const isChord = !!kid(el, 'chord');
            const start = isChord ? lastStart : cursor;
            if (!isChord) { anchors.push({ pi, mi, relQ: cursor, at: el.start, div: divisions }); lastStart = cursor; cursor += dur; }
            maxCursor = Math.max(maxCursor, cursor);
            const voice = txt(el, 'voice') || '1';
            const staff = txt(el, 'staff') || '1';
            if (kid(el, 'rest')) break;
            const pitch = kid(el, 'pitch');
            if (!pitch) { if (kid(el, 'unpitched')) warnings.add('音の高さが決まっていない音符（打楽器など）は外しています。'); break; }
            const step = txt(pitch, 'step').toUpperCase();
            const midi = (num(pitch, 'octave', 4) + 1) * 12 + (STEP[step] ?? 0) + num(pitch, 'alter', 0) +
              transpose.chromatic + 12 * transpose.octave;
            const ties = kids(el, 'tie').map((t) => t.attrs.type);
            const tied = kids(kid(el, 'notations'), 'tied').map((t) => t.attrs.type);
            const tieStart = ties.includes('start') || tied.includes('start');
            const tieStop = ties.includes('stop') || tied.includes('stop');
            let lyric = '';
            const lyrics = kids(el, 'lyric');
            const ly = lyrics.find((l) => !l.attrs.number || l.attrs.number === '1') || lyrics[0];
            if (ly) {
              lyric = kids(ly, 'text').map((t) => t.text).join('');
              const syl = txt(ly, 'syllabic');
              if (syl === 'begin' || syl === 'middle') lyric += '-';
            }
            const noteDyn = el.attrs.dynamics ? dynOfNumber(parseFloat(el.attrs.dynamics)) : dyn;
            // 息継ぎ（V・カンマ）・区切り（//）・フェルマータ。息継ぎは「この音の終わり」で吸う
            let breath = false, fermata = false;
            for (const nt of kids(el, 'notations')) {
              for (const ar of kids(nt, 'articulations')) if (kid(ar, 'breath-mark') || kid(ar, 'caesura')) breath = true;
              if (kid(nt, 'fermata')) fermata = true;
            }
            if (breath) exprRaw.push({ type: 'breath', pi, part: pid, voice, mi, relQ: start + dur });
            if (fermata && !isChord) exprRaw.push({ type: 'fermata', pi, part: pid, voice, mi, relQ: start });
            rawNotes.push({ part: pid, pi, voice, staff, mi, relQ: start, durQ: dur, midi, tieStart, tieStop, lyric, chord: isChord, dyn: noteDyn, src: noteSrc(el) });
            break;
          }
          case 'backup': cursor -= toQ(num(el, 'duration', 0)); if (cursor < 0) cursor = 0; break;
          case 'forward': cursor += toQ(num(el, 'duration', 0)); maxCursor = Math.max(maxCursor, cursor); break;
          case 'direction': {
            const offset = toQ(num(el, 'offset', 0));
            for (const dt of kids(el, 'direction-type')) {
              for (const dy of kids(dt, 'dynamics')) {
                const names = dy.children.map((c) => c.name);
                const d = dynOf(names); if (d) dyn = d;
                const value = names.find((n) => n !== 'other-dynamics') || txt(dy, 'other-dynamics');
                if (value) exprRaw.push({ type: 'dyn', pi, part: pid, mi, relQ: cursor + offset, value });
              }
              for (const wg of kids(dt, 'wedge')) exprRaw.push({ type: 'wedge', pi, part: pid, mi, relQ: cursor + offset, wtype: wg.attrs.type, number: wg.attrs.number || '1' });
              for (const wd of kids(dt, 'words')) {
                const text = wd.text.replace(/\s+/g, ' ').trim();
                if (text && text.length <= 24) exprRaw.push({ type: 'words', pi, part: pid, mi, relQ: cursor + offset, text });
              }
              for (const rh of kids(dt, 'rehearsal')) {
                const label = rh.text.trim();
                if (label && !marksRaw.some((m) => m.mi === mi && m.label === label)) marksRaw.push({ mi, label });
              }
            }
            const snd = kid(el, 'sound');
            if (snd && snd.attrs.dynamics) dyn = dynOfNumber(parseFloat(snd.attrs.dynamics));
            let bpm = snd && snd.attrs.tempo ? parseFloat(snd.attrs.tempo) : NaN;
            if (!(bpm > 0)) {
              for (const dt of kids(el, 'direction-type')) {
                const met = kid(dt, 'metronome');
                if (met && kid(met, 'per-minute')) {
                  const pm = parseFloat(txt(met, 'per-minute'));
                  const unit = txt(met, 'beat-unit');
                  const dots = kids(met, 'beat-unit-dot').length;
                  const unitQ = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 }[unit] || 1;
                  if (pm > 0) bpm = pm * unitQ * (dots ? 1.5 : 1);
                }
              }
            }
            if (snd) checkJump(snd, warnings);
            if (bpm > 0 && pi === 0) tempoRaw.push({ mi, relQ: cursor + offset, bpm });
            else if (bpm > 0 && !tempoRaw.some((t) => t.mi === mi)) tempoRaw.push({ mi, relQ: cursor + offset, bpm, late: true });
            break;
          }
          case 'sound': {
            const bpm = parseFloat(el.attrs.tempo);
            if (bpm > 0 && (pi === 0 || !tempoRaw.some((t) => t.mi === mi))) tempoRaw.push({ mi, relQ: cursor, bpm });
            checkJump(el, warnings);
            break;
          }
          case 'barline': {
            if (kid(el, 'repeat') || kid(el, 'ending')) warnings.add('REPEAT');
            if (kid(el, 'segno') || kid(el, 'coda')) warnings.add('REPEAT');
            break;
          }
        }
      }
      lens[mi] = maxCursor;
      anchors.push({ pi, mi, relQ: maxCursor, at: mEl.innerEnd, div: divisions, end: true });
      if (pi === 0 || !measureMeta[mi]) {
        measureMeta[mi] = { number: mEl.attrs.number || String(mi + 1), beats, beatType, implicit: mEl.attrs.implicit === 'yes' };
      }
    });
    partMeasureLen[pi] = lens;
    clefByPart.set(pid, clefs);
    transposeByPart.set(pid, transpose);
  });

  // 小節の長さ = 全パートの最大（音符が無い小節は拍子どおり）
  const measureCount = Math.max(...partMeasureLen.map((l) => l.length));
  const measures = [];
  let q = 0;
  for (let mi = 0; mi < measureCount; mi++) {
    const meta = measureMeta[mi] || measureMeta[mi - 1] || { number: String(mi + 1), beats: 4, beatType: 4, implicit: false };
    const nominal = (meta.beats * 4) / meta.beatType;
    let len = Math.max(0, ...partMeasureLen.map((l) => l[mi] || 0));
    if (len < EPS) len = nominal;
    measures.push({ index: mi, number: meta.number, startQ: q, lengthQ: len, beats: meta.beats, beatType: meta.beatType, implicit: meta.implicit });
    q += len;
  }
  const totalQ = q;

  // テンポ地図
  tempoRaw.sort((a, b) => (a.mi - b.mi) || (a.relQ - b.relQ));
  const tempoMap = [];
  for (const t of tempoRaw) {
    const tq = measures[t.mi].startQ + t.relQ;
    if (tempoMap.length && Math.abs(tempoMap[tempoMap.length - 1].q - tq) < EPS) tempoMap[tempoMap.length - 1].bpm = t.bpm;
    else if (!tempoMap.length || tempoMap[tempoMap.length - 1].bpm !== t.bpm) tempoMap.push({ q: tq, bpm: t.bpm });
  }
  if (!tempoMap.length || tempoMap[0].q > EPS) {
    if (!tempoMap.length) warnings.add('楽譜にテンポの指定が無いため、♩=90 で再生します。');
    tempoMap.unshift({ q: 0, bpm: tempoMap.length ? tempoMap[0].bpm : 90 });
  }
  const timeline = makeTimeline(tempoMap);

  // 絶対位置へ・タイをつなぐ
  const abs = rawNotes.map((n) => ({ ...n, startQ: measures[n.mi].startQ + n.relQ }));
  abs.sort((a, b) => (a.pi - b.pi) || (a.voice < b.voice ? -1 : a.voice > b.voice ? 1 : 0) || (a.startQ - b.startQ) || (b.midi - a.midi));
  const open = new Map();
  const notes = [];
  for (const n of abs) {
    const key = n.part + '|' + n.voice + '|' + n.midi;
    const o = open.get(key);
    if (n.tieStop && o && Math.abs(o.startQ + o.durQ - n.startQ) < 1e-4) {
      o.durQ += n.durQ;
      o.srcEnd = n.src; // 息継ぎを書き戻すときは、タイの最後の音符に付ける
      if (!n.tieStart) open.delete(key);
      continue;
    }
    const note = {
      id: notes.length, part: n.part, voice: n.voice, staff: n.staff, midi: n.midi,
      startQ: n.startQ, durQ: n.durQ, measureIndex: n.mi, lyric: n.lyric, dyn: n.dyn, src: n.src, srcEnd: n.src,
    };
    notes.push(note);
    if (n.tieStart) open.set(key, note); else open.delete(key);
  }
  for (const n of notes) {
    n.startSec = timeline.qToSec(n.startQ);
    n.endSec = timeline.qToSec(n.startQ + n.durQ);
  }

  const tracks = buildTracks(notes, [...partInfo.values()].filter((p) => partEls.some((e) => e.attrs.id === p.id)), clefByPart, transposeByPart);

  const warnList = [];
  if (warnings.has('REPEAT')) warnList.push('反復記号（くり返し・1番2番かっこ・D.S.など）は展開していません。楽譜の上から順に1回ずつ練習します。');
  for (const w of warnings) if (w !== 'REPEAT') warnList.push(w);

  const marks = marksRaw.sort((a, b) => a.mi - b.mi).map((m) => ({ label: m.label, measure: measures[m.mi].number }));
  const expr = buildExpr(exprRaw, measures);
  const src = {
    anchors: anchors.map((a) => ({ part: partEls[a.pi].attrs.id, q: measures[a.mi].startQ + a.relQ, mi: a.mi, at: a.at, div: a.div, end: !!a.end })),
  };
  return { title, measures, totalQ, tempoMap, notes, tracks, marks, expr, src, warnings: warnList, timeline, totalSec: timeline.qToSec(totalQ) };
}

/** 書き戻し用: 音符の要素のどこに <notations> を足せるか */
function noteSrc(el) {
  const nt = kid(el, 'notations');
  const after = el.children.find((c) => c.name === 'lyric' || c.name === 'play' || c.name === 'listen');
  return { notationsAt: nt && !nt.selfClose ? nt.innerStart : null, insertAt: after ? after.start : el.innerEnd };
}

/** 楽譜の記号 → 絶対位置（q）。松葉（<  >）は始まりと終わりを組にする */
function buildExpr(raw, measures) {
  const out = { breaths: [], dyns: [], wedges: [], words: [], fermatas: [] };
  const open = new Map();
  const at = (r) => measures[r.mi].startQ + r.relQ;
  const sorted = [...raw].sort((a, b) => (a.pi - b.pi) || (at(a) - at(b)));
  for (const r of sorted) {
    const q = at(r);
    if (r.type === 'breath') out.breaths.push({ part: r.part, voice: r.voice, q });
    else if (r.type === 'fermata') out.fermatas.push({ part: r.part, voice: r.voice, q });
    else if (r.type === 'dyn') out.dyns.push({ part: r.part, q, value: r.value });
    else if (r.type === 'words') out.words.push({ part: r.part, q, text: r.text });
    else if (r.type === 'wedge') {
      const key = r.part + '|' + r.number;
      if (r.wtype === 'crescendo' || r.wtype === 'diminuendo') open.set(key, { part: r.part, startQ: q, kind: r.wtype === 'crescendo' ? 'cresc' : 'dim' });
      else if (r.wtype === 'stop' && open.has(key)) {
        const w = open.get(key);
        open.delete(key);
        if (q > w.startQ + 1e-6) out.wedges.push({ ...w, endQ: q });
      }
    }
  }
  const dedupe = (list, key) => { const seen = new Set(); return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  out.breaths = dedupe(out.breaths, (b) => `${b.part}|${b.voice}|${b.q.toFixed(4)}`);
  out.dyns = dedupe(out.dyns, (d) => `${d.part}|${d.q.toFixed(4)}|${d.value}`);
  return out;
}

/** <dynamics><pp/></dynamics> → 'p' / 'mf' / 'f'（ピアノの録音の3段） */
function dynOf(names) {
  for (const n of names) {
    if (/^(ppppp|pppp|ppp|pp|p|pf)$/.test(n)) return 'p';
    if (/^(mp|mf|n)$/.test(n)) return 'mf';
    if (/^(f|ff|fff|ffff|fffff|sf|sfz|sffz|sfp|sfpp|fp|rf|rfz|fz)$/.test(n)) return n === 'fp' || n === 'sfp' || n === 'sfpp' ? 'p' : 'f';
  }
  return null;
}
/** <sound dynamics="…">（forte＝90 に対する百分率）→ 3段 */
function dynOfNumber(pct) {
  if (!Number.isFinite(pct)) return 'mf';
  const vel = pct * 0.9;
  return vel < 58 ? 'p' : vel < 93 ? 'mf' : 'f';
}

function checkJump(snd, warnings) {
  for (const a of ['dacapo', 'dalsegno', 'segno', 'coda', 'tocoda', 'fine']) if (snd.attrs[a]) warnings.add('REPEAT');
}

/** テンポ地図から q ⇔ 秒（テンポ100%）の変換 */
export function makeTimeline(tempoMap) {
  const segs = [];
  let sec = 0;
  for (let i = 0; i < tempoMap.length; i++) {
    const t = tempoMap[i];
    segs.push({ q: t.q, sec, spq: 60 / t.bpm, bpm: t.bpm });
    if (i + 1 < tempoMap.length) sec += (tempoMap[i + 1].q - t.q) * (60 / t.bpm);
  }
  const findQ = (q) => { let s = segs[0]; for (const x of segs) { if (x.q <= q + EPS) s = x; else break; } return s; };
  const findS = (t) => { let s = segs[0]; for (const x of segs) { if (x.sec <= t + EPS) s = x; else break; } return s; };
  return {
    qToSec: (q) => { const s = findQ(q); return s.sec + (q - s.q) * s.spq; },
    secToQ: (t) => { const s = findS(t); return s.q + (t - s.sec) / s.spq; },
    bpmAt: (q) => findQ(q).bpm,
  };
}

// ---------------- パート×声部 → 練習トラック ----------------
const LABELS = [
  { key: 'M', re: /(mezzo|メゾ)/i, ja: 'メゾソプラノ' },
  { key: 'S', re: /(soprano|sopr|ソプラノ)/i, ja: 'ソプラノ' },
  { key: 'A', re: /(alto|アルト)/i, ja: 'アルト' },
  { key: 'T', re: /(tenor|テノール|テナー)/i, ja: 'テノール' },
  { key: 'Br', re: /(baritone|バリトン)/i, ja: 'バリトン' },
  { key: 'B', re: /(bass|basso|バス)/i, ja: 'バス' },
];
const PIANO_RE = /(piano|pf\.?$|pno|ピアノ|伴奏|keyboard|organ|オルガン)/i;

function labelsIn(name) {
  // 「Soprano Alto」「ソプラノ・アルト」→ 名前に出てくる順に [S, A]
  const found = [];
  let rest = name;
  for (const L of LABELS) {
    const m = L.re.exec(rest);
    if (m) {
      found.push({ L, at: m.index });
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length); // mezzo-soprano の二重取り防止
    }
  }
  // 「S.A.」「S/A」「T・B」のような略記
  if (!found.length && /^[SATB](\s*[.・/、,&+]?\s*[SATB])*\.?$/i.test(name.trim())) {
    name.toUpperCase().replace(/[^SATB]/g, '').split('').forEach((ch, i) => found.push({ L: LABELS.find((l) => l.key === ch), at: i }));
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.L);
}

function buildTracks(notes, parts, clefByPart, transposeByPart) {
  const tracks = [];
  for (const p of parts) {
    const pn = notes.filter((n) => n.part === p.id);
    if (!pn.length) continue;
    const voices = [...new Set(pn.map((n) => n.voice))].sort((a, b) => parseFloat(a) - parseFloat(b));
    const staves = [...new Set(pn.map((n) => n.staff))];
    const isPiano = PIANO_RE.test(p.name) || (!!p.keyboard && staves.length >= 2) || staves.length > 2; // 楽器情報だけで決めない（合唱パートがピアノ音色で書き出されることがある）
    const labels = labelsIn(p.name);
    const clefs = clefByPart.get(p.id) || {};
    const tenorClef = Object.values(clefs).find((c) => c.sign === 'G' && c.octaveChange === -1);
    if (isPiano) {
      // 伴奏は分けずに1本（和音ごと鳴らす。練習パートには選ばせない）
      const midis = pn.map((n) => n.midi).sort((a, b) => a - b);
      tracks.push({
        key: `${p.id}|*|piano`, part: p.id, partName: p.name, voice: '*', variant: '', name: p.name, guess: null, isPiano: true,
        noteIds: pn.map((n) => n.id), low: midis[0], high: midis[midis.length - 1], median: midis[midis.length >> 1], clefNote: '', transposeOct: 0,
      });
      continue;
    }
    voices.forEach((v, vi) => {
      const vn = pn.filter((n) => n.voice === v).sort((a, b) => a.startQ - b.startQ || b.midi - a.midi);
      // 同じ声部に和音（divisi）があれば「上の音」「下の音」に分ける
      const groups = [];
      for (const n of vn) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(g[0].startQ - n.startQ) < 1e-4) g.push(n); else groups.push([n]);
      }
      const hasChord = groups.some((g) => g.length > 1);
      const variants = hasChord ? [['上の音', (g) => g[0]], ['下の音', (g) => g[g.length - 1]]] : [['', (g) => g[0]]];
      for (const [suffix, pick] of variants) {
        const tn = groups.map(pick);
        const label = voices.length > 1 && labels.length >= voices.length ? labels[vi] : voices.length === 1 && labels.length === 1 ? labels[0] : null;
        let display = p.name;
        if (label) display = label.ja;
        else if (voices.length > 1) display = p.name + '（' + (vi === 0 ? '上の声部' : vi === voices.length - 1 ? '下の声部' : `声部${v}`) + '）';
        if (suffix) display += '・' + suffix;
        const midis = tn.map((n) => n.midi).sort((a, b) => a - b);
        const median = midis[Math.floor(midis.length / 2)];
        let guess = label ? label.key : null;
        if (!guess && !isPiano) guess = median >= 67 ? 'S' : median >= 62 ? 'A' : median >= 54 ? 'T' : 'B';
        tracks.push({
          key: `${p.id}|${v}|${suffix || '-'}`,
          part: p.id, partName: p.name, voice: v, variant: suffix,
          name: display, guess, isPiano,
          noteIds: tn.map((n) => n.id),
          low: midis[0], high: midis[midis.length - 1], median,
          clefNote: tenorClef ? 'ト音記号の8vb（1オクターブ下で歌う記号）' : '',
          transposeOct: (transposeByPart.get(p.id) || {}).octave || 0,
        });
      }
    });
  }
  // 合唱パートを先・伴奏を後に。合唱は高い順
  tracks.sort((a, b) => (a.isPiano - b.isPiano) || (b.median - a.median));
  return tracks;
}

/** トラックの音符（オクターブ補正込み） */
export function trackNotes(score, track, octaveShift = 0) {
  return track.noteIds.map((id) => {
    const n = score.notes[id];
    return octaveShift ? { ...n, midi: n.midi + 12 * octaveShift } : n;
  });
}
