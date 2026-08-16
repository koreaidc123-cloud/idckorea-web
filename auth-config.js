/* ═══════════════════════════════════════════════════════════════
   소셜 로그인 설정 — 여기 두 줄만 채우면 실제 로그인이 동작합니다.

   [카카오]  developers.kakao.com → 내 애플리케이션 → 앱 만들기
     · 앱 키 → "JavaScript 키" 를 아래 KAKAO_JS_KEY 에 붙여넣기
     · 카카오 로그인 → 활성화 ON
     · Redirect URI 등록:  https://idckorea-dusky.vercel.app/login.html
     · 동의항목 → 닉네임(필수), 전화번호(필수·검수 필요), 카카오계정 이메일(선택)
       ※ 전화번호 제공은 사업자 검수가 필요합니다. 검수 전에는 가입 후
          전화번호 직접 입력 + 문자 인증으로 자동 전환됩니다.
     · 플랫폼 → Web → 사이트 도메인 등록: https://idckorea-dusky.vercel.app

   [구글]  console.cloud.google.com → API 및 서비스 → 사용자 인증 정보
     · OAuth 클라이언트 ID 만들기 → 웹 애플리케이션
     · 승인된 JavaScript 원본:  https://idckorea-dusky.vercel.app
     · 생성된 "클라이언트 ID" 를 아래 GOOGLE_CLIENT_ID 에 붙여넣기

   키가 비어 있으면 로그인 버튼을 눌렀을 때 "어디서 키를 받는지" 안내창이 뜨고,
   그 창의 [체험용으로 계속] 버튼으로 내 가상컴·결제 화면을 미리 점검할 수 있습니다.
   키를 넣는 순간 안내창은 사라지고 진짜 카카오·구글 로그인 창이 뜹니다.

   로그인 이후 흐름
     · 처음 오신 분  → 연락처 확인 + 약관 동의 → 가입 완료
     · 다시 오신 분  → 약관 단계 없이 바로 내 가상컴으로
   ═══════════════════════════════════════════════════════════════ */
/* ★ 이 파일은 예비용입니다.
   실제로는 서버(/api/auth-config)가 Vercel 환경변수에서 키를 내려줍니다.
   서버가 이미 키를 채워줬으면 여기서는 아무것도 하지 않습니다.
   (로컬에서 파일을 직접 열어보실 때만 아래 값이 쓰입니다) */
if (!window.KVC_AUTH || (!window.KVC_AUTH.KAKAO_JS_KEY && !window.KVC_AUTH.GOOGLE_CLIENT_ID)) {
  window.KVC_AUTH = {
    KAKAO_JS_KEY   : '',   // 예: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'
    GOOGLE_CLIENT_ID: '',  // 예: '1234567890-abcdefg.apps.googleusercontent.com'
  };
}
