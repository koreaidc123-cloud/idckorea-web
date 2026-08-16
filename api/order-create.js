/* ═══════════════════════════════════════════════════════════════
   주문 만들기 — 결제창을 띄우기 "전에" 서버가 먼저 주문을 적어둡니다

   흐름
     ① 고객이 상품·기간 선택
     ② 여기로 요청  →  서버가 금액을 계산해서 주문을 저장하고 주문번호를 줍니다
     ③ 그 주문번호·금액으로 토스 결제창을 엽니다
     ④ 결제가 끝나면 /api/toss-confirm 이 ②에서 적어둔 금액과 대조합니다

   ②를 건너뛰면 금액을 고쳐서 결제할 수 있습니다. 그래서 이 단계가 있습니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { quote } = require('./_price');

/* 주문번호: 날짜 + 무작위 — 토스 규격(6~64자, 영숫자·-·_) */
function newOrderId() {
  const d = new Date();
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `KVC${ymd}-${rnd}`;
}

const phoneOk = s => /^01[016789]-?\d{3,4}-?\d{4}$/.test(String(s || '').trim());

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = req.body || {};
  const q = quote(b.specId, b.days);
  if (!q) return res.status(400).json({ error: '상품 또는 이용 기간이 올바르지 않습니다' });

  const name = String(b.name || '').trim().slice(0, 30);
  const phone = String(b.phone || '').trim();
  if (!name) return res.status(400).json({ error: '이름이 필요합니다' });
  if (!phoneOk(phone)) return res.status(400).json({ error: '연락처 형식이 올바르지 않습니다' });

  const orderId = newOrderId();
  const orderName = `${q.name} · ${q.days}일`;

  /* DB 가 아직 없으면 주문번호와 금액만 만들어 돌려줍니다.
     이 경우 결제 승인 때 금액 대조를 할 수 없으므로 테스트 결제만 하셔야 합니다. */
  if (!ready()) {
    return res.status(200).json({ orderId, orderName, amount: q.amount, days: q.days, verified: false });
  }

  try {
    /* 회원 찾기 — 없으면 만듭니다 (전화번호가 고객 식별의 기준입니다) */
    let memberId = null;
    if (b.via && b.socialId) {
      const found = await sb('members', {
        query: `?select=id&via=eq.${encodeURIComponent(b.via)}&social_id=eq.${encodeURIComponent(b.socialId)}&limit=1`,
      });
      if (found && found[0]) memberId = found[0].id;
      else {
        const made = await sb('members', {
          method: 'POST',
          body: [{ via: b.via, social_id: String(b.socialId), name, phone, email: b.email || null }],
          prefer: 'return=representation',
        });
        memberId = made && made[0] ? made[0].id : null;
      }
    }

    const setRows = await sb('settings', { query: '?select=k,v&k=eq.setup_fee' });
    const setupFee = Number((setRows && setRows[0] && setRows[0].v) || 5000);

    await sb('orders', {
      method: 'POST',
      body: [{
        order_id: orderId, member_id: memberId,
        spec_id: q.specId, days: q.days, amount: q.amount, setup_fee: setupFee,
        status: 'ready', user_name: name, user_phone: phone,
      }],
      prefer: 'return=minimal',
    });

    res.status(200).json({ orderId, orderName, amount: q.amount, days: q.days, verified: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
