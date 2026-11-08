/* ═══════════════════════════════════════════════════════════════
   소셜 로그인 설정 (예비용 — 실제 키는 Vercel 환경변수에 넣습니다)

   [카카오·네이버]  ★ 이 파일이 아니라 Vercel 환경변수로 켭니다 (남은작업.md 1번 참고)
     · 카카오: KAKAO_JS_KEY + KAKAO_REST_KEY (+ KAKAO_APP_ID 권장)
       Redirect URI 등록:  https://idckorea-dusky.vercel.app/login
     · 네이버: NAVER_CLIENT_ID + NAVER_CLIENT_SECRET
       Callback URL 등록:  https://idckorea-dusky.vercel.app/login
     (로그인 마무리를 서버가 하므로, 서버 함수 없이 파일로 열면 동작하지 않습니다)

   [구글]  console.cloud.google.com → API 및 서비스 → 사용자 인증 정보
     · OAuth 클라이언트 ID 만들기 → 웹 애플리케이션
     · 승인된 JavaScript 원본:  https://idckorea-dusky.vercel.app
     · 생성된 "클라이언트 ID" 를 아래 GOOGLE_CLIENT_ID 에 붙여넣기

   키가 비어 있는 로그인 버튼은 화면에서 숨깁니다.

   로그인 이후 흐름
     · 처음 오신 분  → 연락처 확인 + 약관 동의 → 가입 완료
     · 다시 오신 분  → 약관 단계 없이 바로 내 가상컴으로
   ═══════════════════════════════════════════════════════════════ */
/* ★ 이 파일은 예비용입니다.
   실제로는 서버(/api/auth-config)가 Vercel 환경변수에서 키를 내려줍니다.
   서버가 이미 키를 채워줬으면 여기서는 아무것도 하지 않습니다.
   (로컬에서 파일을 직접 열어보실 때만 아래 값이 쓰입니다) */
/* ★ 2026-11-08 — 서버가 내려준 값(네이버·토스 키 등)은 그대로 둡니다.
     전에는 카카오·구글 키가 비어 있으면 서버 값을 통째로 덮어써서 다른 키까지 지웠습니다. */
if (!window.KVC_AUTH) {
  window.KVC_AUTH = {
    KAKAO_JS_KEY   : '',
    GOOGLE_CLIENT_ID: '',  // 예: '1234567890-abcdefg.apps.googleusercontent.com'
    NAVER_CLIENT_ID: '',
  };
}
