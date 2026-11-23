// Motor de Query/400 (5770-QU1): definición de consulta (*QRYDFN), SQL generado, informe con cortes y funciones
// de resumen, y salida a pantalla, impresora (QPQUPRFIL) o archivo de base de datos.
import { gw, describeFile, createSpool } from './objects.js';
import { CLError } from './messages.js';
import { sysDate, sysTime } from './system.js';

const up = (s) => String(s ?? '').trim().toUpperCase();
export const TESTS = ['EQ', 'NE', 'GT', 'LT', 'GE', 'LE', 'RANGE', 'LIST', 'LIKE', 'NLIKE', 'NLIST', 'ISNULL', 'ISNNULL'];
export const FUNCS = { 1: 'TOTAL', 2: 'AVG', 3: 'MIN', 4: 'MAX', 5: 'COUNT' };

/** Definición vacía. */
export function emptyQuery() {
  return { files: [], joinType: 1, joins: [], results: [], fields: [], conditions: [], sorts: [], summaries: {}, breaks: [], headings: {}, output: { type: 1, form: 1, file: null, lib: null, mbr: '*FIRST', data: 1 }, text: '' };
}

/** Campos disponibles: de los archivos (T01.CAMPO…) y de resultado. */
export async function availableFields(ctx, q) {
  const out = [];
  for (const f of q.files) {
    const d = await describeFile(gw, `${f.lib}/${f.file}`, ctx.libl);
    for (const x of d.fields) {
      const t = x.type || {};
      const num = ['packed', 'zoned', 'int', 'uns', 'float'].includes(t.t);
      const len = num ? (t.digits || (t.bits === 64 ? 20 : t.bits === 16 ? 5 : 10)) : t.len || 10;
      out.push({ id: f.id, name: x.name, num, len, dec: num ? t.dec || 0 : 0, text: x.text || '', sql: `${f.id}."${x.name}"` });
    }
  }
  for (const r of q.results) out.push({ id: '', name: r.name, num: r.num !== false, len: r.len || 15, dec: r.dec || 0, text: r.heading || r.name, sql: `(${resolveExpr(r.expr, q)})`, result: true });
  return out;
}

// Expresiones de Query (campos, + - * /, || y funciones SQL): los nombres se cualifican con su archivo
function resolveExpr(expr, q) {
  return String(expr).replace(/\b(T\d\d)\.([A-Z#@$][\w#@$]*)\b/gi, (m, t, f) => `${t.toUpperCase()}."${f.toUpperCase()}"`);
}

function fieldSql(name, fields) {
  const n = up(name);
  const [t, f] = n.includes('.') ? n.split('.') : [null, n];
  const c = fields.filter((x) => x.name === f && (!t || x.id === t));
  if (!c.length) throw new CLError('QWM2701', `Field ${n} not found in the selected files.`);
  if (c.length > 1 && !t) throw new CLError('QWM2701', `Field ${n} is in more than one file; qualify it (T01.${f}).`);
  return c[0];
}
const lit = (v, num) => (num && /^[-+]?\d*\.?\d+$/.test(String(v).trim()) ? String(v).trim() : `'${String(v).replace(/^'|'$/g, '').replace(/'/g, "''")}'`);

/** SQL de la consulta. */
export async function buildSql(ctx, q) {
  if (!q.files.length) throw new CLError('QWM2702', 'No files are selected. Specify file selections.');
  const fields = await availableFields(ctx, q);
  const sel = (q.fields.length ? q.fields.map((n) => fieldSql(n, fields)) : fields);
  const from = [];
  q.files.forEach((f, i) => {
    const t = `"${f.lib}"."${f.file}" ${f.id}`;
    if (i === 0) { from.push(t); return; }
    const conds = q.joins.filter((j) => j.left || j.right).map((j) => { const a = fieldSql(j.left, fields); const b = fieldSql(j.right, fields); return `${a.sql} ${({ EQ: '=', NE: '<>', GT: '>', LT: '<', GE: '>=', LE: '<=' })[up(j.test) || 'EQ'] || '='} ${b.sql}`; }).filter((c) => c.includes(`${f.id}.`));
    const kind = q.joinType === 2 ? 'LEFT OUTER JOIN' : q.joinType === 3 ? 'LEFT EXCEPTION JOIN' : 'INNER JOIN';
    if (q.joinType === 3) from.push(`LEFT OUTER JOIN ${t} ON ${conds.join(' AND ') || '1 = 1'}`);
    else from.push(`${kind} ${t} ON ${conds.join(' AND ') || '1 = 1'}`);
  });
  let where = '';
  const parts = [];
  for (const c of q.conditions) {
    if (!c.field) continue;
    const f = fieldSql(c.field, fields);
    const test = up(c.test);
    const vals = String(c.value || '').match(/'(?:[^']|'')*'|\S+/g) || [];
    let s;
    switch (test) {
      case 'EQ': case 'NE': case 'GT': case 'LT': case 'GE': case 'LE': {
        const v = vals[0] || '';
        const other = fields.find((x) => x.name === up(v) || `${x.id}.${x.name}` === up(v));
        s = `${f.sql} ${({ EQ: '=', NE: '<>', GT: '>', LT: '<', GE: '>=', LE: '<=' })[test]} ${other && !/^'/.test(v) ? other.sql : lit(v, f.num)}`;
        break;
      }
      case 'RANGE': s = `${f.sql} BETWEEN ${lit(vals[0], f.num)} AND ${lit(vals[1], f.num)}`; break;
      case 'LIST': case 'NLIST': s = `${f.sql} ${test === 'NLIST' ? 'NOT ' : ''}IN (${vals.map((v) => lit(v, f.num)).join(', ')})`; break;
      case 'LIKE': case 'NLIKE': s = `${f.sql} ${test === 'NLIKE' ? 'NOT ' : ''}LIKE ${lit(vals.join(' '), false)}`; break;
      case 'ISNULL': s = `${f.sql} IS NULL`; break;
      case 'ISNNULL': s = `${f.sql} IS NOT NULL`; break;
      default: throw new CLError('QWM2703', `Test ${test} not valid.`);
    }
    parts.push({ s, andor: up(c.andor) || 'AND' });
  }
  // Tipo de unión 3 (registros no coincidentes con el primario): sin fila en el secundario
  if (q.joinType === 3 && q.files.length > 1) {
    const j = q.joins.find((x) => x.left && x.right);
    const sec = j && [fieldSql(j.left, fields), fieldSql(j.right, fields)].find((x) => x.id !== q.files[0].id);
    if (sec) parts.push({ s: `${sec.sql} IS NULL`, andor: 'AND' });
  }
  if (parts.length) where = ` WHERE ${parts.map((p, i) => (i ? ` ${p.andor} ` : '') + p.s).join('')}`;
  const order = [...q.sorts].sort((a, b) => a.prty - b.prty).map((s) => `${fieldSql(s.field, fields).sql} ${up(s.dir) === 'D' ? 'DESC' : 'ASC'}`);
  // Los cortes de control ordenan primero por sus campos
  const brk = [...q.breaks].sort((a, b) => a.level - b.level).map((b) => fieldSql(b.field, fields));
  const orderBy = [...brk.map((b) => `${b.sql} ASC`).filter((x) => !order.some((o) => o.startsWith(x.replace(' ASC', '')))), ...order];
  const sql = `SELECT ${sel.map((f) => `${f.sql} AS "${f.name}"`).join(', ')} FROM ${from.join(' ')}${where}${orderBy.length ? ` ORDER BY ${orderBy.join(', ')}` : ''}`;
  return { sql, columns: sel };
}

// ---------- Informe ----------
const edit = (v, f) => {
  if (v === null || v === undefined) return '-';
  if (!f.num) return String(v);
  const n = Number(v);
  const s = Math.abs(n).toFixed(f.dec || 0);
  const [i, d] = s.split('.');
  return `${n < 0 ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${d !== undefined ? `.${d}` : ''}`;
};

export async function runQuery(ctx, q, { outtype = null, outform = null, qname = '*NONE' } = {}) {
  const { sql, columns } = await buildSql(ctx, q);
  const r = await ctx.sql(sql, [], { raw: true });
  if (r.error) throw new CLError('QWM2704', `Query ${qname} ended: ${r.error}`);
  const rows = r.rows || [];
  const type = outtype || q.output.type;
  const form = outform || q.output.form;
  if (type === 3) return outfile(ctx, q, columns, rows, qname);
  const lines = report(q, columns, rows, form, qname);
  if (type === 2) {
    const id = await createSpool(ctx.job, 'QPQUPRFIL', lines, { usrdta: qname === '*NONE' ? '' : qname });
    return { kind: 'print', lines, rows: rows.length, spool: id };
  }
  return { kind: 'display', lines, rows: rows.length };
}

function report(q, cols, rows, form, qname) {
  const head = (f) => (q.headings[f.name] || f.name);
  const width = cols.map((f, i) => Math.max(head(f).length, ...rows.slice(0, 2000).map((r) => edit(r[i], f).length), f.num ? 1 : Math.min(f.len, 40)));
  const fmtRow = (vals) => cols.map((f, i) => (f.num ? String(vals[i]).padStart(width[i]) : String(vals[i]).padEnd(width[i]).slice(0, width[i]))).join('  ');
  const now = new Date();
  const lines = [`${sysDate(now)}  ${sysTime(now)}${' '.repeat(30)}${q.text ? q.text.slice(0, 40) : ''}${' '.repeat(10)}PAGE     1`, ''];
  lines.push(fmtRow(cols.map(head)));
  lines.push('');
  const funcsOf = (i) => (q.summaries[cols[i].name] || []).map((n) => FUNCS[n]).filter(Boolean);
  const anyFunc = cols.some((_, i) => funcsOf(i).length);
  const agg = (set) => {
    const res = {};
    cols.forEach((f, i) => {
      for (const fn of funcsOf(i)) {
        const vals = set.map((r) => r[i]).filter((v) => v !== null && v !== undefined);
        const nums = vals.map(Number);
        res[`${fn}:${i}`] = fn === 'COUNT' ? set.length : fn === 'TOTAL' ? nums.reduce((a, b) => a + b, 0) : fn === 'AVG' ? (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0) : fn === 'MIN' ? (f.num ? Math.min(...nums) : vals.sort()[0]) : (f.num ? Math.max(...nums) : vals.sort().pop());
      }
    });
    return res;
  };
  const summaryLines = (set, label) => {
    const out = [];
    if (!anyFunc) return out;
    out.push(`${label}`);
    for (const fn of ['TOTAL', 'AVG', 'MIN', 'MAX', 'COUNT']) {
      if (!cols.some((_, i) => funcsOf(i).includes(fn))) continue;
      const a = agg(set);
      out.push(fmtRow(cols.map((f, i) => (funcsOf(i).includes(fn) ? (fn === 'COUNT' ? String(a[`${fn}:${i}`]) : edit(fn === 'AVG' ? Number(a[`${fn}:${i}`]).toFixed((f.dec || 0) + 1) : a[`${fn}:${i}`], fn === 'AVG' ? { ...f, dec: (f.dec || 0) + 1 } : f)) : i === 0 ? fn : ''))));
    }
    return out;
  };
  const breaks = [...q.breaks].sort((a, b) => a.level - b.level).map((b) => cols.findIndex((c) => c.name === up(b.field).split('.').pop())).filter((i) => i >= 0);
  let group = [];
  const flush = (lvl) => {
    if (!group.length) return;
    if (breaks.length) { lines.push(...summaryLines(group, `   BREAK LEVEL ${lvl}  ${cols[breaks[0]].name} ${group[0][breaks[0]]}`)); lines.push(''); }
    group = [];
  };
  rows.forEach((r, k) => {
    if (breaks.length && k > 0 && breaks.some((bi) => String(r[bi]) !== String(rows[k - 1][bi]))) flush(1);
    group.push(r);
    if (form === 1) lines.push(fmtRow(cols.map((f, i) => edit(r[i], f))));
  });
  flush(1);
  lines.push(...summaryLines(rows, '   FINAL TOTALS'));
  lines.push('', '                         * * *  E N D  O F  R E P O R T  * * *');
  return lines;
}

async function outfile(ctx, q, cols, rows, qname) {
  const o = q.output;
  if (!o.file) throw new CLError('QWM2705', 'Output file not specified.');
  const lib = ctx.resolveLib(o.lib && o.lib !== '*LIBL' ? o.lib : '*CURLIB');
  const t = `"${lib}"."${up(o.file)}"`;
  const exists = (await gw.rows('SELECT 1 AS X FROM SYSCAT.TABLES WHERE TABSCHEMA = ? AND TABNAME = ?', [lib, up(o.file)])).length > 0;
  // Datos en el archivo: 1=Archivo nuevo, 2=Sustituir archivo, 3=Añadir al archivo
  if (exists && o.data === 1) throw new CLError('QWM2706', `File ${up(o.file)} in ${lib} already exists; specify "Replace file" or "Add to file".`);
  if (exists && o.data === 2) await gw.sql(`DROP TABLE ${t}`);
  if (!exists || o.data === 2) {
    const defs = cols.map((f) => `"${f.name}" ${f.num ? `DECIMAL(${Math.min(31, Math.max(f.len, 1))}, ${f.dec || 0})` : `CHAR(${Math.min(f.len || 10, 32000)})`}`);
    const rc = await gw.sql(`CREATE TABLE ${t} (${defs.join(', ')})`);
    if (rc.error) throw new CLError('QWM2706', rc.error);
  }
  const stmts = rows.map((r) => ({ sql: `INSERT INTO ${t} VALUES (${cols.map(() => '?').join(', ')})`, params: r }));
  for (let i = 0; i < stmts.length; i += 250) await gw.batch(stmts.slice(i, i + 250), []);
  const { syncSqlTables } = await import('./objects.js');
  await syncSqlTables(lib);
  return { kind: 'outfile', rows: rows.length, lines: [`${rows.length} records written to file ${up(o.file)} in ${lib}.`] };
}

/** Consulta rápida de un archivo (RUNQRY QRY(*NONE) QRYFILE(...)). */
export async function quickQuery(ctx, lib, file, { rcdslt = false } = {}) {
  const q = emptyQuery();
  q.files.push({ lib, file: up(file), id: 'T01' });
  void rcdslt;
  return q;
}
