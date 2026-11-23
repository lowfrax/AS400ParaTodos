// Analizador XML mínimo (sin dependencias) para SOAP, XMLSERVICE e ISO 20022: elementos, atributos, texto,
// CDATA, comentarios, entidades. No valida DTD ni esquemas.
export function parseXml(src) {
  const s = String(src);
  let i = 0;
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  while (i < s.length) {
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith('<![CDATA[', i)) { const e = s.indexOf(']]>', i); const t = s.slice(i + 9, e < 0 ? s.length : e); top().text += t; top().children.push({ name: '#text', text: t }); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith('<?', i)) { const e = s.indexOf('?>', i); i = e < 0 ? s.length : e + 2; continue; }
    if (s.startsWith('<!', i)) { const e = s.indexOf('>', i); i = e < 0 ? s.length : e + 1; continue; }
    if (s[i] === '<') {
      if (s[i + 1] === '/') {
        const e = s.indexOf('>', i);
        const name = s.slice(i + 2, e).trim();
        while (stack.length > 1) { const n = stack.pop(); if (n.name === name) break; }
        i = e + 1;
        continue;
      }
      let j = i + 1;
      while (j < s.length && !/[\s/>]/.test(s[j])) j++;
      const name = s.slice(i + 1, j);
      const node = { name, attrs: {}, children: [], text: '' };
      // atributos
      const attrRe = /\s*([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/y;
      for (;;) {
        attrRe.lastIndex = j;
        const m = attrRe.exec(s);
        if (!m) break;
        node.attrs[m[1]] = decode(m[3] ?? m[4] ?? '');
        j = attrRe.lastIndex;
      }
      while (j < s.length && /\s/.test(s[j])) j++;
      const selfClose = s[j] === '/';
      const e = s.indexOf('>', j);
      top().children.push(node);
      if (!selfClose) stack.push(node);
      i = e < 0 ? s.length : e + 1;
      continue;
    }
    const e = s.indexOf('<', i);
    const t = decode(s.slice(i, e < 0 ? s.length : e));
    if (t) { top().text += t; if (t.trim()) top().children.push({ name: '#text', text: t }); }
    i = e < 0 ? s.length : e;
  }
  return root;
}

function decode(t) {
  return t.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    return String.fromCodePoint(Number(k.slice(1)));
  });
}

export const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const local = (n) => String(n || '').replace(/^.*:/, '');
export const elems = (n) => (n?.children || []).filter((c) => c.name !== '#text');
export const child = (n, name) => elems(n).find((c) => local(c.name).toLowerCase() === String(name).toLowerCase());
export const children = (n, name) => elems(n).filter((c) => local(c.name).toLowerCase() === String(name).toLowerCase());
export const textOf = (n) => (n ? n.text.trim() : '');
/** Recorre un camino de nombres locales: path(doc, 'Envelope', 'Body'). */
export function path(n, ...names) {
  let cur = n;
  for (const nm of names) { cur = child(cur, nm); if (!cur) return null; }
  return cur;
}
