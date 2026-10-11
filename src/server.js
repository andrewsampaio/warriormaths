// WarriorMaths — servidor (Fastify + PostgreSQL + LiveKit)
'use strict';
const path = require('path');
const crypto = require('crypto');
const Fastify = require('fastify');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const CATALOG = require('./catalog.json');

const cfg = {
  port: +(process.env.PORT || 3000),
  db: process.env.DATABASE_URL || 'postgres://gatos:gatos@localhost:5432/gatos',
  jwtKey: process.env.JWT_SECRET || '',
  lkUrl: process.env.LIVEKIT_URL || '',            // wss://livekit.tu-dominio
  lkKey: process.env.LIVEKIT_API_KEY || '',
  lkSecret: process.env.LIVEKIT_API_SECRET || '',
  maxEarnPerSync: +(process.env.MAX_EARN_PER_SYNC || 1500),
};
if (!cfg.jwtKey || cfg.jwtKey.length < 32) { console.error('JWT_SECRET debe tener al menos 32 caracteres'); process.exit(1); }

const pool = new Pool({ connectionString: cfg.db });
const q = (text, params) => pool.query(text, params);

const SCHEMA = `
create table if not exists families(
  id uuid primary key, email text unique not null, pass_hash text not null,
  consent_at timestamptz not null, created_at timestamptz not null default now());
create table if not exists players(
  id uuid primary key, family_id uuid not null references families(id) on delete cascade,
  code text unique not null, pin_hash text not null, nickname text not null,
  created_at timestamptz not null default now(), last_seen_at timestamptz);
create table if not exists progress(
  player_id uuid primary key references players(id) on delete cascade,
  state jsonb not null, version int not null default 1,
  chapter int not null default 0, honor int not null default 0, presas int not null default 0,
  updated_at timestamptz not null default now());
create table if not exists inventory(
  player_id uuid not null references players(id) on delete cascade, item_id text not null,
  quantity int not null default 1, equipped boolean not null default false,
  acquired_at timestamptz not null default now(), primary key(player_id, item_id));
create table if not exists ledger(
  id bigserial primary key, player_id uuid not null references players(id) on delete cascade,
  kind text not null, amount int not null, item_id text, balance_after int not null,
  created_at timestamptz not null default now());
create index if not exists ledger_player_idx on ledger(player_id, created_at desc);
`;

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 512 * 1024, trustProxy: true });
app.register(require('@fastify/rate-limit'), { global: false });
app.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public'), index: ['index.html'] });

/* ---------- utilidades ---------- */
const sign = (payload, ttl) => jwt.sign(payload, cfg.jwtKey, { expiresIn: ttl });
const EN_MSG = {
  'Sesión no válida. Vuelve a entrar.': 'Invalid session. Please sign in again.',
  'Escribe un correo válido.': 'Enter a valid email.',
  'La contraseña debe tener al menos 8 caracteres.': 'The password must have at least 8 characters.',
  'Hace falta tu consentimiento como madre, padre o tutor.': 'Your consent as a parent or guardian is required.',
  'Ya existe una cuenta con ese correo.': 'An account with that email already exists.',
  'Correo o contraseña incorrectos.': 'Wrong email or password.',
  'Escribe un apodo (mejor si no es su nombre real).': 'Enter a nickname (better if it is not their real name).',
  'El PIN debe tener de 4 a 6 números.': 'The PIN must have 4 to 6 digits.',
  'Máximo 6 jugadoras por familia.': 'Maximum 6 players per family.',
  'No se pudo crear el código. Inténtalo otra vez.': 'The code could not be created. Try again.',
  'No encontrada.': 'Not found.',
  'Código o PIN incorrectos.': 'Wrong code or PIN.',
  'estado inválido': 'invalid state', 'estado demasiado grande': 'state too large',
  'Ese objeto no existe.': 'That item does not exist.',
  'Primero hay que guardar la partida.': 'The game has to be saved first.',
  'Ya lo tienes.': 'You already have it.',
  'Esa sala no existe o ya se cerró.': 'That room does not exist or has closed.',
  'El servidor de voz no está configurado.': 'The voice server is not set up.',
  'La sala está llena (máximo 8).': 'The room is full (maximum 8).',
  'Petición no encontrada.': 'Request not found.',
  'No estás en esta sala.': 'You are not in this room.',
  'Solo la anfitriona puede aceptar.': 'Only the host can accept.',
  'Solo la anfitriona puede expulsar.': 'Only the host can remove players.',
  'No puedes expulsarte a ti misma.': 'You cannot remove yourself.',
  'Demasiados intentos. Espera un poco.': 'Too many attempts. Wait a little.',
  'Error del servidor.': 'Server error.',
};
const isEn = (req) => /^en/i.test(String(req?.headers?.['x-lang'] || ''));
const msgFor = (req, msg) => { if (!isEn(req)) return msg; const m = /^Te faltan (\d+) presas\.$/.exec(msg); return m ? `You need ${m[1]} more prey.` : (EN_MSG[msg] || msg); };
const err = (reply, code, msg) => reply.code(code).send({ error: msgFor(reply.request, msg) });
function auth(role) {
  return async (req, reply) => {
    const h = req.headers.authorization || '';
    try { const p = jwt.verify(h.replace(/^Bearer /, ''), cfg.jwtKey); if (p.role !== role) throw 0; req.user = p; }
    catch { return err(reply, 401, 'Sesión no válida. Vuelve a entrar.'); }
  };
}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randCode = n => Array.from(crypto.randomBytes(n), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
const cleanNick = s => String(s || '').replace(/[<>&"]/g, '').trim().slice(0, 24);
const isEmail = s => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s || '');

/* El estado del juego manda en lo que se gana jugando; el servidor manda en lo que se compra. */
function reconcileInventory(state, inv) {
  const owned = new Map(inv.map(r => [r.item_id, r]));
  state.acc = (Array.isArray(state.acc) ? state.acc : []).filter(id => owned.has(id) && CATALOG.items[id]?.kind === 'acc');
  for (const r of inv) if (CATALOG.items[r.item_id]?.kind === 'acc' && !state.acc.includes(r.item_id)) state.acc.push(r.item_id);
  const looks = new Set([...CATALOG.free, ...CATALOG.gifts, ...inv.filter(r => CATALOG.items[r.item_id]?.kind === 'look').map(r => r.item_id)]);
  state.owned = (Array.isArray(state.owned) ? state.owned : []).filter(id => looks.has(id));
  for (const id of looks) if (!state.owned.includes(id) && !CATALOG.gifts.includes(id)) state.owned.push(id);
  state.items = state.items && typeof state.items === 'object' ? state.items : {};
  for (const [id, it] of Object.entries(CATALOG.items)) if (it.kind === 'consumable') {
    const srv = owned.get(id)?.quantity || 0; state.items[id] = Math.max(0, Math.min(+state.items[id] || 0, srv));
  }
  return state;
}
function sanitizeState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('estado inválido');
  const json = JSON.stringify(s); if (json.length > 200000) throw new Error('estado demasiado grande');
  const st = JSON.parse(json);
  st.presas = Math.max(0, Math.floor(+st.presas || 0)); st.honor = Math.max(0, Math.floor(+st.honor || 0)); st.ch = Math.max(0, Math.min(5, Math.floor(+st.ch || 0)));
  st.name = String(st.name || '').slice(0, 30);
  return st;
}

/* ---------- salud y configuración ---------- */
app.get('/api/health', async () => { await q('select 1'); return { ok: true, voice: !!(cfg.lkUrl && cfg.lkKey && cfg.lkSecret) }; });
app.get('/api/config', async () => ({ livekitUrl: cfg.lkUrl || null }));

/* ---------- familias (padres y madres) ---------- */
const famLimit = { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } };
app.post('/api/family/register', famLimit, async (req, reply) => {
  const { email, password, consent } = req.body || {};
  if (!isEmail(email)) return err(reply, 400, 'Escribe un correo válido.');
  if (!password || String(password).length < 8) return err(reply, 400, 'La contraseña debe tener al menos 8 caracteres.');
  if (consent !== true) return err(reply, 400, 'Hace falta tu consentimiento como madre, padre o tutor.');
  const id = crypto.randomUUID();
  try { await q('insert into families(id,email,pass_hash,consent_at) values($1,lower($2),$3,now())', [id, email, await bcrypt.hash(String(password), 10)]); }
  catch (e) { if (e.code === '23505') return err(reply, 409, 'Ya existe una cuenta con ese correo.'); throw e; }
  return { token: sign({ role: 'family', fid: id }, '7d') };
});
app.post('/api/family/login', famLimit, async (req, reply) => {
  const { email, password } = req.body || {};
  const { rows } = await q('select id,pass_hash from families where email=lower($1)', [String(email || '')]);
  if (!rows[0] || !(await bcrypt.compare(String(password || ''), rows[0].pass_hash))) return err(reply, 401, 'Correo o contraseña incorrectos.');
  return { token: sign({ role: 'family', fid: rows[0].id }, '7d') };
});
app.get('/api/family/players', { preHandler: auth('family') }, async req => {
  const { rows } = await q(`select p.id,p.code,p.nickname,p.created_at,p.last_seen_at,g.chapter,g.honor,g.presas,g.updated_at,
     (select count(*) from inventory i where i.player_id=p.id)::int as items
     from players p left join progress g on g.player_id=p.id where p.family_id=$1 order by p.created_at`, [req.user.fid]);
  return { players: rows };
});
app.post('/api/family/players', { preHandler: auth('family') }, async (req, reply) => {
  const nickname = cleanNick(req.body?.nickname), pin = String(req.body?.pin || '');
  if (!nickname) return err(reply, 400, 'Escribe un apodo (mejor si no es su nombre real).');
  if (!/^\d{4,6}$/.test(pin)) return err(reply, 400, 'El PIN debe tener de 4 a 6 números.');
  const { rows: cnt } = await q('select count(*)::int n from players where family_id=$1', [req.user.fid]);
  if (cnt[0].n >= 6) return err(reply, 400, 'Máximo 6 jugadoras por familia.');
  for (let i = 0; i < 5; i++) {
    const code = randCode(4) + '-' + randCode(4), id = crypto.randomUUID();
    try { await q('insert into players(id,family_id,code,pin_hash,nickname) values($1,$2,$3,$4,$5)', [id, req.user.fid, code, await bcrypt.hash(pin, 10), nickname]); return { id, code, nickname }; }
    catch (e) { if (e.code !== '23505') throw e; }
  }
  return err(reply, 500, 'No se pudo crear el código. Inténtalo otra vez.');
});
async function ownPlayer(req, reply) {
  const { rows } = await q('select id from players where id=$1 and family_id=$2', [req.params.id, req.user.fid]);
  if (!rows[0]) { err(reply, 404, 'No encontrada.'); return false; } return true;
}
app.get('/api/family/players/:id', { preHandler: auth('family') }, async (req, reply) => {
  if (!(await ownPlayer(req, reply))) return;
  const [p, inv, led] = await Promise.all([
    q('select p.code,p.nickname,g.state,g.chapter,g.honor,g.presas,g.updated_at from players p left join progress g on g.player_id=p.id where p.id=$1', [req.params.id]),
    q('select item_id,quantity,acquired_at from inventory where player_id=$1 order by acquired_at', [req.params.id]),
    q('select kind,amount,item_id,balance_after,created_at from ledger where player_id=$1 order by created_at desc limit 100', [req.params.id])]);
  const st = p.rows[0].state || {};
  return { ...p.rows[0], state: undefined, summary: { warrior: st.warrior || null, prefix: st.prefix || null, stats: st.stats || null, topic: st.topic || null, rescues: st.rescues || null, battles: st.battles || null, recruits: st.recruits || [], minutes: st.minutes || {} }, inventory: inv.rows, ledger: led.rows };
});
app.post('/api/family/players/:id/pin', { preHandler: auth('family') }, async (req, reply) => {
  if (!(await ownPlayer(req, reply))) return; const pin = String(req.body?.pin || '');
  if (!/^\d{4,6}$/.test(pin)) return err(reply, 400, 'El PIN debe tener de 4 a 6 números.');
  await q('update players set pin_hash=$1 where id=$2', [await bcrypt.hash(pin, 10), req.params.id]); return { ok: true };
});
app.delete('/api/family/players/:id', { preHandler: auth('family') }, async (req, reply) => {
  if (!(await ownPlayer(req, reply))) return; await q('delete from players where id=$1', [req.params.id]); return { ok: true };
});
app.delete('/api/family', { preHandler: auth('family') }, async req => { await q('delete from families where id=$1', [req.user.fid]); return { ok: true }; });

/* ---------- jugadoras ---------- */
app.post('/api/auth/player', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
  const code = String(req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
  const { rows } = await q('select id,pin_hash,nickname from players where code=$1', [code]);
  if (!rows[0] || !(await bcrypt.compare(String(req.body?.pin || ''), rows[0].pin_hash))) return err(reply, 401, 'Código o PIN incorrectos.');
  await q('update players set last_seen_at=now() where id=$1', [rows[0].id]);
  return { token: sign({ role: 'player', pid: rows[0].id, nick: rows[0].nickname }, '30d'), nickname: rows[0].nickname, code };
});
app.get('/api/me/save', { preHandler: auth('player') }, async req => {
  const { rows } = await q('select state,version,updated_at from progress where player_id=$1', [req.user.pid]);
  return rows[0] ? { state: rows[0].state, version: rows[0].version, updatedAt: rows[0].updated_at } : { state: null, version: 0 };
});
app.put('/api/me/save', { preHandler: auth('player'), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
  let st; try { st = sanitizeState(req.body?.state); } catch (e) { return err(reply, 400, e.message); }
  const base = +req.body?.version || 0, pid = req.user.pid;
  const c = await pool.connect();
  try {
    await c.query('begin');
    const { rows } = await c.query('select version,presas from progress where player_id=$1 for update', [pid]);
    if (!rows[0]) {
      // primera vez: se importa lo que había en el móvil
      const inv = [];
      for (const id of (Array.isArray(st.acc) ? st.acc : [])) if (CATALOG.items[id]?.kind === 'acc') inv.push([id, 1]);
      for (const id of (Array.isArray(st.owned) ? st.owned : [])) if (CATALOG.items[id]?.kind === 'look') inv.push([id, 1]);
      for (const [id, n] of Object.entries(st.items || {})) if (CATALOG.items[id]?.kind === 'consumable' && +n > 0) inv.push([id, Math.min(99, Math.floor(+n))]);
      for (const [id, n] of inv) await c.query('insert into inventory(player_id,item_id,quantity) values($1,$2,$3) on conflict do nothing', [pid, id, n]);
      await c.query('insert into progress(player_id,state,version,chapter,honor,presas) values($1,$2,1,$3,$4,$5)', [pid, st, st.ch, st.honor, st.presas]);
      await c.query("insert into ledger(player_id,kind,amount,balance_after) values($1,'import',$2,$2)", [pid, st.presas]);
      await c.query('commit'); return { version: 1, state: st };
    }
    if (base !== rows[0].version) { await c.query('rollback'); const cur = await q('select state,version from progress where player_id=$1', [pid]); return reply.code(409).send({ error: 'conflict', ...cur.rows[0] }); }
    let delta = st.presas - rows[0].presas;
    if (delta > cfg.maxEarnPerSync) { delta = cfg.maxEarnPerSync; st.presas = rows[0].presas + delta; }
    const inv = (await c.query('select item_id,quantity from inventory where player_id=$1', [pid])).rows;
    reconcileInventory(st, inv);
    for (const [id, it] of Object.entries(CATALOG.items)) if (it.kind === 'consumable') await c.query('update inventory set quantity=$3 where player_id=$1 and item_id=$2', [pid, id, st.items[id] || 0]);
    await c.query('update inventory set equipped = (item_id = any($2)) where player_id=$1', [pid, Object.values(st.wear || {}).filter(Boolean)]);
    if (delta) await c.query('insert into ledger(player_id,kind,amount,balance_after) values($1,$2,$3,$4)', [pid, delta > 0 ? 'gana' : 'pierde', delta, st.presas]);
    const v = rows[0].version + 1;
    await c.query('update progress set state=$2,version=$3,chapter=$4,honor=$5,presas=$6,updated_at=now() where player_id=$1', [pid, st, v, st.ch, st.honor, st.presas]);
    await c.query('commit'); return { version: v, state: st };
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
});
app.post('/api/me/purchase', { preHandler: auth('player'), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
  const id = String(req.body?.itemId || ''), it = CATALOG.items[id], pid = req.user.pid;
  if (!it) return err(reply, 400, 'Ese objeto no existe.');
  const c = await pool.connect();
  try {
    await c.query('begin');
    const { rows } = await c.query('select state,version,presas from progress where player_id=$1 for update', [pid]);
    if (!rows[0]) { await c.query('rollback'); return err(reply, 409, 'Primero hay que guardar la partida.'); }
    const st = rows[0].state;
    const has = (await c.query('select quantity from inventory where player_id=$1 and item_id=$2', [pid, id])).rows[0];
    if (it.kind !== 'consumable' && has) { await c.query('rollback'); return err(reply, 409, 'Ya lo tienes.'); }
    if (rows[0].presas < it.price) { await c.query('rollback'); return err(reply, 402, `Te faltan ${it.price - rows[0].presas} presas.`); }
    const presas = rows[0].presas - it.price;
    if (it.kind === 'consumable') await c.query('insert into inventory(player_id,item_id,quantity) values($1,$2,1) on conflict(player_id,item_id) do update set quantity=inventory.quantity+1', [pid, id]);
    else await c.query('insert into inventory(player_id,item_id,quantity) values($1,$2,1)', [pid, id]);
    await c.query("insert into ledger(player_id,kind,amount,item_id,balance_after) values($1,'compra',$2,$3,$4)", [pid, -it.price, id, presas]);
    st.presas = presas;
    if (it.kind === 'acc') { st.acc = Array.isArray(st.acc) ? st.acc : []; if (!st.acc.includes(id)) st.acc.push(id); }
    else if (it.kind === 'look') { st.owned = Array.isArray(st.owned) ? st.owned : []; if (!st.owned.includes(id)) st.owned.push(id); }
    else { st.items = st.items || {}; st.items[id] = (+st.items[id] || 0) + 1; }
    const v = rows[0].version + 1;
    await c.query('update progress set state=$2,version=$3,presas=$4,updated_at=now() where player_id=$1', [pid, st, v, presas]);
    await c.query('commit'); return { version: v, presas, itemId: id, quantity: it.kind === 'consumable' ? st.items[id] : 1 };
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
});

/* ---------- salas con voz (LiveKit) ---------- */
const rooms = new Map();      // código -> sala
const knocks = new Map();     // id de petición -> {code, pid, nick, status}
const ROOM_TTL = 4 * 3600 * 1000;
const voiceReady = () => !!(cfg.lkUrl && cfg.lkKey && cfg.lkSecret);
async function lkToken(room, pid, nick) {
  const t = new AccessToken(cfg.lkKey, cfg.lkSecret, { identity: pid, name: nick, ttl: '4h' });
  t.addGrant({ roomJoin: true, room: 'gatos-' + room, canPublish: true, canSubscribe: true, canPublishData: true });
  return await t.toJwt();
}
const lkAdmin = () => new RoomServiceClient(cfg.lkUrl.replace(/^ws/, 'http'), cfg.lkKey, cfg.lkSecret);
setInterval(() => { const now = Date.now(); for (const [k, r] of rooms) if (now - r.created > ROOM_TTL) rooms.delete(k); for (const [k, n] of knocks) if (now - n.at > 3600e3) knocks.delete(k); }, 60e3).unref();
const roomOf = (req, reply) => { const r = rooms.get(String(req.params.code || '').toUpperCase()); if (!r) err(reply, 404, 'Esa sala no existe o ya se cerró.'); return r; };

app.post('/api/rooms', { preHandler: auth('player') }, async (req, reply) => {
  if (!voiceReady()) return err(reply, 503, 'El servidor de voz no está configurado.');
  for (const [k, r] of rooms) if (r.host === req.user.pid) rooms.delete(k);
  let code; do code = randCode(3) + '-' + randCode(3); while (rooms.has(code));
  rooms.set(code, { code, host: req.user.pid, hostNick: req.user.nick, created: Date.now(), members: new Map([[req.user.pid, req.user.nick]]) });
  return { code, host: true, livekitUrl: cfg.lkUrl, token: await lkToken(code, req.user.pid, req.user.nick) };
});
app.post('/api/rooms/:code/knock', { preHandler: auth('player'), config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (req, reply) => {
  const r = roomOf(req, reply); if (!r) return;
  if (r.members.size >= 8) return err(reply, 409, 'La sala está llena (máximo 8).');
  if (r.members.has(req.user.pid)) return { id: null, status: 'ok', livekitUrl: cfg.lkUrl, token: await lkToken(r.code, req.user.pid, req.user.nick) };
  const id = crypto.randomUUID(); knocks.set(id, { id, code: r.code, pid: req.user.pid, nick: req.user.nick, status: 'esperando', at: Date.now() });
  return { id, status: 'esperando' };
});
app.get('/api/rooms/knock/:id', { preHandler: auth('player') }, async (req, reply) => {
  const k = knocks.get(req.params.id); if (!k || k.pid !== req.user.pid) return err(reply, 404, 'Petición no encontrada.');
  if (k.status === 'ok') return { status: 'ok', code: k.code, livekitUrl: cfg.lkUrl, token: await lkToken(k.code, k.pid, k.nick) };
  return { status: k.status };
});
app.get('/api/rooms/:code', { preHandler: auth('player') }, async (req, reply) => {
  const r = roomOf(req, reply); if (!r) return;
  if (!r.members.has(req.user.pid)) return err(reply, 403, 'No estás en esta sala.');
  const pending = r.host === req.user.pid ? [...knocks.values()].filter(k => k.code === r.code && k.status === 'esperando').map(k => ({ id: k.id, nick: k.nick })) : [];
  return { code: r.code, host: r.host === req.user.pid, hostNick: r.hostNick, members: [...r.members].map(([pid, nick]) => ({ pid, nick })), pending };
});
app.post('/api/rooms/:code/answer', { preHandler: auth('player') }, async (req, reply) => {
  const r = roomOf(req, reply); if (!r) return; if (r.host !== req.user.pid) return err(reply, 403, 'Solo la anfitriona puede aceptar.');
  const k = knocks.get(String(req.body?.id || '')); if (!k || k.code !== r.code) return err(reply, 404, 'Petición no encontrada.');
  k.status = req.body?.accept ? 'ok' : 'rechazada'; if (k.status === 'ok') r.members.set(k.pid, k.nick); return { ok: true };
});
app.post('/api/rooms/:code/kick', { preHandler: auth('player') }, async (req, reply) => {
  const r = roomOf(req, reply); if (!r) return; if (r.host !== req.user.pid) return err(reply, 403, 'Solo la anfitriona puede expulsar.');
  const pid = String(req.body?.pid || ''); if (pid === r.host) return err(reply, 400, 'No puedes expulsarte a ti misma.');
  r.members.delete(pid); for (const k of knocks.values()) if (k.code === r.code && k.pid === pid) k.status = 'rechazada';
  try { await lkAdmin().removeParticipant('gatos-' + r.code, pid); } catch (e) { req.log.warn({ e: e.message }, 'removeParticipant'); }
  return { ok: true };
});
app.post('/api/rooms/:code/leave', { preHandler: auth('player') }, async (req, reply) => {
  const r = rooms.get(String(req.params.code || '').toUpperCase()); if (!r) return { ok: true };
  if (r.host === req.user.pid) { rooms.delete(r.code); try { await lkAdmin().deleteRoom('gatos-' + r.code); } catch {} }
  else r.members.delete(req.user.pid);
  return { ok: true };
});

app.setErrorHandler((e, req, reply) => { req.log.error(e); reply.code(e.statusCode && e.statusCode < 500 ? e.statusCode : 500).send({ error: msgFor(req, e.statusCode === 429 ? 'Demasiados intentos. Espera un poco.' : 'Error del servidor.') }); });

(async () => {
  for (let i = 0; i < 30; i++) { try { await q(SCHEMA); break; } catch (e) { if (i === 29) throw e; app.log.warn('Esperando a la base de datos…'); await new Promise(r => setTimeout(r, 2000)); } }
  await app.listen({ port: cfg.port, host: '0.0.0.0' });
})();
