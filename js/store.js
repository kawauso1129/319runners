/* データ層：デモ（ブラウザ内保存）と Firebase を同じ形で扱う */
import { FIREBASE_CONFIG } from './config.js';
import { uid, parseDur, ls } from './core.js';

export const DEMO = !FIREBASE_CONFIG || new URLSearchParams(location.search).has('demo');

export function newTeam({ name, raceId }) {
  return { name, raceId, members: [], order: [], handoffs: [], current: { runnerId: null, provisional: false, provisionalAt: 0, lockUntil: 0 }, official: null };
}
const resetTeamFields = tm => ({ ...tm, handoffs: [], official: null, current: { runnerId: null, provisional: false, provisionalAt: 0, lockUntil: 0 } });

/* =====================================================================
   デモ（localStorage）
   ===================================================================== */
let demoDb = null;
function getDemo() {
  if (demoDb) return demoDb;
  const KEY = 'relay.demo.v2';
  const mk = (name, pace) => ({ id: uid(), name, paceSec: parseDur(pace), left: false });
  const seed = () => {
    const a = [mk('田中', '5:00'), mk('佐藤', '5:30'), mk('鈴木', '6:00'), mk('高橋', '5:15'), mk('伊藤', '5:45'), mk('渡辺', '6:15')];
    const b = [mk('山本', '5:10'), mk('中村', '5:40'), mk('小林', '6:05'), mk('加藤', '5:25'), mk('吉田', '5:55')];
    const t = (name, ms) => ({ ...newTeam({ name, raceId: 'demo' }), members: ms, order: ms.map(m => m.id) });
    return {
      races: { demo: { name: 'デモ大会（15分・1周0.2km）', limitHours: 0.25, lapKm: 0.2, startAt: null } },
      teams: { 'demo-team-a1': t('チームA', a), 'demo-team-b2': t('チームB', b) },
    };
  };
  let db = null; try { db = JSON.parse(ls.get(KEY)); } catch {}
  if (!db || !db.teams || !db.races) db = seed();
  const listeners = new Set();
  const emit = () => listeners.forEach(fn => fn());
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('relay-demo') : null;
  const reload = raw => { try { db = JSON.parse(raw ?? ls.get(KEY)) || db; } catch {} emit(); };
  if (bc) bc.onmessage = () => reload();
  window.addEventListener('storage', e => { if (e.key === KEY) reload(e.newValue); });
  return demoDb = {
    get db() { return db; },
    save() { ls.set(KEY, JSON.stringify(db)); bc && bc.postMessage(1); emit(); },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reset() { db = seed(); this.save(); },
  };
}

function demoTeamStore(word) {
  const d = getDemo();
  return {
    exists: () => !!d.db.teams[word],
    async clockOffset() { return 0; },
    subscribe(cb) {
      const emit = () => {
        const t = d.db.teams[word], r = t ? d.db.races[t.raceId] : null;
        cb(r ? structuredClone(r) : null, t ? structuredClone(t) : null);
      };
      d.on(emit); emit();
    },
    async transact(fn) {
      const t = d.db.teams[word]; if (!t) throw new Error('チームが削除されました');
      const res = fn(structuredClone(d.db.races[t.raceId]), structuredClone(t));
      if (!res) return null;
      if (res.race) d.db.races[t.raceId] = res.race;
      if (res.team) d.db.teams[word] = res.team;
      if (res.race || res.team) d.save();
      return res.result ?? null;
    },
  };
}

function demoAdmin() {
  const d = getDemo();
  const sub = fn => { const off = d.on(fn); fn(); return off; };
  return {
    onUser(cb) { cb({ email: 'デモ管理者' }); },
    async signIn() {}, async signOut() {},
    async clockOffset() { return 0; },
    subscribeRaces(cb) { return sub(() => cb(Object.entries(d.db.races).map(([id, r]) => ({ id, ...structuredClone(r) })))); },
    subscribeTeams(raceId, cb) { return sub(() => cb(Object.entries(d.db.teams).filter(([, t]) => t.raceId === raceId).map(([word, t]) => ({ word, ...structuredClone(t) })))); },
    async createRace(data) { const id = uid() + uid(); d.db.races[id] = { ...data, startAt: null }; d.save(); return id; },
    async updateRace(id, fn) { const r = fn(structuredClone(d.db.races[id])); if (r) { d.db.races[id] = r; d.save(); } },
    async createTeam(word, data) {
      if (d.db.teams[word]) throw new Error('その合言葉はすでに使われています');
      d.db.teams[word] = newTeam(data); d.save();
    },
    async updateTeam(word, fn) { const t = fn(structuredClone(d.db.teams[word])); if (t) { d.db.teams[word] = t; d.save(); } },
    async deleteTeam(word) { delete d.db.teams[word]; d.save(); },
    async resetRace(raceId) {
      d.db.races[raceId].startAt = null;
      for (const [w, t] of Object.entries(d.db.teams)) if (t.raceId === raceId) d.db.teams[w] = resetTeamFields(t);
      d.save();
    },
    resetDemo() { d.reset(); },
  };
}

/* =====================================================================
   Firebase
   ===================================================================== */
let fb = null;
async function loadFirebase() {
  if (fb) return fb;
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const [appM, authM, fs] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
  const app = appM.initializeApp(FIREBASE_CONFIG);
  const auth = authM.getAuth(app);
  const db = fs.initializeFirestore(app, { ignoreUndefinedProperties: true });
  await auth.authStateReady();
  return fb = { authM, auth, fs, db };
}
const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
async function clockOffsetFirebase() {
  const { fs, db, auth } = fb;
  const ref = fs.doc(db, 'clock', auth.currentUser.uid);
  let best = null;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await timeout(fs.setDoc(ref, { t: fs.serverTimestamp() }), 5000);
    const t1 = Date.now();
    const s = await timeout(fs.getDoc(ref), 5000);
    const st = s.data()?.t?.toMillis?.(); if (st == null) continue;
    const rtt = t1 - t0;
    if (!best || rtt < best.rtt) best = { rtt, off: st - (t0 + t1) / 2 };
  }
  if (!best) throw new Error('clock');
  return best.off;
}

async function firebaseTeamStore(word, onError) {
  const { authM, auth, fs, db } = await loadFirebase();
  if (!auth.currentUser) await authM.signInAnonymously(auth);
  const teamRef = fs.doc(db, 'teams', word);
  let snap;
  try { snap = await fs.getDoc(teamRef); } catch { throw new Error('team-not-found'); }
  if (!snap.exists()) throw new Error('team-not-found');
  const raceId = snap.data().raceId;
  if (!raceId) throw new Error('チームに大会が設定されていません');
  const raceRef = fs.doc(db, 'races', raceId);
  return {
    exists: () => true,
    clockOffset: clockOffsetFirebase,
    subscribe(cb) {
      let r = null, t = null, gr = false, gt = false;
      const fire = () => gr && gt && cb(r, t);
      fs.onSnapshot(raceRef, s => { r = s.exists() ? s.data() : null; gr = true; fire(); }, e => onError('大会データを読めません：' + e.message));
      fs.onSnapshot(teamRef, s => { t = s.exists() ? s.data() : null; gt = true; fire(); }, e => onError('チームデータを読めません：' + e.message));
    },
    async transact(fn) {
      return fs.runTransaction(db, async tx => {
        const rs = await tx.get(raceRef), ts = await tx.get(teamRef);
        if (!ts.exists()) throw new Error('チームが削除されました');
        const res = fn(rs.data() || {}, ts.data());
        if (!res) return null;
        if (res.race) tx.set(raceRef, res.race);
        if (res.team) tx.set(teamRef, res.team);
        return res.result ?? null;
      });
    },
  };
}

async function firebaseAdmin() {
  const { authM, auth, fs, db } = await loadFirebase();
  const teamsOf = raceId => fs.query(fs.collection(db, 'teams'), fs.where('raceId', '==', raceId));
  const txUpdate = (ref, fn) => fs.runTransaction(db, async tx => {
    const s = await tx.get(ref); if (!s.exists()) throw new Error('データが見つかりません');
    const v = fn(s.data()); if (v) tx.set(ref, v);
  });
  return {
    onUser(cb) { authM.onAuthStateChanged(auth, u => cb(u && !u.isAnonymous ? { email: u.email } : null)); },
    async signIn() { await authM.signInWithPopup(auth, new authM.GoogleAuthProvider()); },
    async signOut() { await authM.signOut(auth); },
    clockOffset: clockOffsetFirebase,
    subscribeRaces(cb, onErr) { return fs.onSnapshot(fs.collection(db, 'races'), s => cb(s.docs.map(x => ({ id: x.id, ...x.data() }))), onErr); },
    subscribeTeams(raceId, cb, onErr) { return fs.onSnapshot(teamsOf(raceId), s => cb(s.docs.map(x => ({ word: x.id, ...x.data() }))), onErr); },
    async createRace(data) { const ref = fs.doc(fs.collection(db, 'races')); await fs.setDoc(ref, { ...data, startAt: null }); return ref.id; },
    updateRace(id, fn) { return txUpdate(fs.doc(db, 'races', id), fn); },
    async createTeam(word, data) {
      const ref = fs.doc(db, 'teams', word);
      await fs.runTransaction(db, async tx => {
        const s = await tx.get(ref);
        if (s.exists()) throw new Error('その合言葉はすでに使われています');
        tx.set(ref, newTeam(data));
      });
    },
    updateTeam(word, fn) { return txUpdate(fs.doc(db, 'teams', word), fn); },
    async deleteTeam(word) { await fs.deleteDoc(fs.doc(db, 'teams', word)); },
    async resetRace(raceId) {
      const snap = await fs.getDocs(teamsOf(raceId));
      const b = fs.writeBatch(db);
      b.update(fs.doc(db, 'races', raceId), { startAt: null });
      snap.docs.forEach(x => b.set(x.ref, resetTeamFields(x.data())));
      await b.commit();
    },
  };
}

/* =====================================================================
   入口
   ===================================================================== */
export async function openTeam(word, onError) {
  if (DEMO) { const s = demoTeamStore(word); if (!s.exists()) throw new Error('team-not-found'); return s; }
  return firebaseTeamStore(word, onError);
}
export async function openAdmin() {
  return DEMO ? demoAdmin() : firebaseAdmin();
}
