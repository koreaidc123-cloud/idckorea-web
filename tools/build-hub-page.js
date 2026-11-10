// hub.html (AI 허브) 을 만듭니다. build-ai-page.js 와 같은 방식입니다.
// 머리(스타일·헤더)와 꼬리(푸터·문의 버튼)는 index.html 에서 그대로 가져와 메인 화면과 모양이 어긋나지 않게 합니다.
// 본문은 tools/hub-page-body.html, 이 페이지만의 모양은 tools/hub-page.css 에서 고칩니다.
// 실행: node tools/build-hub-page.js   (index.html 머리·꼬리를 고친 뒤에도 다시 돌려 주세요)
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const body = fs.readFileSync(path.join(__dirname, 'hub-page-body.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'hub-page.css'), 'utf8');
const cut = (a, b) => {
  const i = idx.indexOf(a), j = idx.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('못 찾음: ' + a);
  return idx.slice(i, j + b.length);
};
const font = cut('<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard', '>');
const style = cut('<style>', '</style>');
const navfit = cut('<style id="kvc-nav-fit">', '</style>');   // 중간 폭 메뉴 쪼개짐 방지
const header = cut('<header class="hd">', '</div></header>')
  .replace('<a class="lg" href="#">', '<a class="lg" href="index.html">')
  .replace(/href="#(price|qa|about)"/g, 'href="index.html#$1"')
  .replace('<a href="ai.html">', '<a class="on" href="ai.html">');   // AI 소식은 AI 작업용 PC 메뉴 안의 부가 정보
if (!header.includes('<a class="on" href="ai.html">')) throw new Error('index.html 헤더에 AI 작업용 PC 링크가 없습니다');
const footer = cut('<footer class="ft">', '</div></footer>')
  .replace(/href="#(price|qa|about)"/g, 'href="index.html#$1"');
const fi = idx.indexOf('<div class="kvc-float">');
const float = idx.slice(fi, idx.indexOf('</style>', fi) + 8);
/* 로그인 상태를 헤더에 반영하는 작은 스크립트도 메인과 같게 가져옵니다 (로그인 후 "내 가상컴") */
const li = idx.indexOf('/* 로그인 상태를 헤더에 반영');
const loginJs = li > 0 ? '<script>\n' + idx.slice(li, idx.indexOf('</script>', li)).trim() + '\n</script>' : '';
const url = 'https://www.idckorea2.co.kr/hub';
const desc = '국내·해외 언론의 AI 기사와 유튜브 AI 영상을 매일 자동으로 모아 주간 AI 뉴스와 인기 AI 도구 순위로 정리합니다.';
const html = [
  '<!doctype html>',
  '<html lang="ko">',
  '<head>',
  '<meta charset="utf-8">',
  '<link rel="icon" href="img/logo-64.png" type="image/png">',
  '<meta name="color-scheme" content="only light">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>AI 소식 · 주간 AI 뉴스와 인기 AI 도구 | 한국 가상컴</title>',
  `<meta name="description" content="${desc}">`,
  '<meta name="keywords" content="AI 뉴스,주간 AI 뉴스,AI 소식,인기 AI 도구,AI 트렌드,클로드,챗GPT,제미나이,코덱스,AI 유튜브">',
  `<link rel="canonical" href="${url}">`,
  '<meta property="og:type" content="website">',
  '<meta property="og:site_name" content="한국 가상컴">',
  '<meta property="og:title" content="AI 소식 — 주간 AI 뉴스와 인기 AI 도구 | 한국 가상컴">',
  `<meta property="og:description" content="${desc}">`,
  `<meta property="og:url" content="${url}">`,
  '<meta property="og:image" content="https://www.idckorea2.co.kr/img/idc-hall.jpg">',
  '<meta property="og:locale" content="ko_KR">',
  font,
  style,
  navfit,
  '<style>', css, '</style>',
  '</head>',
  '<body>',
  header, body, footer, float, loginJs,
  '</body>',
  '</html>', '',
].join('\n').replace(/\r?\n/g, '\r\n');      // 다른 페이지와 같게 CRLF 로 저장
fs.writeFileSync(path.join(root, 'hub.html'), html);
console.log('hub.html', html.length);
