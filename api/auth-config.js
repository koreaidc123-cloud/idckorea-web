/* ═══════════════════════════════════════════════════════════════
   카카오·구글 로그인 키 전달

   왜 이 파일이 필요한가
     전에는 auth-config.js 라는 파일에 키를 적어 넣어야 했습니다.
     그러면 대표님이 키를 받으셔도 제가 코드를 고쳐 올릴 때까지
     로그인이 안 켜집니다.

     이제는 Vercel 환경변수에 키를 넣기만 하면 바로 켜집니다.
     제가 없어도 대표님 혼자 켜실 수 있습니다.

   넣을 곳 : Vercel → Settings → Environment Variables
     KAKAO_JS_KEY      developers.kakao.com → 앱 키 → JavaScript 키
     GOOGLE_CLIENT_ID  console.cloud.google.com → OAuth 클라이언트 ID
     NAVER_CLIENT_ID   developers.naver.com → 내 애플리케이션 → Client ID
     TOSS_CLIENT_KEY   토스 개발자센터 → 내 개발정보 → API 키 → 클라이언트 키

   ※ 이 넷은 원래 브라우저에 공개되는 키입니다.
      공개돼도 안전한 종류이므로 여기서 내려보내도 문제 없습니다.
      (카카오 REST API 키 · 카카오 Client Secret · 네이버 Client Secret ·
       구글 클라이언트 보안 비밀 · 토스 시크릿 키는 절대 여기서 내려보내지 않습니다.
       서버(api/customer.js)에서만 씁니다)

   ★ 카카오는 JavaScript 키(KAKAO_JS_KEY)와 REST API 키(KAKAO_REST_KEY)가
     둘 다 있어야 켜집니다. 공식 방식은 서버가 REST API 키로 로그인을 마무리하기 때문입니다.
     하나만 있으면 버튼을 숨깁니다 (눌러도 실패하는 버튼을 보여주지 않으려고).
   ★ 네이버도 Client ID · Client Secret 이 둘 다 있어야 켜집니다.
   ═══════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  const kakao = (process.env.KAKAO_JS_KEY && process.env.KAKAO_REST_KEY) ? process.env.KAKAO_JS_KEY : '';
  const google = process.env.GOOGLE_CLIENT_ID || '';
  const naver = (process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET) ? process.env.NAVER_CLIENT_ID : '';
  /* 토스 클라이언트 키 — 전에는 product.html 에 테스트 키가 박혀 있었습니다.
     그러면 심사에 통과해 라이브 키를 받으셔도 제가 코드를 고쳐 올릴 때까지
     실결제가 안 열립니다. 이제 환경변수만 바꾸시면 바로 열립니다. */
  const tossCk = process.env.TOSS_CLIENT_KEY || '';

  /* 잠깐 캐시해서 로그인 화면이 빨리 뜨게 합니다 (5분) */
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  /* 실수로 비밀 키를 넣으신 경우를 막습니다 */
  const bad = [];
  if (kakao && kakao.length > 40) bad.push('KAKAO_JS_KEY 가 JavaScript 키가 아닌 것 같습니다');
  if (google && !/\.apps\.googleusercontent\.com$/.test(google)) {
    bad.push('GOOGLE_CLIENT_ID 는 .apps.googleusercontent.com 으로 끝나야 합니다');
  }
  /* ★ 시크릿 키를 클라이언트 키 자리에 넣으시면 브라우저로 새어나갑니다.
     그 즉시 남이 우리 이름으로 결제를 만들 수 있으므로 반드시 막습니다. */
  const ckBad = /^(test|live)_sk_/.test(tossCk)
    ? 'TOSS_CLIENT_KEY 자리에 시크릿 키(sk)를 넣으셨습니다. 클라이언트 키(ck)로 바꿔 주세요'
    : (tossCk && !/^(test|live)_ck_/.test(tossCk)
        ? 'TOSS_CLIENT_KEY 는 test_ck_ 또는 live_ck_ 로 시작해야 합니다' : '');
  if (ckBad) bad.push(ckBad);

  res.status(200).send(
    'window.KVC_AUTH = ' +
    JSON.stringify({
      KAKAO_JS_KEY: bad.length ? '' : kakao,
      GOOGLE_CLIENT_ID: bad.length ? '' : google,
      NAVER_CLIENT_ID: bad.length ? '' : naver,
      TOSS_CLIENT_KEY: ckBad ? '' : tossCk,
      warn: bad.length ? bad : undefined,
    }) + ';'
  );
};
