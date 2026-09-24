// 「ここ！」を選ぶための計算（画面に依存しない。node の単体テストでも使う）
// 位置はすべて q（四分音符いくつ分）で持つ。秒への変換は timeline（テンポ地図）で行う。

const EPS = 1e-6;

/** 拍の目盛り（各小節の拍の頭） */
export function beatGrid(measures) {
  const grid = [];
  for (const m of measures) {
    const b = 4 / m.beatType;
    for (let k = 0; k * b < m.lengthQ - EPS; k++) grid.push({ q: m.startQ + k * b, measureIndex: m.index, beat: k + 1, down: k === 0 });
  }
  return grid;
}

/** 吸着先: 拍の頭 ＋ 音符の頭（重複なし・昇順） */
export function buildSnaps(measures, notes = []) {
  const qs = beatGrid(measures).map((g) => g.q);
  for (const n of notes) qs.push(n.startQ);
  const last = measures[measures.length - 1];
  if (last) qs.push(last.startQ + last.lengthQ);
  qs.sort((a, b) => a - b);
  const out = [];
  for (const q of qs) if (!out.length || q - out[out.length - 1] > 1e-4) out.push(q);
  return out;
}

/** いちばん近い吸着先 */
export function snapQ(snaps, q) {
  if (!snaps.length) return q;
  let lo = 0, hi = snaps.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (snaps[m] <= q) lo = m; else hi = m; }
  return Math.abs(snaps[lo] - q) <= Math.abs(snaps[hi] - q) ? snaps[lo] : snaps[hi];
}

export function measureIndexAt(measures, q) {
  let lo = 0, hi = measures.length - 1;
  if (q < measures[0].startQ) return 0;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (measures[m].startQ <= q + EPS) lo = m; else hi = m - 1; }
  return lo;
}

/** 1拍前／1拍後の拍の頭（いまが拍の途中なら、その拍の頭／次の拍の頭） */
export function stepBeat(measures, q, dir) {
  const grid = beatGrid(measures).map((g) => g.q);
  const end = measures[measures.length - 1].startQ + measures[measures.length - 1].lengthQ;
  grid.push(end);
  if (dir > 0) { for (const g of grid) if (g > q + EPS) return g; return end; }
  for (let i = grid.length - 1; i >= 0; i--) if (grid[i] < q - EPS) return grid[i];
  return grid[0];
}

/** 1小節前／1小節後の小節の頭 */
export function stepMeasure(measures, q, dir) {
  const end = measures[measures.length - 1].startQ + measures[measures.length - 1].lengthQ;
  if (dir > 0) { for (const m of measures) if (m.startQ > q + EPS) return m.startQ; return end; }
  for (let i = measures.length - 1; i >= 0; i--) if (measures[i].startQ < q - EPS) return measures[i].startQ;
  return measures[0].startQ;
}

/** 「12小節3拍目」「12小節」（小節の頭ならこちら） */
export function posLabel(measures, q) {
  const mi = measureIndexAt(measures, q), m = measures[mi];
  const b = 4 / m.beatType;
  const rel = q - m.startQ;
  if (rel < EPS) return `${m.number}小節`;
  const beat = rel / b + 1;
  const whole = Math.abs(beat - Math.round(beat)) < 1e-3;
  if (whole) return `${m.number}小節${Math.round(beat)}拍目`;
  const frac = beat - Math.floor(beat);
  return `${m.number}小節${Math.floor(beat)}拍目の${Math.abs(frac - 0.5) < 1e-3 ? '裏' : '途中'}`;
}

/** 範囲の終わりの言い方（小節の頭で終わるなら「前の小節の終わり」） */
export function endLabel(measures, q) {
  const total = measures[measures.length - 1].startQ + measures[measures.length - 1].lengthQ;
  if (q >= total - EPS) return `${measures[measures.length - 1].number}小節（最後）`;
  const mi = measureIndexAt(measures, q);
  if (Math.abs(measures[mi].startQ - q) < EPS && mi > 0) return `${measures[mi - 1].number}小節の終わり`;
  return posLabel(measures, q) + 'まで';
}

/** 「ここから」「ここまで」: 範囲を作り直す。逆向きになったら、もう片方を曲の端に戻す */
export function setRangeEdge(range, which, q, totalQ, minLen = 0.5) {
  let { startQ, endQ } = range;
  q = Math.max(0, Math.min(totalQ, q));
  if (which === 'start') { startQ = Math.min(q, totalQ - minLen); if (endQ - startQ < minLen) endQ = totalQ; }
  else { endQ = Math.max(q, minLen); if (endQ - startQ < minLen) startQ = 0; }
  return { startQ, endQ };
}

/** 端をドラッグしているとき: もう片方を越えないように止める */
export function dragRangeEdge(range, which, q, totalQ, minLen = 0.5) {
  q = Math.max(0, Math.min(totalQ, q));
  if (which === 'start') return { startQ: Math.min(q, range.endQ - minLen), endQ: range.endQ };
  return { startQ: range.startQ, endQ: Math.max(q, range.startQ + minLen) };
}

/**
 * 交互練習の区切り。途中の拍から始めても、最初の区切りはその小節から数えて len 小節目の終わりまで。
 * @returns [{ startQ, endQ, fromIdx, toIdx }]
 */
export function segmentsFrom(measures, startQ, endQ, len) {
  const segs = [];
  let q = startQ;
  while (q < endQ - EPS) {
    const a = measureIndexAt(measures, q);
    const bIdx = Math.min(measures.length - 1, a + len - 1);
    const mEnd = measures[bIdx].startQ + measures[bIdx].lengthQ;
    const e = Math.min(endQ, mEnd);
    segs.push({ startQ: q, endQ: e, fromIdx: a, toIdx: measureIndexAt(measures, e - 1e-3) });
    q = e;
  }
  return segs;
}

/**
 * 始める位置の前に1小節ぶんのカウント（拍の目盛りにそろえる。小節の頭にはアクセント）
 * @returns [{ q, accent }]（q は開始位置より前。曲の頭より前ならマイナスになる）
 */
export function countInBeats(measures, q0) {
  const mi = measureIndexAt(measures, q0), m = measures[mi];
  const b = 4 / m.beatType, n = Math.max(1, Math.round(m.beats)), barQ = n * b;
  const out = [];
  for (let k = n; k >= 1; k--) {
    const q = q0 - k * b;
    const rel = (((q - m.startQ) % barQ) + barQ) % barQ;
    out.push({ q, accent: rel < EPS || barQ - rel < EPS });
  }
  return out;
}

/** 指を離したあとの慣性（iOS のスクロールに近い減速）。v は px/ms */
export class Inertia {
  constructor(v, tau = 325, minV = 0.02) { this.v = v; this.tau = tau; this.minV = minV; }
  get done() { return Math.abs(this.v) < this.minV; }
  /** dt(ms) 進めて、動いた距離(px)を返す */
  step(dt) {
    if (this.done) return 0;
    const k = Math.exp(-dt / this.tau);
    const dx = this.v * this.tau * (1 - k); // 減速しながら進んだ距離（積分）
    this.v *= k;
    return dx;
  }
  /** このまま止まるまでに進む距離 */
  get distance() { return this.v * this.tau; }
}

/** 指の最後の動き（100ms 以内）から速さを求める */
export function releaseVelocity(samples, now) {
  const recent = samples.filter((s) => now - s.t <= 100);
  if (recent.length < 2) return 0;
  const a = recent[0], b = recent[recent.length - 1];
  return b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
}

// ---------------- 歌詞 ----------------
const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
/** 検索用にそろえる: 全角半角・カタカナ→ひらがな・空白や記号を除く・英字は小文字 */
export function normLyric(s) {
  return kataToHira(String(s || '').normalize('NFKC')).toLowerCase().replace(/[\s\-‐―・、。，．,.!?！？「」『』（）()〜~_]/g, '');
}

const CJK = /[぀-ヿ㐀-鿿]/;
/** 音符の歌詞をつないで読める文字列にする（日本語はつなげ、英語は空白で区切る） */
export function joinLyrics(syls) {
  let out = '';
  for (let i = 0; i < syls.length; i++) {
    const cur = syls[i];
    if (!cur) continue;
    const prev = syls[i - 1] || '';
    const glue = !out || prev.endsWith('-') || (CJK.test(out.slice(-1)) && CJK.test(cur[0]));
    out += (glue ? '' : ' ') + cur.replace(/-$/, '');
  }
  return out;
}

/**
 * 歌詞で検索
 * @param tracks [[note…], …]（先に書いたトラックを優先。同じ位置の重複はまとめる）
 * @returns [{ q, measureIndex, text }]
 */
export function searchLyrics(tracks, query, limit = 8) {
  const nq = normLyric(query);
  if (!nq) return [];
  const hits = [];
  for (const notes of tracks) {
    const ns = notes.filter((n) => n.lyric);
    let str = '';
    const owner = [];
    ns.forEach((n, i) => { const t = normLyric(n.lyric); str += t; for (let k = 0; k < t.length; k++) owner.push(i); });
    let from = 0, at;
    while ((at = str.indexOf(nq, from)) >= 0) {
      const i = owner[at];
      const n = ns[i];
      if (!hits.some((h) => Math.abs(h.q - n.startQ) < 1e-3)) {
        const endI = owner[Math.min(owner.length - 1, at + nq.length - 1)];
        const ctx = joinLyrics(ns.slice(Math.max(0, i - 3), Math.min(ns.length, endI + 5)).map((x) => x.lyric));
        hits.push({ q: n.startQ, measureIndex: n.measureIndex, text: ctx });
      }
      from = at + 1;
    }
  }
  hits.sort((a, b) => a.q - b.q);
  return hits.slice(0, limit);
}
