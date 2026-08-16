/* ═══════════════════════════════════════════════════════════════
   토스페이먼츠 결제 승인 (서버 전용)

   순서가 중요합니다.
     1) 우리 DB 의 주문을 꺼내 금액을 대조합니다   ← 이게 없으면 금액 위변조가 가능합니다
     2) 토스에 승인 요청
     3) 주문을 결제완료로 바꾸고
     4) 조건에 맞는 PC 를 한 대 자동으로 배정합니다
     5) 접속 정보를 고객에게 알립니다  (알림톡 연동 후)

   시크릿 키는 절대 브라우저에 두지 않습니다.
   Vercel → Settings → Environment Variables → TOSS_SECRET_KEY
   아래 기본값은 토스 문서에 공개된 샌드박스 키입니다 (실결제 불가).
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');

const SECRET = process.env.TOSS_SECRET_KEY || 'test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R';
const LIVE_KEY = /^live_sk_/.test(SECRET);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { paymentKey, orderId, amount } = req.body || {};
  if (!paymentKey || !orderId || !amount) {
    return res.status(400).json({ error: 'paymentKey / orderId / amount 가 필요합니다' });
  }
  const paid = Number(amount);

  /* ── 1. 금액 대조 ──────────────────────────────────────────── */
  let order = null;
  if (ready()) {
    try {
      const rows = await sb('orders', {
        query: `?select=*&order_id=eq.${encodeURIComponent(orderId)}&limit=1`,
      });
      order = rows && rows[0];
    } catch (e) {
      return res.status(500).json({ error: '주문 조회 실패', detail: String(e.message || e).slice(0, 200) });
    }

    if (!order) return res.status(400).json({ error: '없는 주문번호입니다' });
    if (order.status === 'paid' || order.status === 'assigned') {
      return res.status(409).json({ error: '이미 결제가 끝난 주문입니다' });
    }
    if (Number(order.amount) !== paid) {
      // 화면에서 올려보낸 금액이 우리가 적어둔 금액과 다르면 승인하지 않습니다
      return res.status(400).json({ error: '결제 금액이 주문 금액과 다릅니다', expected: order.amount, got: paid });
    }
  } else if (LIVE_KEY) {
    // 실결제 키인데 대조할 DB 가 없으면 위험하므로 막습니다
    return res.status(503).json({ error: 'DB 미연결 상태에서는 실결제를 승인하지 않습니다' });
  }

  /* ── 2. 토스 승인 ──────────────────────────────────────────── */
  let data, status;
  try {
    const r = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(SECRET + ':').toString('base64'),
        'Content-Type': 'application/json',
        'Idempotency-Key': orderId,        // 같은 주문이 두 번 승인되는 것을 토스가 막아줍니다
      },
      body: JSON.stringify({ paymentKey, orderId, amount: paid }),
    });
    status = r.status;
    data = await r.json();
  } catch (e) {
    return res.status(500).json({ error: '승인 요청 실패', detail: String(e) });
  }
  if (status !== 200) return res.status(status).json(data);

  /* DB 가 없으면 여기까지 (테스트 결제) */
  if (!ready() || !order) return res.status(200).json(Object.assign({ assigned: null }, data));

  /* ── 가상계좌: 아직 입금 전입니다 ───────────────────────────
     계좌만 발급된 상태이므로 PC 를 배정하면 안 됩니다.
     고객이 실제로 입금하면 토스가 /api/toss-webhook 을 두드려 주고,
     그때 배정합니다. 대조용 secret 을 지금 저장해 둡니다. */
  if (data.status === 'WAITING_FOR_DEPOSIT') {
    try {
      await sb('orders', {
        method: 'PATCH',
        query: `?order_id=eq.${encodeURIComponent(orderId)}`,
        body: {
          status: 'ready', pay_key: paymentKey, pay_method: '가상계좌',
          va_secret: (data.virtualAccount && data.virtualAccount.secret) || null,
          payer_name: (data.virtualAccount && data.virtualAccount.customerName) || null,
        },
        prefer: 'return=minimal',
      });
    } catch (e) { /* 계좌는 이미 발급됐으므로 고객에게는 정상으로 보여줍니다 */ }
    return res.status(200).json(Object.assign({ assigned: null }, data));
  }

  /* ── 3~4. 결제 확정 + PC 자동 배정 ─────────────────────────── */
  const now = new Date();
  const ends = new Date(now); ends.setDate(ends.getDate() + Number(order.days));
  let assigned = null;

  try {
    /* 같은 사양 중에서 임대 가능하고 지금 살아있는 PC 를 한 대 고릅니다.
       오래 쉬고 있던 자리부터 씁니다 (한 대에 몰리지 않게). */
    const cand = await sb('pcs', {
      query: `?select=pn,anydesk,room,rack,fl,slot&status=eq.ok&online=is.true` +
             `&spec_id=eq.${Number(order.spec_id)}&order=updated_at.asc&limit=1`,
    });
    assigned = cand && cand[0] ? cand[0] : null;

    if (assigned) {
      await sb('pcs', {
        method: 'PATCH',
        query: `?pn=eq.${encodeURIComponent(assigned.pn)}&status=eq.ok`,   // 그 사이 남이 가져갔으면 안 바뀝니다
        body: { status: 'rent', updated_at: now.toISOString() },
        prefer: 'return=minimal',
      });
    }

    await sb('orders', {
      method: 'PATCH',
      query: `?order_id=eq.${encodeURIComponent(orderId)}`,
      body: {
        status: assigned ? 'assigned' : 'paid',
        pn: assigned ? assigned.pn : null,
        pay_key: paymentKey,
        pay_method: data.method || null,
        payer_name: (data.card && data.card.ownerType) || (data.virtualAccount && data.virtualAccount.customerName) || null,
        paid_at: now.toISOString(),
        starts_at: now.toISOString(),
        ends_at: ends.toISOString(),
      },
      prefer: 'return=minimal',
    });
  } catch (e) {
    /* 결제는 이미 승인됐습니다. 배정만 실패한 것이므로 고객에게 실패라고 하면 안 됩니다.
       관리자 "오늘 할 일"에 뜨도록 주문은 paid 로 남기고, 사람이 배정합니다. */
    return res.status(200).json(Object.assign({
      assigned: null,
      warn: '결제는 완료됐지만 자동 배정에 실패했습니다. 관리자가 곧 배정합니다.',
    }, data));
  }

  /* ── 5. 고객에게 알리기 ────────────────────────────────────── */
  // TODO: 솔라피 알림톡 연동 후 여기서 접속 정보를 발송합니다.
  //       애니데스크 비밀번호는 이 응답에 담지 않습니다 — 마이페이지에서만 보여줍니다.

  res.status(200).json(Object.assign({
    assigned: assigned ? { pn: assigned.pn, anydesk: assigned.anydesk } : null,
    endsAt: ends.toISOString(),
  }, data));
};
