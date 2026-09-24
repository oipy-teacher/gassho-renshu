// クリック（メトロノーム）の音だけを作る。ピアノの音は録音（audio/piano/）だけを使い、ここでは作らない。

/** クリック音（音程のない短いノイズ。マイクが拾っても音程として検出されにくいようにしてある） */
export function renderClick(sr, accent = false) {
  const n = Math.floor(sr * 0.035);
  const out = new Float32Array(n);
  const fc = accent ? 3400 : 2600;
  const w = (2 * Math.PI * fc) / sr, q = 1.4;
  const alpha = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, seed = accent ? 99 : 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const x = (seed / 0x3fffffff - 1) * Math.exp(-i / (sr * 0.004));
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y * (accent ? 2.6 : 1.8);
  }
  return out;
}
