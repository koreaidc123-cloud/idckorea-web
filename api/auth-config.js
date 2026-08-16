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

   ※ 이 두 개는 원래 브라우저에 공개되는 키입니다.
      공개돼도 안전한 종류이므로 여기서 내려보내도 문제 없습니다.
      (카카오 REST API 키·구글 클라이언트 보안 비밀은 절대 여기 넣지 마세요)
   ═══════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  const kakao = process.env.KAKAO_JS_KEY || '';
  const google = process.env.GOOGLE_CLIENT_ID || '';

  /* 잠깐 캐시해서 로그인 화면이 빨리 뜨게 합니다 (5분) */
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');

  /* 실수로 비밀 키를 넣으신 경우를 막습니다 */
  const bad = [];
  if (kakao && kakao.length > 40) bad.push('KAKAO_JS_KEY 가 JavaScript 키가 아닌 것 같습니다');
  if (google && !/\.apps\.googleusercontent\.com$/.test(google)) {
    bad.push('GOOGLE_CLIENT_ID 는 .apps.googleusercontent.com 으로 끝나야 합니다');
  }

  res.status(200).send(
    'window.KVC_AUTH = ' +
    JSON.stringify({
      KAKAO_JS_KEY: bad.length ? '' : kakao,
      GOOGLE_CLIENT_ID: bad.length ? '' : google,
      warn: bad.length ? bad : undefined,
    }) + ';'
  );
};
