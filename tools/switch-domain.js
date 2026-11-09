// 도메인 전환 — 검색엔진에 보이는 주소(canonical·og·구조화 데이터·사이트맵·robots)를 새 도메인으로 바꿉니다.
// 실행: node tools/switch-domain.js https://www.idckorea2.com
//   · 도메인을 사서 Vercel 에 연결(파란 체크·자물쇠)된 뒤에만 돌립니다.
//   · 여러 번 돌려도 같은 결과입니다.
//   · 바꾸지 않는 것: 랙PC 프로그램(agent/)·AI 본부 업로드(tools/hub-publish.ps1)의 서버 주소.
//     예전 주소(idckorea-dusky.vercel.app)도 계속 살아 있으니 그대로 둡니다. agent/ 는 서명이 걸려 있습니다.
//   · 식스샵 홈페이지(idckorea1.com)는 건드리지 않습니다.
//   · 예전 주소에는 검색 제외(noindex) 머리글을 붙여, 같은 글이 두 주소로 잡히지 않게 합니다.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const OLD = 'https://idckorea-dusky.vercel.app';
const NEW = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/.test(NEW) || NEW === OLD) {
  console.error('사용법: node tools/switch-domain.js https://www.idckorea2.com'); process.exit(1);
}
const host = NEW.replace('https://', '').replace(/^www\./, '');
const SKIP = new Set(['관리자-사용설명서.html']);
let changed = [];
const edit = (rel, fn) => {
  const p = path.join(root, rel); if (!fs.existsSync(p)) return;
  const s = fs.readFileSync(p, 'utf8'), t = fn(s);
  if (t !== s) { fs.writeFileSync(p, t); changed.push(rel); }
};

/* 1. 고객 화면 HTML — 머리(head)의 주소만 바꿉니다 */
for (const f of fs.readdirSync(root).filter(f => f.endsWith('.html') && !SKIP.has(f))) {
  edit(f, s => s.replace(/<head>[\s\S]*?<\/head>/, h => h.split(OLD).join(NEW))
                .replace(/\(c\) 2026 한국가상컴 \(idckorea1\.com\)/, `(c) 2026 한국가상컴 (${host})`));
}
/* 2. 페이지 생성기 (ai.html·hub.html 을 다시 만들 때도 새 주소가 들어가게) */
for (const f of ['tools/build-ai-page.js', 'tools/build-hub-page.js']) edit(f, s => s.split(OLD).join(NEW));
/* 3. 사이트맵 — 새 주소 + .html 없는 주소(cleanUrls) + AI 허브 */
edit('sitemap.xml', s => {
  s = s.split(OLD).join(NEW).replace(new RegExp('(<loc>' + NEW.replace(/\./g, '\\.') + '/[a-z]+)\\.html</loc>', 'g'), '$1</loc>');
  if (!s.includes(NEW + '/hub</loc>')) s = s.replace('</urlset>',
    `  <url>\n    <loc>${NEW}/hub</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>\n\n</urlset>`);
  return s;
});
/* 4. robots.txt */
edit('robots.txt', s => s.split(OLD + '/sitemap.xml').join(NEW + '/sitemap.xml'));
/* 5. vercel.json — 예전 주소로 들어오면 noindex */
edit('vercel.json', s => {
  const j = JSON.parse(s); j.headers = j.headers || [];
  if (!j.headers.some(h => (h.has || []).some(x => x.type === 'host' && x.value === 'idckorea-dusky.vercel.app')))
    j.headers.push({ source: '/(.*)', has: [{ type: 'host', value: 'idckorea-dusky.vercel.app' }],
                     headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] });
  return JSON.stringify(j, null, 2) + '\n';
});
console.log(changed.length ? '바꾼 파일 ' + changed.length + '개:\n  ' + changed.join('\n  ') : '바꿀 것이 없습니다 (이미 전환됨)');
console.log('다음: node tools/build-ai-page.js && node tools/build-hub-page.js → npm --prefix tests/e2e test → 올리기');
