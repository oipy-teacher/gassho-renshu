// 小さなXMLパーサ（ブラウザとnodeの両方で同じコードを使うため、DOMParserに頼らない）
// MusicXMLを読むのに必要な範囲だけ: 要素・属性・テキスト・CDATA・コメント・PI・DOCTYPE・実体参照。

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[e] !== undefined ? ENT[e] : m;
  });
}

export class XmlError extends Error {}

/** @returns {{name:string, attrs:Object, children:Array, text:string, start:number, innerStart:number, innerEnd:number, end:number}} ルート要素 */
export function parseXml(src) {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { appendText(stack, src.slice(i)); break; }
    if (lt > i) appendText(stack, src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('コメントが閉じていません');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('CDATAが閉じていません');
      appendRaw(stack, src.slice(lt + 9, end));
      i = end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError('処理命令が閉じていません');
      i = end + 2;
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE（内部サブセット [ ... ] にも対応）
      let j = lt + 2, depth = 0;
      for (; j < n; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      if (end < 0) throw new XmlError('閉じタグが壊れています');
      const name = src.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new XmlError(`タグの対応が合いません: </${name}>`);
      top.innerEnd = lt; // 閉じタグの '<' の位置（書き戻し用）
      top.end = end + 1;
      i = end + 1;
    } else {
      // 開始タグ。属性値の中の > に注意して終わりを探す
      let j = lt + 1, quote = null;
      for (; j < n; j++) {
        const c = src[j];
        if (quote) { if (c === quote) quote = null; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= n) throw new XmlError('開始タグが閉じていません');
      let body = src.slice(lt + 1, j);
      let selfClose = false;
      if (body.endsWith('/')) { selfClose = true; body = body.slice(0, -1); }
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) throw new XmlError('タグ名がありません');
      // start/innerStart/innerEnd/end = 元の文字列での位置（記号を書き足して書き出すときに使う）
      const el = { name: m[1], attrs: {}, children: [], text: '', start: lt, innerStart: j + 1, innerEnd: j + 1, end: j + 1, selfClose };
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      const rest = body.slice(m[1].length);
      while ((a = re.exec(rest))) el.attrs[a[1]] = decodeEntities(a[3] !== undefined ? a[3] : a[4]);
      stack[stack.length - 1].children.push(el);
      if (!selfClose) stack.push(el);
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError(`閉じていないタグがあります: <${stack[stack.length - 1].name}>`);
  const top = root.children.find((c) => typeof c === 'object');
  if (!top) throw new XmlError('XMLの中身が空です');
  return top;
}

function appendText(stack, raw) {
  appendRaw(stack, decodeEntities(raw));
}
function appendRaw(stack, s) {
  const top = stack[stack.length - 1];
  if (top) top.text += s;
}

// ---- 読み取り用の小道具 ----
export function kids(el, name) {
  if (!el) return [];
  return name ? el.children.filter((c) => c.name === name) : el.children;
}
export function kid(el, name) {
  if (!el) return null;
  for (const c of el.children) if (c.name === name) return c;
  return null;
}
export function txt(el, name) {
  const c = name ? kid(el, name) : el;
  return c ? c.text.trim() : '';
}
export function num(el, name, dflt = NaN) {
  const t = txt(el, name);
  if (t === '') return dflt;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : dflt;
}
