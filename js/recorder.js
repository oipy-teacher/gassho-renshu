// 聞き直し用の録音（声だけ）。マイクの音を 16kHz のモノラルにして、4bit の IMA-ADPCM で 1/4 に縮める（約 8KB/秒）。
// 保存先は端末の中（IndexedDB）だけ。外部には送らない。
// 楽譜の時間との対応は「録音の最初のサンプルが入った時刻」で持つ（音程の線と同じ時計）。

export const REC_RATE = 16000;

// ---------------- IMA-ADPCM ----------------
const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IDX = [-1, -1, -1, -1, 2, 4, 6, 8];

/** Int16 → ADPCM（2サンプルで1バイト） */
export function adpcmEncode(pcm) {
  const out = new Uint8Array(Math.ceil(pcm.length / 2));
  let pred = 0, index = 0;
  for (let i = 0; i < pcm.length; i++) {
    const step = STEP[index];
    let diff = pcm[i] - pred, code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    let delta = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; delta += step; }
    if (diff >= step >> 1) { code |= 2; diff -= step >> 1; delta += step >> 1; }
    if (diff >= step >> 2) { code |= 1; delta += step >> 2; }
    pred += code & 8 ? -delta : delta;
    pred = Math.max(-32768, Math.min(32767, pred));
    index = Math.max(0, Math.min(88, index + IDX[code & 7]));
    if (i & 1) out[i >> 1] |= code << 4; else out[i >> 1] = code;
  }
  return out;
}

/** ADPCM → Float32（-1〜1） */
export function adpcmDecode(bytes, n) {
  const out = new Float32Array(n);
  let pred = 0, index = 0;
  for (let i = 0; i < n; i++) {
    const code = i & 1 ? bytes[i >> 1] >> 4 : bytes[i >> 1] & 15;
    const step = STEP[index];
    let delta = step >> 3;
    if (code & 4) delta += step;
    if (code & 2) delta += step >> 1;
    if (code & 1) delta += step >> 2;
    pred += code & 8 ? -delta : delta;
    pred = Math.max(-32768, Math.min(32767, pred));
    index = Math.max(0, Math.min(88, index + IDX[code & 7]));
    out[i] = pred / 32768;
  }
  return out;
}

// ---------------- 録音（1区切り分） ----------------
/** マイクの生データ（48kHz 等）を 16kHz に落として貯める */
export class ClipRecorder {
  constructor(inRate, firstTime) {
    this.inRate = inRate;
    this.factor = Math.max(1, Math.round(inRate / REC_RATE));
    this.sr = inRate / this.factor;
    // 折り返し防止の2次ローパス（2段）
    const fc = this.sr * 0.45, w = (2 * Math.PI * fc) / inRate, q = Math.SQRT1_2;
    const alpha = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + alpha;
    this.k = { b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
    this.st = [[0, 0, 0, 0], [0, 0, 0, 0]];
    this.t0 = firstTime;
    this.chunks = [];
    this.buf = new Int16Array(4096);
    this.len = 0;
    this.phase = 0;
    this.total = 0;
  }
  lp(x, s) {
    const k = this.k;
    const y = k.b0 * x + k.b1 * s[0] + k.b2 * s[1] - k.a1 * s[2] - k.a2 * s[3];
    s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
    return y;
  }
  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const v = this.lp(this.lp(chunk[i], this.st[0]), this.st[1]);
      if (this.phase++ % this.factor) continue;
      this.buf[this.len++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      if (this.len === this.buf.length) { this.chunks.push(this.buf); this.buf = new Int16Array(4096); this.len = 0; }
    }
  }
  /** @returns { tStart, sr, pcm: Int16Array } */
  finish() {
    const n = this.chunks.length * 4096 + this.len;
    const pcm = new Int16Array(n);
    let o = 0;
    for (const c of this.chunks) { pcm.set(c, o); o += c.length; }
    pcm.set(this.buf.subarray(0, this.len), o);
    return { tStart: this.t0, sr: this.sr, pcm };
  }
}

// ---------------- 保存する形 ----------------
/**
 * 1回分の練習の記録（声・音程の線・採点）
 * 時刻はすべて「タイミングの補正（ユーザー設定）を入れる前」の楽譜の秒で持つ。聞き直すときに、その時点の補正値を当てる。
 */
export function makeTake({ scoreId, trackKey, trackName, mode, tempo, rangeText, summary, clips, frames, userOffsetMs, expr = [], now = Date.now() }) {
  const packed = clips.map((c) => ({ sec0: c.sec0, r: c.r, sr: c.sr, n: c.pcm.length, data: adpcmEncode(c.pcm) }));
  const fs = [...frames].sort((a, b) => a.sec - b.sec);
  const sec = Float32Array.from(fs, (f) => f.sec);
  const midi = Float32Array.from(fs, (f) => (f.midi == null ? NaN : f.midi));
  const results = summary.notes.filter((x) => x.status !== 'nodata').map((x) => [x.id, x.grade || '', x.status, Number.isFinite(x.cents) ? Math.round(x.cents) : null, x.octave || 0, Math.round(x.score)]);
  const take = {
    id: `${scoreId}|${now}`, scoreId, trackKey, trackName, createdAt: now, mode, tempo, rangeText,
    score: summary.score, comments: summary.comments, results, frames: { sec, midi }, clips: packed, userOffsetMs,
    expr, // 息継ぎ・強弱の判定 [{kind, ok, sec, wedge?, value?, from?, to?}]（聞き直しで同じ演出を出す）
  };
  take.sizeBytes = packed.reduce((a, c) => a + c.data.length, 0) + sec.byteLength + midi.byteLength;
  take.startSec = Math.min(...packed.map((c) => c.sec0), ...(sec.length ? [sec[0]] : []));
  take.endSec = Math.max(...packed.map((c) => c.sec0 + (c.n / c.sr) * c.r), ...(sec.length ? [sec[sec.length - 1]] : []));
  return take;
}

/** 聞き直すときの声の線（いまの「タイミングの補正」を当てる） */
export function reviewFrames(take, userOffsetMs) {
  const out = [];
  const shift = (userOffsetMs / 1000) * (take.tempo || 1);
  for (let i = 0; i < take.frames.sec.length; i++) {
    const m = take.frames.midi[i];
    out.push({ sec: take.frames.sec[i] - shift, midi: Number.isNaN(m) ? null : m });
  }
  return out;
}

/** 聞き直すときの、録音の各区切りの位置（楽譜の秒） */
export function reviewClips(take, userOffsetMs) {
  const shift = (userOffsetMs / 1000) * (take.tempo || 1);
  return take.clips.map((c) => ({ ...c, sec0: c.sec0 - shift, sec1: c.sec0 - shift + (c.n / c.sr) * c.r }));
}

/** 楽譜ごとに新しい順で max 件だけ残す: 消す id の一覧 */
export function takesToPrune(takes, scoreId, max = 5) {
  return takes.filter((t) => t.scoreId === scoreId).sort((a, b) => b.createdAt - a.createdAt).slice(max).map((t) => t.id);
}
