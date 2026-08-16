/* ═══════════════════════════════════════════════════════════════
   연결 진단 — 브라우저에서 그냥 열어보면 됩니다.

     https://<우리 도메인>/api/health

   환경변수를 넣은 뒤 이 주소를 열어서 전부 ok 인지 확인합니다.
   무엇이 빠졌는지 한글로 알려주므로, 뭐가 안 되는지 헤맬 일이 없습니다.

   ※ 키 값 자체는 절대 보여주지 않습니다. "있다/없다"와 앞 8글자만 보여줍니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');

const mask = v => (v ? v.slice(0, 8) + '…(' + v.length + '자)' : null);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
    KVC_RELAY_KEY: process.env.KVC_RELAY_KEY || '',
    KVC_ADMIN_PW: process.env.KVC_ADMIN_PW || '',
    KVC_ADMIN_SECRET: process.env.KVC_ADMIN_SECRET || '',
    TOSS_SECRET_KEY: process.env.TOSS_SECRET_KEY || '',
  };

  const 환경변수 = {
    'Supabase 주소': env.SUPABASE_URL ? '✅ ' + env.SUPABASE_URL : '❌ 없음',
    'Supabase 키': env.SUPABASE_SERVICE_KEY
      ? '✅ ' + mask(env.SUPABASE_SERVICE_KEY) +
        (/^sb_secret_/.test(env.SUPABASE_SERVICE_KEY) ? ' (새 형식 secret)'
         : /^sb_publishable_/.test(env.SUPABASE_SERVICE_KEY) ? ' ⚠️ publishable 키입니다 — secret 키로 바꾸세요'
         : /^eyJ/.test(env.SUPABASE_SERVICE_KEY) ? ' (옛 형식 JWT)'
         : ' ⚠️ 형식을 알 수 없습니다')
      : '❌ 없음',
    '중계기 암호': env.KVC_RELAY_KEY ? '✅ ' + mask(env.KVC_RELAY_KEY) : '❌ 없음 — 하트비트를 받을 수 없습니다',
    '관리자 비밀번호': env.KVC_ADMIN_PW ? '✅ 등록됨' : '❌ 없음 — 관리자가 목업으로 동작합니다',
    '관리자 서명키': env.KVC_ADMIN_SECRET ? '✅ 등록됨' : '❌ 없음',
    '토스 시크릿키': env.TOSS_SECRET_KEY
      ? (/^live_sk_/.test(env.TOSS_SECRET_KEY) ? '✅ 실결제 키' : '⚠️ 테스트 키 (실결제 불가)')
      : '⚠️ 미등록 (기본 테스트 키로 동작)',
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
  }

  const 다음할일 = [];
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) 다음할일.push('Vercel 환경변수에 SUPABASE_URL / SUPABASE_SERVICE_KEY 등록 후 Redeploy');
  if (ready() && 데이터베이스.상태 && 데이터베이스.상태.startsWith('⚠️')) 다음할일.push('Supabase SQL Editor 에서 db/schema.sql 실행');
  if (!env.KVC_RELAY_KEY) 다음할일.push('KVC_RELAY_KEY 등록 (현장 중계기 설치 때 같은 값을 입력합니다)');
  if (!env.KVC_ADMIN_PW || !env.KVC_ADMIN_SECRET) 다음할일.push('KVC_ADMIN_PW / KVC_ADMIN_SECRET 등록');
  if (!다음할일.length) 다음할일.push('모두 정상입니다. 현장에서 중계기·에이전트를 설치하시면 됩니다.');

  res.status(200).json({
    확인시각: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    환경변수,
    데이터베이스,
    다음할일,
  });
};
