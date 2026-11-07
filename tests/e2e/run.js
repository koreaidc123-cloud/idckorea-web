/* ═══════════════════════════════════════════════════════════════
   한국 가상컴 — 처음부터 끝까지 눌러보는 자동 시험 (E2E)

   실행 (저장소 맨 위 폴더에서 한 줄)
     npm --prefix tests/e2e install   ← 처음 한 번만 (playwright-core 설치)
     npm --prefix tests/e2e test

   ★ 진짜 Supabase · 토스 · 카카오 · 구글 · 알리고 · Vercel 은 절대 부르지 않습니다.
     server.js 가 가짜 DB 와 가짜 토스를 띄우고, 브라우저의 바깥 요청은 전부 가로챕니다.
   ★ 브라우저는 이 컴퓨터에 깔린 Edge(없으면 Chrome)를 화면 없이 띄워 씁니다.

   결과는 화면에 표로 나오고, tests/e2e/result.json 에도 남습니다.
   ═══════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const srv = require('./server');
const { seed, XSS } = require('./seed');
const { makeTicket } = require('../../api/_ticket');

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) {
  console.error('playwright-core 가 없습니다. 먼저  npm --prefix tests/e2e install  을 실행해 주세요.');
  process.exit(2);
}

const ONLY = process.argv.slice(2);          // node run.js C6 A3 처럼 일부만 돌릴 때
const results = [];
let BASE, browser;

/* ── 작은 시험 도구 ─────────────────────────────────────────── */
class Fail extends Error {}
const ok = (cond, msg) => { if (!cond) throw new Fail(msg); };
const db = () => srv.fakeDb.db;
const pcOf = pn => db().pcs.find(p => p.pn === pn);
const orderOf = id => db().orders.find(o => o.order_id === id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000, msg = '시간 초과') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Fail(msg);
    await sleep(100);
  }
}

async function scenario(id, name, fn) {
  if (ONLY.length && !ONLY.some(x => id.startsWith(x))) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✔ ${id} ${name}`);
  } catch (e) {
    /* 실패 이유를 넉넉히 남깁니다 (playwright 는 왜 못 눌렀는지를 5줄째 이후에 적습니다) */
    const msg = String(e && e.message || e).split('\n').slice(0, 10).join(' / ');
    results.push({ id, name, ok: false, err: msg });
    console.log(`  ✘ ${id} ${name}\n      → ${msg}`);
    /* E2E_DEBUG=1 이면 잘리지 않은 전체 오류를 보여줍니다 */
    if (process.env.E2E_DEBUG) console.log(String(e && e.stack || e));
  }
}

/* ── 브라우저 바깥 요청 가로채기 ───────────────────────────────
   토스 결제창은 가짜로 바꿉니다. 결제창 대신 곧바로 성공 주소로 보내 줍니다
   (토스가 실제로 하는 것과 같은 모양: ?paymentKey=&orderId=&amount=).
   localStorage.__e2eHold = '1' 이면 바로 넘기지 않고 window.__payUrl 에 담아 둡니다. */
const FAKE_TOSS_SDK = `
window.TossPayments=function(ck){return{payment:function(o){return{requestPayment:async function(req){
  window.__lastPayReq=req;
  var va=req.method==='VIRTUAL_ACCOUNT';
  var key=(va?'tva_':'tcard_')+Math.random().toString(36).slice(2,12);
  var u=new URL(req.successUrl);
  u.searchParams.set('paymentKey',key);u.searchParams.set('orderId',req.orderId);
  u.searchParams.set('amount',String(req.amount.value));
  window.__payUrl=u.toString();
  if(localStorage.getItem('__e2eHold')==='1') return;
  location.href=u.toString();
}}}}};`;
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const external = [];
let faviconMissing = false;

async function newContext(opt = {}) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' }, opt));
  await ctx.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return route.continue();
    external.push(u.hostname + u.pathname);
    if (u.hostname === 'js.tosspayments.com') return route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_TOSS_SDK });
    if (/\.css($|\?)/.test(u.pathname) || u.hostname === 'cdn.jsdelivr.net') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (/\.(jpg|png|gif|webp)$/.test(u.pathname) || u.hostname.endsWith('ytimg.com')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG1 });
    if (/\.js$|gsi\/client/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    return route.fulfill({ status: 204, body: '' });
  });
  return ctx;
}

/* 페이지 하나 열기 — 콘솔 오류 · 스크립트 오류 · 대화상자를 모아 둡니다 */
async function openPage(ctx, url, { answers = [] } = {}) {
  const page = await ctx.newPage();
  page.errors = []; page.dialogs = []; page.answers = answers.slice(); page.xss = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = (m.location() && m.location().url) || '';
    /* 서버가 일부러 401·409 를 준 API 응답은 브라우저가 콘솔에 찍어도 오류가 아닙니다 */
    if (/Failed to load resource/.test(m.text()) && /\/api\//.test(loc)) return;
    /* 파비콘(탭 아이콘)이 아직 없어 브라우저가 /favicon.ico 를 찾다 404 를 냅니다.
       화면·기능과 무관하고, 아이콘은 디자인이라 대표님 결정 전에는 만들지 않습니다 → 따로 셉니다 */
    if (/\/favicon\.ico$/.test(loc)) { faviconMissing = true; return; }
    page.errors.push(m.text() + (loc ? ' @' + loc : ''));
  });
  page.on('pageerror', e => page.errors.push('pageerror: ' + e.message));
  page.on('dialog', async d => {
    const msg = d.message();
    page.dialogs.push({ type: d.type(), msg, def: d.defaultValue() });   // def = 입력창에 미리 채워진 값
    if (d.type() === 'alert' && msg === '1') page.xss.push(page.url());     // <img onerror=alert(1)> 이 실행됨
    const a = page.answers.length ? page.answers.shift() : undefined;
    if (d.type() === 'prompt') return d.accept(a === undefined ? (d.defaultValue() || '') : String(a));
    if (d.type() === 'confirm') return a === false ? d.dismiss() : d.accept();
    return d.accept();
  });
  if (url) await page.goto(BASE + url, { waitUntil: 'load' });
  return page;
}
const lastDialog = p => (p.dialogs[p.dialogs.length - 1] || {}).msg || '';

/* 고객 로그인 흉내 — 진짜 카카오 대신, 서버의 makeTicket 으로 출입증 쿠키를 만듭니다 */
async function loginCustomer(ctx, memberId, user) {
  await ctx.addCookies([{ name: 'kvc_cust', value: encodeURIComponent(makeTicket(memberId)),
    domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
  await ctx.addInitScript(u => {
    if (!localStorage.getItem('kvc-user')) localStorage.setItem('kvc-user', JSON.stringify(u));
  }, user);
}

async function adminLogin(page, pw = srv.TEST.ADMIN_PW) {
  await page.fill('#gate-pw', pw);
  await page.click('#gate-go');
}
async function adminReady(page) {
  await page.waitForFunction(() => document.getElementById('gate').classList.contains('off')
    && /실서버 연동중/.test((document.querySelector('.ft') || {}).textContent || ''), null, { timeout: 8000 });
  /* 주문은 PC 목록 다음에 따로 받아옵니다 — 시드에 주문이 있으니 HISTORY 가 차면 다 온 것 */
  await page.waitForFunction(() => HISTORY.length > 0, null, { timeout: 8000 });
}
/* 관리자 화면 이동 — 열려 있는 서랍(상세 창)을 닫고 주소 # 만 바꿉니다 */
async function view(page, v) {
  await page.evaluate(x => { closeDrawer(); location.hash = '#' + x; }, v);
  await page.waitForFunction(x => document.querySelector('.nav a.on') &&
    document.querySelector('.nav a.on').dataset.v === x, v, { timeout: 5000 });
}
const mainText = p => p.$eval('#main', e => e.innerText);
const drawerText = p => p.$eval('#drawer', e => e.innerText);

/* 서버 API 를 브라우저 쿠키 그대로 직접 부르기 (화면이 없는 확인용) */
const apiIn = (page, url, body) => page.evaluate(async ([u, b]) => {
  const r = await fetch(u, b === undefined ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, d };
}, [url, body]);
const post = async (url, body) => {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, d };
};

/* ═══════════════════════════════════════════════════════════════ */
const XSS_ID = '22222222-2222-4222-8222-222222222222';
const XSS_USER = { name: XSS, phone: '010-3333-4444', via: 'kakao' };
const CUSTOMER_PAGES = ['/', '/live', '/product', '/about', '/qa', '/login', '/mypage', '/success', '/fail', '/terms', '/privacy'];
/* 관리자-사용설명서.html 은 .vercelignore 로 배포되지 않으므로 넣지 않습니다 */
const ALL_PAGES = CUSTOMER_PAGES.concat(['/admin', '/ai', '/diag']);
const S = {};       // 시나리오끼리 넘겨 쓰는 값

async function main() {
  const s = await srv.start();
  BASE = s.base;
  seed();
  for (const ch of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {}
  }
  if (!browser) { console.error('Edge·Chrome 을 찾지 못했습니다'); process.exit(2); }
  console.log('시험 시작 — ' + BASE + '\n');

  /* ══════════ 공통 — 모든 화면 ══════════ */
  await scenario('G1', '모든 화면이 콘솔 오류 없이 열린다', async () => {
    const ctx = await newContext(); const bad = [];
    for (const u of ALL_PAGES) {
      const p = await openPage(ctx, u);
      await sleep(400);
      if (p.errors.length) bad.push(u + ' → ' + p.errors.join(' | '));
      await p.close();
    }
    await ctx.close();
    ok(!bad.length, bad.join(' ;; '));
  });

  await scenario('G2', '내부 링크·이미지·스크립트가 모두 살아 있다', async () => {
    const ctx = await newContext(); const seen = new Set(), bad = [];
    for (const u of ALL_PAGES) {
      const p = await openPage(ctx, u);
      await sleep(300);
      const refs = await p.evaluate(() => {
        const out = [];
        document.querySelectorAll('a[href],img[src],link[href],script[src],source[src],source[srcset]').forEach(e => {
          const v = e.getAttribute('href') || e.getAttribute('src') || e.getAttribute('srcset');
          if (v) out.push(v.split(' ')[0]);
        });
        const imgs = [...document.images].filter(i => i.complete && i.naturalWidth === 0 && i.src.startsWith(location.origin)
          && getComputedStyle(i).display !== 'none').map(i => i.getAttribute('src'));
        return { out, imgs };
      });
      for (const im of refs.imgs) bad.push(u + ' 깨진 이미지 ' + im);
      for (const r of refs.out) {
        if (/^(https?:|mailto:|tel:|#|javascript:|data:)/.test(r) && !r.startsWith(BASE)) continue;
        const abs = new URL(r, BASE + u).toString().split('#')[0];
        if (seen.has(abs)) continue; seen.add(abs);
        const res = await fetch(abs, { redirect: 'follow' });
        if (res.status >= 400) bad.push(`${u} → ${r} (${res.status})`);
      }
      await p.close();
    }
    await ctx.close();
    ok(!bad.length, bad.join(' ;; '));
  });

  await scenario('G3', '고객 화면 전부에 사업자 정보 꼬리말', async () => {
    const ctx = await newContext(); const bad = [];
    for (const u of CUSTOMER_PAGES) {
      const p = await openPage(ctx, u);
      const t = await p.evaluate(() => document.body.innerText);
      for (const w of ['한국가상컴', '102-05-08486', '통신판매업', '010-8446-8710', '이용약관', '개인정보처리방침']) {
        if (!t.includes(w)) bad.push(u + ' 에 「' + w + '」 없음');
      }
      for (const w of ['금촌', '영태리', '등원리']) if (t.includes(w)) bad.push(u + ' 에 서버실 실명 「' + w + '」');
      await p.close();
    }
    await ctx.close();
    ok(!bad.length, bad.join(' ;; '));
  });

  await scenario('G4', '휴대폰 폭 390 에서 가로 넘침 없음', async () => {
    const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const bad = [];
    for (const u of ['/', '/live', '/product?g=3&pc=Y-003', '/about', '/qa', '/login', '/mypage', '/success', '/fail', '/terms', '/privacy']) {
      const p = await openPage(ctx, u);
      await sleep(400);
      const w = await p.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
      if (w > 391) {
        const who = await p.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > 392)
          .slice(0, 3).map(e => e.tagName + '.' + String(e.className).slice(0, 30)).join(','));
        bad.push(`${u} 폭 ${w}px (${who})`);
      }
      await p.close();
    }
    await ctx.close();
    ok(!bad.length, bad.join(' ;; '));
  });

  /* ══════════ 고객 ══════════ */
  await scenario('C1', '고객 목록 API·화면에 판매 가능한 PC 만 (미등록·미검증 제외)', async () => {
    const r = await (await fetch(BASE + '/api/live-pcs')).json();
    const ids = r.pcs.map(p => p.id);
    ok(!ids.includes('Y-005') && !ids.includes('Y-006'), '미등록/미검증 PC 가 고객 목록에 있음: ' + ids.join(','));
    ok(!JSON.stringify(r).match(/anydesk|pw_enc|rack|금촌|영태리|등원리|1042887/), '민감정보가 고객 API 에 섞임');
    const free = r.pcs.filter(p => p.st === 'free').map(p => p.id).sort();
    ok(!free.includes('K-001'), '신호 끊긴 K-001 이 임대 가능으로 나감');
    const ctx = await newContext();
    const p = await openPage(ctx, '/live');
    await p.waitForSelector('.tr[data-id]');
    const rows = await p.$$eval('.tr[data-id]', es => es.map(e => e.dataset.id).sort());
    ok(JSON.stringify(rows) === JSON.stringify(free), `화면 목록 ${rows} ≠ 판매가능 ${free}`);
    S.free = free;
    await ctx.close();
  });

  await scenario('C2', '목록에서 PC 선택 → product?g=&pc= 로 이동', async () => {
    const ctx = await newContext();
    const p = await openPage(ctx, '/live');
    await p.click('.tr[data-id="Y-001"]');
    const href = await p.getAttribute('#sgo', 'href');
    ok(href === 'product.html?g=5&pc=Y-001', '결제 링크가 ' + href);
    await Promise.all([p.waitForNavigation(), p.click('#sgo')]);
    const t = await p.evaluate(() => document.body.innerText);
    ok(/선택하신 PC: Y-001/.test(t), '선택 PC 표시 없음');
    ok(/65,000원/.test(t), '3700X 가격 표시 없음');
    const p2 = await openPage(ctx, '/product?g=2&pc=Y-003');
    const t2 = await p2.evaluate(() => document.body.innerText);
    ok(/라이젠 2200G/.test(t2) && /40,000원/.test(t2), '2번 상품 화면이 안 바뀜');
    await ctx.close();
  });

  await scenario('C3', '로그인 안 하고 결제 → 로그인 화면 → 같은 g·pc 로 돌아옴', async () => {
    const ctx = await newContext();
    const p = await openPage(ctx, '/product?g=5&pc=Y-001', { answers: [true] });
    await Promise.all([p.waitForNavigation(), p.click('#go')]);
    const u = new URL(p.url());
    ok(u.pathname === '/login', '로그인 화면으로 안 감: ' + p.url());
    ok(u.searchParams.get('next') === 'product.html?g=5&pc=Y-001', 'next 값이 ' + u.searchParams.get('next'));
    const after = await p.evaluate(() => AFTER);
    ok(after === 'product.html?g=5&pc=Y-001', '로그인 후 갈 곳이 ' + after);
    /* 카카오 대신 출입증을 넣고 로그인 완료 처리 (login.html 의 saveSession 과 같은 일) */
    await loginCustomer(ctx, XSS_ID, XSS_USER);
    await Promise.all([p.waitForNavigation(), p.evaluate(u => saveSession(u), XSS_USER)]);
    const back = new URL(p.url());
    ok(back.pathname === '/product' && back.searchParams.get('g') === '5' && back.searchParams.get('pc') === 'Y-001',
      '돌아온 주소가 ' + p.url());
    await ctx.close();
  });

  await scenario('C4', '카드 결제 → 성공 화면에 고른 PC(Y-001) · DB 배정', async () => {
    const ctx = await newContext();
    await loginCustomer(ctx, XSS_ID, XSS_USER);
    const p = await openPage(ctx, '/product?g=5&pc=Y-001');
    await p.click('.pays button[data-p="cd"]');
    await Promise.all([p.waitForURL(/\/success/), p.click('#go')]);
    await p.waitForFunction(() => /개통이 완료|결제가 완료|실패/.test(document.body.innerText), null, { timeout: 8000 });
    const t = await p.evaluate(() => document.body.innerText);
    ok(/개통이 완료/.test(t), '개통 완료가 아님: ' + t.slice(0, 200));
    ok(/Y-001/.test(t), '성공 화면에 Y-001 없음');
    ok(/1 042 887 613/.test(t), '애니데스크 번호 표기 다름');
    ok(!/pw-Y-001/.test(t), '성공 화면에 비밀번호가 노출됨');
    const q = new URL(p.url()).searchParams;
    const o = orderOf(q.get('orderId'));
    ok(o && o.status === 'assigned' && o.pn === 'Y-001', '주문 상태 ' + JSON.stringify(o && { st: o.status, pn: o.pn }));
    ok(o.member_id === XSS_ID, '주문에 회원이 안 붙음');
    ok(o.amount === 65000, '금액 ' + o.amount);
    ok(pcOf('Y-001').status === 'rent', 'Y-001 이 임대중이 아님');
    S.cardOrder = o.order_id; S.cardUrl = p.url();
    ok(!p.errors.length, '콘솔 오류: ' + p.errors.join(' | '));
    await ctx.close();
  });

  await scenario('C5', '성공 화면 새로고침 → 같은 PC · PC 를 또 잡지 않음', async () => {
    ok(S.cardUrl, 'C4 가 먼저 성공해야 합니다');
    const rentBefore = db().pcs.filter(x => x.status === 'rent').length;
    const ctx = await newContext();
    await loginCustomer(ctx, XSS_ID, XSS_USER);
    const p = await openPage(ctx, S.cardUrl.replace(BASE, ''));
    await p.waitForFunction(() => /개통이 완료|결제가 완료|실패/.test(document.body.innerText), null, { timeout: 8000 });
    const t = await p.evaluate(() => document.body.innerText);
    ok(/개통이 완료/.test(t) && /Y-001/.test(t), '새로고침 화면: ' + t.slice(0, 160));
    ok(db().pcs.filter(x => x.status === 'rent').length === rentBefore, 'PC 를 한 대 더 잡음');
    await ctx.close();
  });

  await scenario('C6', '내 가상컴 — PC 카드 · 비밀번호 보기 · 버튼은 카카오톡 · 이름은 글자로', async () => {
    const ctx = await newContext();
    await loginCustomer(ctx, XSS_ID, XSS_USER);
    const p = await openPage(ctx, '/mypage');
    await p.waitForSelector('.pc');
    const t = await p.evaluate(() => document.body.innerText);
    ok(/Y-001/.test(t), '내 가상컴에 Y-001 없음');
    ok(t.includes(XSS), '이름이 글자 그대로 안 보임');
    ok(!(await p.$('img[src="x"]')), '이름의 <img> 가 실제 태그로 들어감');
    await p.click('.pc [data-pw="0"]');
    await p.waitForFunction(() => document.getElementById('pw0').textContent !== '••••••');
    ok((await p.textContent('#pw0')) === 'pw-Y-001', '비밀번호 ' + await p.textContent('#pw0'));
    ok(db().view_log.some(v => v.pn === 'Y-001' && /고객 본인 열람/.test(v.act)), '열람 기록 없음');
    const hrefs = await p.$$eval('.pc .acts a', as => as.map(a => a.href));
    ok(hrefs.length === 3 && hrefs.every(h => /pf\.kakao\.com/.test(h)), '버튼 링크 ' + hrefs);
    /* 남의 PC 비밀번호는 못 봄 */
    const other = await apiIn(p, '/api/customer?do=secret&pn=Y-004');
    ok(other.status === 403, '남의 PC 비밀번호 응답 ' + other.status);
    ok(!p.xss.length && !p.errors.length, '오류/XSS: ' + p.errors.join('|'));
    await ctx.close();
  });

  await scenario('C7', '가상계좌 → 계좌 발급 화면 → secret 틀린 웹훅 무시 → 맞는 웹훅에 배정', async () => {
    const ctx = await newContext();
    await loginCustomer(ctx, XSS_ID, XSS_USER);
    const p = await openPage(ctx, '/product?g=5');
    await p.click('.pays button[data-p="vb"]');
    await Promise.all([p.waitForURL(/\/success/), p.click('#go')]);
    await p.waitForFunction(() => /입금 계좌가 발급|실패/.test(document.body.innerText), null, { timeout: 8000 });
    const t = await p.evaluate(() => document.body.innerText);
    ok(/입금 계좌가 발급/.test(t), '계좌 화면 아님: ' + t.slice(0, 120));
    const id = new URL(p.url()).searchParams.get('orderId');
    const o = orderOf(id);
    ok(o.status === 'ready' && o.va_secret && o.pay_method === '가상계좌', '주문 ' + JSON.stringify({ st: o.status, s: !!o.va_secret }));
    S.vaOrder = id;
    /* secret 없이 / 틀리게 */
    let r = await post('/api/toss-webhook', { orderId: id, status: 'DONE' });
    ok(r.status === 200 && orderOf(id).status === 'ready', 'secret 없는 웹훅이 통과: ' + JSON.stringify(r.d));
    r = await post('/api/toss-webhook', { eventType: 'DEPOSIT_CALLBACK', orderId: id, status: 'DONE', secret: 'wrong' });
    ok(orderOf(id).status === 'ready', 'secret 틀린 웹훅이 통과');
    /* secret 은 맞지만 토스가 아직 입금 전이라고 하면 무시 */
    r = await post('/api/toss-webhook', { eventType: 'DEPOSIT_CALLBACK', orderId: id, status: 'DONE', secret: o.va_secret });
    ok(orderOf(id).status === 'ready', '토스가 입금 전인데 통과: ' + JSON.stringify(r.d));
    /* 토스가 입금 완료라고 답하면 배정 */
    srv.toss.payments[o.pay_key].status = 'DONE';
    r = await post('/api/toss-webhook', { eventType: 'DEPOSIT_CALLBACK', orderId: id, status: 'DONE', secret: o.va_secret });
    const o2 = orderOf(id);
    ok(o2.status === 'assigned' && o2.pn, '입금 후 배정 안 됨: ' + JSON.stringify(r.d));
    ok(pcOf(o2.pn).status === 'rent', '배정 PC 가 임대중 아님');
    S.vaPn = o2.pn;
    /* 같은 웹훅이 또 와도 두 번 배정하지 않음 */
    const rent = db().pcs.filter(x => x.status === 'rent').length;
    await post('/api/toss-webhook', { eventType: 'DEPOSIT_CALLBACK', orderId: id, status: 'DONE', secret: o.va_secret });
    ok(db().pcs.filter(x => x.status === 'rent').length === rent, '중복 웹훅에 PC 를 또 잡음');
    await ctx.close();
  });

  await scenario('C8', '가짜 CANCELED 웹훅은 무시 · 토스가 취소라고 할 때만 환불 처리', async () => {
    ok(S.vaOrder, 'C7 이 먼저 성공해야 합니다');
    const id = S.vaOrder, o = orderOf(id);
    let r = await post('/api/toss-webhook', { eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: id, status: 'CANCELED' } });
    ok(orderOf(id).status === 'assigned', '가짜 취소가 통과: ' + JSON.stringify(r.d));
    r = await post('/api/toss-webhook', { eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: 'NOPE-123', status: 'CANCELED' } });
    ok(r.status === 200, '없는 주문 웹훅 응답 ' + r.status);
    srv.toss.payments[o.pay_key].status = 'CANCELED';
    r = await post('/api/toss-webhook', { eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: id, status: 'CANCELED' } });
    ok(orderOf(id).status === 'refunded', '진짜 취소가 반영 안 됨: ' + JSON.stringify(r.d));
    /* 2026-11-07 — 취소된 PC 는 바로 판매가 아니라 초기화 대기(wipe) 로 갑니다 (앞 손님 자료 보호) */
    ok(pcOf(S.vaPn).status === 'wipe', '취소 후 PC 가 초기화 대기로 안 감: ' + pcOf(S.vaPn).status);
    ok(orderOf(id).refund_state === 'toss_done', '토스 취소인데 송금 상태가 ' + orderOf(id).refund_state);
    /* 뒤 관리자 시험(A3~A7)이 이 PC(보통 Y-002)를 "임대 가능" 으로 쓰므로,
       관리자가 초기화를 마친 것처럼 되돌려 둡니다 (C10 이 D-001 을 되돌리는 것과 같음) */
    pcOf(S.vaPn).status = 'ok';
  });

  await scenario('C9', '재고 0 상품은 결제창 전에 막힘', async () => {
    const ctx = await newContext();
    await loginCustomer(ctx, XSS_ID, XSS_USER);
    const p = await openPage(ctx, '/product?g=1');
    const before = db().orders.length;
    await p.click('#go');
    await until(() => p.dialogs.length, 5000, '안내창이 안 뜸');
    ok(/모두 임대중/.test(lastDialog(p)), '안내 문구: ' + lastDialog(p));
    ok(db().orders.length === before, '재고 0 인데 주문이 만들어짐');
    ok(new URL(p.url()).pathname === '/product', '결제 화면으로 넘어감');
    await ctx.close();
  });

  await scenario('C10', '결제 사이 재고가 사라지면 → 결제완료 · 배정 대기', async () => {
    const ctx = await newContext();
    await loginCustomer(ctx, XSS_ID, XSS_USER);
    await ctx.addInitScript(() => localStorage.setItem('__e2eHold', '1'));
    const p = await openPage(ctx, '/product?g=4&pc=D-001');
    await p.click('.pays button[data-p="cd"]');
    await p.click('#go');
    const payUrl = await until(() => p.evaluate(() => window.__payUrl), 5000, '결제창(가짜)이 안 열림');
    /* 결제창이 떠 있는 사이 다른 사람이 마지막 1700 을 가져감 */
    pcOf('D-001').status = 'rent';
    await p.goto(payUrl);
    await p.waitForFunction(() => /개통이 완료|결제가 완료|실패/.test(document.body.innerText), null, { timeout: 8000 });
    const t = await p.evaluate(() => document.body.innerText);
    ok(/결제가 완료/.test(t) && /배정 대기/.test(t), '배정 대기 안내 없음: ' + t.slice(0, 160));
    const id = new URL(p.url()).searchParams.get('orderId');
    const o = orderOf(id);
    ok(o.status === 'paid' && !o.pn, '주문 ' + o.status + ' ' + o.pn);
    S.waitOrder = id;
    pcOf('D-001').status = 'ok';         // 관리자 배정 시험에서 쓰도록 되돌림
    await ctx.close();
  });

  await scenario('C11', '금액 조작 · 로그인 없는 주문 · 남의 결제키 재사용은 거절', async () => {
    let r = await post('/api/order-create', { specId: 5, days: 30, name: '익명', phone: '010-1234-5678' });
    ok(r.status === 401, '로그인 없이 주문 ' + r.status);
    const ck = 'kvc_cust=' + encodeURIComponent(makeTicket(XSS_ID));
    const res = await fetch(BASE + '/api/order-create', { method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: ck },
      body: JSON.stringify({ specId: 5, days: 30, name: XSS, phone: '010-3333-4444' }) });
    const d = await res.json();
    ok(res.status === 200 && d.amount === 65000, '주문 만들기 ' + res.status);
    r = await post('/api/toss-confirm', { paymentKey: 'tcard_cheap1', orderId: d.orderId, amount: 100 });
    ok(r.status === 400 && orderOf(d.orderId).status === 'ready', '100원 결제가 승인됨 ' + r.status);
    ok(!srv.toss.confirms.some(c => c.orderId === d.orderId), '금액이 다른데 토스 승인까지 감');
    if (S.cardOrder) {
      r = await post('/api/toss-confirm', { paymentKey: orderOf(S.cardOrder).pay_key, orderId: d.orderId, amount: 65000 });
      ok(orderOf(d.orderId).status === 'ready', '남의 결제키로 이 주문이 결제됨');
    }
  });

  /* ══════════ 관리자 ══════════ */
  let actx, ap;
  const ensureAdmin = async () => {
    if (ap && !ap.isClosed()) return;
    actx = await newContext({ viewport: { width: 1440, height: 1000 } });
    ap = await openPage(actx, '/admin');
    await adminLogin(ap); await adminReady(ap);
  };

  await scenario('A1', '관리자 — 틀린 비밀번호 · 4060 거부', async () => {
    const ctx = await newContext();
    const p = await openPage(ctx, '/admin');
    await adminLogin(p, 'wrong-password');
    await p.waitForFunction(() => /맞지 않습니다/.test(document.getElementById('gate-err').textContent), null, { timeout: 5000 });
    await adminLogin(p, '4060');
    await p.waitForFunction(() => /맞지 않습니다/.test(document.getElementById('gate-err').textContent), null, { timeout: 5000 });
    ok(!(await p.evaluate(() => document.getElementById('gate').classList.contains('off'))), '틀린 비번에 열림');
    const r = await apiIn(p, '/api/admin?do=pcs');
    ok(r.status === 401, '로그인 전 PC 목록 ' + r.status);
    ok(db().view_log.filter(v => v.act === '관리자 로그인 실패').length >= 2, '실패 기록 없음');
    await ctx.close();
  });

  await scenario('A2', '관리자 — 긴 비밀번호로 로그인 · 대시보드 숫자', async () => {
    await ensureAdmin();
    const t = await mainText(ap);
    const pcs = db().pcs, unreg = db().pcs_unregistered.filter(u => !u.claimed_pn).length + 1;
    const total = pcs.length + db().pcs_unregistered.length;
    ok(t.includes('전체 보유') && t.includes(total + '대'), `전체 보유 ${total}대 아님: ` + t.slice(0, 300));
    const rent = pcs.filter(p => p.status === 'rent').length;
    ok(new RegExp('임대중\\s*' + rent + '대').test(t), '임대중 숫자 다름 (' + rent + ')');
    const k = pcs.filter(p => p.room === 'K').length, y = pcs.filter(p => p.room === 'Y').length, d = pcs.filter(p => p.room === 'D').length;
    ok(t.includes(`K ${k} · Y ${y} · D ${d}`), `서버실별 대수 K ${k} · Y ${y} · D ${d} 아님 → ` + (t.match(/K \d+ · Y \d+ · D \d+/) || [''])[0]);
    ok(!ap.errors.length, '콘솔 오류 ' + ap.errors.join('|'));
    void unreg;
  });

  await scenario('A3', '관리자 — 랙맵 · PC 상세 · 비밀번호 열람 기록', async () => {
    await ensureAdmin();
    await view(ap, 'rack');
    await ap.click('[data-room="Y"]');
    const cells = await ap.$$eval('.slot[data-pc]', es => es.map(e => e.dataset.pc));
    ok(cells.includes('Y-001') && cells.includes('Y-004'), '랙맵 칸 ' + cells);
    await ap.click('.slot[data-pc="Y-002"]');
    await ap.waitForSelector('#drawer.on');
    ok(/Y-002/.test(await drawerText(ap)), '상세가 안 열림');
    const before = db().view_log.filter(v => v.act === '비밀번호 열람').length;
    await ap.click('#dr-pwbtn');
    await ap.waitForFunction(() => document.getElementById('dr-pw').textContent !== '••••••');
    ok((await ap.textContent('#dr-pw')) === 'pw-Y-002', '비밀번호 ' + await ap.textContent('#dr-pw'));
    ok(db().view_log.filter(v => v.act === '비밀번호 열람').length === before + 1, '열람 기록이 안 남음');
  });

  await scenario('A4', '관리자 — 메모 저장 후 새로고침해도 남음', async () => {
    await ensureAdmin();
    await ap.evaluate(() => openPc('Y-002', true));
    await ap.fill('#e-memo', 'E2E 메모 <b>굵게</b>');
    await ap.click('[data-savepc="Y-002"]');
    await until(() => pcOf('Y-002').note === 'E2E 메모 <b>굵게</b>', 5000, 'DB 메모 ' + pcOf('Y-002').note);
    await ap.reload(); await adminReady(ap);
    await ap.evaluate(() => openPc('Y-002'));
    const t = await drawerText(ap);
    ok(t.includes('E2E 메모 <b>굵게</b>'), '새로고침 뒤 메모 없음');
    /* 메모만 고치면 위치·상태는 그대로 */
    ok(pcOf('Y-002').rack === 1 && pcOf('Y-002').slot === 2, '메모 저장이 위치를 바꿈');
  });

  await scenario('A5', '관리자 — 원격 재부팅 요청 · 취소', async () => {
    await ensureAdmin();
    ap.answers.push(true);            // 재부팅 확인
    await ap.evaluate(() => openPc('Y-002'));
    await ap.click('[data-reboot="Y-002"]');
    await until(() => pcOf('Y-002').cmd === 'reboot', 5000, '재부팅 명령이 안 걸림');
    await ap.waitForSelector('[data-rbcancel="Y-002"]');
    ap.answers.push(true);
    await ap.click('[data-rbcancel="Y-002"]');
    await until(() => pcOf('Y-002').cmd === null, 5000, '취소가 안 됨');
    ok(db().view_log.some(v => v.pn === 'Y-002' && /재부팅 요청 취소/.test(v.act)), '취소 기록 없음');
    /* 다운 PC 에는 재부팅을 못 건다 */
    const r = await apiIn(ap, '/api/admin?do=pc-cmd', { pn: 'K-001', cmd: 'reboot' });
    ok(r.status === 409, '다운 PC 재부팅 ' + r.status);
  });

  await scenario('A6', '관리자 — 수동 주문 등록 → 바로 30일 연장', async () => {
    await ensureAdmin();
    await ap.evaluate(() => openPc('Y-002'));
    await ap.click('[data-pcassign="Y-002"]');
    await ap.fill('#m-nm', XSS);
    await ap.fill('#m-ph', '010-7777-8888');
    await ap.click('[data-mansave]');
    const o = await until(() => db().orders.find(x => x.pn === 'Y-002' && x.status === 'assigned'), 6000, '수동 주문이 안 생김: ' + await ap.textContent('#m-msg').catch(() => ''));
    ok(o.user_name === XSS && o.amount === 65000, '주문 내용 ' + JSON.stringify({ n: o.user_name, a: o.amount }));
    await ap.waitForSelector(`[data-extend="${o.order_id}"]`, { timeout: 6000 });
    const endBefore = Date.parse(o.ends_at);
    ap.answers.push('65000');
    await ap.click(`[data-extend="${o.order_id}"]`);
    await until(() => orderOf(o.order_id).days === 60, 5000, '연장이 안 됨: ' + lastDialog(ap));
    const diff = Math.round((Date.parse(orderOf(o.order_id).ends_at) - endBefore) / 86400000);
    ok(diff === 30, '만료일이 ' + diff + '일 늘어남');
    ok(orderOf(o.order_id).amount === 130000, '금액 ' + orderOf(o.order_id).amount);
    /* 화면이 서버에서 다시 받아올 때까지 기다립니다. 안 기다리면 연장 뒤의 [닫기] 가
       다음 시험(A7)이 연 주문 상세를 닫아 버려 버튼이 "화면 밖" 이 됩니다 (가끔 실패하던 원인) */
    await ap.waitForFunction(no => { const x = ORDERS.find(y => y.no === no); return x && x.days === 60; }, o.order_id, { timeout: 8000 });
    S.manualOrder = o.order_id;
    ok(!ap.xss.length, 'XSS 실행됨');
  });

  await scenario('A7', '관리자 — PC 이전 (Y-002 → Y-007) · 옛 PC 점검으로', async () => {
    ok(S.manualOrder, 'A6 이 먼저 성공해야 합니다');
    await ensureAdmin();
    await ap.evaluate(no => openOrd(no), S.manualOrder);
    ap.answers.push('Y-007', 'PC 고장', false);
    /* 못 누르면 그때 떠 있던 안내창과 남은 답을 같이 남깁니다 (가끔 30초 멈추던 원인 추적용) */
    await ap.click(`[data-movepc="${S.manualOrder}"]`, { timeout: 10000 }).catch(e => {
      throw new Error('안내창 ' + JSON.stringify(ap.dialogs.slice(-4)) + ' · 남은 답 ' + JSON.stringify(ap.answers)
        + ' · ' + e.message.replace(/\n/g, ' ').slice(0, 1200));
    });
    await until(() => orderOf(S.manualOrder).pn === 'Y-007', 6000, '이전이 안 됨: ' + lastDialog(ap));
    ok(pcOf('Y-007').status === 'rent', 'Y-007 이 임대중 아님');
    ok(pcOf('Y-002').status === 'fix', 'Y-002 가 점검으로 안 감: ' + pcOf('Y-002').status);
  });

  await scenario('A8', '관리자 — 배정 대기 주문에 PC 배정', async () => {
    ok(S.waitOrder, 'C10 이 먼저 성공해야 합니다');
    await ensureAdmin();
    await ap.reload(); await adminReady(ap);
    await ap.evaluate(no => openOrd(no), S.waitOrder);
    ap.answers.push('');               // 비우면 자동 선택
    await ap.click(`[data-assignpaid="${S.waitOrder}"]`);
    await until(() => orderOf(S.waitOrder).status === 'assigned', 6000, '배정 안 됨: ' + lastDialog(ap));
    ok(orderOf(S.waitOrder).pn === 'D-001', '배정 PC ' + orderOf(S.waitOrder).pn);
    ok(pcOf('D-001').status === 'rent', 'D-001 임대중 아님');
  });

  await scenario('A9', '관리자 — 해지·환불 (가짜 토스 취소) → PC 초기화 대기로', async () => {
    ok(S.cardOrder, 'C4 가 먼저 성공해야 합니다');
    await ensureAdmin();
    await ap.reload(); await adminReady(ap);
    await ap.evaluate(no => openOrd(no), S.cardOrder);
    const cancels = srv.toss.cancels.length;
    ap.answers.push(true, '시험 해지');
    await ap.click(`[data-cancelord="${S.cardOrder}"]`);
    await until(() => ['refunded', 'canceled'].includes(orderOf(S.cardOrder).status), 6000, '해지 안 됨: ' + lastDialog(ap));
    ok(srv.toss.cancels.length === cancels + 1, '토스 취소 요청이 안 감');
    ok(orderOf(S.cardOrder).refund_amt > 0, '환불액 ' + orderOf(S.cardOrder).refund_amt);
    ok(pcOf('Y-001').status === 'wipe', 'Y-001 이 초기화 대기로 안 감: ' + pcOf('Y-001').status);
    ok(orderOf(S.cardOrder).refund_state === 'toss_done', '송금 상태 ' + orderOf(S.cardOrder).refund_state);
    await until(() => /환불되었습니다/.test(ap.dialogs.map(d => d.msg).join('\n')), 3000, '완료 안내 없음');
    ok(/초기화 대기/.test(lastDialog(ap)), '완료 안내에 초기화 대기 설명 없음: ' + lastDialog(ap));
    /* 해지 뒤 고객 웹훅(토스가 뒤이어 보내는 CANCELED)이 와도 두 번 처리 안 함 */
    const r = await post('/api/toss-webhook', { eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: S.cardOrder, status: 'CANCELED' } });
    /* 부분 환불이면 토스가 PARTIAL_CANCELED 로 답합니다 — 어느 쪽이든 다시 처리하면 안 됩니다 */
    ok(r.d && /이미 처리됨|부분취소/.test(r.d.skip || ''), '해지 뒤 웹훅 ' + JSON.stringify(r.d));
    ok(orderOf(S.cardOrder).status === 'refunded' && pcOf('Y-001').status === 'wipe', '웹훅이 상태를 또 바꿈');
  });

  await scenario('A10', '관리자 — 설정 저장 (셋팅비 0 가능 · 다운 판정 300 미만 거부)', async () => {
    await ensureAdmin();
    await view(ap, 'set');
    await ap.fill('[data-set="setup"]', '0');
    await ap.click('#set-save');
    await until(() => (db().settings.find(s => s.k === 'setup_fee') || {}).v === '0', 5000, '셋팅비 0 저장 안 됨: ' + await ap.textContent('#set-msg'));
    await ap.fill('[data-set="downSec"]', '200');
    await ap.click('#set-save');
    ok(/300초 이상/.test(await ap.textContent('#set-msg')), '화면 경고 없음');
    const r = await apiIn(ap, '/api/admin?do=settings', { downSec: 200 });
    ok(r.status === 400, '서버가 200초를 받음 ' + r.status);
    ok((db().settings.find(s => s.k === 'down_sec') || {}).v === '300', 'down_sec 이 바뀜');
    await ap.reload(); await adminReady(ap);
    await view(ap, 'set');
    ok((await ap.inputValue('[data-set="setup"]')) === '0', '새로고침 뒤 셋팅비가 0 이 아님');
    /* 셋팅비 0 이 환불 계산에도 실제로 쓰이는가 */
    if (S.manualOrder) {
      const q = await apiIn(ap, '/api/admin?do=order-action', { no: S.manualOrder, act: 'quote' });
      ok(q.status === 200 && q.d.quote.setupFee === 0, '셋팅비 0 인데 환불 계산은 ' + (q.d && q.d.quote && q.d.quote.setupFee) + '원을 뺌');
    }
    db().settings.find(s => s.k === 'setup_fee').v = '5000';
  });

  await scenario('A11', '관리자 — 통합검색 · 회원 목록 · 이름은 글자로', async () => {
    await ensureAdmin();
    await ap.reload(); await adminReady(ap);
    await view(ap, 'find');
    await ap.fill('#findq', '고객A');
    await ap.press('#findq', 'Enter');
    let t = await mainText(ap);
    ok(/KVC260101-SEEDA1/.test(t), '검색에 고객A 주문 없음');
    await ap.fill('#findq', 'Y-004'); await ap.press('#findq', 'Enter');
    ok(/Y-004/.test(await mainText(ap)), '품번 검색 실패');
    await view(ap, 'members');
    t = await mainText(ap);
    ok(t.includes('고객A') && t.includes(XSS), '회원 목록: ' + t.slice(0, 200));
    for (const v of ['dash', 'orders', 'members', 'today', 'noti', 'pcs', 'rack', 'newpc', 'verify']) {
      await view(ap, v);
      ok(!(await ap.$('#main img[src="x"]')), v + ' 화면에 <img> 가 태그로 들어감');
    }
    await view(ap, 'orders');
    await ap.click(`tr[data-ord="${S.waitOrder}"] td`);
    ok(!(await ap.$('#drawer img[src="x"]')), '주문 상세에 <img> 태그');
    ok(!ap.xss.length, 'XSS 실행됨: ' + ap.xss.join(','));
    ok(!ap.errors.length, '콘솔 오류 ' + ap.errors.join('|'));
  });

  await scenario('A12', '관리자 — 미등록 PC 품번 부여 (자리 없는 new · 품번 없는 신호)', async () => {
    await ensureAdmin();
    await view(ap, 'newpc');
    /* ① 대장에 있는 new PC (Y-005) 에 자리 지정 */
    const ad5 = pcOf('Y-005').anydesk;
    await ap.fill(`[data-for="${ad5}"][data-loc="rack"]`, '2');
    await ap.fill(`[data-for="${ad5}"][data-loc="fl"]`, '1');
    await ap.fill(`[data-for="${ad5}"][data-loc="slot"]`, '1');
    await ap.click('[data-assign="Y-005"]');
    await until(() => pcOf('Y-005').status === 'unv', 5000, 'Y-005 품번 부여 실패')
      .catch(e => { e.message += ' · 안내 ' + lastDialog(ap) + ' · api ' + JSON.stringify(srv.apiLog.slice(-2)); throw e; });
    /* ② 품번 없이 신호만 오던 PC (MB-NEW-0001) */
    await ap.reload(); await adminReady(ap);
    await view(ap, 'newpc');
    const n = ap.dialogs.length;
    await ap.fill('[data-pnin="777666555"]', 'D-002');
    await ap.fill('[data-for="777666555"][data-loc="rack"]', '1');
    await ap.fill('[data-for="777666555"][data-loc="fl"]', '1');
    await ap.fill('[data-for="777666555"][data-loc="slot"]', '2');
    await ap.click('[data-assign="777666555"]');
    await sleep(800);
    const said = ap.dialogs.slice(n).map(d => d.msg).join(' / ');
    ok(pcOf('D-002'), '품번이 안 붙음 — 안내: ' + said);
    ok(pcOf('D-002').status === 'unv' && pcOf('D-002').anydesk === '777666555', 'D-002 내용 ' + JSON.stringify(pcOf('D-002')));
    ok(!db().pcs_unregistered.some(u => u.hw_id === 'MB-NEW-0001'), '미등록 목록에 그대로 남음');
    /* 고객 목록에는 여전히 안 보임 (미검증) */
    const live = await (await fetch(BASE + '/api/live-pcs')).json();
    ok(!live.pcs.some(p => p.id === 'D-002' || p.id === 'Y-005'), '미검증 PC 가 고객에게 보임');
  });

  /* ══════════ 2026-11-07 — 반납 초기화 · 오늘 할 일 · 환불 송금 · 주문 잘림 ══════════ */
  const kv = require('../../api/_crypto');
  const live = async () => (await (await fetch(BASE + '/api/live-pcs')).json()).pcs;
  const liveSt = (L, pn) => (L.find(p => p.id === pn) || {}).st;

  await scenario('H1', '만료 정리 — 끝난 주문의 PC 는 반납 유예 → 유예가 지나면 초기화 대기', async () => {
    await ensureAdmin();
    /* 관리자 화면을 열 때 만료 정리가 돌았습니다 → Y-012 는 반납 유예 */
    ok(orderOf('KVC260101-SEEDH1').status === 'expired', 'SEEDH1 이 만료 안 됨: ' + orderOf('KVC260101-SEEDH1').status);
    const pc = pcOf('Y-012');
    ok(pc.status === 'hold', 'Y-012 가 반납 유예가 아님: ' + pc.status);
    const days = (Date.parse(pc.hold_until) - Date.now()) / 86400000;
    ok(days > 2.9 && days < 3.1, '유예 끝나는 날이 3일 뒤가 아님: ' + days.toFixed(2));
    let L = await live();
    ok(liveSt(L, 'Y-012') === 'busy' && liveSt(L, 'Y-011') === 'busy' && liveSt(L, 'Y-010') === 'busy',
      '유예·초기화 대기 PC 가 고객 화면에 임대중이 아님: ' + ['Y-010', 'Y-011', 'Y-012'].map(p => p + '=' + liveSt(L, p)).join(','));
    /* 유예가 끝나면 다음 정리 때 초기화 대기로 */
    pc.hold_until = new Date(Date.now() - 60000).toISOString();
    const r = await apiIn(ap, '/api/admin?do=pcs');
    ok(r.status === 200, 'PC 목록 ' + r.status);
    ok(pcOf('Y-012').status === 'wipe' && pcOf('Y-012').wipe_at, 'Y-012 가 초기화 대기로 안 감: ' + pcOf('Y-012').status);
    const row = r.d.pcs.find(p => p.pn === 'Y-012');
    ok(row && row.rawStatus === 'wipe', '관리자 목록 rawStatus ' + (row && row.rawStatus));
    /* 자동 배정은 ok 만 잡습니다 — 3700X 재고에 유예·초기화 PC 가 섞여 있어도 안 잡힘 */
    L = await live();
    ok(liveSt(L, 'Y-012') === 'busy', 'Y-012 고객 화면 ' + liveSt(L, 'Y-012'));
  });

  await scenario('E1', '만료된 주문 연장 — 유예 중 PC 는 그대로 임대중 · 초기화 대기 PC 는 거절 · 기본 금액은 30일 가격', async () => {
    await ensureAdmin();
    await ap.reload(); await adminReady(ap);
    await ap.evaluate(no => openOrd(no), 'KVC260101-SEEDC1');
    ok(/30일 연장/.test(await drawerText(ap)), '만료된 주문 상세에 연장 버튼 없음');
    ap.answers.length = 0;               // 비워 두면 입력창의 기본값 그대로 확인
    const n = ap.dialogs.length;
    await ap.click('[data-extend="KVC260101-SEEDC1"]');
    await until(() => orderOf('KVC260101-SEEDC1').status === 'assigned', 6000, '연장 안 됨: ' + lastDialog(ap));
    const pr = ap.dialogs.slice(n).find(d => d.type === 'prompt');
    ok(pr && pr.def === '65000', '연장 금액 기본값이 30일 가격(65000)이 아님: ' + (pr && pr.def));
    ok(pcOf('Y-011').status === 'rent', '유예 중이던 Y-011 이 임대중으로 안 돌아옴: ' + pcOf('Y-011').status);
    const left = (Date.parse(orderOf('KVC260101-SEEDC1').ends_at) - Date.now()) / 86400000;
    ok(left > 29.9 && left < 30.1, '오늘부터 30일이 아님: ' + left.toFixed(2));
    ok(orderOf('KVC260101-SEEDC1').amount === 123500 + 65000, '금액 ' + orderOf('KVC260101-SEEDC1').amount);
    /* 초기화 대기로 넘어간 PC 의 옛 주문은 연장하지 않음 */
    const r = await apiIn(ap, '/api/admin?do=order-action', { no: 'KVC260101-SEEDW1', act: 'extend', days: 30, amount: 65000 });
    ok(r.status === 409 && /초기화 대기/.test(r.d.error), '초기화 대기 PC 연장 응답 ' + r.status + ' ' + JSON.stringify(r.d));
    ok(orderOf('KVC260101-SEEDW1').status === 'expired' && pcOf('Y-010').status === 'wipe', '거절했는데 상태가 바뀜');
    ok(!ap.errors.length, '콘솔 오류 ' + ap.errors.join('|'));
  });

  await scenario('W1', '반납 초기화 — 비밀번호 없이 판매로 거절 · 체크 3개 + 새 비밀번호 → 판매 가능', async () => {
    await ensureAdmin();
    let r = await apiIn(ap, '/api/admin?do=pc-update', { key: 'Y-010', status: 'ok' });
    ok(r.status === 409 && /비밀번호/.test(r.d.error), '비밀번호 없이 판매로 응답 ' + r.status + ' ' + JSON.stringify(r.d));
    ok(pcOf('Y-010').status === 'wipe', '거절했는데 상태가 바뀜');
    /* 점검을 거쳐 [점검 완료 → 판매] 로 우회하는 길도 막혀야 함 (Codex T-0179) */
    r = await apiIn(ap, '/api/admin?do=pc-update', { key: 'Y-010', status: 'fix' });
    ok(r.status === 409 && pcOf('Y-010').status === 'wipe', '초기화 대기 → 점검 우회 응답 ' + r.status);
    await ap.reload(); await adminReady(ap);
    await ap.evaluate(() => openPc('Y-010'));
    ok(/초기화 대기/.test(await drawerText(ap)), 'PC 상세에 초기화 대기 표시 없음');
    await ap.click('#drawer [data-wipeopen="Y-010"]');
    await ap.waitForSelector('[data-wipedone="Y-010"]');
    const dis = () => ap.$eval('[data-wipedone="Y-010"]', b => b.disabled);
    ok(await dis(), '아무것도 안 했는데 버튼이 켜져 있음');
    const cks = await ap.$$('[data-wck]');
    ok(cks.length === 3, '체크 칸이 3개가 아님: ' + cks.length);
    await cks[0].check(); await cks[1].check();
    await ap.fill('#w-pw', 'new-pw-0110');
    ok(await dis(), '체크 2개만 했는데 버튼이 켜짐');
    await cks[2].check();
    ok(!(await dis()), '다 했는데 버튼이 안 켜짐');
    await ap.click('[data-wipedone="Y-010"]');
    await until(() => pcOf('Y-010').status === 'ok', 5000, '판매로 안 바뀜: ' + lastDialog(ap));
    ok(kv.open(pcOf('Y-010').pw_enc) === 'new-pw-0110', '새 비밀번호가 저장 안 됨');
    await until(() => db().view_log.some(v => v.pn === 'Y-010' && /반납 초기화 완료/.test(v.act)), 3000, '반납 초기화 완료 기록 없음');
    const L = await live();
    ok(liveSt(L, 'Y-010') === 'free', '초기화 뒤 고객 화면에 임대 가능이 아님: ' + liveSt(L, 'Y-010'));
  });

  await scenario('X1', '계좌이체 주문 해지 → 직접 송금 대기 · PC 초기화 대기 · 이전 때 옛 PC 도 초기화 대기', async () => {
    ok(S.manualOrder, 'A6 이 먼저 성공해야 합니다');
    await ensureAdmin();
    const pn = orderOf(S.manualOrder).pn;
    const r = await apiIn(ap, '/api/admin?do=order-action', { no: S.manualOrder, act: 'cancel', why: '시험 해지' });
    ok(r.status === 200 && r.d.manualRefund && r.d.refundTracked && r.d.refundState === 'manual_pending',
      '해지 응답 ' + r.status + ' ' + JSON.stringify(r.d));
    ok(orderOf(S.manualOrder).refund_state === 'manual_pending', 'DB 송금 상태 ' + orderOf(S.manualOrder).refund_state);
    ok(pcOf(pn).status === 'wipe', pn + ' 이 초기화 대기가 아님: ' + pcOf(pn).status);
    /* PC 이전 — 옛 화면처럼 oldStatus:'ok' 를 보내도 바로 판매로 가지 않음 */
    const m = await apiIn(ap, '/api/admin?do=order-action', { no: 'KVC260101-SEEDE1', act: 'move', toPn: 'Y-008', why: '시험', oldStatus: 'ok' });
    ok(m.status === 200, '이전 응답 ' + m.status + ' ' + JSON.stringify(m.d));
    ok(pcOf('Y-013').status === 'wipe' && pcOf('Y-008').status === 'rent', '이전 뒤 Y-013=' + pcOf('Y-013').status + ' Y-008=' + pcOf('Y-008').status);
    S.manualPn = pn;
  });

  await scenario('T1', '오늘 할 일 — 송금 대기 · 초기화 대기(위치순) · D-3 · 최근 만료 · 가상계좌 · 배지', async () => {
    await ensureAdmin();
    await ap.reload(); await adminReady(ap);
    await view(ap, 'today');
    const t = await mainText(ap);
    for (const w of ['직접 송금해야 할 환불', '고객D', '30,000원', '반납 초기화 대기', '3일 안에 만료', '최근 7일 만료',
      '가상계좌 입금 대기', '구매자B']) ok(t.includes(w), '오늘 할 일에 「' + w + '」 없음');
    ok(!(await ap.$('#sql08')), 'db/08 을 돌린 상태인데 SQL 실행 안내가 뜸');
    /* 3일 안에 만료 — 고객E 는 이전(X1) 뒤에도 이용중 */
    ok(/고객E/.test(await ap.$eval('#today-d3', e => e.innerText)), 'D-3 에 고객E 없음');
    /* 최근 7일 만료 — 연장 안 한 SEEDH1(고객A) · SEEDW1(구매자B) 은 있고, E1 에서 연장한 고객C 는 없음 */
    const e7 = await ap.$eval('#today-exp7', e => e.innerText);
    ok(/고객A/.test(e7) && /구매자B/.test(e7) && !/고객C/.test(e7), '최근 만료 목록: ' + e7.slice(0, 200));
    /* 초기화 대기는 위치 순서 (서버실 → 랙 → 층 → 자리) */
    const rows = await ap.$$eval('#today-wipe tr[data-pc]', es => es.map(e => e.dataset.pc));
    const want = db().pcs.filter(p => p.status === 'wipe').map(p => p.pn);
    ok(rows.length === want.length && want.every(p => rows.includes(p)), `초기화 대기 목록 ${rows} ≠ DB ${want}`);
    const order = ['K', 'Y', 'D'];
    const key = pn => { const p = pcOf(pn); return order.indexOf(p.room) * 1e6 + p.rack * 1e4 + p.fl * 100 + p.slot; };
    ok(rows.every((p, i) => i === 0 || key(rows[i - 1]) <= key(p)), '위치 순서가 아님: ' + rows.join(','));
    const bd = await ap.$eval('#bd-today', e => ({ n: +e.textContent, hidden: e.hidden }));
    ok(bd.n > 0 && !bd.hidden, '오늘 할 일 배지 ' + JSON.stringify(bd));
    ok(!ap.errors.length, '콘솔 오류 ' + ap.errors.join('|'));
  });

  await scenario('T2', '직접 송금 환불 [송금 완료] → 목록에서 빠지고 기록 · 두 번은 안 됨', async () => {
    await ensureAdmin();
    await view(ap, 'today');
    ap.answers.push('신한 11/7');
    await ap.click('[data-refunddone="MAN260101-SEEDR1"]');
    await until(() => orderOf('MAN260101-SEEDR1').refund_state === 'manual_done', 5000, '송금 완료 안 됨: ' + lastDialog(ap));
    ok(orderOf('MAN260101-SEEDR1').refund_done_at, '송금 완료 시각 없음');
    /* 기록은 상태를 바꾼 다음에 남기므로 조금 기다립니다 */
    await until(() => db().view_log.some(v => /환불 직접 송금 완료/.test(v.act) && /신한 11\/7/.test(v.act)), 3000,
      '송금 완료 기록 없음: ' + JSON.stringify(db().view_log.filter(v => /송금/.test(v.act)).map(v => v.act)));
    await ap.waitForFunction(() => !/고객D/.test((document.querySelector('#today-refund') || {}).innerText || ''), null, { timeout: 5000 })
      .catch(() => { throw new Fail('송금 완료 뒤에도 목록에 남음'); });
    const r = await apiIn(ap, '/api/admin?do=order-action', { no: 'MAN260101-SEEDR1', act: 'refund-done' });
    ok(r.status === 409, '두 번째 송금 완료 응답 ' + r.status);
    /* X1 에서 해지한 수동 주문은 아직 목록에 남아 있어야 함 */
    ok(await ap.$(`#today-refund [data-refunddone="${S.manualOrder}"]`), 'X1 해지 건이 송금 대기 목록에 없음');
  });

  await scenario('Q1', '주문 상세 환불 미리보기 = 서버 계산 (화면 공식 아님)', async () => {
    ok(S.waitOrder, 'C10·A8 이 먼저 성공해야 합니다');
    await ensureAdmin();
    await ap.evaluate(no => openOrd(no), S.waitOrder);
    await ap.waitForSelector('#ord-refund', { timeout: 5000 });
    const shown = await ap.textContent('#ord-refund');
    const q = await apiIn(ap, '/api/admin?do=order-action', { no: S.waitOrder, act: 'quote' });
    ok(q.status === 200 && shown.replace(/[^\d]/g, '') === String(q.d.quote.refund), `화면 ${shown} ≠ 서버 ${q.d && q.d.quote.refund}`);
    const want30 = require('../../api/_price').quote(orderOf(S.waitOrder).spec_id, 30).amount;
    ok(q.d.price30 === want30, `30일 가격 ${q.d.price30} ≠ 가격표 ${want30}`);
    ok(!/mypage/.test(await ap.content()), 'admin 에 mypage 연장 안내가 남아 있음');
  });

  await scenario('HC1', '지난 주문이 3,000건 넘어도 이용중 주문은 안 잘림 · "오래된 기록은 생략됨"', async () => {
    await ensureAdmin();
    const base = Date.now() - 86400000 * 400;
    const extra = [];
    for (let i = 0; i < 3100; i++) {
      extra.push({ order_id: 'OLD' + String(i).padStart(5, '0'), member_id: null, pn: 'Y-008', spec_id: 5, days: 30,
        amount: 65000, setup_fee: 5000, status: 'expired', pay_key: null, pay_method: '카드',
        paid_at: new Date(base + i * 60000).toISOString(), va_secret: null, tax_invoice: false, biz_no: null,
        starts_at: new Date(base + i * 60000).toISOString(), ends_at: new Date(base + i * 60000 + 86400000 * 30).toISOString(),
        payer_name: '옛손님' + i, user_name: '옛손님' + i, user_phone: null, canceled_at: null, refund_amt: null,
        refund_why: null, created_at: new Date(base).toISOString(), refund_state: null, refund_done_at: null });
    }
    /* 가장 오래된 한 건은 "직접 송금 대기 환불" — 2000건 밖이어도 빠지면 안 됨 */
    Object.assign(extra[0], { status: 'refunded', refund_amt: 10000, refund_state: 'manual_pending' });
    db().orders.push(...extra);
    try {
      const r = await apiIn(ap, '/api/admin?do=orders&all=1');
      ok(r.status === 200, '주문 목록 ' + r.status);
      const activeDb = db().orders.filter(o => ['paid', 'assigned', 'ready'].includes(o.status)).map(o => o.order_id).sort();
      const activeApi = r.d.orders.filter(o => ['paid', 'assigned', 'ready'].includes(o.st)).map(o => o.no).sort();
      ok(JSON.stringify(activeDb) === JSON.stringify(activeApi), `이용중 주문이 잘림: DB ${activeDb.length} · 화면 ${activeApi.length}`);
      ok(r.d.historyCut === true, 'historyCut 이 ' + r.d.historyCut);
      const hist = r.d.orders.filter(o => !['paid', 'assigned', 'ready'].includes(o.st));
      /* 최근 2000건 + (2000건 밖이라도) 직접 송금 대기 환불은 따로 끝까지 */
      const owed = db().orders.filter(o => o.refund_state === 'manual_pending').map(o => o.order_id);
      ok(hist.length >= 2000 && hist.length <= 2000 + owed.length, '지난 주문 ' + hist.length + '건');
      ok(owed.every(id => r.d.orders.some(o => o.no === id)), '직접 송금 대기 환불이 목록에서 빠짐');
      ok(hist.some(o => o.no === 'OLD03099') && !hist.some(o => o.no === 'OLD00001'), '최근 것부터 받지 않음');
      ok(hist.some(o => o.no === 'OLD00000'), '2000건 밖 직접 송금 대기 환불이 빠짐');
      await ap.reload(); await adminReady(ap);
      await ap.evaluate(() => openPc('Y-008'));
      ok(/오래된 기록은 생략됨/.test(await drawerText(ap)), 'PC 상세에 "오래된 기록은 생략됨" 없음');
    } finally {
      const ids = new Set(extra.map(o => o.order_id));
      const keep = db().orders.filter(o => !ids.has(o.order_id));
      db().orders.length = 0; db().orders.push(...keep);
    }
  });

  await scenario('D1', 'db/08 SQL 을 아직 안 돌린 Supabase — 안내 한 줄 · 해지·목록은 그대로 동작', async () => {
    await ensureAdmin();
    srv.fakeDb.setV08(false);
    const hs = db().settings.findIndex(s => s.k === 'hold_days');
    const saved = db().settings.splice(hs, 1)[0];
    /* 옛 정리 확인용 — 1시간 전에 끝난 주문 하나, 해지 시험용 수동 주문 하나 */
    const now = Date.now();
    const iso = ms => new Date(ms).toISOString();
    const pcRow = (pn, slot) => Object.assign({}, pcOf('Y-008'), { pn, slot, fl: 3, rack: 1, status: 'rent', hw_id: 'HW-' + pn,
      beat_token: 'tok-' + pn + '-0123456789abcdef', anydesk: '10428877' + slot });
    db().pcs.push(pcRow('Y-014', 1), pcRow('Y-015', 2));
    const o = (id, pn, ends, pm) => ({ order_id: id, member_id: null, pn, spec_id: 5, days: 30, amount: 65000, setup_fee: 5000,
      status: 'assigned', pay_key: null, pay_method: pm, paid_at: iso(now - 86400000), va_secret: null, tax_invoice: false,
      biz_no: null, starts_at: iso(now - 86400000), ends_at: iso(ends), payer_name: '옛방식', user_name: '옛방식',
      user_phone: '010-9999-0000', canceled_at: null, refund_amt: null, refund_why: null, created_at: iso(now - 86400000) });
    db().orders.push(o('KVC260101-OLDSW1', 'Y-014', now - 3600000, '카드'), o('MAN260101-OLDC1', 'Y-015', now + 86400000 * 20, '스마트스토어'));
    try {
      await ap.reload(); await adminReady(ap);
      ok(pcOf('Y-014').status === 'ok', '옛 정리인데 Y-014 가 ' + pcOf('Y-014').status);
      await view(ap, 'today');
      ok(await ap.$('#sql08'), '"db/08 SQL 실행 필요" 안내가 안 뜸');
      ok(/db\/08 SQL 실행 필요/.test(await mainText(ap)), '안내 문구 다름');
      const r = await apiIn(ap, '/api/admin?do=orders&all=1');
      ok(r.status === 200 && r.d.refundCols === false, '주문 목록 ' + r.status + ' refundCols=' + (r.d && r.d.refundCols));
      const c = await apiIn(ap, '/api/admin?do=order-action', { no: 'MAN260101-OLDC1', act: 'cancel', why: '옛 방식 해지' });
      ok(c.status === 200 && c.d.manualRefund && c.d.refundTracked === false, '해지 응답 ' + c.status + ' ' + JSON.stringify(c.d));
      ok(orderOf('MAN260101-OLDC1').status === 'refunded', '해지 안 됨');
      const d = await apiIn(ap, '/api/admin?do=order-action', { no: 'MAN260101-OLDC1', act: 'refund-done' });
      ok(d.status === 409 && /db\/08/.test(d.d.error), '송금 완료 응답 ' + d.status + ' ' + JSON.stringify(d.d));
      const p = await apiIn(ap, '/api/admin?do=pcs');
      ok(p.status === 200, 'PC 목록 ' + p.status);
      ok(!ap.errors.length, '콘솔 오류 ' + ap.errors.join('|'));
    } finally {
      srv.fakeDb.setV08(true);
      if (saved) db().settings.push(saved);
    }
  });

  await scenario('M1', '휴대폰 폭 390 관리자 — 아래 탭 · 배지 · 표가 카드로 · 가로 넘침 없음', async () => {
    const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await openPage(ctx, '/admin');
    await adminLogin(p); await adminReady(p);
    const bad = [];
    for (const v of ['today', 'orders', 'dash', 'rack', 'find']) {
      await view(p, v);
      await sleep(150);
      const w = await p.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
      if (w > 391) bad.push(v + ' 폭 ' + w);
    }
    ok(!bad.length, '가로 넘침: ' + bad.join(', '));
    const tab = await p.$eval('#tabbar', e => ({ d: getComputedStyle(e).display, n: e.querySelectorAll('a').length, txt: e.innerText }));
    ok(tab.d === 'flex' && tab.n === 4 && /오늘 할 일/.test(tab.txt) && /검색/.test(tab.txt) && /랙맵/.test(tab.txt) && /주문/.test(tab.txt),
      '아래 탭 ' + JSON.stringify(tab));
    const bd = await p.$eval('#bd-today', e => ({ vis: !!e.offsetParent, n: e.textContent }));
    ok(bd.vis && +bd.n > 0, '휴대폰에서 오늘 할 일 배지가 안 보임 ' + JSON.stringify(bd));
    await p.click('#tabbar a[data-v="orders"]');
    await p.waitForFunction(() => location.hash === '#orders');
    const card = await p.evaluate(() => {
      const th = document.querySelector('#main .tbl.mc thead');
      const td = document.querySelector('#main .tbl.mc td[data-label]');
      return { thead: th ? getComputedStyle(th).display : 'none', label: td ? getComputedStyle(td, '::before').content : '' };
    });
    ok(card.thead === 'none' && /주문|품번|회원|고객/.test(card.label), '주문 표가 카드로 안 바뀜 ' + JSON.stringify(card));
    await view(p, 'today');
    const tl = await p.evaluate(() => { const td = document.querySelector('#main .tbl.mc td[data-label]'); return td ? getComputedStyle(td, '::before').content : ''; });
    ok(tl && tl !== 'none', '오늘 할 일 표가 카드로 안 바뀜');
    ok(!p.errors.length, '콘솔 오류 ' + p.errors.join('|'));
    await ctx.close();
  });

  /* ══════════ 2026-11-08 2차 — 관리자별 비밀번호 · 기록 · 점검→판매 · 대사 · 자동 알림 SQL ══════════ */
  const crypto = require('crypto');
  /* 브라우저 없이 로그인해서 출입증 쿠키만 받아 옵니다 */
  const loginCookie = async pw => {
    const r = await fetch(BASE + '/api/admin-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pw }) });
    const sc = r.headers.get('set-cookie') || '';
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, d, cookie: (sc.match(/kvc_adm=[^;]*/) || [''])[0] };
  };
  const withCookie = async (url, cookie) => (await fetch(BASE + url, { headers: { Cookie: cookie } })).status;
  const iso = ms => new Date(ms).toISOString();

  await scenario('L1', '관리자별 비밀번호 — 현장 로그인 · 이름 표시 · 기록에 이름 · 옛 출입증·위조·빠진 사람 거부 · 예전 비밀번호 대체', async () => {
    const ctx = await newContext();
    const p = await openPage(ctx, '/admin');
    try {
      await adminLogin(p, srv.TEST.FIELD_PW); await adminReady(p);
      await p.waitForFunction(() => /현장/.test(document.getElementById('adm-me').textContent) && !document.getElementById('adm-me').hidden,
        null, { timeout: 5000 }).catch(() => { throw new Fail('왼쪽 메뉴에 "현장" 이름이 안 보임'); });
      ok(db().view_log.some(v => v.act === '관리자 로그인' && v.who === '현장'), '로그인 기록에 현장 없음');
      /* 현장이 비밀번호를 열면 기록에 "현장" — PC 상세 기록(서버)에도 바로 보임 */
      await p.evaluate(() => openPc('Y-003'));
      await p.click('#dr-pwbtn');
      await until(() => db().view_log.some(v => v.pn === 'Y-003' && v.act === '비밀번호 열람' && v.who === '현장'), 4000, '열람 기록 who 가 현장이 아님');
      await p.waitForFunction(() => /비밀번호 열람 · 현장/.test(document.getElementById('dr-log').textContent), null, { timeout: 5000 })
        .catch(() => { throw new Fail('PC 상세 기록(서버)에 "비밀번호 열람 · 현장" 이 안 보임'); });
      /* 대표로 들어간 A3 의 열람은 "대표" 로 남아야 함 */
      ok(db().view_log.some(v => v.pn === 'Y-002' && v.act === '비밀번호 열람' && v.who === '대표'), 'A3 열람 기록 who 가 대표가 아님');
      ok(!db().view_log.some(v => v.who === '관리자' && v.at > iso(Date.now() - 3600e3) && !/로그인/.test(v.act)), '아직 "관리자" 로 남는 기록이 있음: '
        + JSON.stringify(db().view_log.filter(v => v.who === '관리자').map(v => v.act)));
      ok(await p.evaluate(() => localStorage.getItem('kvc-vlog')) === null, '브라우저에 옛 기록(kvc-vlog)이 남아 있음');

      /* 옛 모양 출입증 (만료.서명) — 서명이 맞아도 로그인 안 된 것으로 */
      const kv = require('../../api/_crypto');
      const exp = Date.now() + 3600e3;
      const oldSig = crypto.createHmac('sha256', kv.signKey()).update(String(exp)).digest('hex');
      ok(await withCookie('/api/admin?do=pcs', 'kvc_adm=' + encodeURIComponent(exp + '.' + oldSig)) === 401, '옛 모양 출입증이 통과함');
      /* 현장 출입증의 이름만 대표로 바꿔치기 → 거부 */
      const f = await loginCookie(srv.TEST.FIELD_PW);
      ok(f.status === 200 && f.d.name === '현장' && f.cookie, '현장 로그인 응답 ' + f.status);
      ok(await withCookie('/api/admin?do=pcs', f.cookie) === 200, '현장 출입증으로 목록이 안 열림');
      const [e1, , s1] = decodeURIComponent(f.cookie.slice(8)).split('.');
      const swapped = e1 + '.' + Buffer.from('대표').toString('base64url') + '.' + s1;
      ok(await withCookie('/api/admin?do=pcs', 'kvc_adm=' + encodeURIComponent(swapped)) === 401, '이름 바꿔치기 출입증이 통과함');
      /* 서명은 맞지만 목록에 없는 이름 → 거부 */
      const mac = n => crypto.createHmac('sha256', kv.signKey()).update(exp + '.' + n).digest('hex');
      const ghost = exp + '.' + Buffer.from('손님').toString('base64url') + '.' + mac('손님');
      ok(await withCookie('/api/admin?do=pcs', 'kvc_adm=' + encodeURIComponent(ghost)) === 401, '목록에 없는 이름 출입증이 통과함');

      /* KVC_ADMINS 를 지우면 → 예전 KVC_ADMIN_PW 가 "대표" 로 · 현장 비밀번호와 현장 출입증은 무효 */
      const saved = process.env.KVC_ADMINS;
      delete process.env.KVC_ADMINS;
      try {
        const a = await loginCookie(srv.TEST.ADMIN_PW);
        ok(a.status === 200 && a.d.name === '대표', '예전 비밀번호 대체 로그인 ' + a.status + ' ' + JSON.stringify(a.d));
        ok((await loginCookie(srv.TEST.FIELD_PW)).status === 401, 'KVC_ADMINS 없는데 현장 비밀번호가 통과');
        ok(await withCookie('/api/admin?do=pcs', f.cookie) === 401, '목록에서 빠진 현장의 출입증이 아직 통과');
        ok(await withCookie('/api/admin?do=pcs', a.cookie) === 200, '대체 대표 출입증이 안 통함');
        /* KVC_ADMINS 를 적었는데 형식이 다 틀림 → 예전 비밀번호로 열리면 안 됨 (Codex T-0185) */
        process.env.KVC_ADMINS = '형식이틀린값;또틀림';
        const bad = await loginCookie(srv.TEST.ADMIN_PW);
        ok(bad.status === 503, '틀린 KVC_ADMINS 인데 예전 비밀번호 로그인 ' + bad.status);
        /* 일부러 낸 503(미설정) 은 Z1 의 "서버 오류 없음" 에서 뺍니다 */
        const i503 = srv.apiLog.findIndex(x => x.st === 503 && /^\/api\/admin-login/.test(x.url) && !x.err);
        if (i503 >= 0) srv.apiLog.splice(i503, 1);
        ok(await withCookie('/api/admin?do=pcs', a.cookie) === 401, '틀린 KVC_ADMINS 인데 대표 출입증이 통과');
      } finally { process.env.KVC_ADMINS = saved; }
      ok(!p.errors.length, '콘솔 오류 ' + p.errors.join('|'));
    } finally { await ctx.close(); }
  });

  await scenario('LG1', '관리자 기록 — 서버 기록 · 품번/주문번호/기간/로그인 필터 · 글자로 표시', async () => {
    await ensureAdmin();
    const now = Date.now();
    db().view_log.push(
      { id: 990001, pn: 'Y-003', act: XSS + ' 시험 KVC260101-LOGQ1', who: '현장', at: iso(now - 1000) },
      { id: 990002, pn: 'Y-003', act: '20일 전 기록', who: '대표', at: iso(now - 86400000 * 20) },
      { id: 990003, pn: 'Y-003', act: '100일 전 기록', who: '대표', at: iso(now - 86400000 * 100) },
    );
    let r = await apiIn(ap, '/api/admin?do=log&pn=Y-003');
    ok(r.status === 200 && r.d.days === 7, '기본 조회 ' + r.status + ' ' + JSON.stringify(r.d).slice(0, 200));
    let acts = r.d.rows.map(x => x.act);
    ok(acts.some(a => /LOGQ1/.test(a)) && !acts.includes('20일 전 기록') && r.d.rows.every(x => x.pn === 'Y-003'), '7일 조회 ' + acts);
    ok(r.d.rows[0].who === '현장', '최근 것부터가 아님');
    r = await apiIn(ap, '/api/admin?do=log&pn=Y-003&days=30');
    acts = r.d.rows.map(x => x.act);
    ok(acts.includes('20일 전 기록') && !acts.includes('100일 전 기록'), '30일 조회 ' + acts);
    r = await apiIn(ap, '/api/admin?do=log&pn=Y-003&days=999');
    ok(r.d.days === 90 && !r.d.rows.some(x => x.act === '100일 전 기록'), '90일 상한 ' + r.d.days);
    r = await apiIn(ap, '/api/admin?do=log&q=LOGQ1&days=90');
    ok(r.d.rows.length === 1 && /LOGQ1/.test(r.d.rows[0].act), '주문번호 조회 ' + r.d.rows.length);
    r = await apiIn(ap, '/api/admin?do=log&days=90');
    ok(!r.d.rows.some(x => /^ip:/.test(x.who)), '평소 조회에 로그인 실패(ip:) 가 섞임');
    r = await apiIn(ap, '/api/admin?do=log&days=1&kind=login');
    ok(r.d.rows.some(x => x.act === '관리자 로그인 실패' && /^ip:/.test(x.who)) && r.d.rows.some(x => x.act === '관리자 로그인')
      && r.d.rows.every(x => /^관리자 로그인/.test(x.act)), '로그인 기록 조회 ' + JSON.stringify(r.d.rows.slice(0, 3)));
    ok((await apiIn(ap, '/api/admin?do=log&pn=' + encodeURIComponent('Y-1,x'))).status === 400, '이상한 품번이 통과');
    ok((await apiIn(ap, '/api/admin?do=log&q=' + encodeURIComponent('a,b)'))).status === 400, '이상한 주문번호가 통과');
    /* 화면 — 설정 아래 관리자 기록 */
    await view(ap, 'set');
    await ap.fill('#lf-pn', 'Y-003');
    await ap.click('#log-go');
    await ap.waitForFunction(() => /LOGQ1/.test((document.getElementById('adm-log') || {}).innerText || ''), null, { timeout: 5000 })
      .catch(() => { throw new Fail('관리자 기록 화면에 결과가 안 나옴'); });
    const tx = await ap.$eval('#adm-log', e => e.innerText);
    ok(tx.includes('<img src=x onerror=alert(1)>'), '기록이 글자로 안 보임');
    ok(!(await ap.$('#adm-log img')), '기록 속 <img> 가 태그로 들어감');
    await ap.selectOption('[data-lf="kind"]', 'login');
    await ap.fill('#lf-pn', '');
    await ap.click('#log-go');
    await ap.waitForFunction(() => /관리자 로그인 실패/.test((document.getElementById('adm-log') || {}).innerText || ''), null, { timeout: 5000 })
      .catch(() => { throw new Fail('로그인 기록 보기가 안 됨'); });
    /* PC 상세 기록도 서버에서 — 글자 그대로 */
    await ap.evaluate(() => openPc('Y-003'));
    await ap.waitForFunction(() => /LOGQ1/.test(document.getElementById('dr-log').textContent), null, { timeout: 5000 })
      .catch(() => { throw new Fail('PC 상세 기록이 서버에서 안 옴'); });
    ok(!(await ap.$('#dr-log img')), 'PC 상세 기록 속 <img> 가 태그로 들어감');
    ok(!ap.xss.length, 'XSS 실행됨');
    ok(!ap.errors.length, '콘솔 오류 ' + ap.errors.join('|'));
    await ap.evaluate(() => closeDrawer());
  });

  await scenario('F1', '점검 → 판매 — 최근 90일 손님 있던 PC 는 새 비밀번호 필요 · 오래된 PC 는 예전처럼', async () => {
    await ensureAdmin();
    const kv = require('../../api/_crypto');
    let r = await apiIn(ap, '/api/admin?do=pc-update', { key: 'Y-016', status: 'ok' });
    ok(r.status === 409 && r.d.needPw && /비밀번호/.test(r.d.error), '비밀번호 없이 판매 응답 ' + r.status + ' ' + JSON.stringify(r.d));
    ok(pcOf('Y-016').status === 'fix', '거절했는데 상태가 바뀜');
    r = await apiIn(ap, '/api/admin?do=pc-update', { key: 'Y-017', status: 'ok' });
    ok(r.status === 200 && pcOf('Y-017').status === 'ok', '90일 지난 PC 응답 ' + r.status + ' ' + JSON.stringify(r.d));
    /* 화면 — [점검 완료 → 판매] 를 누르면 같은 체크리스트가 뜸 */
    pcOf('Y-016').last_beat = new Date().toISOString();       // 시험이 길어 신호가 오래되면 "다운" 으로 보여 버튼이 숨으므로
    await ap.reload(); await adminReady(ap);
    await ap.evaluate(() => openPc('Y-016'));
    await ap.click('[data-took="Y-016"]');
    await ap.waitForSelector('[data-wipedone="Y-016"]', { timeout: 5000 });
    ok(/점검 완료/.test(await drawerText(ap)), '체크리스트 제목이 점검용이 아님');
    const cks = await ap.$$('[data-wck]');
    ok(cks.length === 3 && await ap.$eval('[data-wipedone="Y-016"]', b => b.disabled), '체크리스트 모양');
    for (const c of cks) await c.check();
    await ap.fill('#w-pw', 'fix-new-pw-16');
    await ap.click('[data-wipedone="Y-016"]');
    await until(() => pcOf('Y-016').status === 'ok', 5000, '판매로 안 바뀜: ' + lastDialog(ap));
    ok(kv.open(pcOf('Y-016').pw_enc) === 'fix-new-pw-16', '새 비밀번호가 저장 안 됨');
    await until(() => db().view_log.some(v => v.pn === 'Y-016' && /점검 완료 → 판매 가능 \(최근 손님/.test(v.act) && v.who === '대표'), 3000, '점검 완료 기록 없음');
  });

  await scenario('R1', '정산·대사 — 토스 거래내역 대조 · 다섯 묶음 · 쪽 넘김 · 읽기만', async () => {
    await ensureAdmin();
    const now = Date.now();
    const day = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
    const o = (id, x) => Object.assign({ order_id: id, member_id: null, pn: null, spec_id: 5, days: 30, amount: 65000, setup_fee: 5000,
      status: 'expired', pay_key: 'pk_' + id, pay_method: '카드', paid_at: iso(now - 7200e3), va_secret: null, tax_invoice: false, biz_no: null,
      starts_at: iso(now - 7200e3), ends_at: iso(now + 86400000), payer_name: '대사', user_name: '대사', user_phone: null,
      canceled_at: null, refund_amt: null, refund_why: null, created_at: iso(now - 7200e3), refund_state: null, refund_done_at: null }, x);
    const added = [
      o('KVC260101-RCCAN1', { status: 'paid' }),
      o('KVC260101-RCAMT1', {}),
      o('KVC260101-RCREF1', { status: 'refunded', refund_amt: 30000, refund_state: 'toss_done' }),
      o('KVC260101-RCMAN1', { status: 'refunded', refund_amt: 20000, refund_state: 'manual_done', pay_method: '계좌이체' }),
      o('KVC260101-RCOK01', {}),
      /* 기간 경계 (Codex T-0185) — 40일 전 결제, 이번 기간에는 취소 줄만 있음 */
      o('KVC260101-RCXP01', { status: 'assigned', created_at: iso(now - 86400000 * 40) }),
      o('KVC260101-RCXP02', { status: 'refunded', refund_amt: 30000, refund_state: 'toss_done', created_at: iso(now - 86400000 * 40) }),
      /* 토스에 다시 물었는데 토스가 오류 → 결과가 완전하지 않다고 알려야 함 (Codex T-0186) */
      o('KVC260101-RCXP03', { status: 'assigned', created_at: iso(now - 86400000 * 40) }),
    ];
    /* 토스가 지금 기억하는 그 결제의 누적 상태 (GET /v1/payments/{key}) */
    srv.toss.payments['pk_KVC260101-RCXP01'] = { paymentKey: 'pk_KVC260101-RCXP01', orderId: 'KVC260101-RCXP01', confirmed: true,
      method: '카드', totalAmount: 65000, balanceAmount: 0, status: 'CANCELED' };
    srv.toss.payments['pk_KVC260101-RCXP02'] = { paymentKey: 'pk_KVC260101-RCXP02', orderId: 'KVC260101-RCXP02', confirmed: true,
      method: '카드', totalAmount: 65000, balanceAmount: 35000, status: 'PARTIAL_CANCELED' };
    srv.toss.payments['pk_KVC260101-RCXP03'] = { paymentKey: 'pk_KVC260101-RCXP03', orderId: 'KVC260101-RCXP03', confirmed: true,
      method: '카드', totalAmount: 65000, balanceAmount: 0, status: 'CANCELED', getFail: true };
    db().orders.push(...added);
    let k = 900000;
    const tx = (orderId, status, amount, n = 1) => {
      for (let i = 0; i < n; i++) srv.toss.transactions.push({ transactionKey: 'txk_' + (k++), paymentKey: 'pk_' + orderId, orderId,
        method: '카드', status, amount, currency: 'KRW', transactionAt: iso(now - 3600e3) });
    };
    const txBefore = srv.toss.transactions.length;
    tx('KVC260101-RCGHOST', 'DONE', 65000);
    tx('KVC260101-SEEDVA', 'DONE', 55000);
    tx('KVC260101-RCCAN1', 'DONE', 65000); tx('KVC260101-RCCAN1', 'CANCELED', 65000);
    tx('KVC260101-RCAMT1', 'DONE', 60000);
    tx('KVC260101-RCREF1', 'DONE', 65000); tx('KVC260101-RCREF1', 'CANCELED', 20000);
    tx('KVC260101-RCMAN1', 'DONE', 65000);
    tx('KVC260101-RCOK01', 'DONE', 65000);
    tx('KVC260101-RCBULK', 'DONE', 1, 5001);          // 5000건 넘음 → 쪽 넘김
    tx('KVC260101-RCXP01', 'CANCELED', 65000);        // 승인은 40일 전(기간 밖) → 토스에 다시 물어 "취소인데 이용중"
    tx('KVC260101-RCXP03', 'CANCELED', 65000);        // 다시 묻기 실패 → checkFail
    tx('KVC260101-RCXP02', 'PARTIAL_CANCELED', 20000); // 앞서 10,000 + 이번 20,000 = 30,000 → DB 와 같음 (오탐 아님)
    const snap = JSON.stringify(db().orders) + JSON.stringify(db().pcs);
    const cancels = srv.toss.cancels.length, confirms = srv.toss.confirms.length, calls0 = srv.toss.txCalls;
    try {
      const r = await apiIn(ap, `/api/admin?do=recon&from=${day(now - 86400000)}&to=${day(now)}`);
      ok(r.status === 200, '대조 응답 ' + r.status + ' ' + JSON.stringify(r.d).slice(0, 200));
      ok(srv.toss.txCalls - calls0 === 2, '쪽 넘김 호출 수 ' + (srv.toss.txCalls - calls0));
      const ids = g => (r.d.groups[g] || []).map(x => x.orderId).sort();
      const eq = (g, want) => ok(JSON.stringify(ids(g)) === JSON.stringify(want.slice().sort()), `${g}: ${ids(g)} ≠ ${want}`);
      eq('tossOnly', ['KVC260101-RCGHOST', 'KVC260101-RCBULK']);
      eq('doneButNotPaid', ['KVC260101-SEEDVA']);
      eq('canceledButActive', ['KVC260101-RCCAN1', 'KVC260101-RCXP01']);
      ok(r.d.checked >= 2 && (r.d.groups.canceledButActive.find(x => x.orderId === 'KVC260101-RCXP01') || {}).verified,
        '기간 밖 결제를 토스에 다시 확인하지 않음 checked=' + r.d.checked);
      ok(r.d.checkFail === 1, '토스 오류를 세지 않음 checkFail=' + r.d.checkFail);
      eq('amountDiff', ['KVC260101-RCAMT1']);
      /* RCXP03 은 토스에 다시 묻지 못해 거래 합계(취소 65,000 ≠ DB 환불 0)로 남음 — verified=false 로 표시 */
      eq('refundDiff', ['KVC260101-RCREF1', 'KVC260101-RCXP03']);
      ok((r.d.groups.refundDiff.find(x => x.orderId === 'KVC260101-RCXP03') || {}).verified === false, 'RCXP03 verified 표시');
      ok((r.d.groups.tossOnly.find(x => x.orderId === 'KVC260101-RCBULK') || {}).tossPaid === 5001, '쪽 넘김으로 받은 합계가 다름');
      /* 읽기만 — DB · 토스 아무것도 안 바뀜 */
      ok(JSON.stringify(db().orders) + JSON.stringify(db().pcs) === snap, '대조가 DB 를 바꿈');
      ok(srv.toss.cancels.length === cancels && srv.toss.confirms.length === confirms, '대조가 토스에 승인·취소를 보냄');
      /* 잘못된 기간 */
      ok((await apiIn(ap, `/api/admin?do=recon&from=${day(now - 86400000 * 40)}&to=${day(now)}`)).status === 400, '31일 넘는 기간이 통과');
      ok((await apiIn(ap, `/api/admin?do=recon&from=${day(now)}&to=${day(now - 86400000)}`)).status === 400, '거꾸로 된 기간이 통과');
      ok((await apiIn(ap, '/api/admin?do=recon&from=2026-02-31&to=2026-03-01')).status === 400, '없는 날짜가 통과');
      /* 화면 */
      await ap.reload(); await adminReady(ap);
      await view(ap, 'recon');
      await ap.fill('#rc-from', day(now - 86400000)); await ap.fill('#rc-to', day(now));
      await ap.click('#rc-go');
      await ap.waitForFunction(() => /SEEDVA/.test((document.getElementById('recon-doneButNotPaid') || {}).innerText || ''), null, { timeout: 8000 })
        .catch(() => { throw new Fail('대사 화면에 결과가 안 나옴'); });
      for (const g of ['tossOnly', 'doneButNotPaid', 'canceledButActive', 'amountDiff', 'refundDiff']) ok(await ap.$('#recon-' + g), g + ' 표 없음');
      const sum = await ap.$eval('#recon-sum', e => e.innerText);
      ok(/다시 묻지 못했습니다/.test(sum) && !/어긋난 것 없음/.test(sum), '불완전 경고가 없음: ' + sum);
      await ap.click('#recon-amountDiff [data-reconord="KVC260101-RCAMT1"]');
      await ap.waitForSelector('#drawer.on', { timeout: 5000 });
      ok(/RCAMT1/.test(await drawerText(ap)), '줄을 눌러도 주문 상세가 안 열림');
      await ap.evaluate(() => closeDrawer());
      const n = ap.dialogs.length;
      await ap.click('#recon-tossOnly [data-reconord="KVC260101-RCGHOST"]');
      await until(() => ap.dialogs.length > n, 3000, '토스에만 있는 결제를 눌러도 안내가 없음');
      ok(/목록에 없습니다/.test(lastDialog(ap)), '안내 문구 ' + lastDialog(ap));
      ok(!ap.errors.length, '콘솔 오류 ' + ap.errors.join('|'));
    } finally {
      const ids = new Set(added.map(x => x.order_id));
      const keep = db().orders.filter(x => !ids.has(x.order_id));
      db().orders.length = 0; db().orders.push(...keep);
      srv.toss.transactions.length = txBefore;
      delete srv.toss.payments['pk_KVC260101-RCXP01']; delete srv.toss.payments['pk_KVC260101-RCXP02']; delete srv.toss.payments['pk_KVC260101-RCXP03'];
    }
  });

  await scenario('S1', 'db/09 자동 알림 SQL — 예약 2개 · Vault 열쇠 이름 · 실명·고객 이름·진짜 토큰 없음', async () => {
    const sql = fs.readFileSync(path.join(srv.ROOT, 'db', '09-자동알림.sql'), 'utf8');
    for (const w of ['pg_cron', 'pg_net', 'alert_state', 'kvc_alerts', 'vault.decrypted_secrets', "'kvc_tg_token'", "'kvc_tg_chat'",
      'net.http_post', 'api.telegram.org/bot', "cron.schedule", 'sweep_expired', "'*/5 * * * *'", "'* * * * *'", 'Asia/Seoul']) {
      ok(sql.includes(w), 'SQL 에 「' + w + '」 없음');
    }
    ok(!/파주|금촌|영태리|등원리/.test(sql), 'SQL 에 서버실 실명');
    ok(!/payer_name|user_name|user_phone|members/.test(sql), 'SQL 이 고객 이름·연락처를 읽음');
    ok(!/\d{8,10}:[A-Za-z0-9_-]{30,}/.test(sql), 'SQL 에 진짜 봇 토큰처럼 보이는 값');
    ok(/\r\n/.test(sql) && !/[^\r]\n/.test(sql), 'SQL 줄바꿈이 다른 db 파일(CRLF)과 다름');
  });

  await scenario('A13', '관리자 — 로그아웃 → 다시 잠김', async () => {
    await ensureAdmin();
    ap.answers.push(true);
    await Promise.all([ap.waitForNavigation(), ap.click('#adm-logout')]);
    await ap.waitForSelector('#gate:not(.off)');
    const r = await apiIn(ap, '/api/admin?do=pcs');
    ok(r.status === 401, '로그아웃 뒤 PC 목록 ' + r.status);
    await actx.close();
  });

  /* ══════════ 마무리 확인 ══════════ */
  await scenario('Z1', '시험 중 진짜 외부 서비스 호출 없음 · 서버 오류(500) 없음', async () => {
    ok(!srv.blocked.length, '서버가 바깥 주소를 부르려 함: ' + srv.blocked.join(','));
    const errs = srv.apiLog.filter(a => a.st >= 500);
    ok(!errs.length, '500 응답: ' + errs.map(e => e.url + ' ' + (e.err || '')).join(' | '));
    const real = external.filter(h => /supabase|vercel|aligo|kakao\.com\/v2|googleapis/.test(h));
    ok(!real.length, '브라우저가 진짜 서비스로 나가려 함: ' + real.join(','));
  });

  await browser.close();
  await s.close();

  const pass = results.filter(r => r.ok).length;
  console.log(`\n결과: ${pass} / ${results.length} 통과`);
  if (faviconMissing) console.log('참고: favicon.ico(탭 아이콘)가 없어 첫 화면에서 404 가 한 번 납니다 — 기능과 무관, 아이콘은 대표님 결정 사항');
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(results, null, 2));
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(3); });
