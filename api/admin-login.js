/* ═══════════════════════════════════════════════════════════════
   관리자 로그인

   지금 admin.html 은 화면에서 숫자 4개(4060)만 맞으면 열립니다.
   그건 "남이 실수로 못 들어오게" 하는 정도이지, 잠금장치가 아닙니다.
   ─ 브라우저 소스를 열면 그 숫자가 그대로 보이기 때문입니다.

   그래서 진짜 열쇠는 서버에만 둡니다.
     Vercel 환경변수  KVC_ADMIN_PW      관리자 비밀번호 (길게)
     Vercel 환경변수  KVC_ADMIN_SECRET  서명용 문자열 (아무거나 길게)

   비밀번호가 맞으면 서버가 8시간짜리 출입증(쿠키)을 발급합니다.
   이 쿠키는 httpOnly 라 자바스크립트로 훔칠 수 없습니다.
   ═══════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

const kv = require('./_crypto');

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
  if (Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', kv.signKey()).update(exp).digest('hex');
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const pw = process.env.KVC_ADMIN_PW || '';
  if (!pw || !kv.ready()) {
    return res.status(503).json({ error: '미설정', hint: 'KVC_ADMIN_PW / KVC_SECRET 을 Vercel 환경변수에 넣어 주세요' });
  }

  const got = String((req.body || {}).pw || '');
  const ok = got.length === pw.length &&
    crypto.timingSafeEqual(Buffer.from(got.padEnd(pw.length)), Buffer.from(pw));

  /* 비밀번호가 틀리면 왜 틀렸는지 알려주지 않습니다 (자동 대입 공격 대비) */
  if (!ok) {
    await new Promise(r => setTimeout(r, 700));      // 연속 시도를 느리게
    return res.status(401).json({ error: '비밀번호가 맞지 않습니다' });
  }

  const exp = Date.now() + HOURS * 3600 * 1000;
  res.setHeader('Set-Cookie',
    `kvc_adm=${encodeURIComponent(sign(exp))}; Path=/; Max-Age=${HOURS * 3600}; HttpOnly; Secure; SameSite=Strict`);
  res.status(200).json({ ok: true, until: new Date(exp).toISOString() });
};

module.exports.verify = verify;
