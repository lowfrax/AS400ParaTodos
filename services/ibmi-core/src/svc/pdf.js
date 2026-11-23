// Conversión de archivos en spool a PDF (como "Transform Services" / CPYSPLF a *PDF): Courier, apaisado,
// con franjas de papel continuo opcionales. PDF 1.4 mínimo escrito a mano, sin dependencias.
export function spoolToPdf(lines, { title = 'Spooled file', perPage = 60, greenbar = true } = {}) {
  const pages = [];
  for (let i = 0; i < Math.max(1, lines.length); i += perPage) pages.push(lines.slice(i, i + perPage));
  const W = 792, H = 612, fs = 8, lh = 9.4, left = 30, top = H - 36;
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, (c) => {
    const code = c.charCodeAt(0);
    return code < 256 ? `\\${code.toString(8).padStart(3, '0')}` : '?';
  });
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  const pagesIdPlaceholder = objs.length + 1 + pages.length * 2;
  pages.forEach((pl, pi) => {
    let content = '';
    if (greenbar) {
      content += '0.86 0.95 0.86 rg\n';
      for (let k = 0; k < perPage; k += 6) content += `${left - 6} ${top - (k + 3) * lh + 2} ${W - 2 * left + 12} ${3 * lh} re f\n`;
    }
    content += `0 0 0 rg BT /F1 ${fs} Tf ${lh} TL ${left} ${top} Td\n`;
    for (const l of pl) content += `(${esc(l)}) Tj T*\n`;
    content += `ET\nBT /F1 7 Tf ${W - 150} 18 Td (${esc(`${title}  -  page ${pi + 1}/${pages.length}`)}) Tj ET\n`;
    const cid = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesIdPlaceholder} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${cid} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`));
  });
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  if (pagesId !== pagesIdPlaceholder) throw new Error('PDF object numbering mismatch');
  const infoId = add(`<< /Title (${esc(title)}) /Producer (AS400 para Todos) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`);
  const catId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
