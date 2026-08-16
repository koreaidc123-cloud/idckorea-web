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
  if (Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', kv.signKey()).update(exp).digest('hex');
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
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
  const ok = got.length === pw.length &&
    crypto.timingSafeEqual(Buffer.from(got.padEnd(pw.length)), Buffer.from(pw));

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
