// Utilidades comunes de los paneles: SSE con reconexión, sparklines y formato.
export function live(url, handlers, onState) {
  let es;
  const open = () => {
    es = new EventSource(url);
    es.onopen = () => onState && onState(true);
    es.onerror = () => onState && onState(false);
    for (const [ev, fn] of Object.entries(handlers)) {
      es.addEventListener(ev, (m) => fn(JSON.parse(m.data)));
    }
  };
  open();
  return () => es.close();
}

export function spark(canvas, values, { color = '#4589ff', fill = true, max } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (!values.length) return;
  const m = Math.max(max ?? 0, ...values, 1);
  const step = w / Math.max(values.length - 1, 1);
  g.beginPath();
  values.forEach((v, i) => {
    const x = i * step, y = h - 4 - (v / m) * (h - 10);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.strokeStyle = color; g.lineWidth = 1.6; g.stroke();
  if (fill) {
    g.lineTo((values.length - 1) * step, h); g.lineTo(0, h); g.closePath();
    g.globalAlpha = 0.15; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
  }
  g.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted');
  g.font = '10px monospace';
  g.fillText(String(+m.toFixed(2)), 4, 11);
}

export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtTime = (t) => new Date(t).toLocaleTimeString();
export const fmtBytes = (n) => (n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB');
export const fmtDur = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return [h, m, x].map((v) => String(v).padStart(2, '0')).join(':');
};

// Barra de navegación entre los paneles de todos los servicios.
export function navLinks(el) {
  const host = location.hostname;
  const proto = location.protocol;
  const links = [
    ['Terminal 5250', `${proto}//${host}:5250/`],
    ['Sistema IBM i', `${proto}//${host}:5250/dashboard/`],
    ['Compilador RPG', `${proto}//${host}:5251/`],
    ['DB2 Gateway', `${proto}//${host}:5252/`],
  ];
  el.innerHTML = links.map(([t, u]) => `<a href="${u}">${t}</a>`).join('');
}
