// Cliente del DB2 Gateway para los demás servicios.
import { postJson, getJson } from './http.js';

export function createGateway(url, client) {
  const base = url.replace(/\/$/, '');
  const gw = {
    url: base,
    async sql(sql, params = [], opts = {}) {
      try {
        return await postJson(`${base}/sql`, { sql, params, client: opts.client || client }, opts.timeout || 60000);
      } catch (e) {
        return { error: `DB2 Gateway not reachable: ${e.message}`, sqlstate: '08001', sqlcode: -30081 };
      }
    },
    async exec(sql, params = [], opts) {
      const r = await gw.sql(sql, params, opts);
      if (r.error) {
        const e = new Error(r.error);
        e.sqlstate = r.sqlstate;
        e.sqlcode = r.sqlcode;
        throw e;
      }
      return r;
    },
    async rows(sql, params = [], opts) {
      const r = await gw.exec(sql, params, opts);
      return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name.toUpperCase(), row[i]])));
    },
    async batch(statements, ignore = ['42710']) {
      return postJson(`${base}/batch`, { statements, ignore, client, continueOnError: true }, 120000);
    },
    health: () => getJson(`${base}/health`, 3000),
    schemas: () => getJson(`${base}/catalog/schemas`),
    tables: (schema) => getJson(`${base}/catalog/tables?schema=${encodeURIComponent(schema)}`),
    columns: (schema, table) => getJson(`${base}/catalog/columns?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`),
    schema: (name, drop = false) => postJson(`${base}/catalog/schema`, { name, drop }),
  };
  return gw;
}
