// .mxl（圧縮MusicXML = zip）を開く。外部ライブラリを使わず、zipの読み取りと
// deflate の展開（RFC 1951）をここで自前実装する。すべて端末内で完結する。

// ---------------- inflate（RFC 1951） ----------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths) {
  // counts[len] と、長さ順・値順に並べた記号表（canonical Huffman）
  const counts = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { counts, symbols };
}

export function inflateRaw(data) {
  let pos = 0, bitBuf = 0, bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, data.length * 4));
  let outLen = 0;
  const ensure = (extra) => {
    if (outLen + extra <= out.length) return;
    let size = out.length * 2;
    while (size < outLen + extra) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(out.subarray(0, outLen));
    out = nb;
  };
  const bits = (need) => {
    while (bitCnt < need) {
      if (pos >= data.length) throw new Error('圧縮データが途中で切れています');
      bitBuf |= data[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << need) - 1);
    bitBuf >>>= need;
    bitCnt -= need;
    return v;
  };
  const decodeSym = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('圧縮データが壊れています（符号）');
  };

  let fixedLit = null, fixedDist = null;
  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0; // バイト境界へ
      if (pos + 4 > data.length) throw new Error('圧縮データが途中で切れています');
      const len = data[pos] | (data[pos + 1] << 8);
      pos += 4;
      ensure(len);
      out.set(data.subarray(pos, pos + len), outLen);
      outLen += len; pos += len;
      continue;
    }
    let lit, dist;
    if (type === 1) {
      if (!fixedLit) {
        const l = new Uint8Array(288);
        for (let i = 0; i < 144; i++) l[i] = 8;
        for (let i = 144; i < 256; i++) l[i] = 9;
        for (let i = 256; i < 280; i++) l[i] = 7;
        for (let i = 280; i < 288; i++) l[i] = 8;
        fixedLit = buildHuffman(l);
        fixedDist = buildHuffman(new Uint8Array(30).fill(5));
      }
      lit = fixedLit; dist = fixedDist;
    } else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clH = buildHuffman(cl);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const sym = decodeSym(clH);
        if (sym < 16) lens[i++] = sym;
        else {
          let rep = 0, val = 0;
          if (sym === 16) { if (!i) throw new Error('圧縮データが壊れています'); val = lens[i - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          while (rep--) lens[i++] = val;
        }
      }
      lit = buildHuffman(lens.subarray(0, hlit));
      dist = buildHuffman(lens.subarray(hlit));
    } else throw new Error('圧縮データが壊れています（ブロック種別）');

    for (;;) {
      const sym = decodeSym(lit);
      if (sym < 256) { ensure(1); out[outLen++] = sym; }
      else if (sym === 256) break;
      else {
        const li = sym - 257;
        if (li >= 29) throw new Error('圧縮データが壊れています（長さ）');
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decodeSym(dist);
        const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (d > outLen) throw new Error('圧縮データが壊れています（距離）');
        ensure(len);
        for (let k = 0; k < len; k++) { out[outLen] = out[outLen - d]; outLen++; }
      }
    }
  }
  return out.subarray(0, outLen);
}

// ---------------- zip ----------------
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function isZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function readZip(bytes) {
  // 末尾の End of Central Directory を探す
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zipファイルとして読めませんでした');
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const entries = new Map();
  const dec = new TextDecoder('utf-8');
  for (let k = 0; k < count; k++) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error('zipの目次が壊れています');
    const method = u16(bytes, p + 10);
    const csize = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
    const localOff = u32(bytes, p + 42);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, csize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const get = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const o = e.localOff;
    if (u32(bytes, o) !== 0x04034b50) throw new Error('zipの中身が壊れています');
    const start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
    const raw = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflateRaw(raw);
    throw new Error('対応していない圧縮方式です（' + e.method + '）');
  };
  return { names: [...entries.keys()], get };
}

// ---------------- 文字コード ----------------
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  // BOMなしUTF-16（先頭が "<\0" / "\0<"）
  if (bytes[0] === 0x3c && bytes[1] === 0x00) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0x00 && bytes[1] === 0x3c) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/** ファイルのバイト列 → MusicXML の文字列（.mxl / .musicxml / .xml のどれでも） */
export function bytesToMusicXml(bytes) {
  if (!isZip(bytes)) return decodeText(bytes);
  const zip = readZip(bytes);
  let path = null;
  const container = zip.get('META-INF/container.xml');
  if (container) {
    const m = /full-path\s*=\s*"([^"]+)"/.exec(decodeText(container));
    if (m) path = m[1];
  }
  if (!path || !zip.names.includes(path)) {
    path = zip.names.find((n) => !n.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(n));
  }
  if (!path) throw new Error('.mxl の中に楽譜（MusicXML）が見つかりませんでした');
  return decodeText(zip.get(path));
}
