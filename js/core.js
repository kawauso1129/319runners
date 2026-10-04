/* 画面・計算の共通処理（チーム画面と管理画面で共用） */

export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pad = n => String(n).padStart(2, '0');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const uid = () => Math.random().toString(36).slice(2, 10);

export function fmt(ms, withH) {
  if (ms == null || !isFinite(ms)) return '—';
  const neg = ms < 0; let s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); s = s % 60;
  return (neg ? '-' : '') + (h || withH ? h + ':' + pad(m) : m) + ':' + pad(s);
}
export function fmtGap(ms) {
  if (ms == null) return '<span class="muted">—</span>';
  if (Math.abs(ms) < 500) return '±0:00';
  return ms < 0 ? `<span class="good">-${fmt(-ms)}</span>` : `<span class="bad">+${fmt(ms)}</span>`;
}
export function parseDur(str) { // "5:30" → 330 / "1:02:03" → 3723（秒）。全角・「5.30」「5'30」「5分30秒」も 5:30 と読む
  const s = String(str ?? '').trim()
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[：.．'’′"”″]|分|時間?/g, ':').replace(/秒/g, '').replace(/:+$/, '');
  let p = s.split(':');
  if (p.length === 1 && /^\d{3,4}$/.test(p[0])) p = [p[0].slice(0, -2), p[0].slice(-2)]; // "530" → 5:30
  if (!p[0] || p.some(x => x === '' || !/^\d+$/.test(x))) return null;
  if (p.slice(1).some(x => x.length !== 2 || +x >= 60)) return null; // 秒・分は2桁（「5.3」のような曖昧な入力は弾く）
  return p.map(Number).reduce((a, b) => a * 60 + b, 0);
}
/* 1kmあたりのペース。2:00〜20:00/km の範囲外は入力ミスとして扱う */
export const PACE_MIN = 120, PACE_MAX = 1200;
export function parsePace(str) {
  const v = parseDur(str);
  return v != null && v >= PACE_MIN && v <= PACE_MAX ? v : null;
}
export function clock(ms) { if (ms == null) return '—'; const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
export const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
export const need = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ---------- 合言葉ワード ---------- */
export const WORD_RE = /^[A-Za-z0-9-]{12,64}$/;
export function randomWord() {
  const c = 'abcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint32Array(12); crypto.getRandomValues(a);
  const s = Array.from(a, x => c[x % c.length]).join('');
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
}

/* ---------- 計算モデル ---------- */
export class Model {
  constructor(race, team) { this.r = race || {}; this.t = team || {}; }
  get members() { return this.t.members || []; }
  mem(id) { return this.members.find(m => m.id === id); }
  name(id) { return this.mem(id)?.name ?? '—'; }
  get L() { return (Number(this.r.limitHours) || 0) * 3600e3; }
  get started() { return !!this.r.startAt; }
  get deadline() { return this.r.startAt ? this.r.startAt + this.L : null; }
  targetMs(id) { const m = this.mem(id); return m ? m.paceSec * (Number(this.r.lapKm) || 0) * 1000 : 0; }
  laps() {
    if (this._laps) return this._laps;
    let prev = this.r.startAt;
    return this._laps = (this.t.handoffs || []).map((h, i) => {
      const l = { no: i + 1, idx: i, runnerId: h.runnerId, start: prev, end: h.t, ms: h.t - prev, provisional: !!h.provisional, edited: !!h.edited, by: h.by || '' };
      prev = h.t; return l;
    });
  }
  curLapStart() { const hs = this.t.handoffs || []; return hs.length ? hs[hs.length - 1].t : this.r.startAt; }
  activeOrder() { return (this.t.order || []).filter(id => { const m = this.mem(id); return m && !m.left; }); }
  currentRunner() { const c = this.t.current?.runnerId; if (c && this.mem(c)) return c; return this.activeOrder()[0] || null; }
  nextAfter(id) {
    const o = this.t.order || [], n = o.length, i = o.indexOf(id);
    for (let k = 1; k <= n; k++) { const c = o[(i + k + n) % n]; const m = this.mem(c); if (m && !m.left) return c; }
    return null;
  }
  stats(id) {
    const laps = this.laps().filter(l => l.runnerId === id);
    const avg = laps.length ? laps.reduce((a, l) => a + l.ms, 0) / laps.length : null;
    const tgt = this.targetMs(id);
    return { laps, avg, tgt, exp: avg ?? tgt, gap: avg == null ? null : avg - tgt };
  }
  savings() { return this.laps().reduce((a, l) => a + (l.ms - this.targetMs(l.runnerId)), 0); }
  predict(nowMs) {
    const start = this.started ? this.r.startAt : nowMs;
    const deadline = start + this.L;
    const done = this.started ? this.laps().filter(l => l.end <= deadline) : [];
    let count = done.length, lastRunner = done.at(-1)?.runnerId ?? null, lastFinish = done.at(-1)?.end ?? null;
    const upcoming = [];
    let runner = this.currentRunner();
    if (runner && this.L > 0 && !(this.started && nowMs > deadline)) {
      let lapStart = this.started ? this.curLapStart() : start;
      let finish = lapStart + this.stats(runner).exp;
      if (this.started) finish = Math.max(finish, nowMs);
      let guard = 0;
      while (finish <= deadline && guard++ < 5000) {
        count++; lastRunner = runner; lastFinish = finish;
        upcoming.push({ no: count, runnerId: runner, start: lapStart, finish });
        lapStart = finish; runner = this.nextAfter(runner);
        if (!runner) break;
        const e = this.stats(runner).exp; if (!(e > 0)) { runner = null; break; }
        finish += e;
      }
      if (runner && lapStart < deadline) upcoming.push({ no: count + 1, runnerId: runner, start: lapStart, finish, out: true });
    }
    return { count, completed: done.length, lastRunner, lastFinish, deadline, margin: lastFinish == null ? null : deadline - lastFinish, upcoming };
  }
}

/* ---------- CSV ---------- */
export function buildCsv(race, team) {
  const m = new Model(race, team), dl = m.deadline;
  const head = ['周', '走者', '開始(経過)', '終了(経過)', '周回タイム', '開始時刻', '終了時刻', '目安タイム', '暫定', '修正', '記録者', '制限時間内'];
  const rows = m.laps().map(l => [l.no, m.name(l.runnerId), fmt(l.start - race.startAt, true), fmt(l.end - race.startAt, true), fmt(l.ms), clock(l.start), clock(l.end), fmt(m.targetMs(l.runnerId)), l.provisional ? '暫定' : '', l.edited ? '修正' : '', l.by, l.end <= dl ? '○' : '×']);
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  return '﻿' + [head, ...rows].map(r => r.map(q).join(',')).join('\r\n');
}
export function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = filename.replace(/[\\/:*?"<>|\s]/g, '_');
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- トースト・ダイアログ ---------- */
let toastTimer = null;
export function toast(msg, btn, fn, ms = 3500) {
  $('#toastMsg').textContent = msg;
  const b = $('#toastBtn'); b.hidden = !btn; b.textContent = btn || '';
  b.onclick = () => { $('#toast').style.display = 'none'; fn && fn(); };
  $('#toast').style.display = 'flex';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').style.display = 'none'; }, ms);
}
/* ブラウザ標準の confirm() はブロックされることがあるため、画面内の確認ダイアログを使う */
export function askConfirm(msg, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    let d = document.getElementById('cfm');
    if (!d) { d = document.createElement('dialog'); d.id = 'cfm'; document.body.appendChild(d); }
    d.innerHTML = `<p style="margin:0 0 6px;line-height:1.7">${esc(msg)}</p>
      <div class="btns" style="justify-content:flex-end"><button class="b" data-c="0">キャンセル</button><button class="b ${danger ? 'danger' : 'primary'}" data-c="1">${esc(okLabel)}</button></div>`;
    let settled = false;
    const done = v => { if (settled) return; settled = true; if (d.open) d.close(); resolve(v); };
    d.querySelectorAll('[data-c]').forEach(b => { b.onclick = e => { e.stopPropagation(); done(b.dataset.c === '1'); }; });
    d.oncancel = () => done(false);
    d.showModal();
  });
}

export function openDlg(html) { $('#dlgBody').innerHTML = html; if (!$('#dlg').open) $('#dlg').showModal(); }
export function closeDlg() { $('#dlg').close(); }

/* ---------- 入力中は再描画を待つ ---------- */
export function makeRenderer(app, render) {
  let dirty = false;
  const request = () => {
    const a = document.activeElement;
    if ($('#dlg').open || (a && app.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName))) { dirty = true; return; }
    dirty = false; render();
  };
  document.addEventListener('focusout', () => setTimeout(() => { if (dirty) request(); }, 0));
  $('#dlg').addEventListener('close', () => request());
  return request;
}
