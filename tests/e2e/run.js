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
    const msg = String(e && e.message || e).split('\n').slice(0, 4).join(' / ');
    results.push({ id, name, ok: false, err: msg });
    console.log(`  ✘ ${id} ${name}\n      → ${msg}`);
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
    page.dialogs.push({ type: d.type(), msg });
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
    ok(pcOf(S.vaPn).status === 'ok', '취소 후 PC 가 판매 재고로 안 돌아옴');
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
    S.manualOrder = o.order_id;
    ok(!ap.xss.length, 'XSS 실행됨');
  });

  await scenario('A7', '관리자 — PC 이전 (Y-002 → Y-007) · 옛 PC 점검으로', async () => {
    ok(S.manualOrder, 'A6 이 먼저 성공해야 합니다');
    await ensureAdmin();
    await ap.evaluate(no => openOrd(no), S.manualOrder);
    ap.answers.push('Y-007', 'PC 고장', false);
    await ap.click(`[data-movepc="${S.manualOrder}"]`);
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

  await scenario('A9', '관리자 — 해지·환불 (가짜 토스 취소) → PC 판매 재고로', async () => {
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
    ok(pcOf('Y-001').status === 'ok', 'Y-001 이 판매 재고로 안 돌아옴');
    await until(() => /환불되었습니다/.test(ap.dialogs.map(d => d.msg).join('\n')), 3000, '완료 안내 없음');
    /* 해지 뒤 고객 웹훅(토스가 뒤이어 보내는 CANCELED)이 와도 두 번 처리 안 함 */
    const r = await post('/api/toss-webhook', { eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: S.cardOrder, status: 'CANCELED' } });
    /* 부분 환불이면 토스가 PARTIAL_CANCELED 로 답합니다 — 어느 쪽이든 다시 처리하면 안 됩니다 */
    ok(r.d && /이미 처리됨|부분취소/.test(r.d.skip || ''), '해지 뒤 웹훅 ' + JSON.stringify(r.d));
    ok(orderOf(S.cardOrder).status === 'refunded' && pcOf('Y-001').status === 'ok', '웹훅이 상태를 또 바꿈');
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
