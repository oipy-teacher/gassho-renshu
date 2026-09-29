// 歌い方の記号（息継ぎ・強弱・松葉・文字の指示）と、練習中の「合図」の計算
// 画面に依存しない（node の単体テストでも使う）。位置はすべて q（四分音符いくつ分）。
//
// 記号の出どころは2つ:
//   file … 楽譜ファイル（MusicXML）に書いてあったもの。消せない
//   user … この端末で書きこんだもの（S.rec.expr に保存）。息継ぎはパートごと・強弱と松葉は全パート共通

const EPS = 1e-6;

/** 強弱の段（0〜7）。合図の色と「強さの帯」の太さに使う */
export const DYN_LEVEL = { pppp: 0, ppp: 0, pp: 1, p: 2, mp: 3, mf: 4, f: 5, ff: 6, fff: 7, ffff: 7 };
/** アクセント系（その音だけ）: 帯の太さは変えず、記号だけ出す */
const ACCENT_DYN = new Set(['sf', 'sfz', 'sffz', 'fz', 'rf', 'rfz', 'sfp', 'sfpp', 'fp', 'pf', 'n']);
export const DYN_JA = {
  ppp: 'とても とても弱く', pp: 'とても弱く', p: '弱く', mp: '少し弱く', mf: '少し強く', f: '強く', ff: 'とても強く', fff: 'とても とても強く',
  sf: 'その音を強く', sfz: 'その音を強く', fz: 'その音を強く', fp: '強く→すぐ弱く', sfp: '強く→すぐ弱く',
};
/** 書きこみパレットに出す強弱 */
export const DYN_PALETTE = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];

export const levelOf = (v) => (v in DYN_LEVEL ? DYN_LEVEL[v] : null);

/**
 * いま選んでいるパートに効く記号を1つにまとめる
 * @param fileExpr parseMusicXml の expr
 * @param userMarks S.rec.expr.marks（[{id,type,q,endQ?,value?,track?}]）
 * @param track     練習しているトラック（part・voice・key）
 * @param notes     そのトラックの音符（startQ・durQ）
 */
export function mergeExpr(fileExpr, userMarks, track, notes) {
  const fe = fileExpr || { breaths: [], dyns: [], wedges: [], words: [], fermatas: [] };
  const mine = (x) => x.part === track.part;
  const sortedNotes = [...(notes || [])].sort((a, b) => a.startQ - b.startQ);
  // 楽譜の V は「前の音」に付いている（q = その音の終わり）。書きこみと同じく「吸ったあとに歌い出す音の頭」にそろえる
  const nextHead = (q) => { const n = sortedNotes.find((x) => x.startQ >= q - 1e-3); return n ? n.startQ : q; };
  const breaths = [
    ...fe.breaths.filter((b) => mine(b) && b.voice === track.voice).map((b) => ({ q: nextHead(b.q), source: 'file' })),
    ...(userMarks || []).filter((m) => m.type === 'breath' && m.track === track.key).map((m) => ({ q: m.q, source: 'user', id: m.id })),
  ];
  const dyns = [
    ...fe.dyns.filter(mine).map((d) => ({ q: d.q, value: d.value, source: 'file' })),
    ...(userMarks || []).filter((m) => m.type === 'dyn').map((m) => ({ q: m.q, value: m.value, source: 'user', id: m.id })),
  ];
  const wedges = [
    ...fe.wedges.filter(mine).map((w) => ({ startQ: w.startQ, endQ: w.endQ, kind: w.kind, source: 'file' })),
    ...(userMarks || []).filter((m) => m.type === 'wedge').map((m) => ({ startQ: m.q, endQ: m.endQ, kind: m.value, source: 'user', id: m.id })),
  ];
  const words = fe.words.filter(mine).map((w) => ({ q: w.q, text: w.text, source: 'file' }));
  const fermatas = fe.fermatas.filter((f) => mine(f) && f.voice === track.voice).map((f) => ({ q: f.q, source: 'file' }));
  const byQ = (a, b) => a.q - b.q;
  breaths.sort(byQ); dyns.sort(byQ); words.sort(byQ); fermatas.sort(byQ);
  wedges.sort((a, b) => a.startQ - b.startQ);
  // 同じ位置の息継ぎは1つに（ファイルと書きこみが重なったら、ファイルを残す）
  const uniq = [];
  for (const b of breaths) if (!uniq.some((u) => Math.abs(u.q - b.q) < 1e-3)) uniq.push(b);
  return {
    breaths: uniq.map((b) => ({ ...b, zoneQ: breathZoneStart(b.q, sortedNotes) })),
    dyns, wedges, words, fermatas,
    levels: levelSteps(dyns, wedges),
  };
}

/**
 * 息を吸う時間の始まり（q）。
 * 前の音との間に休符があれば、その休符（長くても最後の1拍分）。
 * 休符がなければ、前の音のおしりを少し削って吸う（最大で八分音符ぶん・前の音の半分まで）。
 */
export function breathZoneStart(q, sortedNotes) {
  let prev = null;
  for (const n of sortedNotes) { if (n.startQ < q - EPS) prev = n; else break; }
  if (!prev) return q - 0.5;
  const prevEnd = prev.startQ + prev.durQ;
  if (prevEnd < q - 0.2) return Math.max(prevEnd, q - 1);
  return q - Math.min(0.5, prev.durQ / 2);
}

/**
 * 強さの段の変わり目（松葉は途中を直線でつなぐ）→ [{q, level}]
 * 松葉の終わりの強さ = 終わりの位置（付近）に書いてある強弱。なければ 1段上げる／下げる
 */
export function levelSteps(dyns, wedges) {
  const plain = dyns.filter((d) => levelOf(d.value) !== null).sort((a, b) => a.q - b.q);
  const at = (q) => { let v = null; for (const d of plain) { if (d.q <= q + EPS) v = levelOf(d.value); else break; } return v; };
  const pts = plain.map((d) => ({ q: d.q, level: levelOf(d.value) }));
  for (const w of wedges) {
    const from = at(w.startQ) ?? 4;
    const nextDyn = plain.find((d) => d.q >= w.endQ - 0.5 && d.q <= w.endQ + 1);
    const to = nextDyn ? levelOf(nextDyn.value) : Math.max(0, Math.min(7, from + (w.kind === 'cresc' ? 1 : -1)));
    pts.push({ q: w.startQ, level: from, ramp: true }, { q: w.endQ, level: to });
  }
  pts.sort((a, b) => a.q - b.q || (a.ramp ? -1 : 1));
  return pts;
}

/** その位置の強さ（0〜7・小数あり）。記号がひとつもなければ null */
export function levelAt(steps, q) {
  if (!steps.length || q < steps[0].q - EPS) return null; // 最初の記号より前は「指定なし」
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], n = steps[i + 1];
    if (!n || q < n.q) {
      if (s.ramp && n) return s.level + (n.level - s.level) * ((q - s.q) / Math.max(EPS, n.q - s.q));
      return s.level;
    }
  }
  return steps[steps.length - 1].level;
}

/** いまの強弱記号（最後に出てきたもの）と、その位置 */
export function currentDyn(expr, q) {
  let cur = null;
  for (const d of expr.dyns) { if (d.q <= q + EPS && levelOf(d.value) !== null) cur = d; else if (d.q > q + EPS) break; }
  return cur;
}

/**
 * 練習中の合図
 * @param beatQ その位置の1拍の長さ（q）
 * @returns {{
 *   breath: null | {state:'soon'|'now', beatsLeft:number, progress:number, q:number},
 *   dyn: {value:string|null, level:number|null, next:null|{value,beatsLeft,progress}, flash:null|{value,age}, wedge:null|{kind,progress}}
 * }}
 */
export function cueAt(expr, q, beatQ = 1, lead = 2) {
  const out = { breath: null, dyn: { value: null, level: null, next: null, flash: null, wedge: null } };
  if (!expr) return out;
  const leadQ = lead * beatQ;
  for (const b of expr.breaths) {
    if (q >= b.zoneQ - EPS && q < b.q + 0.08) { out.breath = { state: 'now', beatsLeft: 0, progress: (q - b.zoneQ) / Math.max(EPS, b.q - b.zoneQ), q: b.q }; break; }
    const left = b.zoneQ - q;
    if (left > 0 && left <= leadQ) { out.breath = { state: 'soon', beatsLeft: Math.ceil(left / beatQ - 1e-3), progress: 1 - left / leadQ, q: b.q }; break; }
  }
  const cur = currentDyn(expr, q);
  out.dyn.value = cur ? cur.value : null;
  out.dyn.level = levelAt(expr.levels, q);
  const nextLead = Math.max(leadQ, 4 * beatQ); // 強弱の切り替えは少し早めに知らせる
  const nx = expr.dyns.find((d) => d.q > q + EPS && d.value !== (cur && cur.value));
  if (nx && nx.q - q <= nextLead) out.dyn.next = { value: nx.value, beatsLeft: Math.ceil((nx.q - q) / beatQ - 1e-3), progress: 1 - (nx.q - q) / nextLead };
  for (const d of expr.dyns) {
    const age = (q - d.q) / beatQ;
    if (age >= -EPS && age < 1) out.dyn.flash = { value: d.value, age: Math.max(0, age), q: d.q };
  }
  for (const w of expr.wedges) if (q >= w.startQ - EPS && q < w.endQ) out.dyn.wedge = { kind: w.kind, progress: (q - w.startQ) / Math.max(EPS, w.endQ - w.startQ), q: w.startQ };
  if (!out.dyn.wedge) {
    const w = expr.wedges.find((x) => x.startQ > q + EPS && x.startQ - q <= nextLead);
    if (w && !out.dyn.next) out.dyn.next = { value: w.kind === 'cresc' ? 'cresc.' : 'dim.', beatsLeft: Math.ceil((w.startQ - q) / beatQ - 1e-3), progress: 1 - (w.startQ - q) / nextLead };
  }
  return out;
}

/** 歌い始める位置での強弱（カウント中に「p で入る」と出す） */
export function entryHint(expr, q) {
  if (!expr) return '';
  const d = expr.dyns.find((x) => Math.abs(x.q - q) < 0.26 && levelOf(x.value) !== null) || currentDyn(expr, q + 0.26);
  return d ? d.value : '';
}

/**
 * 休符の所に息継ぎの候補（八分休符以上。1拍に満たない音のすぐ後の短い休符も含む）
 * @returns q の配列（息を吸ったあとに歌い出す音の頭）
 */
export function autoBreaths(notes, minRestQ = 0.5) {
  const ns = [...notes].sort((a, b) => a.startQ - b.startQ);
  const out = [];
  for (let i = 1; i < ns.length; i++) {
    const prevEnd = ns[i - 1].startQ + ns[i - 1].durQ;
    if (ns[i].startQ - prevEnd >= minRestQ - EPS) out.push(ns[i].startQ);
  }
  return out;
}

/** 書きこみの吸着: 息継ぎは自分の音符の頭（吸ったあと歌い出す音）へ */
export function snapToNoteHead(notes, q) {
  let best = null;
  for (const n of notes) if (!best || Math.abs(n.startQ - q) < Math.abs(best - q)) best = n.startQ;
  return best ?? q;
}

// ---------------- 合図どおりに歌えたか（マイクの声から判定。ごほうびの演出に使う） ----------------
// frames: [{sec(楽譜の秒), f0, db}]（10ms ごと）。r = テンポの倍率（楽譜の秒 ÷ r = 実際の秒）
const voiced = (f, quietDb) => f.f0 > 0 && f.db > quietDb;
const meanDb = (fs) => fs.reduce((a, f) => a + f.db, 0) / fs.length;
const within = (frames, a, b) => frames.filter((f) => f.sec >= a && f.sec < b);

/** 息継ぎ: 吸う時間に、声の切れ目（実時間で 0.1 秒ほど）があったか。直前に歌っていなければ判定しない（null） */
export function judgeBreath(frames, zoneSec, sec, r = 1, quietDb = -58) {
  const before = within(frames, zoneSec - 0.6 * r, zoneSec);
  if (before.filter((f) => voiced(f, quietDb)).length < 10) return null;
  const zone = within(frames, zoneSec - 0.04 * r, sec + 0.06 * r);
  if (zone.length < 3) return null;
  let run = 0, best = 0, prev = null;
  for (const f of zone) {
    if (!voiced(f, quietDb)) { run += prev ? f.sec - prev.sec : 0.01 * r; best = Math.max(best, run); } else run = 0;
    prev = f;
  }
  const need = Math.max(0.06, Math.min(0.12, 0.5 * (sec - zoneSec) / r));
  return { ok: best / r >= need - 1e-6, silentSec: +(best / r).toFixed(3) };
}

/** だんだん強く／弱く: 松葉の最初の3割と最後の3割で、声の大きさ（dB）が 2dB 以上変わったか */
export function judgeWedge(frames, startSec, endSec, kind, quietDb = -58) {
  const len = endSec - startSec;
  const a = within(frames, startSec, startSec + len * 0.3).filter((f) => voiced(f, quietDb));
  const b = within(frames, endSec - len * 0.3, endSec).filter((f) => voiced(f, quietDb));
  if (a.length < 8 || b.length < 8) return null;
  const diff = meanDb(b) - meanDb(a);
  return { ok: kind === 'cresc' ? diff >= 2 : diff <= -2, diffDb: +diff.toFixed(1) };
}

/** 強弱の切り替え（p → f など）: 前後 1.5 拍ずつの声の大きさが、向きどおりに 2.5dB 以上変わったか */
export function judgeDyn(frames, sec, beatSec, fromLevel, toLevel, quietDb = -58) {
  if (fromLevel == null || toLevel == null || fromLevel === toLevel) return null;
  const a = within(frames, sec - 1.5 * beatSec, sec).filter((f) => voiced(f, quietDb));
  const b = within(frames, sec + 0.1 * beatSec, sec + 1.6 * beatSec).filter((f) => voiced(f, quietDb));
  if (a.length < 8 || b.length < 8) return null;
  const diff = meanDb(b) - meanDb(a);
  return { ok: toLevel > fromLevel ? diff >= 2.5 : diff <= -2.5, diffDb: +diff.toFixed(1) };
}

/**
 * ある区間で判定する記号の一覧（歌う区間 [fromSec, toSec] の中にあるもの）
 * @param rollExpr 秒に直した記号（Roll.expr）
 * @returns [{kind:'breath'|'wedge'|'dyn', key, evalSec, ...}]  evalSec = この時刻までの声が集まったら判定できる
 */
export function judgeTargets(rollExpr, fromSec, toSec, beatSecAt) {
  if (!rollExpr) return [];
  const out = [];
  for (const b of rollExpr.breaths) {
    if (b.zoneSec > fromSec + 0.3 && b.sec <= toSec + 1e-6) out.push({ kind: 'breath', key: 'b' + b.q, zoneSec: b.zoneSec, sec: b.sec, evalSec: b.sec + 0.08 });
  }
  for (const w of rollExpr.wedges) {
    if (w.startSec >= fromSec - 1e-6 && w.endSec <= toSec + 1e-6) out.push({ kind: 'wedge', key: 'w' + w.startQ, wedge: w.kind, startSec: w.startSec, endSec: w.endSec, evalSec: w.endSec + 0.05 });
  }
  let prevLevel = null;
  for (const d of rollExpr.dyns) {
    const lv = levelOf(d.value);
    if (lv == null) continue;
    const bs = beatSecAt(d.sec);
    // 松葉がそのまま流れこむ強弱（cresc. → f）は、急に変わる所ではないので判定しない（松葉の方で判定する）
    const led = rollExpr.wedges.some((w) => Math.abs(w.endSec - d.sec) < bs + 1e-6);
    if (prevLevel != null && lv !== prevLevel && !led && d.sec - 1.5 * bs >= fromSec && d.sec + 1.6 * bs <= toSec + 1e-6) {
      out.push({ kind: 'dyn', key: 'd' + d.q, value: d.value, from: prevLevel, to: lv, sec: d.sec, beatSec: bs, evalSec: d.sec + 1.6 * bs });
    }
    prevLevel = lv;
  }
  return out.sort((a, b) => a.evalSec - b.evalSec);
}

// ---------------- 楽譜ファイルへの書き戻し ----------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const DYN_SOUND = { ppp: 18, pp: 36, p: 54, mp: 71, mf: 89, f: 106, ff: 124, fff: 141 };

/**
 * 書きこんだ記号を MusicXML に書き足す（元の文字列に差し込むだけ。ほかの所は1文字も変えない）
 * @param xml       元の MusicXML（parseMusicXml に渡したのと同じ文字列）
 * @param score     parseMusicXml(xml) の結果
 * @param userMarks [{type,q,endQ?,value?,track?}]
 * @returns { xml, added:{breath,dyn,wedge}, skipped }
 */
export function writeMarksToXml(xml, score, userMarks) {
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1); // 位置は BOM を除いた文字列で数えている
  const ins = [];
  const added = { breath: 0, dyn: 0, wedge: 0 };
  let skipped = 0;
  const vocalParts = [...new Set(score.tracks.filter((t) => !t.isPiano).map((t) => t.part))];
  const anchorsOf = (part) => score.src.anchors.filter((a) => a.part === part);

  // 方向記号（強弱・松葉）を、その位置の音符（なければ直前の音符＋ずらし）の前に入れる
  const direction = (part, q, inner, soundAttr = '') => {
    const as = anchorsOf(part);
    // 同じ位置に音符（休符）の頭があればその前。なければ、手前でいちばん近い頭の前に置いて <offset> でずらす
    let a = as.find((x) => !x.end && Math.abs(x.q - q) < 1e-6) || null;
    if (!a) for (const x of as) if (x.q <= q + 1e-6 && (!a || x.q > a.q + 1e-9 || (Math.abs(x.q - a.q) < 1e-9 && a.end))) a = x;
    if (!a) return false;
    const off = Math.round((q - a.q) * a.div);
    const offset = off > 0 ? `<offset>${off}</offset>` : '';
    ins.push({ at: a.at, text: `<direction placement="below"><direction-type>${inner}</direction-type>${offset}${soundAttr}</direction>` });
    return true;
  };

  for (const m of userMarks || []) {
    if (m.type === 'breath') {
      const tr = score.tracks.find((t) => t.key === m.track);
      if (!tr) { skipped++; continue; }
      // 息継ぎの q = 吸ったあとに歌い出す音の頭 → その前の音（のタイの最後）に V を付ける
      const ns = tr.noteIds.map((id) => score.notes[id]).filter((n) => n.startQ < m.q - 1e-6);
      const prev = ns.sort((a, b) => a.startQ - b.startQ)[ns.length - 1];
      if (!prev || !prev.srcEnd) { skipped++; continue; }
      const s = prev.srcEnd;
      if (s.notationsAt != null) ins.push({ at: s.notationsAt, text: '<articulations><breath-mark/></articulations>' });
      else ins.push({ at: s.insertAt, text: '<notations><articulations><breath-mark/></articulations></notations>' });
      added.breath++;
    } else if (m.type === 'dyn') {
      const snd = DYN_SOUND[m.value] ? `<sound dynamics="${DYN_SOUND[m.value]}"/>` : '';
      let ok = false;
      for (const p of vocalParts) ok = direction(p, m.q, `<dynamics><${esc(m.value)}/></dynamics>`, snd) || ok;
      if (ok) added.dyn++; else skipped++;
    } else if (m.type === 'wedge') {
      let ok = false;
      const type = m.value === 'cresc' ? 'crescendo' : 'diminuendo';
      for (const p of vocalParts) {
        const a = direction(p, m.q, `<wedge type="${type}" number="9"/>`);
        const b = a && direction(p, m.endQ, '<wedge type="stop" number="9"/>');
        ok = ok || (a && b);
      }
      if (ok) added.wedge++; else skipped++;
    }
  }
  // 後ろから差し込む（前の位置がずれないように）。同じ位置は入れた順を保つ
  ins.forEach((x, i) => { x.i = i; });
  ins.sort((a, b) => b.at - a.at || b.i - a.i);
  let out = xml;
  for (const x of ins) out = out.slice(0, x.at) + x.text + out.slice(x.at);
  return { xml: out, added, skipped };
}
