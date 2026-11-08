/* ═══════════════════════════════════════════════════════════════
   연결 진단 — 브라우저에서 그냥 열어보면 됩니다.

     https://<우리 도메인>/api/health

   환경변수를 넣은 뒤 이 주소를 열어서 전부 ok 인지 확인합니다.
   무엇이 빠졌는지 한글로 알려주므로, 뭐가 안 되는지 헤맬 일이 없습니다.

   ※ 이 주소는 누구나 열 수 있습니다. 그래서 키는 "있다/없다"만 보여주고
     앞 글자나 길이도 보여주지 않습니다. (2026-11 보안 점검 반영)
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
/* 관리자가 몇 명 등록됐는지만 셉니다 (비밀번호는 읽어 오지 않습니다) — 2026-11-08 관리자별 비밀번호 */
const { adminCount } = require('./admin-login');
/* AI 허브 마지막 수집 결과 (settings 표의 hub_last_collect) — 2026-11-08 */
const { lastCollect } = require('./_hub');

const mask = v => (v ? '등록됨' : null);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY || '',
    KVC_SETUP_KEY: process.env.KVC_SETUP_KEY || '',
    KVC_ADMIN_PW: process.env.KVC_ADMIN_PW || '',
    KVC_SECRET: process.env.KVC_SECRET || process.env.KVC_ADMIN_SECRET || '',
    TOSS_SECRET_KEY: process.env.TOSS_SECRET_KEY || '',
    TOSS_CLIENT_KEY: process.env.TOSS_CLIENT_KEY || '',
    KAKAO_JS_KEY: process.env.KAKAO_JS_KEY || '',
    KAKAO_REST_KEY: process.env.KAKAO_REST_KEY || '',
    KAKAO_APP_ID: process.env.KAKAO_APP_ID || '',
    KAKAO_CLIENT_SECRET: process.env.KAKAO_CLIENT_SECRET || '',
    NAVER_CLIENT_ID: process.env.NAVER_CLIENT_ID || '',
    NAVER_CLIENT_SECRET: process.env.NAVER_CLIENT_SECRET || '',
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
    ALIGO_KEY: process.env.ALIGO_KEY || '',
    ALIGO_USER_ID: process.env.ALIGO_USER_ID || '',
    ALIGO_SENDER: process.env.ALIGO_SENDER || '',
  };

  /* 로그인 화면 주소 — 카카오 Redirect URI · 네이버 Callback URL 로 똑같이 등록합니다 */
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] ||
    (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https')).split(',')[0].trim();
  const loginUrl = host ? `${proto}://${host}/login` : '';
  const kakaoMissing = ['KAKAO_JS_KEY', 'KAKAO_REST_KEY'].filter(k => !env[k]);
  const naverMissing = ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET'].filter(k => !env[k]);

  const 환경변수 = {
    'Supabase 주소': env.SUPABASE_URL
      ? '✅ 등록됨'
      : '❌ 없음',
    'Supabase 키': env.SUPABASE_SERVICE_KEY
      ? '✅ ' + mask(env.SUPABASE_SERVICE_KEY) +
        (/^sb_secret_/.test(env.SUPABASE_SERVICE_KEY) ? ' (새 형식 secret)'
         : /^sb_publishable_/.test(env.SUPABASE_SERVICE_KEY) ? ' ⚠️ publishable 키입니다 — secret 키로 바꾸세요'
         : /^eyJ/.test(env.SUPABASE_SERVICE_KEY) ? ' (옛 형식 JWT)'
         : ' ⚠️ 형식을 알 수 없습니다')
      : '❌ 없음',
    'Supabase 공개키': env.SUPABASE_PUBLISHABLE_KEY
      ? (/^sb_publishable_/.test(env.SUPABASE_PUBLISHABLE_KEY)
          ? '✅ ' + mask(env.SUPABASE_PUBLISHABLE_KEY)
          : '⚠️ publishable 키가 아닙니다 — sb_publishable_ 로 시작해야 합니다')
      : '❌ 없음 — 랙PC 를 등록할 수 없습니다',
    '현장 등록 암호': env.KVC_SETUP_KEY ? '✅ ' + mask(env.KVC_SETUP_KEY) : '❌ 없음 — 랙PC 를 등록할 수 없습니다',
    '관리자 비밀번호': adminCount()
      ? '✅ 등록됨 (' + adminCount() + '명)'
      : '❌ 없음 — 관리자 화면이 인터넷에 열려 있습니다',
    '비밀번호 잠금키': env.KVC_SECRET
      ? '✅ 등록됨 (애니데스크 비밀번호 암호화용)'
      : '❌ 없음 — 애니데스크 비밀번호를 보관할 수 없습니다',
    '토스 시크릿키': env.TOSS_SECRET_KEY
      ? (/^live_sk_/.test(env.TOSS_SECRET_KEY) ? '✅ 실결제 키' : '⚠️ 테스트 키 (실결제 불가)')
      : '⚠️ 미등록 (기본 테스트 키로 동작)',
    /* 시크릿 키만 라이브로 바꾸고 클라이언트 키를 그대로 두면 결제창이
       테스트로 떠서 승인 단계에서 어긋납니다. 둘은 항상 짝이어야 합니다. */
    '토스 클라이언트키': env.TOSS_CLIENT_KEY
      ? (/^live_ck_/.test(env.TOSS_CLIENT_KEY) ? '✅ 실결제 키'
         : /^test_ck_/.test(env.TOSS_CLIENT_KEY) ? '⚠️ 테스트 키 (실결제 불가)'
         : '❌ 형식이 이상합니다 — test_ck_ 또는 live_ck_ 로 시작해야 합니다')
      : '⚠️ 미등록 (코드에 든 샌드박스 키로 동작)',
    /* 카카오는 JavaScript 키 + REST API 키가 둘 다 있어야 켜집니다 (2026-11-08 공식 v2 방식).
       빠진 것의 "이름" 만 보여 주고 값은 절대 보여 주지 않습니다. */
    '카카오 로그인': kakaoMissing.length
      ? '❌ 꺼짐 — 빠진 환경변수: ' + kakaoMissing.join(', ')
      : (env.KAKAO_JS_KEY.length > 40 ? '❌ KAKAO_JS_KEY 가 JavaScript 키가 아닌 것 같습니다' : '✅ 켜짐'),
    '카카오 앱 확인 (KAKAO_APP_ID)': env.KAKAO_APP_ID
      ? '✅ 등록됨 — 우리 앱에서 나온 로그인만 받습니다'
      : '⚠️ 미등록 — 넣어 두시면 다른 앱의 카카오 토큰을 확실히 막습니다 (앱 키 화면의 앱 ID 숫자)',
    '카카오 Client Secret': env.KAKAO_CLIENT_SECRET ? '✅ 등록됨' : '선택 — 카카오에서 Client Secret 을 켜셨을 때만 필요합니다',
    '카카오 Redirect URI (카카오에 등록할 주소)': loginUrl || '확인 필요',
    '네이버 로그인': naverMissing.length
      ? '❌ 꺼짐 — 빠진 환경변수: ' + naverMissing.join(', ')
      : '✅ 켜짐 (네이버 검수 전에는 네이버 개발자센터에 등록한 아이디만 로그인됩니다)',
    '네이버 Callback URL (네이버에 등록할 주소)': loginUrl || '확인 필요',
    '구글 로그인': env.GOOGLE_CLIENT_ID
      ? (/\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID)
          ? '✅ 켜짐 (구글 콘솔의 [승인된 JavaScript 원본] 에 이 사이트 주소가 있어야 실제로 됩니다)'
          : '❌ .apps.googleusercontent.com 으로 끝나야 합니다')
      : '❌ 꺼짐 — GOOGLE_CLIENT_ID 가 없습니다',
    '문자 발송 (알리고)': (env.ALIGO_KEY && env.ALIGO_USER_ID && env.ALIGO_SENDER)
      ? '✅ 켜짐 · 발신번호 ' + env.ALIGO_SENDER
      : (env.ALIGO_KEY || env.ALIGO_USER_ID || env.ALIGO_SENDER)
        ? '⚠️ 일부만 등록됨 — ALIGO_KEY · ALIGO_USER_ID · ALIGO_SENDER 셋 다 필요합니다'
        : '⚠️ 미등록 — 접속정보 문자·만료 안내가 나가지 않습니다',
    /* AI 허브 (2026-11-08) — 있다/없다만 보여 줍니다. 값·길이는 절대 내보내지 않습니다 */
    'AI 허브 매일 수집 (CRON_SECRET)': process.env.CRON_SECRET
      ? '✅ 등록됨 — Vercel 크론이 매일 아침 6시(한국)에 뉴스·유튜브를 모읍니다'
      : '⚠️ 미등록 — 매일 자동 수집이 거절됩니다 (관리자 화면 [지금 수집] 은 됩니다)',
    'AI 허브 브리핑 올리기 (HUB_TOKEN)': process.env.HUB_TOKEN
      ? '✅ 등록됨 — AI 본부가 초안을 올릴 수 있습니다 (게시는 관리자만)'
      : '⚠️ 미등록 — AI 본부 브리핑 초안을 받을 수 없습니다',
  };

  const 데이터베이스 = {};
  if (!ready()) {
    데이터베이스.상태 = '❌ 연결 안 됨 — Supabase 주소와 키를 먼저 넣어 주세요';
  } else {
    const 표 = ['pcs', 'pcs_unregistered', 'members', 'orders', 'settings', 'view_log'];
    let 성공 = 0;
    for (const t of 표) {
      try {
        // 개수만 세어 봅니다. 실제 데이터는 가져오지 않습니다.
        const r = await sb(t, { query: '?select=*&limit=0', prefer: 'count=exact' });
        데이터베이스[t] = '✅ 있음';
        성공++;
      } catch (e) {
        const m = String(e.message || e);
        데이터베이스[t] = m.includes('does not exist') || m.includes('PGRST205')
          ? '❌ 표가 없습니다 — db/schema.sql 을 실행해 주세요'
          : '❌ ' + m.slice(0, 120);
      }
    }
    데이터베이스.상태 = 성공 === 표.length ? '✅ 정상 (표 6개 모두 확인)' : `⚠️ 표 ${성공}/${표.length}개만 확인됨`;

    /* 하트비트 접수 창구가 살아 있는지 — 가짜 토큰을 넣어 거절되는지 봅니다.
       DENIED 가 돌아오면 정상입니다. */
    try {
      const r = await sb('rpc/beat', {
        method: 'POST',
        body: { p_pn: 'Z-999', p_token: 'health-check-fake-token-000' },
      });
      데이터베이스['하트비트 창구'] = r === 'DENIED'
        ? '✅ 정상 (가짜 토큰을 제대로 거절함)'
        : '⚠️ 예상 밖 응답: ' + JSON.stringify(r).slice(0, 60);
    } catch (e) {
      const m = String(e.message || e);
      데이터베이스['하트비트 창구'] = /PGRST202|does not exist|Could not find/.test(m)
        ? '❌ 없습니다 — db/02-heartbeat.sql 을 실행해 주세요'
        : '❌ ' + m.slice(0, 120);
    }
  }

  /* DB 업데이트(db/08~10) 실행 여부 — 열·표가 있는지만 봅니다. 데이터는 읽지 않습니다 (2026-11-09) */
  const DB업데이트 = {};
  if (ready()) {
    for (const [name, t, col] of [
      ['db/08-반납초기화.sql', 'orders', 'refund_state'],
      ['db/09-자동알림.sql', 'alert_state', '*'],
      ['db/10-연장결제.sql', 'orders', 'kind,parent_id'],
    ]) {
      try { await sb(t, { query: '?select=' + col + '&limit=0' }); DB업데이트[name] = '✅ 실행됨'; }
      catch (e) {
        const m = String(e.message || e);
        DB업데이트[name] = /does not exist|PGRST20[45]|42P01|42703/.test(m) ? '❌ 아직 실행 안 함' : '❌ ' + m.slice(0, 120);
      }
    }
  }

  /* AI 허브 표 3개 · 마지막 수집 시각 (2026-11-08) — 위 6개 표와 따로 셉니다 (db/11 은 나중에 돌려도 됨) */
  const AI허브 = {};
  if (ready()) {
    let 있음 = 0;
    for (const t of ['hub_sources', 'hub_items', 'hub_briefs']) {
      try { await sb(t, { query: '?select=*&limit=0' }); AI허브[t] = '✅ 있음'; 있음++; }
      catch (e) {
        const m = String(e.message || e);
        AI허브[t] = /does not exist|PGRST205|42P01/.test(m) ? '❌ 없음 — db/11-AI허브.sql 을 실행해 주세요' : '❌ ' + m.slice(0, 120);
      }
    }
    AI허브.상태 = 있음 === 3 ? '✅ 표 3개 모두 있음' : '⚠️ 표 ' + 있음 + '/3 — db/11-AI허브.sql 을 실행해 주세요';
    const last = 있음 === 3 ? await lastCollect() : null;
    AI허브['마지막 수집'] = last && last.at
      ? new Date(last.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' · 저장 ' + (last.saved || 0) + '건 · 출처 오류 ' + (last.errorCount != null ? last.errorCount : (last.errors || []).length) + '곳'
      : '아직 없음';
  } else AI허브.상태 = '❌ 데이터베이스 연결 전';

  const 다음할일 = [];
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) 다음할일.push('Vercel 환경변수에 SUPABASE_URL / SUPABASE_SERVICE_KEY 등록 후 Redeploy');
  if (ready() && 데이터베이스.상태 && 데이터베이스.상태.startsWith('⚠️')) 다음할일.push('Supabase SQL Editor 에서 db/schema.sql 실행');
  if (!env.SUPABASE_PUBLISHABLE_KEY) 다음할일.push('SUPABASE_PUBLISHABLE_KEY 등록 (Supabase → API Keys → Publishable key)');
  if (!env.KVC_SETUP_KEY) 다음할일.push('KVC_SETUP_KEY 등록 (현장에서 랙PC 설치할 때 입력할 암호)');
  if (!adminCount()) 다음할일.push('KVC_ADMINS (또는 KVC_ADMIN_PW) 등록 (관리자 화면 자물쇠 — 없으면 누구나 고객 접속정보를 봅니다)');
  if (!env.KVC_SECRET) 다음할일.push('KVC_SECRET 등록 (애니데스크 비밀번호 암호화용)');
  for (const [k, v] of Object.entries(DB업데이트)) if (v.startsWith('❌')) 다음할일.push('Supabase SQL Editor 에서 ' + k + ' 실행 (07 → 08 → 09 → 10 순서)');
  if (AI허브.상태 && AI허브.상태.startsWith('⚠️')) 다음할일.push('Supabase SQL Editor 에서 db/11-AI허브.sql 실행');
  if (!다음할일.length) 다음할일.push('모두 정상입니다. 현장에서 중계기·에이전트를 설치하시면 됩니다.');

  res.status(200).json({
    확인시각: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    환경변수,
    데이터베이스,
    AI허브,
    DB업데이트,
    다음할일,
  });
};
