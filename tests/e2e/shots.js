// 디자인 점검용 캡처 — 가짜 데이터로 사이트를 띄우고 모든 고객 화면을 PC·휴대폰 폭으로 찍습니다.
// 실행: node tests/e2e/shots.js <저장폴더>
const path = require('path');
const { chromium } = require('playwright-core');
const server = require('./server');
const { makeTicket } = require('../../api/_ticket');
(async () => {
  const out = process.argv[2] || path.join(__dirname, 'shots');
  require('fs').mkdirSync(out, { recursive: true });
  const s = await server.start();
  const seed = require('./seed'); if (seed.seed) await seed.seed(server.fakeDb);
  let browser;
  for (const ch of ['msedge', 'chrome']) { try { browser = await chromium.launch({ channel: ch, headless: true }); break; } catch (e) {} }
  const pages = (process.argv[3] || 'index,ai,live,product?g=5,about,qa,login,mypage,terms,privacy,fail').split(',');
  for (const [w, h, tag] of [[1440, 900, 'pc'], [390, 844, 'm']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    for (const p of pages) {
      const pg = await ctx.newPage();
      await pg.goto(s.base + '/' + p, { waitUntil: 'networkidle' }).catch(() => {});
      await pg.waitForTimeout(600);
      /* 스크롤하면 나타나는 구간이 있어 끝까지 천천히 내렸다가 올라옵니다 */
      await pg.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } window.scrollTo(0, 0); });
      await pg.waitForTimeout(700);
      await pg.evaluate(() => { document.querySelectorAll('.pop,.modal,[class*=popup]').forEach(e => { if (getComputedStyle(e).position === 'fixed') e.remove(); }); });
      const name = p.replace(/[?=&]/g, '_');
      await pg.screenshot({ path: path.join(out, `${tag}_${name}.png`), fullPage: true });
      await pg.close();
    }
    await ctx.close();
  }
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
