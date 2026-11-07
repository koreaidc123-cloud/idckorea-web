/* ═══════════════════════════════════════════════════════════════
   토스페이먼츠 웹훅 — 가상계좌 입금을 자동으로 잡는 곳

   ★ 왜 꼭 필요한가
     카드는 결제창에서 바로 끝납니다. 그런데 가상계좌는 다릅니다.
       고객이 계좌를 발급받고 → 창을 닫고 → 몇 시간 뒤에 입금합니다.
     그 순간 우리 홈페이지는 아무것도 모릅니다.
     토스가 "입금됐습니다" 하고 여기를 두드려 줘야
     비로소 PC 를 배정하고 접속 정보를 보낼 수 있습니다.
     이게 없으면 가상계좌 고객은 사람이 일일이 확인해서 열어줘야 합니다.

   등록 방법
     토스 상점관리자 → 개발자센터 → 웹훅
     URL   https://<우리 도메인>/api/toss-webhook
     이벤트 DEPOSIT_CALLBACK (가상계좌 입금)
            PAYMENT_STATUS_CHANGED (결제 취소·환불 등 상태 변경)

   보안 (두 겹)
     ① 웹훅이 뭐라고 하든, 토스에 그 결제를 직접 다시 물어봅니다.
        토스가 답한 상태(입금완료·취소 등)대로만 처리합니다.
     ② 가상계좌 입금 알림은 secret 도 대조합니다.
        토스가 계좌 발급 때 준 secret 을 주문에 저장해 두었다가 비교합니다.
     남이 아무 주문번호나 넣어 "입금됐다"·"취소됐다" 고 속일 수 없게 하는 장치입니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { tossGet, grabPc, releasePc, period } = require('./_pay');

/* ★ 웹훅 내용은 믿지 않습니다 (2026-11-07 결제 점검에서 고침)
     예전에는 누가 이 주소로 {orderId, status:'CANCELED'} 만 보내도
     주문이 환불 처리되고 PC 가 풀렸습니다. secret 을 빼고 보내면
     대조도 건너뛰었고, 카드 결제중 주문에 가짜 DONE 을 보내면 PC 를 받아 갔습니다.
     이제는 웹훅이 오면 "어느 주문인지" 만 보고,
     실제 상태는 토스에 직접 물어서 토스가 답한 대로만 처리합니다. */
module.exports = async (req, res) => {
  /* 토스는 200 을 못 받으면 계속 재시도합니다.
     처리에 실패해도 우리 쪽 잘못이면 500 을 주어 다시 받도록 합니다. */
  if (req.method !== 'POST') return res.status(405).end();
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const b = req.body || {};
  const ev = String(b.eventType || '');
  /* PAYMENT_STATUS_CHANGED 는 data 안에 결제 정보가 있고,
     DEPOSIT_CALLBACK(가상계좌 입금)은 맨 바깥에 orderId·secret 이 있습니다. */
  const d = (b.data && typeof b.data === 'object') ? b.data : b;
  const orderId = String(d.orderId || '').slice(0, 64);
  if (!orderId) return res.status(200).json({ ok: true, skip: 'orderId 없음' });
  /* 가상계좌 입금 알림은 eventType 없이 옵니다 */
  const isDeposit = ev === 'DEPOSIT_CALLBACK' || !ev;

  try {
    const rows = await sb('orders', {
      query: `?select=*&order_id=eq.${encodeURIComponent(orderId)}&limit=1`,
    });
    const order = rows && rows[0];
    /* 우리가 만든 적 없는 주문은 무시합니다 */
    if (!order) return res.status(200).json({ ok: true, skip: '없는 주문' });

    /* ── 가상계좌 입금 알림: secret 대조 ─────────────────────────
       토스가 계좌를 발급할 때 준 secret 을 주문에 저장해 두었습니다.
       저장된 값이 있으면 반드시 같아야 합니다 (빠뜨려도 통과하지 않습니다). */
    if (order.va_secret && (isDeposit || d.secret !== undefined) && String(d.secret || '') !== order.va_secret) {
      return res.status(200).json({ ok: true, skip: 'secret 불일치' });
    }

    /* ── 토스에 직접 물어봅니다 ─────────────────────────────── */
    const t = await tossGet(order.pay_key ? { paymentKey: order.pay_key } : { orderId });
    if (!t.ok) {
      if (t.notFound) return res.status(200).json({ ok: true, skip: '토스에 없는 결제' });
      return res.status(500).json({ error: '토스 조회 실패 — 다시 받겠습니다' });   // 토스가 재시도합니다
    }
    const pay = t.pay || {};
    if (pay.orderId !== orderId) return res.status(200).json({ ok: true, skip: '주문번호 불일치' });
    if (order.pay_key && pay.paymentKey && pay.paymentKey !== order.pay_key) {
      return res.status(200).json({ ok: true, skip: '결제키 불일치' });
    }
    /* 저장된 secret 이 없던 옛 주문 — 토스가 지금 알려준 secret 과라도 대조합니다 */
    if (isDeposit && !order.va_secret && pay.secret && String(d.secret || '') !== pay.secret) {
      return res.status(200).json({ ok: true, skip: 'secret 불일치' });
    }
    const st = pay.status;
    const now = new Date();

    /* ── 결제 취소·환불 (토스가 취소됐다고 답한 경우만) ─────────── */
    if (st === 'CANCELED' || st === 'PARTIAL_CANCELED') {
      /* 이미 처리한 주문이면 아무것도 안 합니다 (관리자 화면에서 환불하면
         토스가 뒤이어 이 웹훅을 보내 줍니다 — 두 번 처리하지 않습니다) */
      if (['canceled', 'refunded', 'expired'].includes(order.status)) {
        return res.status(200).json({ ok: true, skip: '이미 처리됨' });
      }
      const got = await sb('orders', {
        method: 'PATCH',
        query: `?order_id=eq.${encodeURIComponent(orderId)}&status=in.(ready,paid,assigned)&select=order_id`,
        body: { status: 'refunded', canceled_at: now.toISOString(), ends_at: now.toISOString() },
        prefer: 'return=representation',
      });
      /* 쓰던 PC 를 다시 판매 재고로 — 다른 주문이 그 PC 를 쓰고 있으면 그대로 둡니다 */
      let pc = 'none';
      if (got && got[0]) pc = await releasePc(order.pn, orderId, now);
      return res.status(200).json({ ok: true, canceled: orderId, pc });
    }

    /* ── 가상계좌 입금 기한 지남 / 결제 중단 ──────────────────── */
    if (st === 'EXPIRED' || st === 'ABORTED') {
      await sb('orders', {
        method: 'PATCH',
        query: `?order_id=eq.${encodeURIComponent(orderId)}&status=eq.ready`,
        body: { status: 'canceled', canceled_at: now.toISOString() },
        prefer: 'return=minimal',
      });
      return res.status(200).json({ ok: true, expired: orderId });
    }

    /* ── 입금 완료 (또는 카드 결제 완료) ─────────────────────── */
    if (st !== 'DONE') return res.status(200).json({ ok: true, skip: '상태 ' + st });
    if (order.status !== 'ready') return res.status(200).json({ ok: true, skip: '이미 처리됨 (' + order.status + ')' });
    if (Number(pay.totalAmount) !== Number(order.amount)) {
      return res.status(200).json({ ok: true, skip: '금액 불일치' });
    }

    /* 결제중(ready)일 때만 결제완료로 — 결제 승인 화면과 동시에 와도 한 번만 처리됩니다 */
    const per = period(order.days, now);
    const claimed = await sb('orders', {
      method: 'PATCH',
      query: `?order_id=eq.${encodeURIComponent(orderId)}&status=eq.ready&select=order_id`,
      body: {
        status: 'paid',
        pay_key: order.pay_key || pay.paymentKey || null,
        pay_method: order.pay_method || pay.method || null,
        paid_at: now.toISOString(),
        starts_at: per.starts_at,
        ends_at: per.ends_at,
      },
      prefer: 'return=representation',
    });
    if (!(claimed && claimed[0])) return res.status(200).json({ ok: true, skip: '이미 처리됨' });

    /* 같은 사양 중 임대 가능하고 살아있는 PC 한 대를 배정합니다 */
    let pc = null;
    try {
      pc = await grabPc({ specId: order.spec_id, now });
      if (pc) {
        const done = await sb('orders', {
          method: 'PATCH',
          query: `?order_id=eq.${encodeURIComponent(orderId)}&status=eq.paid&select=order_id`,
          body: { status: 'assigned', pn: pc.pn },
          prefer: 'return=representation',
        });
        if (!(done && done[0])) {
          await sb('pcs', { method: 'PATCH', prefer: 'return=minimal',
            query: `?pn=eq.${encodeURIComponent(pc.pn)}&status=eq.rent`,
            body: { status: 'ok', updated_at: new Date().toISOString() } });
          pc = null;
        }
      }
    } catch (e) {
      /* 입금은 확정됐습니다. 배정만 못 한 것이므로 결제완료(배정 대기)로 둡니다.
         관리자 화면에서 배정합니다. 500 을 주면 토스가 다시 보내도 이미
         paid 라 위에서 걸러지므로 200 으로 끝냅니다. */
      pc = null;
    }

    // TODO: 알림톡으로 접속 정보 발송 (배정 실패 시 관리자에게 즉시 알림)

    res.status(200).json({ ok: true, event: ev || 'DEPOSIT', assigned: pc ? pc.pn : null });
  } catch (e) {
    // 500 을 주면 토스가 잠시 뒤 다시 보내줍니다 — 입금 건을 놓치지 않습니다
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
