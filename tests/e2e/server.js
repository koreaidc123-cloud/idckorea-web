/* ═══════════════════════════════════════════════════════════════
   시험용 로컬 서버 — 사이트 + api 함수 + 가짜 Supabase + 가짜 토스

   ★ 진짜 서비스는 하나도 부르지 않습니다.
     · Supabase → 같은 프로세스 안의 가짜(fake-supabase.js)로 갑니다
     · 토스      → fetch 를 가로채서 가짜 토스가 답합니다
     · 카카오·네이버 → fetch 를 가로채서 가짜 카카오·네이버가 답합니다 (2026-11-08)
     · 구글 tokeninfo → 가짜 구글이 답합니다 (시험이 넣어 둔 ID 토큰만 통과)
     · AI 허브 RSS · 유튜브 피드 → 시험이 넣어 둔 가짜 피드 글자로 답합니다 (2026-11-08)
     · 알리고·그 밖의 바깥 주소 → 전부 막고 기록만 남깁니다
   ★ 여기 적힌 열쇠·비밀번호는 전부 시험용 가짜 값입니다 (진짜 값과 무관).

   혼자 띄워 눈으로 보고 싶을 때:  node tests/e2e/server.js
   (자동 시험은 run.js 가 이 파일을 불러 씁니다)
   ═══════════════════════════════════════════════════════════════ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PORT = Number(process.env.E2E_DB_PORT || 54329);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 3939);

/* ── 시험용 가짜 환경변수 ─────────────────────────────────────────
   api 파일들은 불러오는 순간 환경변수를 읽으므로, require 보다 먼저 정합니다.
   진짜 키가 이 컴퓨터 환경변수에 있더라도 시험 중에는 쓰지 않도록 지웁니다. */
const TEST = {
  ADMIN_PW: 'e2e-test-admin-password-long-2026',     // 시험용 관리자 비밀번호 (가짜)
  SECRET: 'e2e-test-dummy-secret-0123456789abcdef',    // 시험용 서명 열쇠 (가짜)
  FIELD_PW: 'e2e-test-field-password-long-2026',      // 시험용 두 번째 관리자 '현장' 비밀번호 (가짜)
  CRON: 'e2e-test-cron-secret-0123456789',            // 시험용 Vercel 크론 열쇠 (가짜 · AI 허브 수집)
  HUB: 'e2e-test-hub-token-0123456789abcd',           // 시험용 AI 본부 브리핑 열쇠 (가짜)
};
for (const k of ['KAKAO_JS_KEY', 'KAKAO_REST_KEY', 'KAKAO_APP_ID', 'KAKAO_CLIENT_SECRET',
  'NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'TOSS_CLIENT_KEY', 'ALIGO_KEY', 'ALIGO_USER_ID',
  'ALIGO_SENDER', 'KVC_ADMIN_SECRET', 'KVC_ASSIGN_FRESH_SEC', 'SUPABASE_PUBLISHABLE_KEY', 'CRON_SECRET', 'HUB_TOKEN']) delete process.env[k];
Object.assign(process.env, {
  SUPABASE_URL: `http://127.0.0.1:${DB_PORT}`,
  SUPABASE_SERVICE_KEY: 'test-dummy',
  SUPABASE_PUBLISHABLE_KEY: 'test-dummy-publishable',
  KVC_SECRET: TEST.SECRET,
  KVC_ADMIN_PW: TEST.ADMIN_PW,
  /* 관리자별 비밀번호 (2026-11-08) — 대표 · 현장 두 사람. 시험(L1)에서 지웠다 넣었다 합니다 */
  KVC_ADMINS: '대표:' + TEST.ADMIN_PW + ';현장:' + TEST.FIELD_PW,
  KVC_SETUP_KEY: 'test-dummy-setup-key',
  TOSS_SECRET_KEY: 'test_sk_e2e_dummy_not_real',
  KVC_TEST_PAY: '1',   // 시험 결제 열기 (운영에서는 실결제 키가 없으면 결제가 닫힙니다)
  CRON_SECRET: TEST.CRON,
  HUB_TOKEN: TEST.HUB,
});

const fakeDb = require('./fake-supabase');
/* AI 허브의 DNS 확인(내부망 막기)도 가짜로 — 진짜 DNS 를 묻지 않습니다. internal.e2e.test 만 내부 주소로 답합니다 */
require('../../api/_hub').__setLookup(async h => (h === 'internal.e2e.test' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '203.0.113.10', family: 4 }]));

/* ═══ 가짜 토스 ═══════════════════════════════════════════════════ */
const toss = {
  payments: {},          // paymentKey → 결제 정보
  cancels: [],           // 취소 요청 기록
  confirms: [],          // 승인 요청 기록
  /* 거래내역 (GET /v1/transactions) — 승인·취소가 될 때마다 한 줄씩 쌓입니다.
     시험에서 직접 넣어 "토스에만 있는 결제" 같은 어긋남을 만들 수도 있습니다 (2026-11-08) */
  transactions: [],
  txSeq: 1,
  txCalls: 0,
};
function addTx(o) {
  toss.transactions.push(Object.assign({ transactionKey: 'txk_' + String(toss.txSeq++).padStart(6, '0'),
    method: '카드', currency: 'KRW', transactionAt: new Date().toISOString() }, o));
}
function tossJson(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
async function fakeToss(url, opt) {
  const u = new URL(url);
  const method = (opt && opt.method) || 'GET';
  const body = opt && opt.body ? JSON.parse(opt.body) : {};
  /* 시크릿 키가 Basic 로 실려 왔는지 확인 (값은 기록하지 않습니다) */
  const auth = (opt && opt.headers && (opt.headers.Authorization || opt.headers.authorization)) || '';
  if (!/^Basic /.test(auth)) return tossJson(401, { code: 'UNAUTHORIZED_KEY', message: '인증 없음' });

  if (method === 'POST' && u.pathname === '/v1/payments/confirm') {
    toss.confirms.push(body);
    const ex = toss.payments[body.paymentKey];
    if (ex && ex.confirmed) return tossJson(400, { code: 'ALREADY_PROCESSED_PAYMENT', message: '이미 처리된 결제 입니다.' });
    if (ex && ex.reject) return tossJson(400, { code: ex.reject, message: '시험용 거절' });
    const va = /^tva_/.test(body.paymentKey);
    const pay = Object.assign({
      paymentKey: body.paymentKey, orderId: body.orderId, totalAmount: Number(body.amount), balanceAmount: Number(body.amount),
      method: va ? '가상계좌' : '카드',
      status: va ? 'WAITING_FOR_DEPOSIT' : 'DONE',
      secret: va ? 'vsec_' + Math.random().toString(36).slice(2, 14) : null,
      virtualAccount: va ? { accountNumber: '12345678901234', bankCode: '20', customerName: '시험입금자',
        dueDate: new Date(Date.now() + 86400000).toISOString() } : null,
      card: va ? null : { ownerType: '개인' },
    }, ex || {}, { confirmed: true });
    toss.payments[body.paymentKey] = pay;
    if (pay.status === 'DONE') addTx({ paymentKey: pay.paymentKey, orderId: pay.orderId, status: 'DONE', amount: pay.totalAmount, method: pay.method });
    return tossJson(200, pay);
  }
  let m = u.pathname.match(/^\/v1\/payments\/orders\/(.+)$/);
  if (method === 'GET' && m) {
    const id = decodeURIComponent(m[1]);
    const p = Object.values(toss.payments).find(x => x.orderId === id && x.confirmed);
    return p ? tossJson(200, p) : tossJson(404, { code: 'NOT_FOUND_PAYMENT', message: '없음' });
  }
  m = u.pathname.match(/^\/v1\/payments\/([^/]+)\/cancel$/);
  if (method === 'POST' && m) {
    const key = decodeURIComponent(m[1]);
    const p = toss.payments[key];
    toss.cancels.push(Object.assign({ paymentKey: key }, body));
    if (!p || !p.confirmed) return tossJson(404, { code: 'NOT_FOUND_PAYMENT', message: '없는 결제' });
    if (p.cancelReject) return tossJson(400, { code: p.cancelReject, message: '시험용 취소 거절' });
    p.status = body.cancelAmount && body.cancelAmount < p.totalAmount ? 'PARTIAL_CANCELED' : 'CANCELED';
    p.balanceAmount = Math.max(0, (p.balanceAmount == null ? p.totalAmount : p.balanceAmount) - Number(body.cancelAmount || p.totalAmount));
    addTx({ paymentKey: key, orderId: p.orderId, status: p.status, amount: Number(body.cancelAmount || p.totalAmount), method: p.method });
    return tossJson(200, p);
  }
  /* 거래내역 — startDate · endDate (한국 시각) 사이 · startingAfter 다음부터 · limit 건 */
  if (method === 'GET' && u.pathname === '/v1/transactions') {
    const sd = u.searchParams.get('startDate') || '', ed = u.searchParams.get('endDate') || '';
    const F = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
    if (!F.test(sd) || !F.test(ed)) return tossJson(400, { code: 'INVALID_REQUEST', message: '날짜 형식' });
    const lo = Date.parse(sd + '+09:00'), hi = Date.parse(ed + '+09:00');
    const limit = Math.min(10000, Number(u.searchParams.get('limit') || 100));
    toss.txCalls++;
    let list = toss.transactions.filter(x => { const t = Date.parse(x.transactionAt); return t >= lo && t <= hi; })
      .sort((a, b) => a.transactionKey.localeCompare(b.transactionKey));
    const after = u.searchParams.get('startingAfter');
    if (after) list = list.filter(x => x.transactionKey > after);
    return tossJson(200, list.slice(0, limit));
  }
  m = u.pathname.match(/^\/v1\/payments\/([^/]+)$/);
  if (method === 'GET' && m) {
    const p = toss.payments[decodeURIComponent(m[1])];
    /* 시험용 — 토스 서버 오류 흉내 (대사의 "다시 묻기 실패" 확인) */
    if (p && p.getFail) return tossJson(500, { code: 'FAILED_INTERNAL_SYSTEM_PROCESSING', message: '시험용 오류' });
    return p && p.confirmed ? tossJson(200, p) : tossJson(404, { code: 'NOT_FOUND_PAYMENT', message: '없음' });
  }
  return tossJson(404, { code: 'NOT_FOUND', message: '가짜 토스가 모르는 주소' });
}

/* ═══ 가짜 카카오 · 가짜 네이버 (2026-11-08) ═══════════════════════
   시험이 codes 에 "인가 코드 → 사용자" 를 넣어 두면, 서버가 그 코드로 토큰을 바꾸고
   사용자 정보를 받아 가는 길을 진짜와 같은 모양으로 흉내 냅니다.
     kakao.codes['K-NEW'] = { id: 7001, nickname: '…', email, phone: '+82 10-…', appId: '424242' }
     naver.codes['N-NEW'] = { id: 'nv-…', name: '…', email, mobile: '010-…' }
   코드는 한 번 쓰면 사라집니다 (진짜도 그렇습니다). 값은 전부 시험용 가짜입니다. */
const kakao = { codes: {}, tokens: {}, calls: [] };
const naver = { codes: {}, tokens: {}, calls: [] };
const formOf = opt => Object.fromEntries(new URLSearchParams(String((opt && opt.body) || '')));
const bearer = opt => String((opt && opt.headers && (opt.headers.Authorization || opt.headers.authorization)) || '')
  .replace(/^Bearer /, '');
async function fakeKakao(url, opt) {
  const u = new URL(url);
  const method = (opt && opt.method) || 'GET';
  kakao.calls.push(method + ' ' + u.hostname + u.pathname);
  if (u.hostname === 'kauth.kakao.com' && u.pathname === '/oauth/token' && method === 'POST') {
    const f = formOf(opt);
    if (f.grant_type !== 'authorization_code' || f.client_id !== process.env.KAKAO_REST_KEY || !f.redirect_uri) {
      return tossJson(401, { error: 'invalid_client', error_code: 'KOE101' });
    }
    if ((process.env.KAKAO_CLIENT_SECRET || '') !== (f.client_secret || '')) return tossJson(401, { error: 'invalid_client', error_code: 'KOE010' });
    const who = kakao.codes[f.code];
    if (!who) return tossJson(400, { error: 'invalid_grant', error_code: 'KOE320' });
    delete kakao.codes[f.code];
    const tok = 'kat_' + Math.random().toString(36).slice(2, 14);
    kakao.tokens[tok] = who;
    return tossJson(200, { access_token: tok, token_type: 'bearer', expires_in: 21599 });
  }
  const who = kakao.tokens[bearer(opt)];
  if (!who) return tossJson(401, { msg: 'this access token does not exist', code: -401 });
  if (u.hostname === 'kapi.kakao.com' && u.pathname === '/v1/user/access_token_info') {
    return tossJson(200, { id: who.id, app_id: Number(who.appId), expires_in: 21000 });
  }
  if (u.hostname === 'kapi.kakao.com' && u.pathname === '/v2/user/me') {
    return tossJson(200, { id: who.id, kakao_account: { profile: { nickname: who.nickname }, email: who.email, phone_number: who.phone } });
  }
  return tossJson(404, { msg: '가짜 카카오가 모르는 주소' });
}
async function fakeNaver(url, opt) {
  const u = new URL(url);
  const method = (opt && opt.method) || 'GET';
  naver.calls.push(method + ' ' + u.hostname + u.pathname);
  if (u.hostname === 'nid.naver.com' && u.pathname === '/oauth2.0/token') {
    const f = formOf(opt);
    if (f.client_id !== process.env.NAVER_CLIENT_ID || f.client_secret !== process.env.NAVER_CLIENT_SECRET) {
      return tossJson(200, { error: 'invalid_client', error_description: 'client 오류' });
    }
    const who = naver.codes[f.code];
    if (f.grant_type !== 'authorization_code' || !who || !f.state) return tossJson(200, { error: 'invalid_request', error_description: 'no valid data in session' });
    delete naver.codes[f.code];
    const tok = 'nat_' + Math.random().toString(36).slice(2, 14);
    naver.tokens[tok] = who;
    return tossJson(200, { access_token: tok, refresh_token: 'nrt', token_type: 'bearer', expires_in: '3600' });
  }
  if (u.hostname === 'openapi.naver.com' && u.pathname === '/v1/nid/me') {
    const who = naver.tokens[bearer(opt)];
    if (!who) return tossJson(401, { resultcode: '024', message: 'Authentication failed' });
    return tossJson(200, { resultcode: '00', message: 'success', response: who });
  }
  return tossJson(404, { message: '가짜 네이버가 모르는 주소' });
}

/* 가짜 구글 tokeninfo — google.idTokens['G-OK'] = { sub, name, email, aud } 처럼 넣어 둡니다 */
const google = { idTokens: {}, calls: 0 };
async function fakeGoogle(url) {
  const u = new URL(url);
  google.calls++;
  const t = google.idTokens[u.searchParams.get('id_token') || ''];
  if (u.pathname !== '/tokeninfo' || !t) return tossJson(400, { error: 'invalid_token' });
  return tossJson(200, Object.assign({ exp: String(Math.floor(Date.now() / 1000) + 3600) }, t));
}

/* ═══ 가짜 RSS · 유튜브 피드 (AI 허브 · 2026-11-08) ═══════════════════
   시험이 feeds.byUrl['https://…'] = { status, body } 를 넣어 두면 그 주소만 그 글자로 답합니다.
   넣지 않은 피드 주소는 진짜로 나가지 않고 아래 '바깥 주소 막기' 에 걸립니다.
   feeds.calls 에 서버가 부른 피드 주소가 쌓입니다 (꺼 둔 출처를 부르지 않는지 확인용). */
const feeds = { byUrl: {}, calls: [] };
async function fakeFeed(url) {
  feeds.calls.push(url);
  const f = feeds.byUrl[url];
  if (f.delayMs) await new Promise(r => setTimeout(r, f.delayMs));
  return new Response(f.body || '', { status: f.status || 200, headers: { 'Content-Type': f.type || 'application/xml; charset=utf-8' } });
}

/* ═══ 바깥 주소 막기 ═══════════════════════════════════════════════
   api 함수들이 부르는 fetch 를 가로챕니다. 내 컴퓨터(127.0.0.1)만 그대로 보내고,
   토스는 가짜로, 나머지(카카오·구글·알리고 등)는 막고 기록합니다. */
const blocked = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opt) => {
  const s = String(url && url.url ? url.url : url);
  const u = new URL(s);
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, opt);
  if (u.hostname === 'api.tosspayments.com') return fakeToss(s, opt);
  if (u.hostname === 'kauth.kakao.com' || u.hostname === 'kapi.kakao.com') return fakeKakao(s, opt);
  if (u.hostname === 'nid.naver.com' || u.hostname === 'openapi.naver.com') return fakeNaver(s, opt);
  if (u.hostname === 'oauth2.googleapis.com') return fakeGoogle(s);
  if (Object.prototype.hasOwnProperty.call(feeds.byUrl, s)) return fakeFeed(s);
  blocked.push(u.hostname + u.pathname);
  throw new Error('시험 중에는 바깥 주소를 부르지 않습니다: ' + u.hostname);
};

/* ═══ Vercel 함수처럼 (req, res) 를 꾸며 줍니다 ═══════════════════ */
function vercelify(req, res, rawBody) {
  const u = new URL(req.url, 'http://localhost');
  req.query = Object.fromEntries(u.searchParams);
  req.cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean)
    .map(s => { const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))]; }));
  const ct = String(req.headers['content-type'] || '');
  req.body = undefined;
  if (rawBody.length) {
    if (/application\/json/.test(ct)) {
      try { req.body = JSON.parse(rawBody.toString('utf8')); }
      catch (e) { return 'BADJSON'; }   // Vercel 은 깨진 JSON 이면 400 을 줍니다
    } else req.body = rawBody.toString('utf8');
  }
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => {
    if (res.statusCode >= 500) res.__err = JSON.stringify(obj).slice(0, 200);   // 500 일 때 무슨 오류였는지 Z1 에 보여 주려고
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = b => {
    if (typeof b === 'object' && !Buffer.isBuffer(b)) return res.json(b);
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(b);
    return res;
  };
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.md': 'text/markdown; charset=utf-8' };

const apiLog = [];
function sendFile(res, file) {
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/* vercel.json 의 cleanUrls:true · trailingSlash:false 를 흉내 냅니다
     /live.html → 308 /live      /live → live.html      /live/ → 308 /live */
function serveStatic(req, res, u) {
  let p = decodeURIComponent(u.pathname);
  /* .vercelignore 와 같게 — 배포에 안 올라가는 파일은 여기서도 404 로 둡니다
     (그래야 배포 안 되는 파일을 가리키는 링크를 시험에서 잡을 수 있습니다) */
  const ignored = /^\/(tests|node_modules|\.git|\.claude|db|tools|_보고서)(\/|$)/.test(p) || /\/\./.test(p) ||
    /\.md$/i.test(p) || p === '/관리자-사용설명서.html' || p === '/관리자-사용설명서' ||
    (/^\/agent\//.test(p) && !/^\/agent\/kvc-agent\.ps1(\.sig)?$/.test(p));
  if (p.includes('..') || ignored) {
    res.writeHead(404); return res.end('not found');
  }
  if (p.length > 1 && p.endsWith('/')) {
    res.writeHead(308, { Location: p.replace(/\/+$/, '') + u.search }); return res.end();
  }
  if (/\.html$/.test(p)) {
    const clean = p === '/index.html' ? '/' : p.replace(/\.html$/, '');
    res.writeHead(308, { Location: clean + u.search }); return res.end();
  }
  const tryFiles = p === '/' ? ['index.html'] : [p.slice(1), p.slice(1) + '.html'];
  for (const f of tryFiles) {
    const full = path.join(ROOT, f);
    if (full.startsWith(ROOT) && fs.existsSync(full) && fs.statSync(full).isFile()) return sendFile(res, full);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404');
}

async function serveApi(req, res, u, rawBody) {
  const name = u.pathname.replace(/^\/api\//, '').replace(/\.js$/, '');
  if (!/^[a-z0-9-]+$/.test(name)) { res.writeHead(404); return res.end(); }
  const file = path.join(ROOT, 'api', name + '.js');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('NOT_FOUND'); }
  if (vercelify(req, res, rawBody) === 'BADJSON') {
    res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Invalid JSON');
  }
  const fn = require(file);
  try {
    await fn(req, res);
    apiLog.push({ m: req.method, url: req.url, st: res.statusCode, body: res.__err });
  } catch (e) {
    apiLog.push({ m: req.method, url: req.url, st: 500, err: String(e && e.stack || e) });
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); }
    res.end('FUNCTION_INVOCATION_FAILED');
  }
}

function startWeb(port) {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname.startsWith('/api/')) return serveApi(req, res, u, Buffer.concat(chunks));
      return serveStatic(req, res, u);
    });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

async function start() {
  const db = await fakeDb.start(DB_PORT);
  const web = await startWeb(WEB_PORT);
  return {
    db, web,
    base: `http://localhost:${WEB_PORT}`,
    close: () => Promise.all([new Promise(r => db.close(r)), new Promise(r => web.close(r))]),
  };
}

module.exports = { start, fakeDb, toss, kakao, naver, google, feeds, blocked, apiLog, TEST, ROOT, WEB_PORT };

if (require.main === module) {
  start().then(s => {
    require('./seed').seed();
    console.log('시험 서버 ' + s.base + ' (가짜 DB · 가짜 토스) — 끄려면 Ctrl+C');
  });
}
