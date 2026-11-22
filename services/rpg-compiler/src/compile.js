// Compilación de miembros fuente: RPGLE/SQLRPGLE/RPG (fijo), CLLE/CLP, PF y DSPF.
import { compileRpg, CompileError } from '../../../shared/rpg/parser.js';
import { compileCL } from '../../../shared/cl.js';
import { parsePF, parseDSPF, pfToSql } from '../../../shared/dds.js';
import { describeFile, findObject, objectData, readMember } from '../../../shared/catalog.js';

const SQLCA = ['SQLCODE', 'SQLCOD', 'SQLSTATE', 'SQLSTT', 'SQLERRMC', 'SQLER3', 'SQLERRD'];
const BUILTIN_NAMES = ['UDATE', 'UYEAR', 'UMONTH', 'UDAY', '*N', '$CALLLR$'];
const OPM_TYPES = { RPG: 'RPG', RPG38: 'RPG38', RPG36: 'RPG36', RPT: 'RPG', RPT38: 'RPG38', RPT36: 'RPG36' };

export const PRODUCT = {
  RPGLE: { id: '5770WDS', name: 'ILE RPG', cmd: 'CRTBNDRPG' },
  SQLRPGLE: { id: '5770ST1', name: 'ILE RPG (SQL precompiler)', cmd: 'CRTSQLRPGI' },
  RPG: { id: '5770WDS', name: 'RPG/400', cmd: 'CRTRPGPGM' },
  RPG38: { id: '5770WDS', name: 'RPG/38', cmd: 'CRTRPGPGM' },
  RPG36: { id: '5770WDS', name: 'RPG II (System/36 environment)', cmd: 'CRTRPGPGM' },
  CLLE: { id: '5770SS1', name: 'ILE CL', cmd: 'CRTBNDCL' },
  CLP: { id: '5770SS1', name: 'ILE CL', cmd: 'CRTBNDCL' },
  PF: { id: '5770SS1', name: 'DDS', cmd: 'CRTPF' },
  DSPF: { id: '5770SS1', name: 'DDS', cmd: 'CRTDSPF' },
};

/**
 * req: {type, name, lib, srcfile, srcmbr, source:[{seq,dat,text}], libl, user}
 */
export async function compile(gw, req) {
  const type = String(req.type || 'RPGLE').toUpperCase();
  const lines = (req.source || []).map((s) => (typeof s === 'string' ? s : s.text));
  const messages = [];
  const add = (id, sev, text, line = 0) => messages.push({ id, sev, text, line });
  let object = null;
  const libl = req.libl && req.libl.length ? req.libl : ['QGPL'];
  const t0 = Date.now();
  try {
    if (type === 'RPGLE' || type === 'SQLRPGLE' || type === 'RPGIV' || OPM_TYPES[type]) {
      const includes = await prefetchIncludes(gw, lines, libl, req.lib);
      const ir = compileRpg(lines, {
        name: req.name,
        dialect: OPM_TYPES[type] ? 'RPG3' : 'RPG4',
        includeResolver: ({ lib, file, member }) => includes.get(`${lib || ''}/${file}/${member}`) || includes.get(`/${file}/${member}`) || null,
      });
      await semanticRpg(gw, ir, libl, add);
      object = { type: '*PGM', attr: OPM_TYPES[type] || (type === 'SQLRPGLE' ? 'SQLRPGLE' : 'RPGLE'), data: { kind: 'RPG', ir } };
    } else if (type === 'CLLE' || type === 'CLP') {
      const ir = compileCL(lines);
      semanticCl(ir, lines, add);
      object = { type: '*PGM', attr: 'CLLE', data: { kind: 'CL', ir } };
    } else if (type === 'PF') {
      const pf = parsePF(lines);
      object = { type: '*FILE', attr: 'PF', data: { kind: 'PF', ...pf, sql: pfToSql(req.lib, req.name, pf) } };
      add('CPC7301', 0, `DDS for file ${req.name} in ${req.lib} validated. ${pf.fields.length} fields, ${pf.keys.length} key field(s).`);
    } else if (type === 'DSPF') {
      const d = parseDSPF(lines);
      const nf = Object.keys(d.formats).length;
      if (!nf) throw new CompileError('CPD7411', 'No record formats defined.', 1);
      object = { type: '*FILE', attr: 'DSPF', data: d };
      add('CPC7301', 0, `DDS for file ${req.name} in ${req.lib} validated. ${nf} record format(s).`);
    } else {
      add('CPD0078', 40, `Source type ${type} not supported by this compiler.`);
    }
  } catch (e) {
    if (e instanceof CompileError) add(e.msgId, e.severity || 30, e.message, e.line || 0);
    else { add('RNS9310', 50, `Compilation stopped. Internal error: ${e.message}`); console.error(e); }
  }
  const severity = messages.reduce((m, x) => Math.max(m, x.sev), 0);
  const ok = severity < 30 && !!object;
  const created = new Date();
  const listing = makeListing({ ...req, type }, lines, req.source || [], messages, severity, ok, created);
  return { ok, severity, messages, listing, object: ok ? object : null, ms: Date.now() - t0 };
}

async function prefetchIncludes(gw, lines, libl, curLib, depth = 0, map = new Map()) {
  if (depth > 5) return map;
  for (const raw of lines) {
    const m = /\/(?:COPY|INCLUDE)\s+(?:([\w#@$]+)\/)?(?:([\w#@$]+),)?([\w#@$]+)/i.exec(raw || '');
    if (!m) continue;
    const lib = m[1] ? m[1].toUpperCase() : null;
    const file = (m[2] || 'QRPGLESRC').toUpperCase();
    const mbr = m[3].toUpperCase();
    const key = `${lib || ''}/${file}/${mbr}`;
    if (map.has(key)) continue;
    const libs = lib ? [lib] : [curLib, ...libl].filter(Boolean);
    for (const l of libs) {
      const src = await readMember(gw, l, file, mbr).catch(() => []);
      if (src.length) {
        const text = src.map((s) => s.text);
        map.set(key, text[0] && text[0].trim().toUpperCase().startsWith('**FREE') ? text.slice(1) : text);
        await prefetchIncludes(gw, text, libl, curLib, depth + 1, map);
        break;
      }
    }
  }
  return map;
}

// ---------- Análisis semántico RPG ----------
async function semanticRpg(gw, ir, libl, add) {
  const globals = new Set([...SQLCA, ...BUILTIN_NAMES]);
  if ((ir.ospecs || []).length) for (const n of ['PAGE', 'PAGE1', 'PAGE2', 'PAGE3', 'PAGE4', 'PAGE5', 'PAGE6', 'PAGE7']) globals.add(n);
  const fileNames = new Set();
  const dsFields = new Map();
  for (const f of ir.files) {
    fileNames.add(f.name);
    try {
      if (f.device === 'PRINTER') {
        // Archivo de impresora descrito externamente (PRTF): sus formatos y campos
        const qn = f.extfile || f.name;
        const [lib, name] = qn.includes('/') ? qn.split('/') : ['*LIBL', qn];
        const o = await findObject(gw, name, '*FILE', lib, libl).catch(() => null);
        const data = o ? await objectData(gw, o.LIB, name, '*FILE') : null;
        if (data && data.kind === 'PRTF') {
          for (const [fmt, def] of Object.entries(data.formats)) {
            fileNames.add(f.rename[fmt] || fmt);
            for (const fld of def.fields) if (fld.name) globals.add((f.prefix || '') + fld.name);
          }
        }
      } else if (f.device === 'DISK') {
        const d = await describeFile(gw, f.extfile || f.name, libl);
        fileNames.add(f.rename[d.format] || d.format);
        for (const fld of d.fields) globals.add((f.prefix || '') + fld.name);
        dsFields.set(d.format, d.fields.map((x) => x.name));
        dsFields.set(f.name, d.fields.map((x) => x.name));
      } else if (f.device === 'WORKSTN') {
        const qn = f.extfile || f.name;
        const [lib, name] = qn.includes('/') ? qn.split('/') : ['*LIBL', qn];
        const o = await findObject(gw, name, '*FILE', lib, libl);
        const data = o ? await objectData(gw, o.LIB, name, '*FILE') : null;
        if (!data || data.kind !== 'DSPF') throw new Error('nf');
        for (const [fmt, def] of Object.entries(data.formats)) {
          fileNames.add(f.rename[fmt] || fmt);
          for (const fld of def.fields) globals.add((f.prefix || '') + fld.name);
          dsFields.set(fmt, def.fields.map((x) => x.name));
        }
        for (const v of Object.values(f.sfile)) globals.add(v);
      }
    } catch {
      add('RNF2120', 40, `External description for file ${f.name} not found; file is ignored.`, f.line);
    }
  }
  const declare = (set, d) => {
    if (d.kind === 'ds') {
      set.add(d.name);
      if (!d.qualified && !d.dim) for (const fl of d.fields) set.add(fl.name);
    } else set.add(d.name);
  };
  for (const d of ir.decls) {
    declare(globals, d);
    if (d.kind === 'ds' && d.extname && !d.qualified) {
      try {
        const desc = await describeFile(gw, d.extname, libl);
        for (const fl of desc.fields) globals.add(fl.name);
      } catch {
        add('RNF3373', 30, `The external description for data structure ${d.name} (EXTNAME ${d.extname}) was not found.`, d.line);
      }
    }
  }
  if (ir.pi) for (const p of ir.pi.params) globals.add(p.name);
  const callables = new Set([...Object.keys(ir.procs), ...Object.keys(ir.protos)]);
  const subrs = new Set(Object.keys(ir.subrs));
  const reported = new Set();
  const undefinedName = (n, line) => {
    const k = `${n}@${line}`;
    if (reported.has(k)) return;
    reported.add(k);
    add('RNF7030', 30, `The name or indicator ${n} is not defined.`, line);
  };

  const checkExpr = (e, scope, line) => {
    if (!e || typeof e !== 'object') return;
    switch (e.k) {
      case 'id':
        if (!scope.has(e.name) && !callables.has(e.name)) undefinedName(e.name, line);
        return;
      case 'call':
        if (/^\$[A-Z]+\$$/.test(e.name)) { e.args.forEach((a) => checkExpr(a, scope, line)); return; }
        if (!scope.has(e.name) && !callables.has(e.name)) undefinedName(e.name, line);
        e.args.forEach((a) => checkExpr(a, scope, line));
        return;
      case 'dot': checkExpr(e.base, scope, line); return;
      case 'idx': checkExpr(e.base, scope, line); e.args.forEach((a) => checkExpr(a, scope, line)); return;
      case 'bif':
        if (['%EOF', '%FOUND', '%EQUAL', '%OPEN'].includes(e.name)) {
          for (const a of e.args) if (a.k === 'id' && !fileNames.has(a.name)) add('RNF7030', 30, `The file ${a.name} is not defined.`, line);
          return;
        }
        if (e.name === '%FIELDS') return;
        e.args.forEach((a) => checkExpr(a, scope, line));
        return;
      case 'un': checkExpr(e.e, scope, line); return;
      case 'bin': checkExpr(e.l, scope, line); checkExpr(e.r, scope, line); return;
      case 'list': e.items.forEach((a) => checkExpr(a, scope, line)); return;
      case 'inidx': checkExpr(e.idx, scope, line); return;
      default: return;
    }
  };
  const checkStmts = (stmts, scope, localSubrs) => {
    for (const s of stmts) {
      const L = s.line;
      switch (s.op) {
        case 'assign': checkExpr(s.target, scope, L); checkExpr(s.expr, scope, L); break;
        case 'callp': checkExpr(s.call, scope, L); break;
        case 'if': for (const b of s.branches) { checkExpr(b.cond, scope, L); checkStmts(b.body, scope, localSubrs); } if (s.else) checkStmts(s.else, scope, localSubrs); break;
        case 'dow': case 'dou': checkExpr(s.cond, scope, L); checkStmts(s.body, scope, localSubrs); break;
        case 'for': checkExpr(s.v, scope, L); checkExpr(s.from, scope, L); checkExpr(s.to, scope, L); checkExpr(s.by, scope, L); checkStmts(s.body, scope, localSubrs); break;
        case 'select': for (const w of s.whens) { checkExpr(w.cond, scope, L); checkStmts(w.body, scope, localSubrs); } if (s.other) checkStmts(s.other, scope, localSubrs); break;
        case 'monitor': checkStmts(s.body, scope, localSubrs); for (const h of s.handlers) checkStmts(h.body, scope, localSubrs); break;
        case 'return': checkExpr(s.expr, scope, L); break;
        case 'exsr': if (!localSubrs.has(s.name) && !subrs.has(s.name)) add('RNF7030', 30, `The subroutine ${s.name} is not defined.`, L); break;
        case 'dsply': checkExpr(s.msg, scope, L); checkExpr(s.resp, scope, L); break;
        case 'clear': case 'reset': case 'sorta': checkExpr(s.target, scope, L); break;
        case 'move': case 'movea': checkExpr(s.src, scope, L); checkExpr(s.target, scope, L); break;
        case 'test': case 'bit': checkExpr(s.target, scope, L); break;
        case 'callpgm': s.parms.forEach((p) => checkExpr(p, scope, L)); break;
        case 'file':
          if (!s.file.startsWith('*') && !fileNames.has(s.file)) add('RNF7030', 30, `The file or record format ${s.file} is not defined.`, L);
          if (s.key) checkExpr(s.key, scope, L);
          if (s.ds && !scope.has(s.ds)) undefinedName(s.ds, L);
          break;
        case 'sql': {
          const re = /:\s*([A-Za-z_#@$][\w#@$]*)/g;
          let m;
          const text = s.text.replace(/'(?:[^']|'')*'/g, "''");
          while ((m = re.exec(text))) {
            const n = m[1].toUpperCase();
            if (!scope.has(n)) add('SQL0312', 30, `Variable ${n} not defined or not usable.`, L);
          }
          break;
        }
        default: break;
      }
    }
  };
  checkStmts(ir.main, globals, new Set());
  for (const t of ir.totals || []) checkStmts(t.body, globals, new Set());
  for (const sr of Object.values(ir.subrs)) checkStmts(sr, globals, new Set());
  for (const p of Object.values(ir.procs)) {
    const local = new Set(globals);
    for (const prm of p.params) local.add(prm.name);
    for (const d of p.decls) declare(local, d);
    checkStmts(p.body, local, new Set(Object.keys(p.subrs)));
    for (const sr of Object.values(p.subrs)) checkStmts(sr, local, new Set(Object.keys(p.subrs)));
  }
  if (!ir.main.length && !ir.ctl.MAIN && !Object.keys(ir.procs).length) {
    add('RNF7086', 0, 'The program contains no calculation statements.', 0);
  } else if (!ir.ctl.MAIN && ir.main.length && !hasLrOrReturn(ir)) {
    add('RNF7023', 40, 'The compiler cannot determine how the program can end (no *INLR or RETURN found).', 0);
  }
}

function hasLrOrReturn(ir) {
  // Con archivo primario el ciclo termina solo (LR al fin de archivo)
  if (Object.values(ir.filex || {}).some((f) => f.desig === 'P')) return true;
  const s = JSON.stringify([ir.main, ir.subrs, ir.totals || []]);
  return s.includes('"*INLR"') || s.includes('"op":"return"');
}

function semanticCl(ir, lines, add) {
  const declared = new Set(ir.dcls.map((d) => d.name));
  for (const p of ir.parms) if (!declared.has(p)) add('CPD0728', 30, `Variable ${p} for parameter not declared.`, 1);
  const seen = new Set();
  lines.forEach((raw, i) => {
    const s = (raw || '').replace(/'(?:[^']|'')*'/g, "''");
    for (const m of s.matchAll(/&[A-Za-z#@$][\w#@$]*/g)) {
      const v = m[0].toUpperCase();
      if (!declared.has(v) && !seen.has(v)) { seen.add(v); add('CPD0727', 30, `Variable ${v} referred to but not declared.`, i + 1); }
    }
  });
}

// ---------- Listado de compilación ----------
function pad(s, n) { return String(s ?? '').padEnd(n).slice(0, n); }
function lpad(s, n) { return String(s ?? '').padStart(n); }
function dt(d) {
  const p = (x) => String(x).padStart(2, '0');
  return { date: `${p(d.getMonth() + 1)}/${p(d.getDate())}/${String(d.getFullYear()).slice(2)}`, time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` };
}

export function makeListing(req, lines, source, messages, severity, ok, created) {
  const prod = PRODUCT[req.type] || PRODUCT.RPGLE;
  const { date, time } = dt(created);
  const out = [];
  let page = 1;
  const header = () => {
    out.push(`${pad(`${prod.id} V7R5M0  220415`, 32)}${pad(prod.name, 26)}${pad(`${req.lib}/${req.name}`, 30)}${pad(`${date} ${time}`, 22)}Page ${lpad(page++, 4)}`);
  };
  header();
  out.push(` Command . . . . . . . . . . . . :   ${prod.cmd}`);
  out.push(`   ${req.type === 'PF' || req.type === 'DSPF' ? 'File' : 'Program'} . . . . . . . . . . . :   ${req.name}`);
  out.push(`     Library . . . . . . . . . . :     ${req.lib}`);
  out.push(`   Source file . . . . . . . . . :   ${req.srcfile || ''}`);
  out.push(`     Library . . . . . . . . . . :     ${req.srclib || req.lib}`);
  out.push(`   Source member . . . . . . . . :   ${req.srcmbr || req.name}`);
  out.push(`   Text 'description'  . . . . . :   ${req.text || '*SRCMBRTXT'}`);
  out.push(`   Compiler options  . . . . . . :   *XREF      *GEN       *SECLVL    *SHOWCPY`);
  out.push(`   Target release  . . . . . . . :   *CURRENT`);
  out.push('');
  out.push(` ${'S o u r c e   L i s t i n g'}`);
  out.push(` Line   <---------------------- Source Specifications ----------------------------><---- Comments ----> Do  Page  Change Src Seq`);
  out.push(` Number ....1....+....2....+....3....+....4....+....5....+....6....+....7....+....8....+....9....+...10 Num Line  Date   Id  Number`);
  const byLine = new Map();
  for (const m of messages) if (m.line) { if (!byLine.has(m.line)) byLine.set(m.line, []); byLine.get(m.line).push(m); }
  lines.forEach((l, i) => {
    const src = source[i] && typeof source[i] === 'object' ? source[i] : {};
    const seq = src.seq !== undefined ? Math.round(src.seq * 100) : (i + 1) * 100;
    const datv = src.dat ? String(src.dat).padStart(6, '0') : '      ';
    out.push(`${lpad(i + 1, 7)} ${pad(l, 100)}       ${datv}     ${String(seq).padStart(6, '0')}`);
    for (const m of byLine.get(i + 1) || []) {
      out.push(`======> ${'a'.padStart(1)}`);
      out.push(`*${m.id} ${String(m.sev).padStart(2, '0')}      a      ${String(seq).padStart(6, '0')}  ${m.text}`);
    }
  });
  out.push(' * * * * *   E N D   O F   S O U R C E   * * * * *');
  out.push('');
  out.push(' M e s s a g e   S u m m a r y');
  out.push(' Msg id  Sv Number Message text');
  const groups = new Map();
  for (const m of messages) {
    const g = groups.get(m.id) || { ...m, count: 0 };
    g.count++;
    groups.set(m.id, g);
  }
  for (const g of groups.values()) out.push(` *${g.id} ${String(g.sev).padStart(2, '0')} ${lpad(g.count, 6)} ${g.text}`);
  out.push(' * * * * *   E N D   O F   M E S S A G E   S U M M A R Y   * * * * *');
  out.push('');
  out.push(' F i n a l   S u m m a r y');
  out.push(' Message Totals:');
  const count = (lo, hi) => messages.filter((m) => m.sev >= lo && m.sev <= hi).length;
  out.push(`   Information  (00) . . . . . . . :   ${lpad(count(0, 9), 6)}`);
  out.push(`   Warning      (10) . . . . . . . :   ${lpad(count(10, 19), 6)}`);
  out.push(`   Error        (20) . . . . . . . :   ${lpad(count(20, 29), 6)}`);
  out.push(`   Severe Error (30+)  . . . . . . :   ${lpad(count(30, 99), 6)}`);
  out.push('   ---------------------------------   -------');
  out.push(`   Total  . . . . . . . . . . . . :   ${lpad(messages.length, 6)}`);
  out.push(' Source Totals:');
  out.push(`   Records  . . . . . . . . . . . :   ${lpad(lines.length, 6)}`);
  out.push(`   Specifications . . . . . . . . :   ${lpad(lines.filter((l) => l && l.trim() && !l.trim().startsWith('//')).length, 6)}`);
  out.push(`   Comments . . . . . . . . . . . :   ${lpad(lines.filter((l) => l && l.trim().startsWith('//')).length, 6)}`);
  out.push('');
  const objType = req.type === 'PF' || req.type === 'DSPF' ? 'File' : 'Program';
  if (ok) out.push(` ${objType} ${req.name} placed in library ${req.lib}. ${String(severity).padStart(2, '0')} highest severity. Created on ${date} at ${time}.`);
  else out.push(` ${objType} ${req.name} not created in library ${req.lib}. Maximum error severity ${String(severity).padStart(2, '0')}.`);
  out.push(' * * * * *   E N D   O F   C O M P I L A T I O N   * * * * *');
  return out.join('\n');
}
