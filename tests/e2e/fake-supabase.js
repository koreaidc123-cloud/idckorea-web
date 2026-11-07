/* ═══════════════════════════════════════════════════════════════
   시험용 가짜 Supabase (PostgREST 흉내) — 진짜 데이터베이스는 절대 부르지 않습니다

   api/_supa.js 의 sb() 가 보내는 요청만 알아듣는 작은 서버입니다.
     · GET    /rest/v1/<표>?select=...&col=eq.값&order=...&limit=...
     · POST   /rest/v1/<표>            새 줄 넣기 (Prefer: resolution=merge-duplicates 면 덮어쓰기)
     · PATCH  /rest/v1/<표>?조건        고치기 (Prefer: return=representation 이면 바뀐 줄을 돌려줌)
     · DELETE /rest/v1/<표>?조건        지우기
     · POST   /rest/v1/rpc/sweep_expired · rpc/beat

   표 모양은 db/schema.sql + 02-heartbeat + 06-B 를 따라 만들었습니다.
   없는 칸을 읽거나 쓰면 진짜 Supabase 처럼 400 을 돌려줘서
   코드가 없는 칸을 쓰는 실수를 시험에서 잡을 수 있게 했습니다.
   ═══════════════════════════════════════════════════════════════ */
const http = require('http');
const crypto = require('crypto');

/* 표마다 있는 칸 — 여기에 없는 칸은 "없는 칸" 오류가 납니다 */
const COLS = {
  pcs: ['pn', 'room', 'rack', 'fl', 'slot', 'cpu', 'core', 'ram_gb', 'ssd_gb', 'gpu', 'spec_id',
        'anydesk', 'pw_enc', 'ip', 'status', 'online', 'in_use', 'up_sec', 'last_beat', 'note',
        'created_at', 'updated_at', 'beat_token', 'hw_id', 'cmd', 'cmd_at', 'cmd_by'],
  pcs_unregistered: ['hw_id', 'room', 'ip', 'cpu', 'core', 'ram_gb', 'ssd_gb', 'gpu', 'anydesk',
        'first_seen', 'last_beat', 'claimed_pn', 'note'],
  members: ['id', 'via', 'social_id', 'name', 'phone', 'email', 'marketing', 'created_at'],
  orders: ['order_id', 'member_id', 'pn', 'spec_id', 'days', 'amount', 'setup_fee', 'status',
        'pay_key', 'pay_method', 'paid_at', 'va_secret', 'tax_invoice', 'biz_no', 'starts_at',
        'ends_at', 'payer_name', 'user_name', 'user_phone', 'canceled_at', 'refund_amt',
        'refund_why', 'created_at'],
  view_log: ['id', 'pn', 'act', 'who', 'at'],
  settings: ['k', 'v'],
};
const PK = { pcs: 'pn', pcs_unregistered: 'hw_id', members: 'id', orders: 'order_id', view_log: 'id', settings: 'k' };

/* 다른 표를 붙여 읽기 (select=*,pcs(pn,anydesk) 같은 것) — 외래키 방향 */
const EMBED = {
  orders: {
    pcs: { table: 'pcs', local: 'pn', remote: 'pn' },
    members: { table: 'members', local: 'member_id', remote: 'id' },
  },
};

let seqLog = 1;
function defaults(table) {
  const now = new Date().toISOString();
  switch (table) {
    case 'pcs': return { status: 'new', online: false, in_use: false, created_at: now, updated_at: now };
    case 'pcs_unregistered': return { first_seen: now, last_beat: now };
    case 'members': return { id: crypto.randomUUID(), marketing: false, created_at: now };
    case 'orders': return { status: 'ready', setup_fee: 5000, tax_invoice: false, created_at: now };
    case 'view_log': return { id: seqLog++, at: now };
    default: return {};
  }
}

function makeDb() {
  const db = {};
  for (const t of Object.keys(COLS)) db[t] = [];
  return db;
}
let DB = makeDb();
const calls = [];                     // 어떤 요청이 왔는지 (시험에서 확인용)

class PgErr extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/* ── select 해석: "*,pcs(pn,anydesk)" → [{col:'*'}, {rel:'pcs', cols:[...]}] ── */
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}
function parseSelect(s) {
  return splitTop(s || '*').map(it => {
    const m = it.match(/^([a-z_]+)\((.*)\)$/i);
    if (m) return { rel: m[1], sub: parseSelect(m[2]) };
    return { col: it };
  });
}
function project(table, row, sel) {
  const out = {};
  for (const it of sel) {
    if (it.col === '*') { for (const c of COLS[table]) out[c] = row[c] === undefined ? null : row[c]; continue; }
    if (it.col) {
      if (!COLS[table].includes(it.col)) throw new PgErr(400, '42703', `column ${table}.${it.col} does not exist`);
      out[it.col] = row[it.col] === undefined ? null : row[it.col];
      continue;
    }
    const e = EMBED[table] && EMBED[table][it.rel];
    if (!e) throw new PgErr(400, 'PGRST200', `Could not find a relationship between '${table}' and '${it.rel}'`);
    const key = row[e.local];
    const hit = key == null ? null : DB[e.table].find(r => r[e.remote] === key);
    out[it.rel] = hit ? project(e.table, hit, it.sub) : null;
  }
  return out;
}

/* ── 값 비교 ── */
const ISO = /^\d{4}-\d{2}-\d{2}T/;
function cmpVal(a, b) {
  if (typeof a === 'number') return a - Number(b);
  if (typeof a === 'string' && ISO.test(a) && ISO.test(b)) return Date.parse(a) - Date.parse(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function eqVal(a, v) {
  if (a === null || a === undefined) return false;
  if (typeof a === 'boolean') return String(a) === v;
  if (typeof a === 'number') return a === Number(v);
  if (typeof a === 'string' && ISO.test(a) && ISO.test(v)) return Date.parse(a) === Date.parse(v);
  return String(a) === v;
}
function parseList(v) {
  const m = v.match(/^\((.*)\)$/);
  if (!m) throw new PgErr(400, 'PGRST100', 'bad in list ' + v);
  return m[1] === '' ? [] : m[1].split(',').map(s => s.replace(/^"|"$/g, ''));
}
function makeFilter(table, col, expr) {
  if (!COLS[table].includes(col)) throw new PgErr(400, '42703', `column ${table}.${col} does not exist`);
  let neg = false;
  if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot), v = expr.slice(dot + 1);
  let f;
  switch (op) {
    case 'eq': f = r => eqVal(r[col], v); break;
    case 'neq': f = r => r[col] !== null && r[col] !== undefined && !eqVal(r[col], v); break;
    case 'gt': f = r => r[col] != null && cmpVal(r[col], v) > 0; break;
    case 'gte': f = r => r[col] != null && cmpVal(r[col], v) >= 0; break;
    case 'lt': f = r => r[col] != null && cmpVal(r[col], v) < 0; break;
    case 'lte': f = r => r[col] != null && cmpVal(r[col], v) <= 0; break;
    case 'in': { const L = parseList(v); f = r => r[col] != null && L.some(x => eqVal(r[col], x)); break; }
    case 'is':
      if (v === 'null') f = r => r[col] === null || r[col] === undefined;
      else if (v === 'true') f = r => r[col] === true;
      else if (v === 'false') f = r => r[col] === false;
      else throw new PgErr(400, 'PGRST100', 'bad is value');
      break;
    default: throw new PgErr(400, 'PGRST100', 'unknown operator ' + op);
  }
  /* SQL 처럼 null 은 not 조건에서도 걸리지 않습니다 (is 제외) */
  if (!neg) return f;
  if (op === 'is') return r => !f(r);
  return r => r[col] !== null && r[col] !== undefined && !f(r);
}
function parseQuery(table, qs) {
  const p = new URLSearchParams(qs);
  const out = { select: null, filters: [], order: [], limit: null, onConflict: null };
  for (const [k, v] of p) {
    if (k === 'select') out.select = v;
    else if (k === 'order') {
      out.order = v.split(',').map(s => {
        const [c, ...mods] = s.split('.');
        if (!COLS[table].includes(c)) throw new PgErr(400, '42703', `column ${table}.${c} does not exist`);
        const desc = mods.includes('desc');
        const nullsFirst = mods.includes('nullsfirst') ? true : mods.includes('nullslast') ? false : desc;
        return { c, desc, nullsFirst };
      });
    } else if (k === 'limit') out.limit = Number(v);
    else if (k === 'offset') out.offset = Number(v);
    else if (k === 'on_conflict') out.onConflict = v;
    else if (k === 'columns') { /* 무시 */ }
    else out.filters.push(makeFilter(table, k, v));
  }
  return out;
}
function applyRead(rows, q) {
  let out = rows.filter(r => q.filters.every(f => f(r)));
  if (q.order.length) {
    out = out.slice().sort((a, b) => {
      for (const o of q.order) {
        const x = a[o.c], y = b[o.c];
        const xn = x === null || x === undefined, yn = y === null || y === undefined;
        if (xn || yn) { if (xn && yn) continue; return (xn ? -1 : 1) * (o.nullsFirst ? 1 : -1); }
        const c = cmpVal(x, y);
        if (c) return o.desc ? -c : c;
      }
      return 0;
    });
  }
  if (q.offset) out = out.slice(q.offset);
  if (q.limit !== null && q.limit !== undefined) out = out.slice(0, q.limit);
  return out;
}

/* ── 제약 조건 (겹침 · 외래키) ── */
function checkRow(table, row, self) {
  const others = DB[table].filter(r => r !== self);
  const pk = PK[table];
  if (others.some(r => r[pk] === row[pk])) {
    throw new PgErr(409, '23505', `duplicate key value violates unique constraint "${table}_pkey"`);
  }
  if (table === 'members' && others.some(r => r.via === row.via && r.social_id === row.social_id)) {
    throw new PgErr(409, '23505', 'duplicate key value violates unique constraint "members_via_social_id_key"');
  }
  if (table === 'pcs' && row.rack > 0 && row.fl > 0 && row.slot > 0 &&
      others.some(r => r.room === row.room && r.rack === row.rack && r.fl === row.fl && r.slot === row.slot)) {
    throw new PgErr(409, '23505', 'duplicate key value violates unique constraint "pcs_slot_unique"');
  }
  if (table === 'orders') {
    if (row.pn != null && !DB.pcs.some(p => p.pn === row.pn)) {
      throw new PgErr(409, '23503', 'insert or update on table "orders" violates foreign key constraint "orders_pn_fkey"');
    }
    if (row.member_id != null && !DB.members.some(m => m.id === row.member_id)) {
      throw new PgErr(409, '23503', 'insert or update on table "orders" violates foreign key constraint "orders_member_id_fkey"');
    }
  }
  if (table === 'pcs' && row.room && !['K', 'Y', 'D'].includes(row.room)) {
    throw new PgErr(400, '23514', 'new row for relation "pcs" violates check constraint "pcs_room_check"');
  }
}
function checkCols(table, obj) {
  for (const k of Object.keys(obj)) {
    if (!COLS[table].includes(k)) {
      throw new PgErr(400, 'PGRST204', `Could not find the '${k}' column of '${table}' in the schema cache`);
    }
  }
}

/* ── rpc ── */
function rpc(name, body) {
  if (name === 'sweep_expired') {
    const now = Date.now();
    const expired = DB.orders.filter(o => o.status === 'assigned' && o.ends_at && Date.parse(o.ends_at) < now);
    for (const o of expired) {
      const busy = DB.orders.some(x => x !== o && x.pn === o.pn && ['assigned', 'paid'].includes(x.status) &&
        !(x.status === 'assigned' && x.ends_at && Date.parse(x.ends_at) < now));
      const pc = DB.pcs.find(p => p.pn === o.pn);
      if (pc && pc.status === 'rent' && !busy) { pc.status = 'ok'; pc.updated_at = new Date().toISOString(); }
      o.status = 'expired';
    }
    return expired.length;
  }
  if (name === 'beat') {
    const b = body || {};
    if (!b.p_token || String(b.p_token).length < 16) return 'DENIED';
    const pc = DB.pcs.find(p => p.pn === b.p_pn && p.beat_token === b.p_token);
    if (!pc) return 'DENIED';
    Object.assign(pc, { online: b.p_online !== false, in_use: !!b.p_in_use, last_beat: new Date().toISOString() });
    if (pc.cmd) { const c = pc.cmd; pc.cmd = null; pc.cmd_at = null; pc.cmd_by = null; return 'CMD:' + c; }
    return 'OK';
  }
  throw new PgErr(404, 'PGRST202', 'Could not find the function public.' + name);
}

/* ── 요청 하나 처리 ── */
function handle(method, path, qs, headers, body) {
  const m = path.match(/^\/rest\/v1\/(.+)$/);
  if (!m) throw new PgErr(404, 'PGRST000', 'not found');
  const name = m[1];
  if (name.startsWith('rpc/')) {
    if (method !== 'POST') throw new PgErr(405, 'PGRST000', 'POST only');
    return { status: 200, json: rpc(name.slice(4), body) };
  }
  const table = name;
  if (!COLS[table]) throw new PgErr(404, '42P01', `relation "public.${table}" does not exist`);
  const prefer = String(headers.prefer || '');
  const wantRows = /return=representation/.test(prefer);
  const q = parseQuery(table, qs);
  const sel = parseSelect(q.select || '*');

  if (method === 'GET') {
    const rows = applyRead(DB[table], q).map(r => project(table, r, sel));
    return { status: 200, json: rows };
  }
  if (method === 'POST') {
    const list = Array.isArray(body) ? body : [body];
    const merge = /resolution=merge-duplicates/.test(prefer);
    const conflictCol = q.onConflict || PK[table];
    const done = [];
    for (const raw of list) {
      checkCols(table, raw);
      const exist = merge ? DB[table].find(r => r[conflictCol] === raw[conflictCol]) : null;
      if (exist) {
        const next = Object.assign({}, exist, raw);
        checkRow(table, next, exist);
        Object.assign(exist, raw);
        done.push(exist);
      } else {
        const row = Object.assign(defaults(table), raw);
        for (const c of COLS[table]) if (row[c] === undefined) row[c] = null;
        checkRow(table, row, null);
        DB[table].push(row);
        done.push(row);
      }
    }
    return { status: 201, json: wantRows ? done.map(r => project(table, r, sel)) : null };
  }
  if (method === 'PATCH') {
    checkCols(table, body || {});
    const hits = applyRead(DB[table], Object.assign({}, q, { order: [], limit: null }));
    /* 먼저 전부 확인하고 나서 바꿉니다 (중간에 실패해도 반쯤 바뀌지 않게) */
    for (const r of hits) {
      const next = Object.assign({}, r, body);
      checkRow(table, next, r);
      if (table === 'pcs' && body.pn !== undefined && body.pn !== r.pn &&
          DB.orders.some(o => o.pn === r.pn)) {
        throw new PgErr(409, '23503', 'update or delete on table "pcs" violates foreign key constraint "orders_pn_fkey" on table "orders"');
      }
    }
    for (const r of hits) Object.assign(r, body);
    return { status: 200, json: wantRows ? hits.map(r => project(table, r, sel)) : null };
  }
  if (method === 'DELETE') {
    const hits = applyRead(DB[table], Object.assign({}, q, { order: [], limit: null }));
    if (table === 'pcs') {
      for (const r of hits) {
        if (DB.orders.some(o => o.pn === r.pn)) {
          throw new PgErr(409, '23503', 'update or delete on table "pcs" violates foreign key constraint "orders_pn_fkey" on table "orders"');
        }
      }
    }
    DB[table] = DB[table].filter(r => !hits.includes(r));
    return { status: 200, json: wantRows ? hits.map(r => project(table, r, sel)) : null };
  }
  throw new PgErr(405, 'PGRST000', 'method');
}

function start(port) {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
      calls.push({ method: req.method, path: u.pathname, qs: u.search });
      let out;
      try {
        out = handle(req.method, u.pathname, u.search, req.headers, body);
      } catch (e) {
        const st = e.status || 500;
        res.writeHead(st, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: e.code || 'XX000', message: e.message, details: null, hint: null }));
        return;
      }
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.json === null || out.json === undefined ? '' : JSON.stringify(out.json));
    });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

module.exports = {
  start,
  get db() { return DB; },
  reset() { DB = makeDb(); calls.length = 0; },
  calls,
};
