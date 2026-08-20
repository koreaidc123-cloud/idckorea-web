/* ═══════════════════════════════════════════════════════════════
   문자 발송 — 알리고 (smartsms.aligo.in)

   Vercel 환경변수 세 개가 모두 있어야 켜집니다.
     ALIGO_KEY      알리고 → API 키
     ALIGO_USER_ID  알리고 아이디
     ALIGO_SENDER   사전 등록한 발신번호 (예: 01084468710)

   ★ 발신번호는 알리고에서 서류 심사를 거쳐 등록해야 합니다.
     등록 안 된 번호로는 통신사가 발송 자체를 막습니다.

   ★ 알리고는 EUC-KR 로 보냅니다. 이모지·특수문자는 ? 로 깨지므로
     문구에 넣지 않습니다. 90바이트가 넘으면 알아서 LMS 로 넘어갑니다.
   ═══════════════════════════════════════════════════════════════ */

function ready() {
  return !!(process.env.ALIGO_KEY && process.env.ALIGO_USER_ID && process.env.ALIGO_SENDER);
}

/* 문자 한 통을 보냅니다. 성공하면 true.
   실패해도 예외를 던지지 않습니다 — 문자 때문에 가입·결제가
   멈추면 안 되므로, 부른 쪽이 true/false 만 보고 판단합니다. */
async function send(to, msg) {
  if (!ready()) return false;
  const receiver = String(to || '').replace(/[^\d]/g, '');
  if (!/^01[016789]\d{7,8}$/.test(receiver)) return false;

  try {
    const body = new URLSearchParams({
      key: process.env.ALIGO_KEY,
      user_id: process.env.ALIGO_USER_ID,
      sender: process.env.ALIGO_SENDER,
      receiver,
      msg: String(msg || '').slice(0, 1000),
    });
    const r = await fetch('https://apis.aligo.in/send/', { method: 'POST', body });
    const d = await r.json().catch(() => ({}));
    /* 알리고는 성공이면 result_code 1 을 줍니다 (문자열로 올 때도 있습니다) */
    return Number(d.result_code) === 1;
  } catch (e) {
    return false;
  }
}

module.exports = { ready, send };
