// 운영 사이트 점검 — 읽기만 합니다 (주문·결제·로그인·데이터 변경 없음)
// 실행: node tests/e2e/prod-smoke.js [주소]   기본 https://idckorea-dusky.vercel.app
const { chromium } = require('playwright-core');
const BASE = (process.argv[2] || 'https://idckorea-dusky.vercel.app').replace(/\/$/, '');
const R = [];
const ok = (n, c, d = '') => { R.push([n, !!c, d]); console.log((c ? '  ✔ ' : '  ✘ ') + n + (d ? ' — ' + d : '')); };
const json = { 'Content-Type': 'application/json' };

(async () => {
  let b;
  for (const ch of ['msedge', 'chrome']) { try { b = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {} }
  const get = async (p, opt = {}) => {
    const r = await fetch(BASE + p, opt); let t = '';
    try { t = await r.text(); } catch (e) {}
    return { s: r.status, t };
  };

  /* 1. 공개 API */
  const h = await get('/api/health'); let hj = {};
  try { hj = JSON.parse(h.t); } catch (e) {}
  const dbs = hj['데이터베이스'] || {};
  ok('진단: DB 6개 표 정상', /정상/.test(dbs['상태'] || ''), dbs['상태']);
  ok('진단: 하트비트 창구 정상', /정상/.test(dbs['하트비트 창구'] || ''));
  ok('진단: 키 앞 글자 노출 없음', !/sb_secre|kvc-setu|…\(/.test(h.t));

  const lp = await get('/api/live-pcs'); let lj = {};
  try { lj = JSON.parse(lp.t); } catch (e) {}
  ok('실시간 재고 API', lj.ready === true && lj.total > 0, `전체 ${lj.total} · 임대 가능 ${lj.available}`);
  ok('재고 목록에 미등록·미검증 PC 없음', (lj.pcs || []).every(p => !['new', 'unv'].includes(p.status)));
  ok('재고 목록에 애니데스크·비밀번호 없음', !/anydesk|pw_enc/i.test(lp.t));

  const ac = await get('/api/auth-config');
  const gOn = /GOOGLE_CLIENT_ID"\s*:\s*"[^"]+/.test(ac.t), kOn = /KAKAO_JS_KEY"\s*:\s*"[^"]+/.test(ac.t);
  ok('로그인 설정 응답', ac.s === 200, `구글 ${gOn ? '켜짐' : '꺼짐'} · 카카오 ${kOn ? '켜짐' : '꺼짐'}`);

  const oc = await get('/api/order-create', { method: 'POST', headers: json, body: JSON.stringify({ specId: 5, days: 30 }) });
  ok('실결제 키 없을 때 주문 닫힘', [401, 503].includes(oc.s), oc.s + ' ' + oc.t.slice(0, 50));
  const tc = await get('/api/toss-confirm', { method: 'POST', headers: json, body: JSON.stringify({ paymentKey: 'x', orderId: 'y', amount: 1 }) });
  ok('결제 승인 창구가 테스트 결제를 받지 않음', tc.s === 503, tc.s + '');
  const wh = await get('/api/toss-webhook', { method: 'POST', headers: json, body: JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: 'FAKE-NOPE', status: 'CANCELED' } }) });
  ok('가짜 웹훅 → 오류 없이 무시', wh.s < 500, wh.s + ' ' + wh.t.slice(0, 50));
  const ad = await get('/api/admin?do=pcs');
  ok('관리자 API 로그인 없이 막힘', ad.s === 401, ad.s + '');
  const al = await get('/api/admin-login', { method: 'POST', headers: json, body: JSON.stringify({ pw: '4060' }) });
  ok('관리자 4060 거부', al.s === 401 || al.s === 429, al.s + '');
  const pr = await get('/api/pc-register', { method: 'POST', headers: json, body: '{}' });
  ok('랙PC 등록 창구 암호 없이 막힘', pr.s === 401 || pr.s === 503, pr.s + '');
  for (const p of ['/CLAUDE.md', '/db/schema.sql', '/agent/kvc-config.json', '/tools/sign-agent.ps1', '/tests/e2e/run.js']) {
    const r = await get(p); ok('내부 파일 비공개 ' + p, r.s === 404, r.s + '');
  }
  for (const p of ['/agent/kvc-agent.ps1', '/agent/kvc-agent.ps1.sig', '/img/logo-96.png', '/sitemap.xml', '/robots.txt']) {
    const r = await get(p); ok('공개 파일 ' + p, r.s === 200, r.s + '');
  }

  /* 2. 화면 — PC·휴대폰 */
  const pages = ['/', '/ai', '/live', '/product?g=5', '/product?g=2', '/about', '/qa', '/login', '/mypage', '/terms', '/privacy', '/success', '/fail', '/admin'];
  for (const [w, hgt, t] of [[1440, 900, 'PC'], [390, 844, '휴대폰']]) {
    const c = await b.newContext({ viewport: { width: w, height: hgt } });
    for (const p of pages) {
      const pg = await c.newPage(); const errs = [], bad = [];
      pg.on('dialog', d => d.accept());
      pg.on('pageerror', e => errs.push(String(e).slice(0, 100)));
      pg.on('response', r => {
        if (r.status() >= 400 && r.url().startsWith(BASE) && !/\/api\/(customer|admin)/.test(r.url())) bad.push(r.status() + ' ' + r.url().replace(BASE, ''));
      });
      await pg.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => errs.push('열기 실패'));
      await pg.waitForTimeout(2500);
      const info = await pg.evaluate(() => ({
        ov: document.documentElement.scrollWidth - innerWidth,
        imgs: [...document.images].filter(i => i.complete && i.naturalWidth === 0 && i.src && !i.src.startsWith('data:')).map(i => i.src.split('/').pop()),
        foot: /사업자등록번호/.test(document.body.innerText),
        demo: /시안 결제|테스트 키라|Y-042/.test(document.body.innerText),
        dead: [...document.querySelectorAll('a[href="#"]')].filter(a => a.offsetParent && !a.dataset.go && !/로그아웃/.test(a.textContent)).map(a => a.textContent.trim()).slice(0, 5),
      }));
      const det = [errs.join('|'), bad.join('|'), info.ov > 1 ? '가로넘침 ' + info.ov : '', info.imgs.length ? '깨진 그림 ' + info.imgs.join(',') : '', info.demo ? '시안 문구' : ''].filter(Boolean).join(' / ');
      ok(`${t} ${p} 화면`, !det, det);
      if (!['/admin', '/success', '/fail'].includes(p)) ok(`${t} ${p} 사업자 정보 꼬리말`, info.foot);
      if (info.dead.length) ok(`${t} ${p} 빈 링크`, false, info.dead.join(','));
      await pg.close();
    }
    await c.close();
  }

  /* 3. 고객 흐름 — 결제 직전까지 */
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await c.newPage();
  pg.on('dialog', d => d.accept());   // '지금 로그인하시겠습니까?' 확인 창에 [확인]
  await pg.goto(BASE + '/live', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1500);
  const pick = await pg.$('button:has-text("선택"), a:has-text("선택")');
  if (pick) {
    await pick.click(); await pg.waitForTimeout(1500);
    const go = await pg.$('a:has-text("이 PC 바로 임대하기"), a[href*="product"][href*="pc="]');
    if (go) { await go.click(); await pg.waitForTimeout(2500); }
    ok('실시간 PC → 상품 화면(고른 PC 유지)', /product/.test(pg.url()) && /pc=/.test(pg.url()), pg.url().replace(BASE, ''));
  } else ok('실시간 PC → 상품 화면', false, '선택 버튼 없음');
  const pay = await pg.$('button:has-text("바로 이용하기"), a:has-text("바로 이용하기")');
  if (pay) {
    await pay.click(); await pg.waitForTimeout(3000);
    ok('로그인 안 한 결제 → 로그인 화면(상품·PC 유지)', /login/.test(pg.url()) && /g%3D|g=/.test(pg.url()), decodeURIComponent(pg.url().replace(BASE, '')));
  } else ok('결제 버튼', false, '없음');
  await pg.goto(BASE + '/login', { waitUntil: 'networkidle' }); await pg.waitForTimeout(3500);
  const vis = await pg.evaluate(() => ({
    kk: [...document.querySelectorAll('.so-kk')].some(e => e.offsetParent),
    gg: [...document.querySelectorAll('[data-go="google"], iframe[src*="accounts.google.com"], [id*="gbtn"], .g-btn')].some(e => e.offsetParent),
    nv: [...document.querySelectorAll('.so-nv,[data-go="naver"]')].some(e => e.offsetParent),
  }));
  ok('로그인 화면: 구글 버튼 보임', vis.gg === gOn);
  ok('로그인 화면: 카카오 버튼은 키가 있을 때만', vis.kk === kOn);
  ok('로그인 화면: 네이버 버튼은 키가 있을 때만', vis.nv === /NAVER_CLIENT_ID"\s*:\s*"[^"]+/.test(ac.t));
  await pg.goto(BASE + '/mypage', { waitUntil: 'domcontentloaded' }); await pg.waitForTimeout(2500);
  ok('로그인 안 한 내 가상컴 → 로그인 안내', /로그인/.test(await pg.evaluate(() => document.body.innerText)));
  await b.close();

  const fail = R.filter(r => !r[1]);
  console.log(`\n결과: ${R.length - fail.length} / ${R.length} 통과`);
  require('fs').writeFileSync(__dirname + '/prod-result.json', JSON.stringify(R, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
