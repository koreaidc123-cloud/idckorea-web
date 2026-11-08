/* ═══════════════════════════════════════════════════════════════
   시험용 로컬 서버 — 사이트 + api 함수 + 가짜 Supabase + 가짜 토스

   ★ 진짜 서비스는 하나도 부르지 않습니다.
     · Supabase → 같은 프로세스 안의 가짜(fake-supabase.js)로 갑니다
     · 토스      → fetch 를 가로채서 가짜 토스가 답합니다
     · 카카오·구글·알리고·그 밖의 바깥 주소 → 전부 막고 기록만 남깁니다
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
};
for (const k of ['KAKAO_JS_KEY', 'GOOGLE_CLIENT_ID', 'TOSS_CLIENT_KEY', 'ALIGO_KEY', 'ALIGO_USER_ID',
  'ALIGO_SENDER', 'KVC_ADMIN_SECRET', 'KVC_ASSIGN_FRESH_SEC', 'SUPABASE_PUBLISHABLE_KEY']) delete process.env[k];
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
});

const fakeDb = require('./fake-supabase');

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
    apiLog.push({ m: req.method, url: req.url, st: res.statusCode });
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

module.exports = { start, fakeDb, toss, blocked, apiLog, TEST, ROOT, WEB_PORT };

if (require.main === module) {
  start().then(s => {
    require('./seed').seed();
    console.log('시험 서버 ' + s.base + ' (가짜 DB · 가짜 토스) — 끄려면 Ctrl+C');
  });
}
