// 練習番号（Intro, A, B …）→ 練習する小節の範囲
// marks: [{ label, measure }]（measure は楽譜の小節番号）  measures: parseMusicXml の measures

/** @returns [{ label, fromIdx, toIdx }]（小節のインデックス。toIdx は次の練習番号の手前まで） */
export function sections(marks, measures) {
  if (!marks || !marks.length || !measures.length) return [];
  const pts = [];
  for (const m of marks) {
    const idx = measures.findIndex((x) => x.number === String(m.measure));
    if (idx < 0 || pts.some((p) => p.fromIdx === idx)) continue;
    pts.push({ label: String(m.label), fromIdx: idx });
  }
  pts.sort((a, b) => a.fromIdx - b.fromIdx);
  if (pts.length && pts[0].fromIdx > 0) pts.unshift({ label: '冒頭', fromIdx: 0 });
  return pts.map((p, i) => ({ ...p, toIdx: i + 1 < pts.length ? pts[i + 1].fromIdx - 1 : measures.length - 1 }));
}

/** その小節が入っている練習番号 */
export function sectionOf(secs, idx) {
  let hit = null;
  for (const s of secs) if (s.fromIdx <= idx && idx <= s.toIdx) hit = s;
  return hit;
}
