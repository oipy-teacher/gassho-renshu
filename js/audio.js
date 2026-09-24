// 音まわり: AudioContext・録音ピアノの再生・クリック・先読みスケジューラ・マイク入力
// 録音データは保存も送信もしない。マイクの音はその場で音程に変えて捨てる。

import { renderClick } from './piano.js';
import { sampleFor, rateFor, releaseCurve, SAMPLE_DIR } from './piano-samples.js';

// ピアノは録音（Salamander Grand Piano）だけを鳴らす。合成音で代わりに鳴らすことはしない。
export const REVERB_WET = 0.14;   // ごく控えめな部屋の響き
// 録音は fluidsynth（ゲイン0.6）と同じ大きさで書き出してあり、iPad のスピーカーには小さいので、全体を一律に持ち上げる。
// 一律の倍率なので音色は変わらない。曲全体・全部の音量を最大にしても、音割れ止めが働く −3dBFS より下に収まる（実測）
export const PIANO_GAIN = Math.pow(10, 11 / 20);

/** 部屋の響き（インパルス応答）: 左右でずらしたノイズを指数的に減衰させ、高い音ほど早く消えるようにしたもの */
function makeRoomIR(ctx, seconds = 1.3, rt60 = 1.0) {
  const sr = ctx.sampleRate, n = Math.round(sr * seconds);
  const ir = ctx.createBuffer(2, n, sr);
  const pre = Math.round(sr * 0.012);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let seed = 1234 + c * 777, lp = 0;
    for (let i = pre; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const white = seed / 0x3fffffff - 1;
      const t = (i - pre) / sr;
      const k = Math.exp((-2 * Math.PI * (7000 * Math.exp(-t * 2.2) + 600)) / sr); // だんだん暗くなる
      lp = k * lp + (1 - k) * white;
      d[i] = lp * Math.pow(10, (-3 * t) / rt60);
    }
  }
  // 響きの全体の大きさをそろえる
  let e = 0;
  for (let c = 0; c < 2; c++) for (const v of ir.getChannelData(c)) e += v * v;
  const g = 1 / Math.sqrt(e / 2);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < n; i++) d[i] *= g; }
  return ir;
}

/**
 * 音割れ止め: −3dBFS までは素通し（音を一切変えない）、それを超えた分だけなめらかに頭を丸める。
 * DynamicsCompressor は使わない（自動の音量持ち上げ（+2dB）と 6ms の遅れが入り、録音の音が変わるため。実測）
 */
function makeSafetyCurve(n = 4096, knee = 0.708) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = a <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
  }
  return c;
}

/** 出力までの共通の配線: 4本のバス → マスター →（直接の音 ＋ 部屋の響き）→ 音割れ止め → 出口 */
function buildGraph(ctx, gains = {}, { reverb = true, ir = null, limiter = true } = {}) {
  const master = ctx.createGain();
  master.gain.value = 1;
  const lim = ctx.createWaveShaper();
  lim.curve = makeSafetyCurve();
  lim.oversample = 'none'; // オーバーサンプリングは遅れ（約4ms・実測）が出るので使わない。−3dBFS 未満では素通しなので影響なし
  const out = ctx.createGain();
  out.gain.value = 1;
  master.connect(limiter ? lim : out);
  if (reverb) {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = ir || makeRoomIR(ctx);
    const wet = ctx.createGain();
    wet.gain.value = REVERB_WET;
    master.connect(conv).connect(wet).connect(limiter ? lim : out);
  }
  if (limiter) lim.connect(out);
  out.connect(ctx.destination);
  const bus = {};
  for (const name of ['mine', 'others', 'piano', 'click']) {
    const g = ctx.createGain();
    g.gain.value = gains[name] ?? 1;
    g.connect(name === 'click' ? (limiter ? lim : out) : master); // クリックには響きを足さない
    bus[name] = g;
  }
  // 聞き直しの声（録音）: 響きを足さず、音割れ止めだけ通す
  bus.voice = ctx.createGain();
  bus.voice.gain.value = gains.voice ?? 1;
  bus.voice.connect(limiter ? lim : out);
  return { master, lim, out, bus };
}

/**
 * 読み込んだ録音の頭をそろえる。AAC は先頭に「エンコーダの待ち時間（無音）」が入るため、
 * 音が出始める所を探し、そこから「note-on から音が出るまでの時間（表の leadMs・fluidsynth と同じ）」だけ戻した所を 0 にする。
 * 音量は変えない（強弱の段ごとの本来の大きさを保つ）。
 */
function prepareSample(ctx, decoded, leadMs) {
  const n0 = decoded.length, chs = decoded.numberOfChannels;
  const chans = Array.from({ length: chs }, (_, c) => decoded.getChannelData(c));
  let on = 0;
  while (on < n0 && chans.every((d) => Math.abs(d[on]) < 1e-4)) on++;
  const start = Math.max(0, on - Math.round((decoded.sampleRate * leadMs) / 1000));
  const len = n0 - start;
  const buf = ctx.createBuffer(chs, len, decoded.sampleRate);
  for (let c = 0; c < chs; c++) buf.getChannelData(c).set(chans[c].subarray(start));
  return buf;
}

const relCache = new Map();
/** 離鍵のカーブを −60dB まで使い、最後の 20ms で 0 にする（それより下は聞こえない）。全体の持ち上げ（PIANO_GAIN）込み */
function releaseCurveFor(root) {
  if (relCache.has(root)) return relCache.get(root);
  const full = releaseCurve(root) || Float32Array.from({ length: 30 }, (_, i) => Math.pow(10, -i / 20));
  let n = full.findIndex((v) => v < 0.001);
  if (n < 0) n = full.length;
  const c = new Float32Array(n + 2);
  for (let i = 0; i < n; i++) c[i] = full[i] * PIANO_GAIN;
  c[n] = (c[n - 1] || 0) * 0.3;
  c[n + 1] = 0;
  relCache.set(root, c);
  return c;
}

function nameToArgs(name) {
  // "Fs3-mf" → [54, 'mf']
  const m = /^([A-G]s?)(-?\d)-(p|mf|f)$/.exec(name);
  const PC = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };
  return [(Number(m[2]) + 1) * 12 + PC[m[1]], m[3]];
}

function decode(ctx, ab) {
  // Safari の古い形（コールバック）にも対応
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(ab, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.samples = new Map(); // name -> AudioBuffer（録音ピアノ）
    this.sampleFail = new Set();
    this.sources = new Set();
    this.queue = [];
    this.timer = null;
    this.mic = null;
  }

  async init() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const c = this.ctx;
    this.ir = makeRoomIR(c);
    this.graph = buildGraph(c, {}, { ir: this.ir });
    this.bus = this.graph.bus;
    this.clickBuf = this.makeBuffer(renderClick(c.sampleRate, false));
    this.clickAccentBuf = this.makeBuffer(renderClick(c.sampleRate, true));
    // iOS: 無音を1回鳴らして音を出せる状態にする
    const s = c.createBufferSource();
    s.buffer = c.createBuffer(1, 1, c.sampleRate);
    s.connect(c.destination);
    s.start();
    if (c.state !== 'running') await c.resume().catch(() => {});
  }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  /** いま耳に届いている音の時刻（出力の遅れを差し引く） */
  audibleTime() {
    const c = this.ctx;
    if (!c) return 0;
    if (c.getOutputTimestamp) {
      const ts = c.getOutputTimestamp();
      if (ts && ts.contextTime > 0) return ts.contextTime;
    }
    return c.currentTime - (c.outputLatency || 0) - (c.baseLatency || 0);
  }

  outputDelay() {
    const c = this.ctx;
    return c ? (c.outputLatency || 0) + (c.baseLatency || 0) : 0;
  }

  makeBuffer(data) {
    const b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    b.getChannelData(0).set(data);
    return b;
  }

  /**
   * 楽譜で使う高さ・強弱に必要な録音だけ読み込む（同じフォルダの m4a。外部には取りに行かない）
   * @param notes [{ midi, dyn }]
   * @returns {{ok:number, failed:number, total:number}}
   */
  async loadPiano(notes, onProgress) {
    this.sampleFail.clear();
    const need = [...new Set(notes.map((n) => sampleFor(n.midi, n.dyn).name))].filter((n) => !this.samples.has(n));
    let done = 0, failed = 0;
    const one = async (name) => {
      try {
        const meta = sampleFor(...nameToArgs(name));
        const url = new URL(`../${SAMPLE_DIR}${name}.m4a`, import.meta.url).href;
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const buf = prepareSample(this.ctx, await decode(this.ctx, await res.arrayBuffer()), meta.leadMs);
        this.samples.set(name, buf);
      } catch (_) {
        this.sampleFail.add(name);
        failed++;
      }
      done++;
      if (onProgress) onProgress(done / need.length, done, need.length);
    };
    // 4本ずつ並行で読む
    const q = [...need];
    await Promise.all(Array.from({ length: Math.min(4, q.length) }, async () => { while (q.length) await one(q.shift()); }));
    return { ok: need.length - failed, failed, total: need.length };
  }

  /** この音符を鳴らす録音が読み込み済みか */
  hasSample(midi, dyn) { const s = sampleFor(midi, dyn); return !!s && this.samples.has(s.name); }

  setBusGain(name, v) {
    if (!this.ctx) return;
    this.bus[name].gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // ---- 先読みスケジューラ ----
  /** events: { time(ctx秒), kind:'note'|'click', midi, dur, bus, vel, accent } */
  schedule(events) {
    this.queue.push(...events);
    this.queue.sort((a, b) => a.time - b.time);
    if (!this.timer) {
      this.timer = setInterval(() => this.pump(), 25);
      this.pump();
    }
  }

  pump() {
    const horizon = this.ctx.currentTime + 0.25;
    while (this.queue.length && this.queue[0].time < horizon) {
      const e = this.queue.shift();
      if (e.time < this.ctx.currentTime - 0.05) continue; // 間に合わなかったものは鳴らさない
      this.play(e, this.ctx, this.bus);
    }
    if (!this.queue.length) { clearInterval(this.timer); this.timer = null; }
  }

  play(e, ctx, bus) {
    const src = e.kind === 'click' ? this.clickSource(ctx, bus, e.time, e.accent) : this.noteSource(ctx, bus, e.midi, e.time, e.dur, e.bus, e.dyn);
    if (ctx === this.ctx && src) this.track(src);
  }

  noteSource(ctx, bus, midi, when, dur, busName, dyn = 'mf') {
    const m = Math.round(midi);
    const s = sampleFor(m, dyn);
    const buf = s && this.samples.get(s.name);
    if (!buf) return null; // 録音が無い音は鳴らさない（合成音で代わりに鳴らさない）
    const rate = rateFor(m, s);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = PIANO_GAIN;
    src.connect(g).connect(bus[busName] || bus.others);
    // 離鍵: SF2 を fluidsynth で鳴らして実測した「離したあとの減り方」のカーブをそのまま当てる
    //（ダンパーのある鍵は 0.1 秒で約 −10dB、最高音域のダンパーの無い鍵はゆっくり）
    const off = when + Math.max(0.03, dur);
    const curve = releaseCurveFor(s.midi);
    const relDur = (curve.length - 1) * 0.01;
    const natural = when + buf.duration / rate;
    if (off < natural) g.gain.setValueCurveAtTime(curve, off, relDur);
    src.start(when);
    src.stop(Math.min(off + relDur + 0.005, natural));
    return src;
  }

  /** 聞き直し: 録音（Float32・任意のサンプリング周波数）を when から、offset 秒目から鳴らす */
  playVoice(data, sr, when, offset = 0) {
    const c = this.ctx;
    const b = c.createBuffer(1, data.length, sr);
    b.getChannelData(0).set(data);
    const src = c.createBufferSource();
    src.buffer = b;
    src.connect(this.bus.voice);
    src.start(Math.max(c.currentTime, when), Math.max(0, offset));
    this.track(src);
    return src;
  }

  clickSource(ctx, bus, when, accent) {
    const src = ctx.createBufferSource();
    src.buffer = accent ? this.clickAccentBuf : this.clickBuf;
    src.connect(bus.click);
    src.start(when);
    return src;
  }

  track(src) {
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  stopAll() {
    this.queue = [];
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const t = this.ctx ? this.ctx.currentTime : 0;
    for (const s of this.sources) { try { s.stop(t + 0.01); } catch (_) { /* 既に止まっている */ } }
    this.sources.clear();
  }

  /**
   * 検証用: 同じ配線・同じ音量で、画面に出さずに書き出す（音割れ・無音・音程の機械チェックに使う）
   * @returns {Promise<AudioBuffer>}
   */
  async renderOffline(events, seconds, { reverb = true, gains = null, channels = 2, limiter = true } = {}) {
    const sr = this.ctx.sampleRate;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(channels, Math.ceil(seconds * sr), sr);
    if (!gains) { gains = {}; for (const k of Object.keys(this.bus)) gains[k] = this.bus[k].gain.value; }
    const g = buildGraph(off, gains, { reverb, ir: this.ir, limiter });
    for (const e of events) this.play(e, off, g.bus);
    return off.startRendering();
  }

  // ---- マイク ----
  /**
   * @param {boolean} echoCancel true=通し（エコーキャンセルに頼る）/ false=交互練習（生の音）
   * @param {(data:Float32Array, t:number)=>void} onData
   */
  async openMic(echoCancel, onData) {
    await this.closeMic();
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('INSECURE');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: echoCancel,
        noiseSuppression: echoCancel,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    const c = this.ctx;
    if (c.state !== 'running') await c.resume().catch(() => {});
    const src = c.createMediaStreamSource(stream);
    const sink = c.createGain();
    sink.gain.value = 0; // マイクの音はスピーカーに出さない
    sink.connect(c.destination);
    let node;
    if (c.audioWorklet && window.AudioWorkletNode) {
      if (!this.workletLoaded) {
        await c.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);
        this.workletLoaded = true;
      }
      node = new AudioWorkletNode(c, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (ev) => onData(ev.data.data, ev.data.t);
    } else {
      // 古い端末向けの予備（ScriptProcessor）
      node = c.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = (ev) => {
        const d = ev.inputBuffer.getChannelData(0);
        onData(new Float32Array(d), (ev.playbackTime || c.currentTime) - d.length / c.sampleRate);
      };
    }
    src.connect(node).connect(sink);
    const track = stream.getAudioTracks()[0];
    const settings = track && track.getSettings ? track.getSettings() : {};
    this.mic = { stream, src, node, sink, settings, echoCancel };
    return settings;
  }

  /** マイクの入力遅れ（分かる範囲で） */
  inputDelay() {
    const s = this.mic && this.mic.settings;
    return s && typeof s.latency === 'number' ? s.latency : 0;
  }

  async closeMic() {
    if (!this.mic) return;
    const { stream, src, node, sink } = this.mic;
    try { src.disconnect(); node.disconnect(); sink.disconnect(); } catch (_) { /* 既に外れている */ }
    if (node.port) node.port.onmessage = null;
    for (const t of stream.getTracks()) t.stop();
    this.mic = null;
  }
}
