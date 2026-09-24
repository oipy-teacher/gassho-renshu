// 曲全体の縮図（ミニマップ）: 小節の目盛り・練習番号・自分のパートの音の動き・練習範囲・いま見ている所

const FONT = '"Hiragino Sans", "Noto Sans JP", sans-serif';
export const MINI_PAD = 14;
export const HANDLE_HIT = 22;

/** 秒 ⇔ x（ミニマップの座標） */
export function miniScale(totalSec, width, pad = MINI_PAD) {
  const w = Math.max(1, width - pad * 2);
  return {
    xOf: (sec) => pad + (Math.max(0, Math.min(totalSec, sec)) / totalSec) * w,
    secOf: (x) => Math.max(0, Math.min(totalSec, ((x - pad) / w) * totalSec)),
  };
}

/** 範囲の端（つまみ）に指が当たっているか */
export function hitEdge(x, range, scale, hit = HANDLE_HIT) {
  const ds = Math.abs(x - scale.xOf(range.startSec)), de = Math.abs(x - scale.xOf(range.endSec));
  if (Math.min(ds, de) > hit) return null;
  return ds <= de ? 'start' : 'end';
}

export class Minimap {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.measures = [];
    this.sections = [];
    this.notes = [];
    this.totalSec = 1;
    this.resize();
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(100, r.width);
    this.h = Math.max(30, r.height);
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setData(measures, notes, sections) {
    this.measures = measures;
    this.notes = notes;
    this.sections = sections || [];
    const last = measures[measures.length - 1];
    this.totalSec = last ? last.endSec : 1;
    const ms = notes.map((n) => n.midi);
    this.low = Math.min(...ms); this.high = Math.max(...ms);
  }

  get scale() { return miniScale(this.totalSec, this.w); }

  /**
   * @param s { range:{startSec,endSec}, view:{fromSec,toSec}, cursorSec, playing }
   */
  draw(s) {
    const g = this.g, W = this.w, H = this.h, sc = this.scale;
    const top = 18, bot = H - 4;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#e4e9e6';
    g.fillRect(MINI_PAD, top, W - MINI_PAD * 2, bot - top);

    // 練習範囲
    const rx0 = sc.xOf(s.range.startSec), rx1 = sc.xOf(s.range.endSec);
    g.fillStyle = 'rgba(33,184,111,0.22)';
    g.fillRect(rx0, top, rx1 - rx0, bot - top);

    // 小節の目盛り（10小節ごとに番号）
    g.font = `600 10px ${FONT}`;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'center';
    this.measures.forEach((m) => {
      const x = sc.xOf(m.startSec);
      const n = parseInt(m.number, 10);
      const major = Number.isFinite(n) && n % 10 === 0;
      g.fillStyle = major ? 'rgba(34,34,34,0.45)' : 'rgba(34,34,34,0.16)';
      g.fillRect(Math.round(x), major ? top - 3 : bot - 6, 1, major ? bot - top + 3 : 6);
      if (major && !this.sections.some((sec) => Math.abs(sc.xOf(this.measures[sec.fromIdx].startSec) - x) < 30)) {
        g.fillStyle = '#3e4544';
        g.fillText(m.number, x, top - 5);
      }
    });

    // 自分のパートの音の動き（細い線）
    const span = Math.max(1, this.high - this.low);
    g.fillStyle = '#27463c';
    for (const n of this.notes) {
      const x0 = sc.xOf(n.startSec), x1 = Math.max(x0 + 1, sc.xOf(n.endSec));
      const y = bot - 4 - ((n.midi - this.low) / span) * (bot - top - 10);
      g.fillRect(x0, y - 1, x1 - x0, 2);
    }

    // 練習番号（四角い囲み）
    g.font = `700 11px "Times New Roman", serif`;
    for (const sec of this.sections) {
      const x = sc.xOf(this.measures[sec.fromIdx].startSec);
      const w = g.measureText(sec.label).width + 6;
      const bx = Math.max(1, Math.min(W - w - 1, x - w / 2)); // 端で切れないように
      g.fillStyle = '#f8faf9';
      g.fillRect(bx, 1, w, 14);
      g.strokeStyle = '#222'; g.lineWidth = 1;
      g.strokeRect(bx + 0.5, 1.5, w - 1, 13);
      g.fillStyle = '#222';
      g.fillText(sec.label, bx + w / 2, 12);
      g.fillStyle = 'rgba(34,34,34,0.5)';
      g.fillRect(Math.round(x), 15, 1, bot - 15);
    }

    // いま見ている所（つまみ）
    const vx0 = sc.xOf(s.view.fromSec), vx1 = sc.xOf(s.view.toSec);
    g.strokeStyle = '#27463c'; g.lineWidth = 2;
    g.strokeRect(vx0, top - 1, Math.max(6, vx1 - vx0), bot - top + 2);
    g.fillStyle = 'rgba(39,70,60,0.10)';
    g.fillRect(vx0, top - 1, Math.max(6, vx1 - vx0), bot - top + 2);

    // 範囲の端のつまみ
    if (!s.playing) {
      for (const x of [rx0, rx1]) {
        g.fillStyle = '#1d6f4b';
        g.fillRect(x - 3, top - 2, 6, bot - top + 4);
      }
    }
    // 再生位置
    const cx = sc.xOf(s.cursorSec);
    g.fillStyle = '#a3433a';
    g.fillRect(cx - 1, top - 4, 2, bot - top + 8);
  }
}
