// Alteraciones temporales de archivos (OVRDBF / OVRPRTF / DLTOVR) con ámbito de nivel de llamada, como en IBM i:
// una alteración emitida dentro de un programa desaparece cuando ese programa termina (OVRSCOPE(*CALLLVL), lo habitual
// en el grupo de activación por omisión); OVRSCOPE(*JOB) dura hasta DLTOVR o el fin del trabajo.

const up = (s) => String(s || '').toUpperCase();

export function callLevel(job) { return job.callDepth || 0; }

export function enterCall(job) { job.callDepth = (job.callDepth || 0) + 1; }

/** Al volver de un programa se eliminan las alteraciones emitidas en su nivel de llamada. */
export function leaveCall(job) {
  const lvl = job.callDepth || 0;
  if (job.overrides) job.overrides = job.overrides.filter((o) => o.scope === '*JOB' || o.level < lvl);
  job.callDepth = Math.max(0, lvl - 1);
}

export function addOverride(job, o) {
  job.overrides = job.overrides || [];
  const level = o.scope === '*JOB' ? -1 : callLevel(job);
  // En el mismo nivel, la nueva sustituye a la anterior del mismo archivo
  job.overrides = job.overrides.filter((x) => !(x.kind === o.kind && x.file === up(o.file) && x.level === level));
  job.overrides.push({ ...o, file: up(o.file), level });
}

export function deleteOverride(job, file, { all = false } = {}) {
  const lvl = callLevel(job);
  const before = (job.overrides || []).length;
  job.overrides = (job.overrides || []).filter((x) => !((all || x.file === up(file)) && (x.level === lvl || (x.scope === '*JOB' && lvl === 0) || all)));
  return before - job.overrides.length;
}

/** Alteración efectiva (la del nivel más alto aplica primero, y se combinan con las de niveles inferiores). */
export function overrideFor(job, kind, file) {
  const list = (job.overrides || []).filter((x) => x.kind === kind && x.file === up(file)).sort((a, b) => b.level - a.level);
  if (!list.length) return null;
  const merged = {};
  for (const o of list.reverse()) for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '*SAME') merged[k] = v;
  return merged;
}

export function listOverrides(job) { return (job.overrides || []).slice(); }
