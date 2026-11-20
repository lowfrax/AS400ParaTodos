// Archivos de pantalla (DSPF): composición de formatos con OVERLAY, indicadores, subarchivos y EXFMT.
import { Panel } from '../panel.js';
import { SYS, sysDate, sysTime } from '../system.js';
import { editc } from '../../../../shared/rpg/types.js';

const COLOR_ATTR = { green: 'g', white: 'w', blue: 'b', red: 'r', turquoise: 't', yellow: 'y', pink: 'p' };
const AIDS_F = (n) => `F${n}`;

function condOn(cond, ind) {
  if (!cond || !cond.length) return true;
  return cond.every(({ ind: i, not }) => ((ind[i] || '0') === '1') !== not);
}

function attrsFor(item, ind, isInput) {
  let color = item.attrs.color;
  for (const rule of item.attrs.colorRules || []) if (rule.cond.length && condOn(rule.cond, ind)) color = rule.color;
  const set = new Set();
  for (const d of item.attrs.dspatr) if (condOn(d.cond, ind)) set.add(d.attr);
  let a = COLOR_ATTR[color] || (set.has('HI') ? 'w' : 'g');
  if (set.has('HI') && !color) a = 'w';
  if (set.has('RI')) a += 'v';
  if (set.has('UL') || (isInput && !set.has('PR'))) a += 'u';
  if (set.has('BL')) a += 'k';
  if (set.has('ND')) a += 'n';
  return { a, pr: set.has('PR'), pc: set.has('PC'), nd: set.has('ND') };
}

function fmtOut(f, v) {
  if (f.rpgType.t === 'char') return String(v ?? '').padEnd(f.len).slice(0, f.len);
  const n = Number(v || 0);
  if (f.edtcde) return editc(n, f.edtcde, { t: 'zoned', digits: f.len, dec: f.dec });
  const s = f.dec ? Math.abs(n).toFixed(f.dec).replace('.', '') : String(Math.trunc(Math.abs(n)));
  return (n < 0 ? '-' : '') + s.padStart(f.len, f.type === 'Y' ? ' ' : '0').slice(-f.len);
}

function fmtIn(f, v) {
  if (f.rpgType.t === 'char') return String(v ?? '').replace(/\s+$/, '');
  const n = Number(v || 0);
  if (!n) return '';
  return f.dec ? n.toFixed(f.dec) : String(Math.trunc(n));
}

function specialText(sp, ctx) {
  const d = new Date();
  if (sp === 'DATE') return sysDate(d);
  if (sp === 'TIME') return sysTime(d);
  if (sp === 'USER') return ctx.job.user;
  if (sp === 'SYSNAME' || sp === 'SYSTEM') return SYS.name;
  return '';
}

/**
 * Muestra un formato (y los superpuestos) y devuelve {values, ind, aid, sflRecords}.
 */
export async function displayFormat(ctx, fileName, dspf, fmtName, values, ind, mode, sfl) {
  const s = ctx.session;
  s.dspfBuf = s.dspfBuf || new Map();
  let buf = s.dspfBuf.get(fileName) || [];
  const fmt = dspf.formats[fmtName];
  if (!fmt) return null;
  if (mode === 'write' || mode === 'exfmt') {
    if (!fmt.overlay) buf = [];
    buf = buf.filter((b) => b.fmt !== fmtName && !(fmt.sflctl && b.fmt === fmt.sflctl));
    buf.push({ fmt: fmtName, values: { ...values }, ind: { ...ind }, sfl });
    s.dspfBuf.set(fileName, buf);
  }
  const keyDefs = [...(dspf.keys || []), ...(fmt.keys || [])].filter((k) => condOn(k.cond, ind));
  const allowed = new Set(keyDefs.map((k) => k.key));
  if (mode === 'write') {
    const p = compose(ctx, dspf, buf, fmtName, null);
    s.screen = p;
    s.send({ ...p.toJSON(), lock: true, mw: s.mw, dev: s.device });
    return { values: {}, ind: {} };
  }
  let page = 0;
  for (;;) {
    const p = compose(ctx, dspf, buf, fmtName, page);
    const sflInfo = p.sflInfo;
    p.keys = [...allowed, 'PAGEUP', 'PAGEDOWN', 'HELP', 'PRINT'];
    p.fn = ctx.job.function;
    const r = await ctx.display(p);
    if (r.aid === 'PAGEDOWN' || r.aid === 'PAGEUP') {
      if (sflInfo) {
        if (r.aid === 'PAGEDOWN' && (page + 1) * sflInfo.pag < sflInfo.total) { saveSfl(r, sflInfo); page++; continue; }
        if (r.aid === 'PAGEUP' && page > 0) { saveSfl(r, sflInfo); page--; continue; }
      }
      const pk = r.aid === 'PAGEDOWN' ? ['PAGEDOWN', 'ROLLUP'] : ['PAGEUP', 'ROLLDOWN'];
      if (!(fmt.keys || []).some((k) => pk.includes(k.key))) {
        const last = buf[buf.length - 1];
        last.values = { ...last.values, ...pickValues(fmt, r.fields) };
        p.msg({ text: 'Roll up or down past the first or last record in file.', sev: 30 }, true);
        s.send({ ...p.toJSON(), mw: s.mw, dev: s.device });
        continue;
      }
    }
    const out = { values: pickValues(fmt, r.fields), aid: r.aid, ind: {} };
    for (const k of keyDefs) if (k.ind) out.ind[k.ind] = r.aid === k.key ? '1' : '0';
    if (sflInfo) out.sflRecords = saveSfl(r, sflInfo);
    const cur = buf.find((b) => b.fmt === fmtName);
    if (cur) cur.values = { ...cur.values, ...out.values };
    return out;
  }
}

function pickValues(fmt, fields) {
  const out = {};
  for (const f of fmt.fields) {
    if (f.usage === 'O' || f.usage === 'H') continue;
    if (fields[f.name] === undefined) continue;
    out[f.name] = fields[f.name];
  }
  return out;
}

function saveSfl(r, info) {
  const changed = [];
  for (const [key, v] of Object.entries(r.fields)) {
    const m = /^SFL_(\d+)_(.+)$/.exec(key);
    if (!m) continue;
    const rrn = Number(m[1]);
    const rec = info.records.find((x) => x.$rrn === rrn);
    if (!rec) continue;
    const norm = (x) => String(x ?? '').replace(/\s+$/, '');
    if (norm(rec[m[2]]) === norm(v)) continue;
    let upd = changed.find((c) => c.$rrn === rrn);
    if (!upd) { upd = { $rrn: rrn }; changed.push(upd); }
    upd[m[2]] = v;
    rec[m[2]] = v;
    rec.$chg = true;
  }
  return changed;
}

function compose(ctx, dspf, buf, activeFmt, page) {
  const p = new Panel({ fn: ctx.job.function });
  let cursorSet = null;
  let msgShown = null;
  for (const b of buf) {
    const fmt = dspf.formats[b.fmt];
    const ind = b.ind;
    const active = b.fmt === activeFmt;
    if (!fmt.sflctl || !fmt.sfldspctlInd || condOn(fmt.sfldspctlInd, ind)) {
      for (const c of fmt.constants) {
        if (!condOn(c.cond, ind) || c.row === null) continue;
        const { a } = attrsFor(c, ind, false);
        p.text(c.row, c.col, c.special ? specialText(c.special, ctx) : c.text, a);
      }
      for (const f of fmt.fields) {
        if (f.usage === 'H' || f.row === null || !condOn(f.cond, ind)) continue;
        const isIn = active && (f.usage === 'I' || f.usage === 'B');
        const at = attrsFor(f, ind, isIn);
        if (isIn && !at.pr) {
          p.input(f.name, f.row, f.col, f.len, {
            value: f.usage === 'I' ? (f.dft || '') : fmtIn(f, b.values[f.name]),
            attr: at.a, num: f.rpgType.t !== 'char', nd: at.nd, lower: f.check.includes('LC'),
          });
          if (at.pc && !cursorSet) cursorSet = [f.row, f.col];
        } else {
          p.text(f.row, f.col, at.nd ? '' : f.special ? specialText(f.special, ctx) : fmtOut(f, b.values[f.name]), at.a.replace('u', f.usage === 'O' ? '' : 'u'));
          if (at.pc && !cursorSet) cursorSet = [f.row, f.col];
        }
        for (const em of f.errmsg || []) if (condOn(em.cond, ind)) msgShown = em.text;
      }
    }
    // Subarchivo asociado a un formato de control
    if (fmt.sflctl && b.sfl) {
      const sflFmt = dspf.formats[fmt.sflctl];
      const pag = fmt.sflpag || 10;
      const recs = b.sfl.records;
      const pg = active && page !== null ? page : 0;
      const firstRow = Math.min(...sflFmt.fields.filter((f) => f.row).map((f) => f.row), ...sflFmt.constants.filter((c) => c.row).map((c) => c.row));
      const slice = recs.slice(pg * pag, pg * pag + pag);
      slice.forEach((rec, i) => {
        const rowOff = firstRow + i - firstRow;
        for (const c of sflFmt.constants) if (c.row && condOn(c.cond, rec.$ind || b.ind)) p.text(c.row + rowOff, c.col, c.text, attrsFor(c, b.ind, false).a);
        for (const f of sflFmt.fields) {
          if (f.usage === 'H' || !f.row) continue;
          const isIn = active && (f.usage === 'I' || f.usage === 'B');
          const at = attrsFor(f, b.ind, isIn);
          if (isIn && !at.pr) p.input(`SFL_${rec.$rrn}_${f.name}`, f.row + rowOff, f.col, f.len, { value: fmtIn(f, rec[f.name]), attr: at.a, num: f.rpgType.t !== 'char', lower: f.check.includes('LC') });
          else p.text(f.row + rowOff, f.col, fmtOut(f, rec[f.name]), at.a.replace('u', ''));
        }
      });
      if (!recs.length && active) { /* subarchivo vacío */ }
      const end = (pg + 1) * pag >= recs.length;
      const atEnd = end && (!fmt.sflendInd || condOn(fmt.sflendInd, b.ind));
      if (fmt.sflend || fmt.sflendInd) p.text(firstRow + pag, 74, atEnd ? 'Bottom' : 'More...', 'w');
      else if (!end) p.text(firstRow + pag, 74, 'More...', 'w');
      if (active) p.sflInfo = { pag, total: recs.length, records: recs };
    }
  }
  if (msgShown) p.msg({ text: msgShown, sev: 30 }, true);
  const af = dspf.formats[activeFmt];
  if (af && af.alarm) p.alarm = true;
  if (cursorSet) p.cursor = cursorSet;
  return p;
}
