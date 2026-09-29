// カラオケ風の演出（黒板の上に重ねて描く）
//   息継ぎ！       … カウントの玉が1拍ごとに消える → 「息継ぎ！」がはじけて、光が再生位置へ吸いこまれる
//   だんだん強く！！ … 進むほど文字が大きく・赤く・「！」が増え、火の粉が舞い上がる
//   だんだん弱く…   … 進むほど文字が小さく・淡く、雪のように粒が降りる
//   f／p           … 強くなる所は大きな文字が落ちてきて画面がゆれる。弱くなる所はふわっと現れる
//   決まった！      … 声で判定して成功したら金色の文字と星・コンボ
// 画面の文字はすべて日本語。粒の数は上限つき（iPad で重くならないように）

const FONT = '"Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans JP", sans-serif';
const SERIF = '"Times New Roman", "Hiragino Mincho ProN", serif';
const MAX_PARTS = 240;
const SKY = [147, 201, 236], GOLD = [255, 208, 77], HOT = [255, 120, 60], CHALK = [240, 243, 234];
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const easeOutBack = (t) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export const DYN_SHOUT = { ppp: 'とても とても弱く…', pp: 'とても弱く…', p: '弱く…', mp: '少し弱く', mf: '少し強く', f: '強く！', ff: 'とても強く！！', fff: '全力で！！！' };

export class Fx {
  constructor() {
    this.items = [];   // 文字の演出 {kind, t0, dur, ...}
    this.parts = [];   // 粒 {x,y,vx,vy,life,age,size,color,kind}
    this.combo = 0;
    this.comboAt = 0;
    this.shakeUntil = 0; this.shakeAmp = 0;
    this.last = 0;
    this.wedgeT0 = 0; this.wedgeKey = null;
  }

  reset() { this.items = []; this.parts = []; this.combo = 0; this.shakeAmp = 0; this.wedgeKey = null; }

  /** いまのゆれ（黒板ごとずらす量） */
  shake(now) {
    if (now > this.shakeUntil || !this.shakeAmp) return null;
    const k = (this.shakeUntil - now) / 380;
    const a = this.shakeAmp * k;
    return { x: (Math.random() * 2 - 1) * a, y: (Math.random() * 2 - 1) * a };
  }

  // ---------------- きっかけ ----------------
  breath(now, box) {
    this.items.push({ kind: 'breath', t0: now, dur: 950 });
    // 光の粒が、まわりから再生位置へ吸いこまれる（＝息を吸う）
    const cx = box.px, cy = box.top + (box.bot - box.top) * 0.45;
    for (let i = 0; i < 34; i++) {
      const ang = Math.random() * Math.PI * 2, r = 120 + Math.random() * 120;
      this.add({ kind: 'inhale', x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r * 0.7, tx: cx, ty: cy, life: 420 + Math.random() * 220, size: 2 + Math.random() * 2.5, color: Math.random() < 0.3 ? CHALK : SKY });
    }
  }

  slam(now, value, level, box) {
    const loud = level != null && level >= 5, soft = level != null && level <= 2;
    this.items.push({ kind: 'slam', t0: now, dur: loud ? 1250 : 1150, value, level, loud, soft });
    const cx = box.px + (box.W - box.px) * 0.34, cy = box.top + (box.bot - box.top) * 0.45;
    if (loud) {
      this.shakeUntil = now + 380; this.shakeAmp = level >= 6 ? 11 : 7;
      for (let i = 0; i < (level >= 6 ? 60 : 40); i++) {
        const ang = Math.random() * Math.PI * 2, sp = 0.35 + Math.random() * 0.6;
        this.add({ kind: 'spark', x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 500 + Math.random() * 400, size: 2 + Math.random() * 3, color: Math.random() < 0.5 ? HOT : GOLD });
      }
    } else if (soft) {
      for (let i = 0; i < 22; i++) this.add({ kind: 'twinkle', x: cx + (Math.random() - 0.5) * 260, y: cy + (Math.random() - 0.5) * 120, vx: 0, vy: -0.015 - Math.random() * 0.02, life: 900 + Math.random() * 500, size: 1.5 + Math.random() * 2, color: SKY });
    } else {
      for (let i = 0; i < 16; i++) {
        const ang = Math.random() * Math.PI * 2, sp = 0.2 + Math.random() * 0.3;
        this.add({ kind: 'spark', x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 450 + Math.random() * 300, size: 2 + Math.random() * 2, color: CHALK });
      }
    }
  }

  /** 声で判定した結果。ok なら金色＋星＋コンボ、だめなら小さく励ます */
  judge(now, kind, ok, info, box) {
    if (ok) { this.combo++; this.comboAt = now; } else this.combo = 0;
    const text = ok
      ? (kind === 'breath' ? 'ナイス息継ぎ！' : kind === 'wedge' ? (info.wedge === 'cresc' ? 'クレッシェンド 決まった！' : 'ディミヌエンド 決まった！') : `${info.value} 決まった！`)
      : (kind === 'breath' ? '息継ぎ、次はしっかり！' : kind === 'wedge' ? (info.wedge === 'cresc' ? 'おしい！もっと強く！' : 'おしい！もっと弱く…') : (info.to > info.from ? 'おしい！もっと強く！' : 'おしい！もっと弱く…'));
    this.items.push({ kind: 'judge', t0: now, dur: ok ? 1300 : 1100, text, ok, combo: this.combo });
    if (ok) {
      const cx = box.px + (box.W - box.px) * 0.5, cy = box.top + 44;
      for (let i = 0; i < 14; i++) {
        const ang = Math.random() * Math.PI * 2, sp = 0.12 + Math.random() * 0.25;
        this.add({ kind: 'star', x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.05, life: 700 + Math.random() * 400, size: 4 + Math.random() * 4, color: GOLD, rot: Math.random() * 6 });
      }
    }
  }

  add(p) { if (this.parts.length < MAX_PARTS) this.parts.push({ age: 0, vx: 0, vy: 0, ...p }); }

  // ---------------- 毎フレーム ----------------
  /**
   * @param box { W, H, top, bot, px, keyW }
   * @param st  { running, breathSoon:{beatsLeft,progress}|null, wedge:{kind,progress,q}|null, level }
   */
  draw(g, box, now, st) {
    const dt = this.last ? Math.min(50, now - this.last) : 16;
    this.last = now;
    g.save();
    g.beginPath(); g.rect(box.keyW, 0, box.W - box.keyW, box.H); g.clip();

    // 画面が白く光る（強くなった瞬間）
    for (const it of this.items) {
      if (it.kind === 'slam' && it.loud) {
        const t = (now - it.t0) / 260;
        if (t < 1) { g.fillStyle = `rgba(255,236,200,${0.34 * (1 - t)})`; g.fillRect(box.keyW, box.top, box.W - box.keyW, box.bot - box.top); }
      }
    }

    // だんだん強く／弱く（続いている間ずっと）
    if (st.running && st.wedge) this.drawWedge(g, box, now, st.wedge, dt);
    else this.wedgeKey = null;

    // 息継ぎまでのカウント（カラオケの前奏の玉）
    if (st.running && st.breathSoon) this.drawBreathDots(g, box, st.breathSoon);

    // 粒
    this.stepParts(g, dt, box);

    // 文字
    this.items = this.items.filter((it) => now - it.t0 < it.dur);
    for (const it of this.items) {
      const t = (now - it.t0) / it.dur;
      if (it.kind === 'breath') this.drawBreath(g, box, now - it.t0, t);
      else if (it.kind === 'slam') this.drawSlam(g, box, now - it.t0, t, it);
      else if (it.kind === 'judge') this.drawJudge(g, box, now - it.t0, t, it);
    }

    // コンボ
    if (this.combo >= 2 && now - this.comboAt < 6000) this.drawCombo(g, box, now);
    g.restore();
  }

  drawBreathDots(g, box, b) {
    const n = clamp(b.beatsLeft, 1, 4);
    const x0 = box.px + 18, y = box.top + 24;
    g.save();
    g.font = `800 17px ${FONT}`;
    g.textBaseline = 'middle'; g.textAlign = 'left';
    outlined(g, '息継ぎまで', x0, y, rgba(SKY), 5);
    const tw = g.measureText('息継ぎまで').width;
    const beatFrac = (b.progress * 2) % 1; // いまの拍の中の進み（2拍前から出る）
    for (let i = 0; i < n; i++) {
      const cx = x0 + tw + 22 + i * 30;
      const last = i === n - 1;
      const r = last ? 11 * (1 - 0.35 * beatFrac) : 11;
      g.fillStyle = rgba(SKY, last ? 1 - 0.5 * beatFrac : 1);
      g.strokeStyle = '#fff'; g.lineWidth = 2.5;
      g.beginPath(); g.arc(cx, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    g.restore();
  }

  drawBreath(g, box, ms, t) {
    const cx = box.px, cy = box.top + (box.bot - box.top) * 0.45;
    // 吸いこむ輪（外から内へ縮む）
    if (ms < 520) {
      const k = ms / 520;
      g.strokeStyle = rgba(SKY, 0.15 + 0.6 * k); g.lineWidth = 3 + 5 * k;
      g.beginPath(); g.ellipse(cx, cy, 170 * (1 - k) + 6, 120 * (1 - k) + 5, 0, 0, Math.PI * 2); g.stroke();
    }
    // 「息継ぎ！」
    const s = ms < 260 ? 0.35 + 0.65 * easeOutBack(ms / 260) : 1;
    const a = t > 0.72 ? 1 - (t - 0.72) / 0.28 : 1;
    const x = Math.min(box.W - 150, cx + 150), y = cy - 36;
    g.save();
    g.globalAlpha = a;
    g.translate(x, y); g.scale(s, s); g.rotate(-0.05);
    g.font = `900 64px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const grd = g.createLinearGradient(0, -34, 0, 34);
    grd.addColorStop(0, '#ffffff'); grd.addColorStop(1, rgba(SKY));
    g.shadowColor = rgba(SKY, 0.9); g.shadowBlur = 24;
    g.lineJoin = 'round'; g.strokeStyle = '#123a4e'; g.lineWidth = 11;
    g.strokeText('息継ぎ！', 0, 0);
    g.shadowBlur = 0;
    g.fillStyle = grd; g.fillText('息継ぎ！', 0, 0);
    g.font = `800 20px ${FONT}`;
    outlined(g, 'すって〜', 0, 50, '#e8f6ff', 6);
    g.restore();
  }

  drawWedge(g, box, now, w, dt) {
    const key = w.kind + w.q;
    if (this.wedgeKey !== key) { this.wedgeKey = key; this.wedgeT0 = now; }
    const p = clamp(w.progress, 0, 1);
    const cresc = w.kind === 'cresc';
    const pop = Math.min(1, (now - this.wedgeT0) / 280);
    const size = cresc ? 30 + 46 * p : 64 - 34 * p;
    const col = cresc ? mix(SKY, HOT, p) : mix(CHALK, SKY, p);
    const text = cresc ? 'だんだん強く' + '！'.repeat(1 + Math.floor(p * 2.99)) : 'だんだん弱く' + '…'.repeat(1 + Math.floor(p * 1.99));
    const jit = cresc ? p * p * 3.5 : 0;
    const x = box.px + (box.W - box.px) * 0.42 + (Math.random() * 2 - 1) * jit;
    const y = box.bot - 58 - (cresc ? p * 18 : 0) + (Math.random() * 2 - 1) * jit;
    g.save();
    g.globalAlpha = cresc ? 1 : 1 - 0.5 * p;
    g.translate(x, y);
    const sc = 0.4 + 0.6 * easeOutBack(pop);
    g.scale(sc, sc);
    g.font = `900 ${Math.round(size)}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = rgba(col, 0.85); g.shadowBlur = cresc ? 10 + 26 * p : 12;
    g.lineJoin = 'round'; g.strokeStyle = cresc ? '#3a1408' : '#10293a'; g.lineWidth = Math.max(6, size * 0.16);
    g.strokeText(text, 0, 0);
    g.shadowBlur = 0;
    const grd = g.createLinearGradient(0, -size / 2, 0, size / 2);
    grd.addColorStop(0, '#ffffff'); grd.addColorStop(1, rgba(col));
    g.fillStyle = grd; g.fillText(text, 0, 0);
    // 進み具合のゲージ
    const gw = Math.max(120, size * 4.2);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(-gw / 2, size * 0.62, gw, 8);
    g.fillStyle = rgba(col); g.fillRect(-gw / 2, size * 0.62, gw * (cresc ? p : 1 - p), 8);
    g.restore();
    // 粒: 強く＝火の粉が舞い上がる／弱く＝雪が降る
    const rate = cresc ? 0.02 + 0.12 * p : 0.035 * (1 - p) + 0.008;
    let n = rate * dt;
    while (n > 0) {
      if (Math.random() < Math.min(1, n)) {
        if (cresc) this.add({ kind: 'ember', x: box.px + (Math.random() - 0.2) * (box.W - box.px) * 0.9, y: box.bot + 4, vx: (Math.random() - 0.5) * 0.04, vy: -(0.08 + 0.22 * p + Math.random() * 0.1), life: 900 + Math.random() * 700, size: 1.5 + 3 * p * Math.random() + 1, color: Math.random() < p ? HOT : GOLD });
        else this.add({ kind: 'snow', x: box.keyW + Math.random() * (box.W - box.keyW), y: box.top - 4, vx: (Math.random() - 0.5) * 0.02, vy: 0.03 + Math.random() * 0.04, life: 2200, size: 1.5 + Math.random() * 2.2, color: Math.random() < 0.5 ? SKY : CHALK });
      }
      n -= 1;
    }
  }

  drawSlam(g, box, ms, t, it) {
    const cx = box.px + (box.W - box.px) * 0.34, cy = box.top + (box.bot - box.top) * 0.45;
    const lv = it.level ?? 4;
    const col = lv >= 5 ? mix(GOLD, HOT, clamp((lv - 5) / 2 + 0.4, 0, 1)) : lv <= 2 ? SKY : CHALK;
    let s = 1, a = 1;
    if (it.loud) s = ms < 150 ? 3 - 2 * easeOut(ms / 150) : 1 + 0.04 * Math.sin((ms - 150) / 40) * Math.max(0, 1 - (ms - 150) / 400);
    else if (it.soft) { s = 1.15 - 0.15 * easeOut(Math.min(1, ms / 500)); a = Math.min(1, ms / 380); }
    else s = ms < 200 ? 0.4 + 0.6 * easeOutBack(ms / 200) : 1;
    if (t > 0.7) a *= 1 - (t - 0.7) / 0.3;
    g.save();
    g.globalAlpha = a;
    g.translate(cx, cy); g.scale(s, s);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const big = it.loud ? 150 : it.soft ? 120 : 128;
    g.font = `italic 700 ${big}px ${SERIF}`;
    g.shadowColor = rgba(col, 0.9); g.shadowBlur = it.loud ? 34 : 18;
    g.lineJoin = 'round'; g.strokeStyle = 'rgba(16,30,26,0.95)'; g.lineWidth = 10;
    g.strokeText(it.value, 0, -10);
    g.shadowBlur = 0;
    g.fillStyle = rgba(col); g.fillText(it.value, 0, -10);
    const shout = DYN_SHOUT[it.value];
    if (shout) {
      g.font = `900 ${it.loud ? 40 : 32}px ${FONT}`;
      outlined(g, shout, 0, big * 0.5 + 8, rgba(mix(col, [255, 255, 255], 0.35)), 8);
    }
    g.restore();
  }

  drawJudge(g, box, ms, t, it) {
    const x = box.px + (box.W - box.px) * 0.5, y = box.top + 44 - 30 * easeOut(Math.min(1, t * 1.4));
    const s = ms < 220 ? 0.5 + 0.5 * easeOutBack(ms / 220) : 1;
    const a = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
    g.save();
    g.globalAlpha = a;
    g.translate(Math.min(box.W - 170, x), y); g.scale(s, s);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (it.ok) {
      g.font = `900 36px ${FONT}`;
      const grd = g.createLinearGradient(0, -20, 0, 20);
      grd.addColorStop(0, '#fff7c2'); grd.addColorStop(0.5, '#ffd04d'); grd.addColorStop(1, '#f39a2e');
      g.shadowColor = 'rgba(255,208,77,0.9)'; g.shadowBlur = 22;
      g.lineJoin = 'round'; g.strokeStyle = '#4a2a06'; g.lineWidth = 9;
      g.strokeText(it.text, 0, 0);
      g.shadowBlur = 0;
      g.fillStyle = grd; g.fillText(it.text, 0, 0);
    } else {
      g.font = `800 24px ${FONT}`;
      outlined(g, it.text, 0, 0, '#cfe3ee', 6);
    }
    g.restore();
  }

  drawCombo(g, box, now) {
    const since = now - this.comboAt;
    const s = since < 240 ? 1 + 0.5 * (1 - easeOut(since / 240)) : 1;
    const x = box.W - 18, y = box.top + 30;
    const hot = this.combo >= 3;
    g.save();
    g.translate(x, y); g.scale(s, s);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    g.font = `900 34px ${FONT}`;
    g.shadowColor = hot ? 'rgba(255,120,60,0.9)' : 'rgba(255,208,77,0.8)'; g.shadowBlur = hot ? 26 : 14;
    g.lineJoin = 'round'; g.strokeStyle = '#3a1a06'; g.lineWidth = 8;
    const text = `${this.combo} コンボ${hot ? '！' : ''}`;
    g.strokeText(text, 0, 0);
    g.shadowBlur = 0;
    g.fillStyle = hot ? '#ff9b5a' : '#ffd04d'; g.fillText(text, 0, 0);
    g.font = `800 13px ${FONT}`;
    outlined(g, '歌い方', 0, 26, '#fff0c8', 4);
    g.restore();
  }

  stepParts(g, dt, box) {
    const keep = [];
    for (const p of this.parts) {
      p.age += dt;
      if (p.age >= p.life) continue;
      const k = p.age / p.life;
      if (p.kind === 'inhale') {
        const e = easeOut(k);
        p.cx = p.x + (p.tx - p.x) * e; p.cy = p.y + (p.ty - p.y) * e;
      } else {
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.kind === 'spark') { p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.0006 * dt; }
        if (p.kind === 'star') { p.vy += 0.0002 * dt; p.rot += 0.008 * dt; }
        if (p.kind === 'ember' || p.kind === 'snow') p.x += Math.sin((p.age + p.size * 300) / 260) * 0.25;
        p.cx = p.x; p.cy = p.y;
      }
      if (p.cy < -20 || p.cy > box.H + 20) continue;
      keep.push(p);
      const a = p.kind === 'inhale' ? Math.min(1, k * 2.5) * (1 - k * 0.3) : p.kind === 'twinkle' ? Math.sin(k * Math.PI) * (0.6 + 0.4 * Math.sin(p.age / 60)) : 1 - k;
      g.fillStyle = rgba(p.color, clamp(a, 0, 1));
      if (p.kind === 'star') drawStar(g, p.cx, p.cy, p.size, p.rot);
      else if (p.kind === 'inhale') {
        g.strokeStyle = rgba(p.color, clamp(a, 0, 1)); g.lineWidth = p.size; g.lineCap = 'round';
        const dx = (p.tx - p.cx) * 0.12, dy = (p.ty - p.cy) * 0.12;
        g.beginPath(); g.moveTo(p.cx - dx, p.cy - dy); g.lineTo(p.cx, p.cy); g.stroke();
      } else { g.beginPath(); g.arc(p.cx, p.cy, p.size, 0, Math.PI * 2); g.fill(); }
    }
    this.parts = keep;
  }
}

function outlined(g, text, x, y, fill, w) {
  g.lineJoin = 'round'; g.strokeStyle = 'rgba(12,24,20,0.92)'; g.lineWidth = w;
  g.strokeText(text, x, y);
  g.fillStyle = fill; g.fillText(text, x, y);
}

function drawStar(g, x, y, r, rot) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r, a = rot + (i * Math.PI) / 5;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath(); g.fill();
}
