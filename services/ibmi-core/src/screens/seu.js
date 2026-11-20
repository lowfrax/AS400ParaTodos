// SEU (Source Entry Utility): editor de miembros fuente con órdenes de línea.
import { Panel, padR } from '../panel.js';
import { gw, readMember, findMember, addMember, writeMember, updateMemberInfo, createSpool, findObject } from '../objects.js';
import { CLError } from '../messages.js';

const ROWS = 18; // filas 4..21
const WIDTH = 71;
const fmtSeq = (s) => (s === null || s === undefined ? "'''''''" : s.toFixed(2).padStart(7, '0'));

export async function seu(ctx, { lib, file, mbr, type = '', mode = 'edit', text = '' }) {
  const fo = await findObject(gw, file, '*FILE', lib, []);
  if (!fo) throw new CLError('CPF9812', file, lib);
  let mi = await findMember(gw, lib, file, mbr, []);
  if (!mi) {
    if (mode === 'browse') throw new CLError('CPF9815', mbr, file, lib);
    await addMember(lib, file, mbr, type || 'TXT', text);
    mi = { TYPE: type || 'TXT', TEXT: text };
  }
  const src = await readMember(gw, lib, file, mbr);
  let lines = src.map((l) => ({ seq: l.seq, dat: l.dat, text: l.text }));
  const browse = mode === 'browse';
  let top = 0; // índice en la lista virtual [BEGIN, ...lines, END]
  let left = 0;
  let message = { id: '', text: '(C) COPYRIGHT IBM CORP. 1981, 2009.', sev: 0 };
  let changed = false;
  let seuCmd = '';
  let lastFind = '';
  let pendingBlock = null; // {cmd:'CC'|'MM'|'DD'|'RR', idx}
  let pendingSrc = null;   // {kind:'C'|'M', from, to}
  let cursorRow = null;
  const today = () => { const d = new Date(); return Number(`${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`); };

  const virt = () => lines.length + 2;
  const assignSeqs = () => {
    // Asigna números de secuencia a líneas nuevas interpolando entre vecinas.
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].seq !== null && lines[i].seq !== undefined) continue;
      let j = i;
      while (j < lines.length && (lines[j].seq === null || lines[j].seq === undefined)) j++;
      const prev = i > 0 ? lines[i - 1].seq : 0;
      const next = j < lines.length ? lines[j].seq : prev + (j - i + 1);
      const step = (next - prev) / (j - i + 1);
      for (let k = i; k < j; k++) lines[k].seq = step >= 0.01 ? +(prev + step * (k - i + 1)).toFixed(2) : +(prev + 0.01 * (k - i + 1)).toFixed(2);
    }
  };

  for (;;) {
    const p = new Panel({ fn: `CMD-STRSEU`, keys: ['F3', 'F4', 'F5', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F19', 'F20', 'F24', 'PAGEUP', 'PAGEDOWN'] });
    p.text(1, 2, 'Columns . . . :', 'g');
    p.text(1, 18, `${String(left + 1).padStart(4)} ${String(left + WIDTH).padStart(3)}`, 'w');
    p.text(1, 36, browse ? 'Browse' : 'Edit', 'w');
    const qn = `${lib}/${file}`;
    p.text(1, 81 - qn.length, qn, 'w');
    p.text(2, 2, 'SEU==>', 'g');
    p.input('SEUCMD', 2, 9, 54, { value: seuCmd, lower: true });
    p.text(2, 81 - mbr.length - 1, mbr, 'w');
    const ruler = ' ...+... 1 ...+... 2 ...+... 3 ...+... 4 ...+... 5 ...+... 6 ...+... 7 ...+... 8 ...+... 9 ...+... 0';
    p.text(3, 2, 'FMT **', 'w');
    p.text(3, 10, ruler.slice(left, left + WIDTH), 'w');
    const visible = [];
    for (let i = 0; i < ROWS; i++) {
      const v = top + i;
      if (v >= virt()) break;
      const row = 4 + i;
      if (v === 0) {
        p.input(`S${i}`, row, 2, 7, { value: '', attr: 'g' });
        p.text(row, 10, '*************** Beginning of data *************************************', 'w');
        visible.push({ v, idx: -1 });
      } else if (v === virt() - 1) {
        p.input(`S${i}`, row, 2, 7, { value: '', attr: 'g' });
        p.text(row, 10, '****************** End of data ****************************************', 'w');
        visible.push({ v, idx: lines.length });
      } else {
        const L = lines[v - 1];
        const seqStr = L.ins ? "'''''''" : fmtSeq(L.seq);
        p.input(`S${i}`, row, 2, 7, { value: browse ? seqStr : seqStr, attr: 'g', lower: true });
        const part = L.text.slice(left, left + WIDTH);
        if (browse) p.text(row, 10, part, 'g');
        else p.input(`D${i}`, row, 10, WIDTH, { value: part, attr: 'g', lower: true });
        visible.push({ v, idx: v - 1, seqStr, part });
      }
    }
    p.fkeys('F3=Exit   F4=Prompt   F5=Refresh   F9=Retrieve   F10=Cursor   F11=Toggle', 'F16=Repeat find       F17=Repeat change          F24=More keys');
    if (message) p.msg(message);
    message = null;
    if (cursorRow !== null) { p.cursor = [4 + cursorRow, 10]; cursorRow = null; } else p.cursor = [2, 9];
    seuCmd = '';
    const r = await ctx.display(p);

    // 1) Cambios de datos
    if (!browse) {
      for (let i = 0; i < visible.length; i++) {
        const vis = visible[i];
        if (vis.idx < 0 || vis.idx >= lines.length) continue;
        const nv = (r.fields[`D${i}`] ?? '').replace(/\s+$/, '');
        if (nv !== vis.part.replace(/\s+$/, '')) {
          const L = lines[vis.idx];
          const full = L.text.padEnd(left);
          L.text = (full.slice(0, left) + nv.padEnd(Math.min(WIDTH, Math.max(nv.length, full.length - left))) + full.slice(left + WIDTH)).replace(/\s+$/, '');
          L.dat = today();
          L.typed = true;
          changed = true;
        }
      }
    }
    if (r.aid === 'F3' || r.aid === 'F12') {
      if (browse) return null;
      const ex = await exitScreen(ctx, { lib, file, mbr, text: mi.TEXT, changed });
      if (ex.action === 'return') continue;
      if (ex.action === 'save') {
        const target = { lib: ex.lib, file: ex.file, mbr: ex.mbr };
        lines = lines.filter((l) => !(l.ins && !l.text.trim()));
        if (ex.reseq) lines.forEach((l, i) => { l.seq = +(ex.start + ex.incr * i).toFixed(2); }); else assignSeqs();
        if (target.mbr !== mbr || target.file !== file || target.lib !== lib) {
          const exists = await findMember(gw, target.lib, target.file, target.mbr, []);
          if (!exists) await addMember(target.lib, target.file, target.mbr, mi.TYPE, ex.text);
        }
        await writeMember(target.lib, target.file, target.mbr, lines.map((l) => ({ seq: l.seq, dat: l.dat || 0, text: l.text })));
        await updateMemberInfo(target.lib, target.file, target.mbr, { type: mi.TYPE, text: ex.text });
        if (ex.print) await createSpool(ctx.job, target.mbr, lines.map((l) => `${fmtSeq(l.seq)}  ${l.text}`), { usrdta: target.file });
        return { id: 'EDT0B07', text: `Member ${target.mbr} file ${target.file} in ${target.lib} changed with ${lines.length} records.` };
      }
      return { text: `Member ${mbr} not changed.` };
    }
    if (r.aid === 'F5') { message = { text: 'Display refreshed.' }; continue; }
    if (r.aid === 'F19') { left = Math.max(0, left - 20); continue; }
    if (r.aid === 'F20') { left = Math.min(29, left + 20); continue; }
    if (r.aid === 'PAGEDOWN') { if (top + ROWS - 1 < virt() - 1) top = Math.min(top + ROWS - 1, virt() - 1); else message = { text: 'Bottom of data reached.' }; continue; }
    if (r.aid === 'PAGEUP') { if (top > 0) top = Math.max(0, top - (ROWS - 1)); else message = { text: 'Top of data reached.' }; continue; }
    if (r.aid === 'F4') { message = { text: `Prompting is not available for source type ${mi.TYPE}. Type directly in the source line.` }; continue; }
    if (r.aid === 'F16' && lastFind) { message = doFind(lastFind); continue; }
    if (r.aid === 'F10' || r.aid === 'F11' || r.aid === 'F13' || r.aid === 'F14' || r.aid === 'F15' || r.aid === 'F17' || r.aid === 'F24' || r.aid === 'F9') {
      message = { text: 'Function not available in this SEU session.' };
      continue;
    }

    // 2) Órdenes de línea
    const cmds = [];
    for (let i = 0; i < visible.length; i++) {
      const vis = visible[i];
      const raw = (r.fields[`S${i}`] ?? '');
      const orig = vis.seqStr ?? '';
      if (raw === orig || (!raw.trim() && !orig)) continue;
      let typed;
      const t = raw.replace(/\s+$/, '');
      if (t.length < 7 || !orig) typed = t.trim();
      else {
        let last = -1;
        for (let k = 0; k < 7; k++) if (raw[k] !== orig[k]) last = k;
        typed = raw.slice(0, last + 1).trim();
      }
      if (!typed) continue;
      const m = /^([A-Za-z]+|[<>]{1,2})(\d*)$/.exec(typed);
      if (!m || browse) { message = { text: `Line command ${typed} not valid.`, sev: 30 }; cmds.length = 0; break; }
      cmds.push({ cmd: m[1].toUpperCase(), n: m[2] ? Number(m[2]) : 1, idx: vis.idx, row: i });
    }
    if (cmds.length) {
      const res = applyLineCommands(cmds);
      if (res) message = res;
      changed = true;
    } else {
      // Inserción continua: si se escribió en la última línea insertada, añadir otra.
      const lastIns = lines.findIndex((l) => l.insLast);
      if (lastIns >= 0) {
        const L = lines[lastIns];
        L.insLast = false;
        if (L.typed && L.text.trim()) {
          lines.splice(lastIns + 1, 0, { seq: null, text: '', ins: true, insLast: true });
          const rowInView = lastIns + 2 - top;
          if (rowInView >= ROWS) top = lastIns + 2 - ROWS + 1;
          cursorRow = lastIns + 2 - top;
        }
      }
      lines = lines.filter((l) => !(l.ins && !l.typed && !l.text.trim() && !l.insLast));
      for (const l of lines) { if (l.typed) { l.ins = false; } l.typed = false; }
    }
    assignSeqs();

    // 3) Mandato SEU
    const sc = (r.fields.SEUCMD || '').trim();
    if (sc) {
      const U = sc.toUpperCase();
      let m;
      if (U === 'TOP' || U === 'T') top = 0;
      else if (U === 'BOTTOM' || U === 'BOT' || U === 'B') top = Math.max(0, virt() - ROWS);
      else if ((m = /^F(?:IND)?\s+(?:'([^']*)'|(\S+))/i.exec(sc))) { lastFind = m[1] ?? m[2]; message = doFind(lastFind); }
      else if ((m = /^C(?:HANGE)?\s+(?:'([^']*)'|(\S+))\s+(?:'([^']*)'|(\S+))(\s+ALL)?/i.exec(sc))) {
        const from = m[1] ?? m[2]; const to = m[3] ?? m[4];
        let n = 0;
        for (const l of lines) {
          if (!l.text.includes(from)) continue;
          if (m[5]) { n += l.text.split(from).length - 1; l.text = l.text.split(from).join(to); } else if (!n) { l.text = l.text.replace(from, to); n = 1; }
          l.dat = today();
        }
        changed = changed || n > 0;
        message = { text: n ? `${n} occurrence(s) of '${from}' changed.` : `String '${from}' not found.` };
      } else if (U === 'SAVE') {
        assignSeqs();
        lines = lines.filter((l) => !(l.ins && !l.text.trim()));
        await writeMember(lib, file, mbr, lines.map((l) => ({ seq: l.seq, dat: l.dat || 0, text: l.text })));
        changed = false;
        message = { text: `Member ${mbr} saved.` };
      } else if (U === 'FILE') {
        assignSeqs();
        lines = lines.filter((l) => !(l.ins && !l.text.trim()));
        await writeMember(lib, file, mbr, lines.map((l) => ({ seq: l.seq, dat: l.dat || 0, text: l.text })));
        return { text: `Member ${mbr} file ${file} in ${lib} changed with ${lines.length} records.` };
      } else if (U === 'CAN' || U === 'CANCEL') return { text: `Member ${mbr} not changed.` };
      else if ((m = /^([+-]?)(\d+)$/.exec(U))) {
        const n = Number(m[2]);
        if (m[1] === '+') top = Math.min(virt() - 1, top + n);
        else if (m[1] === '-') top = Math.max(0, top - n);
        else { const i = lines.findIndex((l) => l.seq >= n); top = i >= 0 ? i + 1 : virt() - 1; }
      } else message = { text: `SEU command ${sc} not valid.`, sev: 30 };
    }
  }

  function doFind(str) {
    const start = Math.max(0, top);
    for (let i = start; i < lines.length; i++) {
      if (i + 1 === top) continue;
      if (lines[i].text.toUpperCase().includes(str.toUpperCase())) {
        top = i + 1;
        cursorRow = 0;
        return { text: `String '${str}' found.` };
      }
    }
    return { text: `String '${str}' not found.`, sev: 30 };
  }

  function applyLineCommands(cmds) {
    // Las órdenes de bloque (CC, DD, MM, RR) se emparejan; A/B son destinos.
    const target = cmds.find((c) => c.cmd === 'A' || c.cmd === 'B');
    const blocks = {};
    const singles = [];
    for (const c of cmds) {
      if (['CC', 'DD', 'MM', 'RR'].includes(c.cmd)) (blocks[c.cmd] = blocks[c.cmd] || []).push(c);
      else if (c.cmd !== 'A' && c.cmd !== 'B') singles.push(c);
    }
    let msgOut = null;
    const realIdx = (c) => Math.min(Math.max(c.idx, 0), lines.length - 1);
    const ops = [];
    for (const [k, arr] of Object.entries(blocks)) {
      if (pendingBlock && pendingBlock.cmd === k && arr.length === 1) arr.unshift(pendingBlock);
      if (arr.length === 1) { pendingBlock = arr[0]; return { text: `Block command ${k} pending.` }; }
      pendingBlock = null;
      const a = realIdx(arr[0]); const b = realIdx(arr[1]);
      ops.push({ cmd: k[0], from: Math.min(a, b), to: Math.max(a, b), n: 1 });
    }
    for (const c of singles) {
      const i = c.idx;
      switch (c.cmd) {
        case 'I': ops.push({ cmd: 'I', at: i, n: c.n }); break;
        case 'D': ops.push({ cmd: 'D', from: realIdx(c), to: Math.min(realIdx(c) + c.n - 1, lines.length - 1) }); break;
        case 'C': case 'M': ops.push({ cmd: c.cmd, from: realIdx(c), to: Math.min(realIdx(c) + c.n - 1, lines.length - 1) }); break;
        case 'R': ops.push({ cmd: 'R', from: realIdx(c), to: realIdx(c), n: c.n }); break;
        default: return { text: `Line command ${c.cmd} not valid.`, sev: 30 };
      }
    }
    // Copia/mover necesitan destino A o B (pendiente si no hay)
    const cm = ops.find((o) => o.cmd === 'C' || o.cmd === 'M');
    if (cm && !target) { pendingSrc = cm; return { text: `${cm.cmd === 'C' ? 'Copy' : 'Move'} pending. Specify target with A (after) or B (before).` }; }
    if (!cm && target && pendingSrc) ops.push(pendingSrc);
    const src = ops.find((o) => o.cmd === 'C' || o.cmd === 'M');
    if (src && target) {
      pendingSrc = null;
      const chunk = lines.slice(src.from, src.to + 1).map((l) => ({ ...l, seq: null, dat: today() }));
      let at = target.cmd === 'A' ? target.idx + 1 : target.idx;
      if (target.idx < 0) at = 0;
      if (src.cmd === 'M') {
        lines.splice(src.from, src.to - src.from + 1);
        if (at > src.to) at -= (src.to - src.from + 1);
      }
      lines.splice(Math.max(0, Math.min(at, lines.length)), 0, ...chunk);
      msgOut = { text: `${chunk.length} line(s) ${src.cmd === 'C' ? 'copied' : 'moved'}.` };
    }
    // Resto de operaciones de abajo arriba para no desplazar índices
    const rest = ops.filter((o) => o.cmd !== 'C' && o.cmd !== 'M').sort((a, b) => (b.from ?? b.at) - (a.from ?? a.at));
    for (const o of rest) {
      if (o.cmd === 'D') { lines.splice(o.from, o.to - o.from + 1); msgOut = msgOut || { text: `${o.to - o.from + 1} line(s) deleted.` }; }
      if (o.cmd === 'R') {
        const chunk = lines.slice(o.from, o.to + 1);
        const copies = [];
        for (let k = 0; k < o.n; k++) copies.push(...chunk.map((l) => ({ ...l, seq: null, dat: today() })));
        lines.splice(o.to + 1, 0, ...copies);
      }
      if (o.cmd === 'I') {
        const at = o.at < 0 ? 0 : Math.min(o.at + 1, lines.length);
        const news = Array.from({ length: o.n }, (_, k) => ({ seq: null, text: '', ins: true, insLast: o.n === 1 && k === 0 }));
        lines.splice(at, 0, ...news);
        const rowInView = at + 1 - top;
        if (rowInView >= ROWS) top = at + 1 - Math.floor(ROWS / 2);
        cursorRow = at + 1 - top;
      }
    }
    return msgOut;
  }
}

async function exitScreen(ctx, { lib, file, mbr, text, changed }) {
  const p = new Panel({ fn: 'CMD-STRSEU', keys: ['F3', 'F4', 'F5', 'F12'] });
  p.center(1, 'Exit', 'w');
  p.text(3, 2, 'Type choices, press Enter.', 'b');
  const L = (row, col, label, width, name, len, value, hint) => {
    p.label(row, col, label, width);
    p.input(name, row, 37, len, { value });
    if (hint) p.text(row, 51, hint, 'g');
  };
  L(5, 4, 'Change/create member', 33, 'CHG', 1, changed ? 'Y' : 'N', 'Y=Yes, N=No');
  L(6, 6, 'Member', 31, 'MBR', 10, mbr, 'Name, F4 for list');
  L(7, 6, 'File', 31, 'FILE', 10, file, 'Name, F4 for list');
  p.label(8, 8, 'Library', 29); p.input('LIB', 8, 39, 10, { value: lib }); p.text(8, 51, 'Name', 'g');
  p.label(9, 6, 'Text', 31); p.input('TEXT', 9, 37, 40, { value: text || '', lower: true });
  L(10, 6, 'Resequence member', 31, 'RESEQ', 1, 'Y', 'Y=Yes, N=No');
  L(11, 8, 'Start', 29, 'START', 7, '0001.00', '0000.01-9999.99');
  L(12, 8, 'Increment', 29, 'INCR', 5, '01.00', '00.01-99.99');
  L(13, 4, 'Print member', 33, 'PRINT', 1, 'N', 'Y=Yes, N=No');
  L(14, 4, 'Return to editing', 33, 'RETURN', 1, 'N', 'Y=Yes, N=No');
  L(15, 4, 'Go to member list', 33, 'GOLIST', 1, 'Y', 'Y=Yes, N=No');
  p.fkeys('F3=Exit   F4=Prompt   F5=Refresh   F12=Cancel');
  p.cursorTo('CHG');
  const r = await ctx.display(p);
  const f = (n) => (r.fields[n] || '').trim().toUpperCase();
  if (r.aid === 'F12' || f('RETURN') === 'Y') return { action: 'return' };
  if (f('CHG') !== 'Y') return { action: 'quit' };
  return {
    action: 'save', mbr: f('MBR') || mbr, file: f('FILE') || file, lib: f('LIB') || lib, text: (r.fields.TEXT || '').trim(),
    reseq: f('RESEQ') !== 'N', start: Number(f('START')) || 1, incr: Number(f('INCR')) || 1, print: f('PRINT') === 'Y',
  };
}

export { padR };
