/* ═══════════════════════════════════════════════════════════════
   고객 출입증 (httpOnly 쿠키 kvc_cust) — 만들기 · 읽기

   로그인(customer.js)과 주문 만들기(order-create.js)가 함께 씁니다.
   ★ 주문을 만들 때도 이 출입증으로 회원을 찾습니다.
     예전에는 브라우저가 보낸 카카오·구글 번호를 믿었는데, 내 가상컴
     화면이 그 번호를 지워 버려서 주문에 회원이 안 붙었습니다.
     그러면 결제를 해도 내 가상컴에 PC 가 안 보이고 비밀번호도 못 봤습니다.

   ※ 밑줄로 시작하는 파일이라 Vercel 함수 개수(12개 한도)에 세지 않습니다.
   ═══════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const kv = require('./_crypto');

const DAYS = 30;
const DAY = 86400000;

function signKey() {
  return crypto.createHmac('sha256', kv.signKey()).update('kvc-customer').digest();
}
function makeTicket(memberId) {
  const exp = Date.now() + DAYS * DAY;
  const body = `${memberId}.${exp}`;
  const sig = crypto.createHmac('sha256', signKey()).update(body).digest('hex');
  return `${body}.${sig}`;
}
/* 출입증이 진짜면 회원 번호, 아니면 null */
function readTicket(req) {
  if (!kv.ready()) return null;
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim())
    .find(s => s.startsWith('kvc_cust='));
  if (!raw) return null;
  const parts = decodeURIComponent(raw.slice(9)).split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  const want = crypto.createHmac('sha256', signKey()).update(`${id}.${exp}`).digest('hex');
  if (want.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  return id;
}

module.exports = { DAYS, makeTicket, readTicket };
