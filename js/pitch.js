// 音程検出（YIN）。マイクの生データ（48kHz等）→ 約16kHzに間引き → 10msごとに基本周波数を推定する。
// ブラウザ（AudioWorkletから受け取ったデータ）とnodeの単体テストで同じコードを使う。

export const PITCH_MIN_HZ = 70;
export const PITCH_MAX_HZ = 1100;
export const QUIET_DB = -58;      // これより小さい音は「声として扱わない」
export const TOO_QUIET_DB = -50;  // 歌う区間でこれより小さい状態が続いたら「声が小さすぎ」表示

export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** 2次のローパス（間引きの前の折り返し防止） */
class Biquad {
  constructor(sr, fc) {
    const w = (2 * Math.PI * fc) / sr, q = Math.SQRT1_2;
    const alpha = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + alpha;
    this.b0 = (1 - cw) / 2 / a0; this.b1 = (1 - cw) / a0; this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/**
 * YIN による基本周波数推定
 * @param {Float32Array} x 解析窓（長さ = W + tauMax）
 * @returns {{f0:number, ap:number}} f0=0 は無声。ap は非周期性（小さいほど澄んだ音）
 */
export function yin(x, sr, fmin = PITCH_MIN_HZ, fmax = PITCH_MAX_HZ, threshold = 0.15, scratch) {
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.min(Math.floor(sr / fmin), Math.floor(x.length / 2));
  const W = x.length - tauMax;
  const need = 2 * (tauMax + 2);
  const buf = scratch && scratch.length >= need ? scratch : new Float32Array(need);
  const d = buf.subarray(0, tauMax + 2);         // 累積平均で正規化した差分関数
  const raw = buf.subarray(tauMax + 2, need);     // 生の差分関数（補間に使う）
  d[0] = 1; raw[0] = 0;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < W; j++) { const diff = x[j] - x[j + tau]; s += diff * diff; }
    raw[tau] = s;
    running += s;
    d[tau] = running > 0 ? (s * tau) / running : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (d[t] < threshold) {
      while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
      tau = t; break;
    }
  }
  if (tau < 0) {
    // しきい値を下回らなかった: いちばん深い谷を仮に採る（あとで ap で弾く）
    let best = tauMin;
    for (let t = tauMin; t <= tauMax; t++) if (d[t] < d[best]) best = t;
    tau = best;
  }
  const ap = d[tau];
  // 放物線補間（YINの原論文どおり、生の差分関数の谷で行う）
  let tf = tau;
  if (tau > 1 && tau < tauMax) {
    const a = raw[tau - 1], b = raw[tau], c = raw[tau + 1];
    const den = a - 2 * b + c;
    if (Math.abs(den) > 1e-12) tf = tau + (0.5 * (a - c)) / den;
  }
  const f0 = sr / tf;
  if (!(f0 >= fmin * 0.97 && f0 <= fmax * 1.03)) return { f0: 0, ap: 1 };
  return { f0, ap };
}

/**
 * マイクのデータを流し込むと、10msごとの推定結果（frames）を返す
 * frame = { t:秒（入力の時刻基準）, f0:Hz（0=無声）, db:音量dBFS, ap }
 */
export class PitchTracker {
  constructor(inputRate, opts = {}) {
    this.inRate = inputRate;
    this.factor = Math.max(1, Math.floor(inputRate / 16000));
    this.sr = inputRate / this.factor;
    this.lp = this.factor > 1 ? new Biquad(inputRate, this.sr * 0.45) : null;
    this.tauMax = Math.floor(this.sr / PITCH_MIN_HZ);
    this.W = Math.round((opts.windowMs ?? 32) * this.sr / 1000);
    this.N = this.W + this.tauMax + 2;
    this.hop = Math.round((opts.hopMs ?? 10) * this.sr / 1000);
    this.cap = this.N * 4;
    this.buf = new Float32Array(this.cap);
    this.len = 0;
    this.win = new Float32Array(this.N);
    this.scratch = new Float32Array(2 * (this.tauMax + 2));
    this.filled = 0;
    this.sinceHop = 0;
    this.phase = 0;
    this.outCount = 0;  // 間引き後のサンプル数（通算）
    this.t0 = null;     // 最初のサンプルの時刻
    this.threshold = opts.threshold ?? 0.15;
    this.maxAp = opts.maxAp ?? 0.3;
  }
  reset() { this.len = 0; this.filled = 0; this.sinceHop = 0; this.phase = 0; this.outCount = 0; this.t0 = null; }

  /** @param {Float32Array} chunk 入力サンプル @param {number} startTime chunk先頭の時刻（秒） */
  push(chunk, startTime) {
    if (this.t0 === null) this.t0 = startTime;
    else {
      // 途切れ（50ms以上のずれ）があれば、その時刻から数え直す
      const expected = this.t0 + (this.outCount * this.factor + this.phase) / this.inRate;
      if (Math.abs(expected - startTime) > 0.05) { this.reset(); this.t0 = startTime; }
    }
    const frames = [];
    for (let i = 0; i < chunk.length; i++) {
      const v = this.lp ? this.lp.run(chunk[i]) : chunk[i];
      if (++this.phase < this.factor) continue;
      this.phase = 0;
      if (this.len === this.cap) { this.buf.copyWithin(0, this.cap - this.N); this.len = this.N; }
      this.buf[this.len++] = v;
      if (this.filled < this.N) this.filled++;
      this.outCount++;
      if (++this.sinceHop >= this.hop && this.filled === this.N) {
        this.sinceHop = 0;
        frames.push(this.analyze());
      }
    }
    return frames;
  }

  analyze() {
    const x = this.win, off = this.len - this.N, b = this.buf;
    let mean = 0;
    for (let i = 0; i < this.N; i++) mean += b[off + i];
    mean /= this.N;
    let e = 0;
    for (let i = 0; i < this.N; i++) { const v = b[off + i] - mean; x[i] = v; e += v * v; }
    const db = 10 * Math.log10(e / this.N + 1e-12);
    // 窓の中央の時刻
    const centerIdx = this.outCount - this.N / 2;
    const t = this.t0 + (centerIdx * this.factor) / this.inRate;
    if (db < QUIET_DB) return { t, f0: 0, db, ap: 1 };
    const r = yin(x, this.sr, PITCH_MIN_HZ, PITCH_MAX_HZ, this.threshold, this.scratch);
    return { t, f0: r.ap <= this.maxAp ? r.f0 : 0, db, ap: r.ap };
  }
}
