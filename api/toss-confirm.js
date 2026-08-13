// 토스페이먼츠 결제 승인 (서버 전용)
// 시크릿 키는 절대 브라우저에 두지 않는다.
// 실서비스 전환: Vercel → Settings → Environment Variables 에 TOSS_SECRET_KEY 등록만 하면 됨.
// 아래 기본값은 토스 공식 문서에 공개된 샌드박스 키 (실결제 불가, 누구나 사용 가능).
const SECRET = process.env.TOSS_SECRET_KEY || 'test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const { paymentKey, orderId, amount } = req.body || {};
  if (!paymentKey || !orderId || !amount) {
    res.status(400).json({ error: 'paymentKey / orderId / amount 가 필요합니다' });
    return;
  }
  try {
    const r = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(SECRET + ':').toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    const data = await r.json();
    // 실서비스에서는 여기서: 주문 검증 → PC 자동 배정 → 접속정보 발급 → 알림톡/문자 발송
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: '승인 요청 실패', detail: String(e) });
  }
};
