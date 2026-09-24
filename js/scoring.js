// 採点と講評（AIのAPIは使わず、決まったルールで日本語の文を作る）
// 入力の frames は「楽譜の秒（テンポ100%基準）」に直したもの: { sec, f0, db }

import { QUIET_DB, TOO_QUIET_DB, midiToHz } from './pitch.js';

export const GRADE = {
  great: '◎', good: '○', fair: '△', miss: '×', unsung: '－',
};

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 音程のずれ（セント）から音程点 */
export function pitchPoints(absCents) {
  const pts = [[0, 100], [10, 100], [25, 90], [50, 70], [100, 30], [200, 0]];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (absCents <= x1) return y0 + ((absCents - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 0;
}

export function gradeOf(absCents) {
  return absCents <= 25 ? GRADE.great : absCents <= 50 ? GRADE.good : absCents <= 100 ? GRADE.fair : GRADE.miss;
}

/** 1音ぶんの評価 */
export function evaluateNote(note, frames, r = 1, fromIdx = 0, prev = null) {
  const start = note.startSec, end = note.endSec;
  const durReal = (end - start) / r;
  const head = Math.min(0.08, durReal * 0.3) * r;
  const tail = Math.min(0.03, durReal * 0.1) * r;
  const target = midiToHz(note.midi);
  let lo = start + head, hi = end - tail;
  // 範囲の frames を探す（frames は sec 昇順）
  let i = fromIdx;
  while (i < frames.length && frames[i].sec < start - 0.25 * r) i++;
  const firstIdx = i;
  const win = [];
  for (let j = i; j < frames.length && frames[j].sec < end; j++) if (frames[j].sec >= lo && frames[j].sec <= hi) win.push(frames[j]);
  if (win.length < 2) { // ごく短い音
    win.length = 0;
    for (let j = i; j < frames.length && frames[j].sec < end; j++) if (frames[j].sec >= start) win.push(frames[j]);
  }
  const res = { id: note.id, midi: note.midi, measureIndex: note.measureIndex, startSec: start, endSec: end, weight: Math.min(durReal, 2) + 0.25 };
  if (!win.length) return { ...res, status: 'nodata', nextIdx: firstIdx };

  const voiced = win.filter((f) => f.f0 > 0 && f.db > QUIET_DB);
  res.voicedRatio = voiced.length / win.length;
  res.levelDb = median(win.map((f) => f.db));
  if (res.voicedRatio < 0.25 || voiced.length < 2) {
    return { ...res, status: 'unsung', grade: GRADE.unsung, score: 0, nextIdx: firstIdx };
  }
  const raw = voiced.map((f) => 1200 * Math.log2(f.f0 / target));
  const ks = raw.map((c) => Math.round(c / 1200));
  const kCount = new Map();
  for (const k of ks) kCount.set(k, (kCount.get(k) || 0) + 1);
  let kMode = 0, kBest = -1;
  for (const [k, c] of kCount) if (c > kBest || (c === kBest && k === 0)) { kMode = k; kBest = c; }
  const folded = raw.map((c, idx) => c - 1200 * ks[idx]);
  const dev = median(folded);
  const mad = median(folded.map((c) => Math.abs(c - dev)));
  const sd = 1.4826 * mad;
  const octave = kMode !== 0 && kBest / voiced.length >= 0.5 ? kMode : 0;

  // 入りのタイミング: 休符のあと、または音が変わる所だけ測る（同じ高さの連続は区切りが声に出ないため）
  let onsetMs = null;
  const leap = prev ? Math.abs(note.midi - prev.midi) : 99;
  const entrance = !prev || start - prev.endSec > 0.1;
  if (entrance || leap >= 1) {
    const tol = entrance || leap >= 2 ? 100 : 50; // 半音の動きは前の音と取り違えないよう狭く
    const searchEnd = start + Math.min(0.6 * r, end - start);
    for (let j = firstIdx; j < frames.length && frames[j].sec <= searchEnd; j++) {
      const f = frames[j];
      if (f.sec < start - 0.2 * r || !(f.f0 > 0) || f.db <= QUIET_DB) continue;
      const c = 1200 * Math.log2(f.f0 / target);
      if (Math.abs(c - 1200 * Math.round(c / 1200)) < tol) { onsetMs = ((f.sec - start) / r) * 1000; break; }
    }
  }

  let score = pitchPoints(Math.abs(dev));
  if (sd > 30) score -= Math.min(15, (sd - 30) * 0.5);
  if (octave) score *= 0.92;
  score *= Math.min(1, 0.4 + (0.6 * res.voicedRatio) / 0.85);
  return {
    ...res, status: 'sung', cents: dev, sd, octave, onsetMs,
    grade: gradeOf(Math.abs(dev)), score: Math.max(0, Math.min(100, score)), nextIdx: firstIdx,
  };
}

/** 音符ごとの評価（前の音との関係＝跳躍・休符の後も付ける） */
export function evaluateNotes(notes, frames, r = 1) {
  const sorted = [...frames].sort((a, b) => a.sec - b.sec);
  const ordered = [...notes].sort((a, b) => a.startSec - b.startSec);
  const results = [];
  let idx = 0;
  for (let k = 0; k < ordered.length; k++) {
    const prev = ordered[k - 1];
    const ev = evaluateNote(ordered[k], sorted, r, idx, prev);
    idx = ev.nextIdx;
    ev.leap = prev ? Math.abs(ordered[k].midi - prev.midi) : 0;
    ev.entrance = !prev || ordered[k].startSec - prev.endSec > 0.1;
    results.push(ev);
  }
  return results;
}

/**
 * 区間の採点
 * @param notes 採点する音符（startSec/endSec/midi/measureIndex）
 * @param frames 声の推定結果
 * @param opts { tempoFactor, measures, allNotes（トラック全体の音符。高い/低いの判定に使う） }
 */
export function evaluate(notes, frames, opts = {}) {
  return summarize(evaluateNotes(notes, frames, opts.tempoFactor || 1), opts);
}

/** 音符ごとの評価をまとめて、点数・苦手な小節・講評を作る（区間ごとの結果をつなげて使ってもよい） */
export function summarize(results, opts = {}) {
  const measures = opts.measures || [];
  results = [...results].sort((a, b) => a.startSec - b.startSec);
  const scored = results.filter((x) => x.status !== 'nodata');
  const sung = scored.filter((x) => x.status === 'sung');
  const wsum = scored.reduce((a, x) => a + x.weight, 0);
  const total = wsum ? scored.reduce((a, x) => a + x.weight * x.score, 0) / wsum : 0;

  // 小節ごと
  const byMeasure = new Map();
  for (const x of scored) {
    if (!byMeasure.has(x.measureIndex)) byMeasure.set(x.measureIndex, []);
    byMeasure.get(x.measureIndex).push(x);
  }
  const measureScores = [...byMeasure.entries()].sort((a, b) => a[0] - b[0]).map(([mi, xs]) => {
    const w = xs.reduce((a, x) => a + x.weight, 0);
    return { measureIndex: mi, number: measures[mi] ? measures[mi].number : String(mi + 1), score: xs.reduce((a, x) => a + x.weight * x.score, 0) / w, notes: xs };
  });

  const all = opts.allNotes && opts.allNotes.length ? opts.allNotes : results;
  const midisSorted = all.map((n) => n.midi).sort((a, b) => a - b);
  const pct = (p) => midisSorted[Math.min(midisSorted.length - 1, Math.floor(p * midisSorted.length))];
  const highLine = pct(0.7), lowLine = pct(0.3);

  // 苦手な小節（70点未満）を、となり同士まとめる
  const weak = [];
  for (const m of measureScores) {
    if (m.score >= 70) continue;
    const last = weak[weak.length - 1];
    if (last && m.measureIndex - last.toIdx <= 1) { last.toIdx = m.measureIndex; last.items.push(m); }
    else weak.push({ fromIdx: m.measureIndex, toIdx: m.measureIndex, items: [m] });
  }
  for (const w of weak) {
    const ns = w.items.flatMap((m) => m.notes);
    const wt = ns.reduce((a, x) => a + x.weight, 0);
    w.score = ns.reduce((a, x) => a + x.weight * x.score, 0) / wt;
    w.label = rangeLabel(measures, w.fromIdx, w.toIdx);
    w.reason = weakReason(ns, highLine, lowLine);
  }
  weak.sort((a, b) => a.score - b.score);

  const meanCents = sung.length ? sung.reduce((a, x) => a + x.weight * x.cents, 0) / sung.reduce((a, x) => a + x.weight, 0) : NaN;
  const onsets = results.filter((x) => x.status === 'sung' && x.onsetMs !== null && (x.entrance || x.leap >= 1)).map((x) => x.onsetMs);
  const onsetMedian = onsets.length >= 2 ? median(onsets) : NaN;
  const octaveShare = sung.length ? sung.filter((x) => x.octave).length / sung.length : 0;
  const shakyShare = sung.length ? sung.filter((x) => x.sd > 35).length / sung.length : 0;
  const levelMedian = median(scored.map((x) => x.levelDb).filter(Number.isFinite));
  const unsungShare = scored.length ? scored.filter((x) => x.status === 'unsung').length / scored.length : 0;

  // 点数は70点以上でも、まとまって低め／高めの小節（平均±20セント以上）
  const biased = [];
  for (const m of measureScores) {
    const xs = m.notes.filter((x) => x.status === 'sung');
    if (!xs.length) continue;
    const c = xs.reduce((a, x) => a + x.weight * x.cents, 0) / xs.reduce((a, x) => a + x.weight, 0);
    const sign = c <= -20 ? -1 : c >= 20 ? 1 : 0;
    if (!sign) continue;
    const last = biased[biased.length - 1];
    if (last && last.sign === sign && m.measureIndex - last.toIdx <= 1) { last.toIdx = m.measureIndex; last.xs.push(...xs); }
    else biased.push({ sign, fromIdx: m.measureIndex, toIdx: m.measureIndex, xs: [...xs] });
  }
  for (const b of biased) {
    b.cents = b.xs.reduce((a, x) => a + x.weight * x.cents, 0) / b.xs.reduce((a, x) => a + x.weight, 0);
    b.label = rangeLabel(measures, b.fromIdx, b.toIdx);
    delete b.xs;
  }
  biased.sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
  const weakSet = new Set(weak.flatMap((w) => w.items.map((m) => m.measureIndex)));
  const outside = sung.filter((x) => !weakSet.has(x.measureIndex));
  const meanCentsOutsideWeak = outside.length ? outside.reduce((a, x) => a + x.weight * x.cents, 0) / outside.reduce((a, x) => a + x.weight, 0) : NaN;
  const octs = sung.filter((x) => x.octave).map((x) => x.octave);
  const octaveDir = octs.length ? Math.sign(median(octs)) : 0;
  const summary = {
    score: Math.round(total), notes: results, measureScores, weak, biased,
    meanCents, meanCentsOutsideWeak, onsetMedian, octaveShare, octaveDir, shakyShare, levelMedian, unsungShare,
    counted: scored.length,
    gradeCount: countGrades(scored),
  };
  summary.comments = buildComments(summary, measures, results);
  return summary;
}

function countGrades(xs) {
  const c = {};
  for (const x of xs) c[x.grade] = (c[x.grade] || 0) + 1;
  c.octave = xs.filter((x) => x.octave).length;
  return c;
}

export function rangeLabel(measures, a, b) {
  const na = measures[a] ? measures[a].number : String(a + 1);
  const nb = measures[b] ? measures[b].number : String(b + 1);
  return a === b ? `${na}小節` : `${na}〜${nb}小節`;
}

function weakReason(ns, highLine, lowLine) {
  const sung = ns.filter((x) => x.status === 'sung');
  if (!sung.length || sung.length < ns.length * 0.5) return { key: 'unsung', text: '声が拾えていない所があるようです' };
  const w = sung.reduce((a, x) => a + x.weight, 0);
  const mean = sung.reduce((a, x) => a + x.weight * x.cents, 0) / w;
  const avgMidi = sung.reduce((a, x) => a + x.weight * x.midi, 0) / w;
  const leapMiss = sung.filter((x) => x.leap >= 5 && Math.abs(x.cents) > 50).length;
  const shaky = sung.filter((x) => x.sd > 35).length / sung.length;
  if (mean <= -30 && avgMidi >= highLine) return { key: 'high-flat', text: '高い音で下がりやすいようです' };
  if (mean >= 30 && avgMidi <= lowLine) return { key: 'low-sharp', text: '低い音で上ずりやすいようです' };
  if (leapMiss >= 1 && leapMiss >= sung.length * 0.3) return { key: 'leap', text: '音が大きく跳ぶところで届きにくいようです' };
  if (mean <= -30) return { key: 'flat', text: '低めになりやすいようです' };
  if (mean >= 30) return { key: 'sharp', text: '高めになりやすいようです' };
  if (shaky >= 0.4) return { key: 'shaky', text: '音が揺れやすいようです' };
  return { key: 'mixed', text: '音程がずれやすいようです' };
}

const signed = (c) => (c > 0 ? '+' : c < 0 ? '−' : '±') + Math.round(Math.abs(c));

export function buildComments(s, measures, results) {
  const out = [];
  if (!s.counted) return ['まだ歌った記録がありません。'];
  if (s.score === 0 || s.unsungShare >= 0.9) {
    out.push('声が拾えませんでした。iPadに少し近づいて、もう一度歌ってみましょう。');
    if (Number.isFinite(s.levelMedian) && s.levelMedian < TOO_QUIET_DB) out.push('声が小さすぎて音程が拾えないようです。大きな声でなくて大丈夫なので、iPadのマイクの近く（30cmくらい）で歌ってみましょう。');
    return out;
  }
  if (s.score >= 90) out.push(`${s.score}点。とても安定しています。この調子です。`);
  else if (s.score >= 75) out.push(`${s.score}点。よく歌えています。あと少し整えると、さらに良くなりそうです。`);
  else if (s.score >= 55) out.push(`${s.score}点。音の流れはつかめてきています。気になる所を1つずつ直していきましょう。`);
  else out.push(`${s.score}点。まずはお手本をよく聞いて、1音ずつ合わせていきましょう。`);

  if (s.octaveShare >= 0.5) {
    const dir = s.octaveDir < 0 ? '下' : '上';
    out.push(`1オクターブ${dir}で歌っていますが、音の動きは合っています。この形は大きく減点していません。どの高さで歌うかは、パートの先生に確認してみましょう。`);
  }
  // 全体の傾向: 苦手な小節だけが原因なら、場所の講評に任せる
  const globalBias = Number.isFinite(s.meanCents) && Math.abs(s.meanCents) >= 15 && !(Math.abs(s.meanCentsOutsideWeak) < 15);
  if (globalBias) {
    const deg = Math.abs(s.meanCents) < 40 ? '少し' : '';
    if (s.meanCents < 0) out.push(`全体的に${deg}低めのようです（平均${signed(s.meanCents)}セント）。音の上の方をねらうつもりで歌ってみましょう。`);
    else out.push(`全体的に${deg}高めのようです（平均${signed(s.meanCents)}セント）。肩の力を抜いて、音の真ん中をねらってみましょう。`);
  }
  for (const w of s.weak.slice(0, 2)) {
    out.push(`${w.label}は${w.reason.text}。ここだけくり返してみましょう。`);
  }
  if (!globalBias && s.biased && s.biased.length) {
    // 全体では目立たないが、一部の小節だけ低め／高め
    const b = s.biased.find((x) => !s.weak.some((w) => w.fromIdx <= x.toIdx && x.fromIdx <= w.toIdx));
    if (b) out.push(`${b.label}は少し${b.sign < 0 ? '低め' : '高め'}のようです（平均${signed(b.cents)}セント）。${b.sign < 0 ? '音の上の方をねらってみましょう。' : '力を抜いて、音の真ん中をねらってみましょう。'}`);
  }
  if (Number.isFinite(s.onsetMedian)) {
    if (s.onsetMedian >= 150) out.push(`入りが遅れがちです（平均${(s.onsetMedian / 1000).toFixed(1)}秒）。カウントの最後の拍で息を吸っておきましょう。`);
    else if (s.onsetMedian <= -120) out.push(`入りが少し早めです（平均${(Math.abs(s.onsetMedian) / 1000).toFixed(1)}秒）。クリックをよく聞いてから歌い出しましょう。`);
  }
  if (s.shakyShare >= 0.3 && !s.weak.some((w) => w.reason.key === 'shaky')) out.push('のばす音が揺れやすいようです。息を細く一定に流すと安定します。');
  if (s.unsungShare >= 0.2 && Number.isFinite(s.levelMedian) && s.levelMedian < TOO_QUIET_DB) out.push('声が小さくて拾えない所がありました。iPadに少し近づくと、きちんと採点できます。');
  return out.slice(0, 5);
}
