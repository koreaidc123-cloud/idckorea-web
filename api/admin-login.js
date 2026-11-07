/* ═══════════════════════════════════════════════════════════════
   관리자 로그인

   예전 admin.html 은 이 서버가 응답을 못 하면 화면에 적힌 숫자(4060)로 열렸습니다.
   브라우저 소스를 열면 그 숫자가 그대로 보이니 잠금장치가 아니었습니다.
   2026-11-07 그 길을 없앴습니다 — 이제 이 서버가 "맞다" 할 때만 열립니다.

   POST /api/admin-login              { pw }   로그인 (출입증 쿠키 발급)
   POST /api/admin-login?do=logout             로그아웃 (출입증 쿠키 지움)

   그래서 진짜 열쇠는 서버에만 둡니다.
     Vercel 환경변수  KVC_ADMIN_PW      관리자 비밀번호 (길게)
     Vercel 환경변수  KVC_ADMIN_SECRET  서명용 문자열 (아무거나 길게)

   비밀번호가 맞으면 서버가 8시간짜리 출입증(쿠키)을 발급합니다.
   이 쿠키는 httpOnly 라 자바스크립트로 훔칠 수 없습니다.
   ═══════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

const kv = require('./_crypto');
const supa = require('./_supa');

const HOURS = 8;

/* 출입증 만들기: "만료시각.서명" */
function sign(expMs) {
  const h = crypto.createHmac('sha256', kv.signKey()).update(String(expMs)).digest('hex');
  return expMs + '.' + h;
}
/* 출입증 확인 — 서버 어디서든 이 함수로 검사합니다 */
function verify(req) {
  if (!kv.ready()) return false;
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim())
    .find(s => s.startsWith('kvc_adm='));
  if (!raw) return false;
  const [exp, sig] = decodeURIComponent(raw.slice(8)).split('.');
  if (!exp || !sig) return false;
  if (!/^\d{10,16}$/.test(String(exp)) || Number(exp) < Date.now()) return false;  // 만료값은 숫자만
  const want = crypto.createHmac('sha256', kv.signKey()).update(exp).digest('hex');
  /* 글자 수가 같아도 한글 같은 글자가 섞이면 바이트 수가 달라 timingSafeEqual 이
     오류를 냅니다. 바이트로 바꾼 뒤 길이를 비교합니다. */
  const a = Buffer.from(want), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* 비밀번호 비교 — 두 값을 각각 sha256 으로 바꿔(항상 32바이트) 비교합니다.
   ★ 2026-11-07 — 예전엔 글자 수만 같으면 바로 timingSafeEqual 에 넣었는데,
     한글처럼 한 글자가 여러 바이트인 값을 넣으면 길이가 달라 오류(500)가 났고,
     그 시도는 "틀린 횟수" 에도 안 세졌습니다 (자동 대입 잠금을 피해 갈 수 있었음).
     이제 길이가 늘 같아서 오류가 날 수 없고, 틀리면 무조건 셉니다. */
function samePw(got, want) {
  const h = s => crypto.createHash('sha256').update(String(s), 'utf8').digest();
  return crypto.timingSafeEqual(h(got), h(want));
}

/* ── 자동 대입 막기 ────────────────────────────────────────────
   짧은 비밀번호(예: 네 자리)는 프로그램으로 1만 번 시도하면 뚫립니다.
   그래서 같은 곳에서 15분 안에 10번 틀리면 잠급니다.
   사람이 오타로 10번 틀릴 일은 없고, 자동 시도는 사실상 불가능해집니다.
   (15분에 10번 = 하루 960번 = 1만 번 채우는 데 열흘 넘게 걸립니다)

   기록은 이미 있는 view_log 표를 씁니다. IP 는 그대로 남기지 않고
   섞어서(해시) 남기므로, 누가 접속했는지 추적하는 용도로는 쓰이지 않습니다. */
const WINDOW_MIN = 15;
const MAX_FAIL = 10;

function whoHash(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '')
    .split(',')[0].trim() || 'unknown';
  return 'ip:' + crypto.createHmac('sha256', kv.signKey()).update(ip).digest('hex').slice(0, 16);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Cache-Control', 'no-store');

  /* ── 로그아웃 — 출입증 쿠키를 바로 만료시킵니다 (Max-Age=0) ──
     설정이 안 돼 있어도 지우는 건 항상 됩니다. */
  if (String((req.query && req.query.do) || '') === 'logout') {
    res.setHeader('Set-Cookie', 'kvc_adm=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    return res.status(200).json({ ok: true });
  }

  const pw = process.env.KVC_ADMIN_PW || '';
  if (!pw || !kv.ready()) {
    return res.status(503).json({ error: '미설정', hint: 'KVC_ADMIN_PW / KVC_SECRET 을 Vercel 환경변수에 넣어 주세요' });
  }

  const who = whoHash(req);
  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();

  /* 이미 너무 많이 틀렸으면 비밀번호를 확인하지도 않고 돌려보냅니다 */
  if (supa.ready()) {
    try {
      const rows = await supa.sb('view_log', {
        query: `?select=at&act=eq.${encodeURIComponent('관리자 로그인 실패')}` +
               `&who=eq.${encodeURIComponent(who)}&at=gte.${since}&order=at.asc&limit=${MAX_FAIL}`,
      });
      if (rows && rows.length >= MAX_FAIL) {
        const wait = Math.ceil((Date.parse(rows[0].at) + WINDOW_MIN * 60 * 1000 - Date.now()) / 60000);
        return res.status(429).json({
          error: `비밀번호를 여러 번 틀리셨습니다. ${Math.max(1, wait)}분 뒤에 다시 시도해 주세요.`,
        });
      }
    } catch (e) { /* 기록을 못 읽어도 로그인 자체는 막지 않습니다 */ }
  }

  const got = String((req.body || {}).pw || '');
  const ok = samePw(got, pw);

  /* 비밀번호가 틀리면 왜 틀렸는지 알려주지 않습니다 (자동 대입 공격 대비) */
  if (!ok) {
    if (supa.ready()) {
      try {
        await supa.sb('view_log', {
          method: 'POST', prefer: 'return=minimal',
          body: [{ pn: null, act: '관리자 로그인 실패', who }],
        });
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 700));      // 연속 시도를 느리게
    return res.status(401).json({ error: '비밀번호가 맞지 않습니다' });
  }

  const exp = Date.now() + HOURS * 3600 * 1000;
  res.setHeader('Set-Cookie',
    `kvc_adm=${encodeURIComponent(sign(exp))}; Path=/; Max-Age=${HOURS * 3600}; HttpOnly; Secure; SameSite=Strict`);
  res.status(200).json({ ok: true, until: new Date(exp).toISOString() });
};

module.exports.verify = verify;
