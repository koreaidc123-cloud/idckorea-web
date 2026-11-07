// ai.html 을 만듭니다. 머리(스타일·헤더)와 꼬리(푸터·문의 버튼)는 index.html 에서 그대로 가져와
// 메인 화면과 모양이 어긋나지 않게 합니다. 본문은 tools/ai-page-body.html 에서 고칩니다.
// 실행: node tools/build-ai-page.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const idx = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const body = fs.readFileSync(path.join(__dirname, 'ai-page-body.html'), 'utf8');
const cut = (a, b) => {
  const i = idx.indexOf(a), j = idx.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('못 찾음: ' + a);
  return idx.slice(i, j + b.length);
};
const font = cut('<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard', '>');
const style = cut('<style>', '</style>');
const header = cut('<header class="hd">', '</div></header>')
  .replace('<a class="lg" href="#">', '<a class="lg" href="index.html">')
  .replace(/href="#(price|qa|about)"/g, 'href="index.html#$1"')
  .replace('<a href="ai.html">', '<a class="on" href="ai.html">');
const footer = cut('<footer class="ft">', '</div></footer>')
  .replace(/href="#(price|qa|about)"/g, 'href="index.html#$1"');
const fi = idx.indexOf('<div class="kvc-float">');
const float = idx.slice(fi, idx.indexOf('</style>', fi) + 8);
const url = 'https://idckorea-dusky.vercel.app/ai';
const desc = '클로드 코드·코덱스를 24시간 돌릴 윈도우 원격PC. 라이젠 3700X 메모리 32GB, 30일 65,000원(부가세 별도). 노트북을 덮어도 일하는 PC를 따로 두세요.';
const css = fs.readFileSync(path.join(__dirname, 'ai-page.css'), 'utf8');
const html = [
  '<!doctype html>',
  '<html lang="ko">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="color-scheme" content="only light">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>AI 작업용 원격PC · 클로드 코드 24시간 | 한국 가상컴</title>',
  `<meta name="description" content="${desc}">`,
  '<meta name="keywords" content="AI 작업용 PC,클로드 코드 24시간,클로드 코드 원격PC,코덱스,AI 에이전트 PC,맥미니 대신,원격PC 임대,가상PC">',
  `<link rel="canonical" href="${url}">`,
  '<meta property="og:type" content="website">',
  '<meta property="og:site_name" content="한국 가상컴">',
  '<meta property="og:title" content="원격PC 임대로 AI를 밤새 돌리세요 | 한국 가상컴">',
  `<meta property="og:description" content="${desc}">`,
  `<meta property="og:url" content="${url}">`,
  '<meta property="og:image" content="https://idckorea-dusky.vercel.app/img/hero1.jpg">',
  '<meta property="og:locale" content="ko_KR">',
  font,
  style,
  '<style>', css, '</style>',
  '</head>',
  '<body>',
  header, body, footer, float,
  '</body>',
  '</html>', '',
].join('\n');
fs.writeFileSync(path.join(root, 'ai.html'), html);
console.log('ai.html', html.length);
