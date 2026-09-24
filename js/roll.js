// 黒板のピアノロール: お手本の音符（チョークの棒）と自分の声（黄色いチョークの線）を重ねて流す

const C = {
  board: '#27463c',
  boardDark: '#223e35',
  line: 'rgba(236,240,230,0.13)',
  lineStrong: 'rgba(236,240,230,0.34)',
  chalk: 'rgba(240,243,234,0.86)',
  chalkDim: 'rgba(240,243,234,0.30)',
  voice: '#ffd04d',
  voiceOct: '#93c9ec',
  great: '#a4db8c',
  good: '#dde88f',
  fair: '#f3b26a',
  miss: '#f09090',
  keyWhite: '#e9ece6',
  keyBlack: '#2b2f2c',
  keyText: '#33403a',
};
const GRADE_COLOR = { '◎': C.great, '○': C.good, '△': C.fair, '×': C.miss };
const BLACK = new Set([1, 3, 6, 8, 10]);
const SOLFA = { 0: 'ド', 2: 'レ', 4: 'ミ', 5: 'ファ', 7: 'ソ', 9: 'ラ', 11: 'シ' };
const FONT = '"Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans JP", sans-serif';

export class Roll {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.pxPerSec = 120;
    this.keyW = 58;
    this.headH = 30;
    this.lyricH = 38;
    this.notes = [];
    this.measures = [];
    this.low = 60; this.high = 72;
    this.resize();
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(200, r.width);
    this.h = Math.max(160, r.height);
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.playX = this.keyW + (this.w - this.keyW) * 0.28;
  }

  setData(notes, measures, sections = []) {
    this.notes = [...notes].sort((a, b) => a.startSec - b.startSec);
    this.measures = measures;
    this.markAt = new Map(sections.map((sec) => [sec.fromIdx, sec.label]));
    const ms = notes.map((n) => n.midi);
    let lo = Math.floor(Math.min(...ms)) - 3, hi = Math.ceil(Math.max(...ms)) + 3;
    while (hi - lo < 14) { lo--; hi++; }
    this.low = lo; this.high = hi;
  }

  xOf(sec, view) { return this.playX + (sec - view) * this.pxPerSec; }
  secOfX(x, view) { return view + (x - this.playX) / this.pxPerSec; }
  yOf(midi) {
    const top = this.headH, bot = this.h - this.lyricH;
    const row = (bot - top) / (this.high - this.low + 1);
    return bot - (midi - this.low + 0.5) * row;
  }
  get rowH() { return (this.h - this.lyricH - this.headH) / (this.high - this.low + 1); }

  /** 画面に見えている秒の範囲 */
  visibleSpan(view) { return { fromSec: this.secOfX(this.keyW, view), toSec: this.secOfX(this.w, view) }; }

  /** 範囲の端のつまみ（上の小節番号の帯）に指が当たっているか */
  hitHandle(x, y, range, view) {
    if (y > this.headH + 14) return null;
    const ds = Math.abs(x - this.xOf(range.startSec, view)), de = Math.abs(x - this.xOf(range.endSec, view));
    if (Math.min(ds, de) > 24) return null;
    return ds <= de ? 'start' : 'end';
  }

  /** タップした所の音符（なければ null） */
  noteHit(x, y, view) {
    const row = this.rowH, hh = Math.max(10, row * 0.7) + 8;
    for (const n of this.notes) {
      const xa = this.xOf(n.startSec, view), xb = this.xOf(n.endSec, view);
      if (x >= xa - 4 && x <= xb && Math.abs(y - this.yOf(n.midi)) <= hh / 2) return n;
    }
    return null;
  }

  noteAt(sec) {
    const ns = this.notes;
    let lo = 0, hi = ns.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (ns[m].endSec <= sec) lo = m + 1;
      else if (ns[m].startSec > sec) hi = m - 1;
      else return ns[m];
    }
    return null;
  }

  /**
   * @param s { view, range:{startSec,endSec}, segment, results:Map, voice:[{sec,midi}], count, liveMidi, phase }
   */
  draw(s) {
    const g = this.g, W = this.w, H = this.h, view = s.view;
    const top = this.headH, bot = H - this.lyricH, row = this.rowH;
    g.fillStyle = C.board;
    g.fillRect(0, 0, W, H);

    // 黒鍵の段を少し暗く（鍵盤の並びが目で追える）
    for (let m = this.low; m <= this.high; m++) {
      const y = this.yOf(m);
      if (BLACK.has(((m % 12) + 12) % 12)) { g.fillStyle = C.boardDark; g.fillRect(this.keyW, y - row / 2, W - this.keyW, row); }
      if (m % 12 === 0) { g.fillStyle = C.line; g.fillRect(this.keyW, y + row / 2 - 0.5, W - this.keyW, 1); }
    }

    // 練習範囲の外は暗く
    const x0 = this.xOf(s.range.startSec, view), x1 = this.xOf(s.range.endSec, view);
    g.fillStyle = 'rgba(12,24,20,0.45)';
    if (x0 > this.keyW) g.fillRect(this.keyW, top, x0 - this.keyW, bot - top);
    if (x1 < W) g.fillRect(Math.max(this.keyW, x1), top, W - x1, bot - top);
    if (s.segment) {
      const sx0 = this.xOf(s.segment.startSec, view), sx1 = this.xOf(s.segment.endSec, view);
      g.fillStyle = 'rgba(240,243,234,0.06)';
      g.fillRect(Math.max(this.keyW, sx0), top, Math.max(0, sx1 - Math.max(this.keyW, sx0)), bot - top);
    }

    // 小節線と小節番号
    g.font = `600 13px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (const m of this.measures) {
      const x = this.xOf(m.startSec, view);
      if (x < this.keyW - 2 || x > W + 2) continue;
      g.fillStyle = C.lineStrong;
      g.fillRect(Math.round(x), top, 1, bot - top);
      g.fillStyle = C.chalk;
      g.fillText(m.number, x + 5, top / 2 + 1);
      const mk = this.markAt && this.markAt.get(m.index);
      if (mk) {
        // 練習番号: 楽譜と同じ四角い囲み
        const nx = x + 5 + g.measureText(m.number).width + 8;
        g.font = `700 15px "Times New Roman", serif`;
        const w = g.measureText(mk).width + 10;
        g.strokeStyle = C.chalk; g.lineWidth = 1.5;
        g.strokeRect(nx, 4, w, top - 8);
        g.fillText(mk, nx + 5, top / 2 + 1);
        g.font = `600 13px ${FONT}`;
      }
    }

    // 練習範囲の帯と、端のつまみ（止まっている間だけ動かせる）
    if (x1 > this.keyW && x0 < W) {
      g.fillStyle = 'rgba(255,208,77,0.18)';
      g.fillRect(Math.max(this.keyW, x0), 0, Math.min(W, x1) - Math.max(this.keyW, x0), top);
      if (s.handles) {
        for (const [x, dir] of [[x0, 1], [x1, -1]]) {
          if (x < this.keyW - 2 || x > W + 2) continue;
          g.fillStyle = '#ffd04d';
          g.fillRect(x - (dir > 0 ? 0 : 14), 2, 14, top - 4);
          g.fillStyle = '#27463c';
          for (let k = 0; k < 3; k++) g.fillRect(x - (dir > 0 ? -4 : 10) + k * 3, 8, 1.5, top - 16);
          g.fillStyle = 'rgba(255,208,77,0.7)';
          g.fillRect(x - 1, top, 2, bot - top);
        }
      }
    }

    // お手本の音符
    const results = s.results;
    const r = Math.min(5, row * 0.3);
    for (const n of this.notes) {
      const xa = this.xOf(n.startSec, view), xb = this.xOf(n.endSec, view);
      if (xb < this.keyW || xa > W) continue;
      const y = this.yOf(n.midi);
      const hh = Math.max(6, row * 0.7);
      const res = results && results.get(n.id);
      const xs = Math.max(this.keyW, xa + 1), xe = xb - 1.5;
      if (xe <= xs) continue;
      const active = s.activeId === n.id;
      if (res && res.status === 'sung') g.fillStyle = GRADE_COLOR[res.grade] || C.chalk;
      else if (res && res.status === 'unsung') g.fillStyle = C.chalkDim;
      else g.fillStyle = active ? '#ffffff' : C.chalk;
      rounded(g, xs, y - hh / 2, xe - xs, hh, r);
      g.fill();
      if (res && res.octave) {
        g.strokeStyle = C.voiceOct; g.lineWidth = 2;
        rounded(g, xs, y - hh / 2, xe - xs, hh, r); g.stroke();
      }
      if (res && res.status === 'sung' && xe - xs > 22) {
        g.fillStyle = '#1f332c';
        g.font = `700 ${Math.min(14, Math.max(10, hh - 3))}px ${FONT}`;
        g.textAlign = 'left';
        g.fillText(res.octave ? '8' : res.grade, xs + 4, y + 0.5);
      }
    }

    // 自分の声
    const v = s.voice || [];
    if (v.length) {
      g.lineWidth = 3.5;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      let prev = null, open = false, curOct = null;
      const flush = () => { if (open) { g.stroke(); open = false; } };
      for (const f of v) {
        const x = this.xOf(f.sec, view);
        if (x < this.keyW - 20 || x > (s.clip ? this.playX + 4 : W + 20)) { prev = null; flush(); continue; }
        if (f.midi == null) { prev = null; flush(); continue; }
        let m = f.midi, folded = false;
        const t = this.noteAt(f.sec);
        if (t && Math.abs(m - t.midi) > 6.5) { const k = Math.round((m - t.midi) / 12); if (k) { m -= 12 * k; folded = true; } }
        const y = this.yOf(m);
        if (prev && f.sec - prev.sec < 0.06 && folded === curOct) { g.lineTo(x, y); }
        else {
          flush();
          g.strokeStyle = folded ? C.voiceOct : C.voice;
          g.setLineDash(folded ? [5, 5] : []);
          g.beginPath(); g.moveTo(x, y); open = true; curOct = folded;
        }
        prev = f;
      }
      flush();
      g.setLineDash([]);
    }

    // 歌詞の段（スクロール中も読めるよう大きめ。いまの位置の歌詞は黄色）
    g.fillStyle = 'rgba(10,20,17,0.45)';
    g.fillRect(this.keyW, bot, W - this.keyW, this.lyricH);
    g.font = `600 19px ${FONT}`;
    g.textAlign = 'left';
    let lastX = -1e9;
    const cur = this.noteAt(view);
    for (const n of this.notes) {
      if (!n.lyric) continue;
      const x = this.xOf(n.startSec, view);
      if (x < this.keyW - 30 || x > W) continue;
      if (x - lastX < 20) continue;
      g.fillStyle = cur && cur.id === n.id ? C.voice : C.chalk;
      g.fillText(n.lyric.replace(/-$/, ''), Math.max(this.keyW + 2, x + 2), bot + this.lyricH / 2 + 1);
      lastX = x;
    }

    // 再生位置（止まっている間は「ここから始める」位置）
    g.fillStyle = s.idle ? '#ff8f7a' : 'rgba(255,255,255,0.75)';
    g.fillRect(Math.round(this.playX) - 1, top - 4, s.idle ? 3 : 2, bot - top + 4);
    if (s.cursorLabel) {
      g.font = `700 13px ${FONT}`;
      const tw = g.measureText(s.cursorLabel).width + 14;
      const lx = Math.min(W - tw - 4, this.playX + 6);
      g.fillStyle = '#ff8f7a';
      g.fillRect(lx, top + 4, tw, 22);
      g.fillStyle = '#1f332c';
      g.textAlign = 'left';
      g.fillText(s.cursorLabel, lx + 7, top + 15.5);
    }
    if (s.liveMidi != null) {
      let m = s.liveMidi;
      const t = this.noteAt(view);
      if (t && Math.abs(m - t.midi) > 6.5) m -= 12 * Math.round((m - t.midi) / 12);
      g.fillStyle = C.voice;
      g.beginPath(); g.arc(this.playX, this.yOf(m), 6, 0, Math.PI * 2); g.fill();
    }

    this.drawKeys(s.activeMidi);

    if (s.count) {
      g.fillStyle = 'rgba(240,243,234,0.92)';
      g.font = `700 ${Math.min(140, H * 0.36)}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.count, this.keyW + (W - this.keyW) / 2, top + (bot - top) / 2);
    }
  }

  drawKeys(activeMidi) {
    const g = this.g, row = this.rowH, top = this.headH, bot = this.h - this.lyricH;
    g.fillStyle = C.keyWhite;
    g.fillRect(0, 0, this.keyW, this.h);
    g.font = `600 ${Math.max(9, Math.min(13, row * 0.8))}px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let m = this.low; m <= this.high; m++) {
      const pc = ((m % 12) + 12) % 12, y = this.yOf(m);
      if (y - row / 2 < top - 1 || y + row / 2 > bot + 1) continue;
      if (m === activeMidi) { g.fillStyle = C.voice; g.fillRect(0, y - row / 2, this.keyW, row); }
      if (BLACK.has(pc)) {
        g.fillStyle = C.keyBlack;
        g.fillRect(0, y - row / 2 + 1, this.keyW * 0.58, row - 2);
      } else if (row >= 9 || pc === 0) {
        g.fillStyle = C.keyText;
        const label = SOLFA[pc] + (pc === 0 ? Math.floor(m / 12) - 1 : '');
        g.fillText(label, this.keyW * 0.62 - (pc === 0 ? 8 : 0), y + 0.5);
      }
      if (pc === 0 || pc === 5) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, y + row / 2 - 0.5, this.keyW, 1); }
    }
    g.fillStyle = '#6b5236';
    g.fillRect(this.keyW - 2, 0, 2, this.h);
  }
}

function rounded(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) { g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); return; }
  g.rect(x, y, w, h);
}
