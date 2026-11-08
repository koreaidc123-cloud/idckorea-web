/* ═══════════════════════════════════════════════════════════════
   시험용 가짜 Supabase (PostgREST 흉내) — 진짜 데이터베이스는 절대 부르지 않습니다

   api/_supa.js 의 sb() 가 보내는 요청만 알아듣는 작은 서버입니다.
     · GET    /rest/v1/<표>?select=...&col=eq.값&order=...&limit=...
     · POST   /rest/v1/<표>            새 줄 넣기 (Prefer: resolution=merge-duplicates 면 덮어쓰기)
     · PATCH  /rest/v1/<표>?조건        고치기 (Prefer: return=representation 이면 바뀐 줄을 돌려줌)
     · DELETE /rest/v1/<표>?조건        지우기
     · POST   /rest/v1/rpc/sweep_expired · rpc/beat
              rpc/apply_extension · revert_extension · admin_extend_order (db/10 을 켰을 때만 · setV10)
     · 조건: eq neq gt gte lt lte in is like ilike (앞에 not. 가능)

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
  /* AI 허브 (db/11-AI허브.sql · 2026-11-08) — setHub(false) 면 '아직 안 돌린 Supabase' 처럼 표가 없습니다 */
  hub_sources: ['id', 'kind', 'name', 'url_or_channel_id', 'topic', 'enabled', 'created_at'],
  hub_items: ['id', 'source_id', 'kind', 'title', 'url', 'summary', 'thumb', 'published_at', 'views', 'score', 'hidden', 'pinned', 'created_at'],
  hub_briefs: ['id', 'day', 'title', 'body', 'status', 'source', 'created_at', 'published_at', 'who'],
};
let hubOn = true;
/* db/11 의 unique · check 제약 (겹치면 23505 · 값이 틀리면 23514) */
const HUB_UNIQ = { hub_sources: 'url_or_channel_id', hub_items: 'url', hub_briefs: 'day' };
const HUB_CHECK = { hub_sources: r => ['rss', 'youtube'].includes(r.kind), hub_items: r => ['news', 'youtube'].includes(r.kind) && (r.summary == null || r.summary.length <= 200) && !!r.title && !!r.url,
  hub_briefs: r => ['draft', 'published'].includes(r.status) && ['ai_hq', 'admin'].includes(r.source) && /^\d{4}-\d{2}-\d{2}$/.test(String(r.day)) && !!r.title && !!r.body };
/* db/08-반납초기화.sql 을 돌리면 생기는 칸 — v08 이 false 면 "아직 안 돌린 Supabase" 처럼
   이 칸들이 없고, 만료 정리도 예전(07) 방식으로 돕니다. 대표님이 SQL 을 돌리기 전에도
   코드가 멈추지 않는지 시험하려고 둘 다 흉내 냅니다. */
const V08 = { pcs: ['wipe_at', 'hold_until'], orders: ['refund_state', 'refund_done_at'] };
let v08 = true;
/* db/10-연장결제.sql 을 돌리면 생기는 칸 · 함수 (2026-11-08)
   ★ 기본은 "아직 안 돌린 Supabase" (v10=false) 입니다 — 월요일 결제 시험 때의 실제 상태라서,
     예전 시험들이 그대로 통과해야 합니다. 연장 결제 시험(EX*)만 setV10(true) 로 켭니다. */
const V10 = { orders: ['kind', 'parent_id', 'ext_from', 'ext_to', 'applied_at', 'ext_req', 'cancel_lock_at', 'cancel_job', 'refund_plan'] };
let v10 = false;
const colsOf = t => {
  let c = COLS[t];
  if (v08 && V08[t]) c = c.concat(V08[t]);
  if (v10 && V10[t]) c = c.concat(V10[t]);
  return c;
};
const PK = { pcs: 'pn', pcs_unregistered: 'hw_id', members: 'id', orders: 'order_id', view_log: 'id', settings: 'k',
  hub_sources: 'id', hub_items: 'id', hub_briefs: 'id' };

/* 다른 표를 붙여 읽기 (select=*,pcs(pn,anydesk) 같은 것) — 외래키 방향 */
const EMBED = {
  orders: {
    pcs: { table: 'pcs', local: 'pn', remote: 'pn' },
    members: { table: 'members', local: 'member_id', remote: 'id' },
  },
};

let seqLog = 1, seqHub = 1;
function defaults(table) {
  const now = new Date().toISOString();
  switch (table) {
    case 'pcs': return { status: 'new', online: false, in_use: false, created_at: now, updated_at: now };
    case 'pcs_unregistered': return { first_seen: now, last_beat: now };
    case 'members': return { id: crypto.randomUUID(), marketing: false, created_at: now };
    case 'orders': return Object.assign({ status: 'ready', setup_fee: 5000, tax_invoice: false, created_at: now },
      v10 ? { kind: 'new' } : {});
    case 'view_log': return { id: seqLog++, at: now };
    case 'hub_sources': return { id: seqHub++, enabled: true, created_at: now };
    case 'hub_items': return { id: seqHub++, score: 0, hidden: false, pinned: false, created_at: now };
    case 'hub_briefs': return { id: seqHub++, status: 'draft', source: 'admin', created_at: now };
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
    if (it.col === '*') { for (const c of colsOf(table)) out[c] = row[c] === undefined ? null : row[c]; continue; }
    if (it.col) {
      if (!colsOf(table).includes(it.col)) throw new PgErr(400, '42703', `column ${table}.${it.col} does not exist`);
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
  if (!colsOf(table).includes(col)) throw new PgErr(400, '42703', `column ${table}.${col} does not exist`);
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
    /* like · ilike — PostgREST 처럼 * 가 "아무 글자나" 입니다 (관리자 기록 화면이 씀 · 2026-11-08) */
    case 'like': case 'ilike': {
      const rx = new RegExp('^' + v.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
        op === 'ilike' ? 'is' : 's');
      f = r => r[col] != null && rx.test(String(r[col]));
      break;
    }
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
        if (!colsOf(table).includes(c)) throw new PgErr(400, '42703', `column ${table}.${c} does not exist`);
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
/* 시험용 한 번짜리 끼어들기 — 새 회원을 넣기 "직전" 에 다른 창이 먼저 넣은 것처럼 만들 때 씁니다 (2026-11-08) */
const hooks = { beforeMemberInsert: null };
function checkRow(table, row, self) {
  if (table === 'members' && !self && hooks.beforeMemberInsert) {
    const f = hooks.beforeMemberInsert; hooks.beforeMemberInsert = null; f(DB, row);
  }
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
    /* db/10 — 종류 검사 · 원 주문 외래키 · "결제 대기 연장은 원 주문당 하나" 부분 유일 색인 */
    if (v10) {
      if (row.kind != null && !['new', 'extend'].includes(row.kind)) {
        throw new PgErr(400, '23514', 'new row for relation "orders" violates check constraint "orders_kind_check"');
      }
      if (row.parent_id != null && !DB.orders.some(o => o.order_id === row.parent_id)) {
        throw new PgErr(409, '23503', 'insert or update on table "orders" violates foreign key constraint "orders_parent_id_fkey"');
      }
      if (row.kind === 'extend' && row.status === 'ready' &&
          others.some(o => o.kind === 'extend' && o.status === 'ready' && o.parent_id === row.parent_id)) {
        throw new PgErr(409, '23505', 'duplicate key value violates unique constraint "orders_one_ready_ext"');
      }
      if (row.ext_req != null && others.some(o => o.ext_req === row.ext_req)) {
        throw new PgErr(409, '23505', 'duplicate key value violates unique constraint "orders_ext_req_uq"');
      }
    }
  }
  if (HUB_UNIQ[table] && others.some(r => r[HUB_UNIQ[table]] === row[HUB_UNIQ[table]])) {
    throw new PgErr(409, '23505', 'duplicate key value violates unique constraint "' + table + '_' + HUB_UNIQ[table] + '_key"');
  }
  if (HUB_CHECK[table] && !HUB_CHECK[table](row)) {
    throw new PgErr(400, '23514', 'new row for relation "' + table + '" violates check constraint');
  }
  if (table === 'pcs' && row.room && !['K', 'Y', 'D'].includes(row.room)) {
    throw new PgErr(400, '23514', 'new row for relation "pcs" violates check constraint "pcs_room_check"');
  }
}
function checkCols(table, obj) {
  for (const k of Object.keys(obj)) {
    if (!colsOf(table).includes(k)) {
      throw new PgErr(400, 'PGRST204', `Could not find the '${k}' column of '${table}' in the schema cache`);
    }
  }
}

/* ── rpc ── */
function rpc(name, body) {
  if (name === 'sweep_expired') {
    const now = Date.now();
    const expired = DB.orders.filter(o => o.status === 'assigned' && o.ends_at && Date.parse(o.ends_at) < now);
    /* db/08 방식: 만료 → 반납 유예(hold, hold_days 일) → 초기화 대기(wipe)
       07 방식(v08=false): 만료 → 바로 임대 가능(ok) */
    const hs = DB.settings.find(s => s.k === 'hold_days');
    const holdDays = hs && /^\d{1,3}$/.test(hs.v) ? Number(hs.v) : 3;
    const stamp = new Date(now).toISOString();
    for (const o of expired) {
      /* 08 과 같게 — 결제완료(paid)는 날짜와 상관없이 쓰는 중 */
      const busy = DB.orders.some(x => x !== o && x.pn === o.pn && (x.status === 'paid' ||
        (x.status === 'assigned' && !(x.ends_at && Date.parse(x.ends_at) < now))));
      const pc = DB.pcs.find(p => p.pn === o.pn);
      if (pc && pc.status === 'rent' && !busy) {
        if (v08) Object.assign(pc, { status: 'hold', hold_until: new Date(now + holdDays * 86400000).toISOString(), updated_at: stamp });
        else Object.assign(pc, { status: 'ok', updated_at: stamp });
      }
      o.status = 'expired';
    }
    if (v08) {
      for (const pc of DB.pcs) {
        if (pc.status === 'hold' && pc.hold_until && Date.parse(pc.hold_until) < now) {
          Object.assign(pc, { status: 'wipe', wipe_at: stamp, updated_at: stamp });
        }
      }
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
  /* db/10 함수들 — SQL 과 같은 순서 · 같은 조건으로 흉내 냅니다 (한 요청이 한 번에 끝나므로 잠금과 같음) */
  if (v10 && FN10[name]) return FN10[name](body || {});
  throw new PgErr(404, 'PGRST202', 'Could not find the function public.' + name);
}

/* ── db/10 흉내 ── */
const ACTIVE = ['assigned', 'paid'];
const isoOf = ms => new Date(ms).toISOString();
function logExt(pn, act, who) {
  DB.view_log.push(Object.assign(defaults('view_log'), { pn, act, who: who || 'system:extend' }));
}
const findOrder = id => DB.orders.find(o => o.order_id === id);
function applyExtension(id) {
  const c = findOrder(id);
  if (!c) return { ok: false, reason: 'no_order' };
  if (c.kind !== 'extend') return { ok: false, reason: 'not_extend' };
  if (c.status !== 'paid') return { ok: true, skip: 'done', status: c.status, pn: c.pn, endsAt: c.ext_to };
  const p = findOrder(c.parent_id);
  if (!p) return { ok: false, reason: 'no_parent' };
  if (!['assigned', 'expired'].includes(p.status) || !p.pn) return { ok: false, reason: 'parent_state', status: p.status };
  const now = Date.now();
  if (p.cancel_lock_at) return { ok: false, reason: 'parent_busy', pn: p.pn };   // 해지 중 — 시간이 지나도 저절로 안 풀림 (SQL 과 같음)
  if (DB.orders.some(o => o.parent_id === p.order_id && o.kind === 'extend' && o.status === 'refunding')) return { ok: false, reason: 'parent_busy', pn: p.pn };
  if (DB.orders.some(o => o.pn === p.pn && ACTIVE.includes(o.status) && o.order_id !== p.order_id)) {
    return { ok: false, reason: 'pc_taken', pn: p.pn };
  }
  const pc = DB.pcs.find(x => x.pn === p.pn);
  const st = pc ? pc.status : null;
  if (!st || (p.status === 'assigned' && !['rent', 'hold'].includes(st)) || (p.status === 'expired' && st !== 'hold')) {
    return { ok: false, reason: 'pc_gone', pn: p.pn, pcStatus: st };
  }
  const base = Math.max(p.ends_at ? Date.parse(p.ends_at) : now, now);
  const end = base + Number(c.days) * 86400000;
  Object.assign(p, { ends_at: isoOf(end), status: 'assigned' });
  Object.assign(pc, { status: 'rent', updated_at: isoOf(now) });
  if (v08) pc.hold_until = null;
  Object.assign(c, { status: 'applied', pn: p.pn, ext_from: isoOf(base), ext_to: isoOf(end),
    starts_at: isoOf(base), ends_at: isoOf(end), applied_at: isoOf(now) });
  logExt(p.pn, `연장 결제 적용 ${c.order_id} · ${c.days}일 · 원 주문 ${p.order_id}`);
  return { ok: true, pn: p.pn, endsAt: isoOf(end), from: isoOf(base), parent: p.order_id };
}
function beginExtRefund(id, amount) {
  const c = findOrder(id);
  if (!c) return { ok: false, reason: 'no_order' };
  if (c.kind !== 'extend') return { ok: false, reason: 'not_extend' };
  if (c.status === 'refunding') {
    return { ok: true, was: c.applied_at ? 'applied' : 'paid', again: true, amount: c.refund_plan, moneyDone: c.refund_amt != null };
  }
  if (!['paid', 'applied'].includes(c.status)) return { ok: false, reason: 'bad_state', status: c.status };
  const amt = amount === null || amount === undefined ? null : Number(amount);
  if (amt === null || !(amt >= 0) || amt > Number(c.amount)) return { ok: false, reason: 'bad_amount' };
  if (c.status === 'applied') {
    const p = findOrder(c.parent_id);
    if (DB.orders.some(o => o.parent_id === c.parent_id && o.kind === 'extend' && ['applied', 'refunding'].includes(o.status) &&
        o.order_id !== c.order_id && Date.parse(o.ext_to) > Date.parse(c.ext_to))) return { ok: false, reason: 'not_latest' };
    if (!p || Date.parse(p.ends_at) !== Date.parse(c.ext_to)) return { ok: false, reason: 'parent_changed' };
  }
  const was = c.status;
  Object.assign(c, { status: 'refunding', refund_plan: amt });
  return { ok: true, was, amount: amt, moneyDone: false };
}
function recordExtRefund(id, state, why) {
  const c = findOrder(id);
  if (!c || c.kind !== 'extend') return { ok: false, reason: 'no_order' };
  if (['refunded', 'canceled'].includes(c.status)) return { ok: true, skip: 'done' };
  if (c.refund_plan == null) return { ok: false, reason: 'no_plan' };
  Object.assign(c, { status: 'refunding', refund_amt: c.refund_plan, refund_state: state,
    refund_why: String(why || '고객 요청').slice(0, 200), canceled_at: c.canceled_at || isoOf(Date.now()) });
  return { ok: true, amount: c.refund_plan };
}
function finishExtRefund(id, st) {
  if (!['refunded', 'canceled'].includes(st)) return { ok: false, reason: 'bad_status' };
  const c = findOrder(id);
  if (!c) return { ok: false, reason: 'no_order' };
  if (['refunded', 'canceled'].includes(c.status)) return { ok: true, skip: 'done', status: c.status };
  if (c.kind !== 'extend' || c.status !== 'refunding') return { ok: false, reason: 'not_refunding', status: c.status };
  const now = Date.now();
  let p = null, vEnd = null, vSt = null;
  if (c.applied_at) {
    p = findOrder(c.parent_id);
    if (!p) return { ok: false, reason: 'no_parent' };
    if (Date.parse(p.ends_at) !== Date.parse(c.ext_to)) return { ok: false, reason: 'parent_changed' };
    vEnd = c.ext_from;
    /* 만료 정리가 이미 expired 로 바꿨어도 날짜는 되돌립니다 (SQL 과 같음) */
    if (!['assigned', 'expired'].includes(p.status)) return { ok: false, reason: 'parent_state', status: p.status };
    const past = Date.parse(vEnd) <= now;
    p.ends_at = vEnd;
    if (p.status === 'assigned' && past) p.status = 'expired';
    vSt = p.status;
    if (past) {
      const pc = DB.pcs.find(x => x.pn === p.pn);
      const busy = DB.orders.some(o => o.pn === p.pn && ACTIVE.includes(o.status) && o.order_id !== p.order_id);
      if (pc && ['rent', 'hold'].includes(pc.status) && !busy) Object.assign(pc, { status: 'wipe', wipe_at: isoOf(now), updated_at: isoOf(now) });
    }
    logExt(p.pn, `연장 되돌림 ${c.order_id} · 원 주문 ${p.order_id}`);
  }
  Object.assign(c, { status: st, canceled_at: c.canceled_at || isoOf(now),
    ends_at: isoOf(Math.min(c.ends_at ? Date.parse(c.ends_at) : now, now)) });
  return { ok: true, pn: (p && p.pn) || c.pn, parentEnd: vEnd, parentStatus: vSt, reverted: !!c.applied_at };
}
function abortExtRefund(id) {
  const c = findOrder(id);
  if (!c || c.status !== 'refunding') return { ok: false, reason: 'not_refunding' };
  if (c.refund_amt !== null && c.refund_amt !== undefined) return { ok: false, reason: 'money_done' };
  Object.assign(c, { status: c.applied_at ? 'applied' : 'paid', refund_plan: null });
  return { ok: true };
}
function beginParentCancel(id, job) {
  if (!job) return { ok: false, reason: 'no_job' };
  const p = findOrder(id);
  if (!p) return { ok: false, reason: 'no_order' };
  const kids = DB.orders.filter(o => o.parent_id === id && o.kind === 'extend' && ['applied', 'paid', 'refunding'].includes(o.status))
    .sort((a, b) => (b.ext_to ? Date.parse(b.ext_to) : Infinity) - (a.ext_to ? Date.parse(a.ext_to) : Infinity))
    .map(o => ({ no: o.order_id, days: o.days, status: o.status }));
  if (kids.length) return { ok: false, reason: 'has_ext', kids };
  Object.assign(p, { cancel_lock_at: isoOf(Date.now()), cancel_job: String(job).slice(0, 64) });
  return { ok: true };
}
/* 관리자 수동 연장 — 실패하면 넣은 줄까지 없던 일로 (apply 는 실패할 때 아무것도 안 바꾸므로 줄만 빼면 됨) */
function adminExtendOrder(b) {
  const days = Number(b.p_days);
  if (![30, 60, 90].includes(days)) return { ok: false, reason: 'bad_days' };
  const p = findOrder(b.p_parent);
  if (!p) return { ok: false, reason: 'no_parent' };
  const req = b.p_req ? String(b.p_req).slice(0, 64) : null;
  if (req) {
    const d = DB.orders.find(o => o.ext_req === req);
    if (d) return { ok: d.status === 'applied' && d.parent_id === p.order_id, dup: true, child: d.order_id, pn: d.pn, endsAt: d.ext_to, reason: 'dup' };
  }
  if (!['assigned', 'expired'].includes(p.status)) return { ok: false, reason: 'parent_state', status: p.status };
  const id = 'MXT' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' +
    crypto.randomBytes(3).toString('hex').toUpperCase();
  const row = Object.assign(defaults('orders'), {
    order_id: id, member_id: p.member_id, pn: null, spec_id: p.spec_id, days, amount: Math.max(Number(b.p_amount) || 0, 0),
    setup_fee: 0, status: 'paid', pay_method: String(b.p_method || '수동').slice(0, 30) || '수동', paid_at: new Date().toISOString(),
    payer_name: p.payer_name, user_name: p.user_name, user_phone: p.user_phone, kind: 'extend', parent_id: p.order_id, ext_req: req,
  });
  for (const c of colsOf('orders')) if (row[c] === undefined) row[c] = null;
  checkRow('orders', row, null);
  DB.orders.push(row);
  const r = applyExtension(id);
  if (!r.ok || r.skip) {
    DB.orders.splice(DB.orders.indexOf(row), 1);
    const pc = DB.pcs.find(x => x.pn === p.pn);
    return { ok: false, reason: r.reason || 'fail', pcStatus: pc ? pc.status : null };
  }
  const lg = DB.view_log.slice().reverse().find(v => v.who === 'system:extend' && v.act.startsWith('연장 결제 적용 ' + id));
  if (lg) lg.who = String(b.p_who || 'admin').slice(0, 60);
  return Object.assign({}, r, { child: id });
}
const FN10 = {
  apply_extension: b => applyExtension(String(b.p_order || '')),
  begin_ext_refund: b => beginExtRefund(String(b.p_order || ''), b.p_amount),
  record_ext_refund: b => recordExtRefund(String(b.p_order || ''), b.p_state, b.p_why),
  finish_ext_refund: b => finishExtRefund(String(b.p_order || ''), b.p_status === undefined ? 'refunded' : b.p_status),
  abort_ext_refund: b => abortExtRefund(String(b.p_order || '')),
  /* 웹훅용 — 시작(전액) + 돈 기록 + 마무리 */
  revert_extension: b => {
    const id = String(b.p_order || ''), c = findOrder(id);
    let r = beginExtRefund(id, c ? c.amount : null);
    if (!r.ok) return r;
    r = recordExtRefund(id, 'toss_done', '토스에서 직접 취소');
    if (!r.ok) return r;
    return finishExtRefund(id, b.p_status === undefined ? 'refunded' : b.p_status);
  },
  begin_parent_cancel: b => beginParentCancel(String(b.p_order || ''), b.p_job),
  abort_parent_cancel: b => {
    const p = findOrder(String(b.p_order || ''));
    if (p && p.cancel_job && p.cancel_job === b.p_job) { p.cancel_lock_at = null; p.cancel_job = null; return { ok: true }; }
    return { ok: false };
  },
  admin_extend_order: adminExtendOrder,
};

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
  if (!hubOn && /^hub_/.test(table)) throw new PgErr(404, 'PGRST205', `Could not find the table 'public.${table}' in the schema cache`);
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
        for (const c of colsOf(table)) if (row[c] === undefined) row[c] = null;
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
  reset() { DB = makeDb(); calls.length = 0; v08 = true; v10 = false; hubOn = true; seqHub = 1; },
  /* false = db/11-AI허브.sql 을 아직 안 돌린 Supabase (hub_* 표 없음) */
  setHub(on) { hubOn = !!on; },
  /* false = db/08 SQL 을 아직 안 돌린 Supabase 흉내 (새 칸 없음 · 옛 만료 정리) */
  setV08(on) { v08 = !!on; },
  get v08() { return v08; },
  /* true = db/10-연장결제.sql 을 돌린 Supabase 흉내 (칸 · 함수 · ext_pay=1).
     SQL 처럼 예전 주문은 kind='new' 로 채웁니다. 끄면 칸 · 함수 · ext_pay 가 없어집니다
     (이미 넣은 값은 남지만 "없는 칸" 이라 읽을 수 없습니다 — 진짜 DB 에서 칸을 지운 것과 비슷) */
  setV10(on) {
    v10 = !!on;
    DB.settings = DB.settings.filter(s => s.k !== 'ext_pay');
    if (v10) {
      for (const o of DB.orders) if (!o.kind) o.kind = 'new';
      for (const k of ['parent_id', 'ext_from', 'ext_to', 'applied_at', 'ext_req', 'cancel_lock_at', 'cancel_job', 'refund_plan']) for (const o of DB.orders) if (o[k] === undefined) o[k] = null;
      DB.settings.push({ k: 'ext_pay', v: '1' });
    }
  },
  get v10() { return v10; },
  hooks,
  calls,
};
