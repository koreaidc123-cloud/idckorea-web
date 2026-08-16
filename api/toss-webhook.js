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

   보안
     토스는 결제 승인 때 가상계좌마다 secret 값을 줍니다.
     그 값을 주문에 저장해 두었다가, 웹훅이 들고 온 secret 과 대조합니다.
     남이 아무 주문번호나 넣어 "입금됐다"고 속일 수 없게 하는 장치입니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');

module.exports = async (req, res) => {
  /* 토스는 200 을 못 받으면 계속 재시도합니다.
     처리에 실패해도 우리 쪽 잘못이면 500 을 주어 다시 받도록 합니다. */
  if (req.method !== 'POST') return res.status(405).end();
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const b = req.body || {};
  const ev = b.eventType || '';
  const d = b.data || b;
  const orderId = d.orderId;
  if (!orderId) return res.status(200).json({ ok: true, skip: 'orderId 없음' });

  try {
    const rows = await sb('orders', {
      query: `?select=*&order_id=eq.${encodeURIComponent(orderId)}&limit=1`,
    });
    const order = rows && rows[0];
    if (!order) return res.status(200).json({ ok: true, skip: '없는 주문' });

    /* ── 결제 취소·환불 ─────────────────────────────────────── */
    if (d.status === 'CANCELED' || d.status === 'PARTIAL_CANCELED' || d.status === 'EXPIRED') {
      await sb('orders', {
        method: 'PATCH',
        query: `?order_id=eq.${encodeURIComponent(orderId)}`,
        body: { status: d.status === 'EXPIRED' ? 'canceled' : 'refunded', canceled_at: new Date().toISOString() },
        prefer: 'return=minimal',
      });
      // 쓰던 PC 를 다시 판매 재고로 돌립니다
      if (order.pn) {
        await sb('pcs', {
          method: 'PATCH',
          query: `?pn=eq.${encodeURIComponent(order.pn)}&status=eq.rent`,
          body: { status: 'ok', updated_at: new Date().toISOString() },
          prefer: 'return=minimal',
        });
      }
      return res.status(200).json({ ok: true, canceled: orderId });
    }

    /* ── 가상계좌 입금 완료 ─────────────────────────────────── */
    if (d.status !== 'DONE') return res.status(200).json({ ok: true, skip: '상태 ' + d.status });

    // 대조: 우리가 저장해 둔 secret 과 같아야 합니다
    if (order.va_secret && d.secret && order.va_secret !== d.secret) {
      return res.status(200).json({ ok: true, skip: 'secret 불일치' });
    }
    if (order.status === 'assigned') return res.status(200).json({ ok: true, skip: '이미 배정됨' });

    const now = new Date();
    const ends = new Date(now); ends.setDate(ends.getDate() + Number(order.days));

    /* 같은 사양 중 임대 가능하고 살아있는 PC 한 대를 배정합니다.
       online 칸만 보면 신호가 끊긴 PC 도 잡힙니다 — 마지막 신호 시각까지 봅니다. */
    const fresh = new Date(now.getTime() - Number(process.env.KVC_ASSIGN_FRESH_SEC || 420) * 1000).toISOString();
    const cand = await sb('pcs', {
      query: `?select=pn,anydesk&status=eq.ok&online=is.true&last_beat=gte.${fresh}` +
             `&spec_id=eq.${Number(order.spec_id)}&order=updated_at.asc&limit=1`,
    });
    const pc = cand && cand[0];

    if (pc) {
      await sb('pcs', {
        method: 'PATCH',
        query: `?pn=eq.${encodeURIComponent(pc.pn)}&status=eq.ok`,
        body: { status: 'rent', updated_at: now.toISOString() },
        prefer: 'return=minimal',
      });
    }
    await sb('orders', {
      method: 'PATCH',
      query: `?order_id=eq.${encodeURIComponent(orderId)}`,
      body: {
        status: pc ? 'assigned' : 'paid',
        pn: pc ? pc.pn : null,
        paid_at: now.toISOString(),
        starts_at: now.toISOString(),
        ends_at: ends.toISOString(),
      },
      prefer: 'return=minimal',
    });

    // TODO: 솔라피 알림톡으로 접속 정보 발송 (배정 실패 시 관리자에게 즉시 알림)

    res.status(200).json({ ok: true, event: ev, assigned: pc ? pc.pn : null });
  } catch (e) {
    // 500 을 주면 토스가 잠시 뒤 다시 보내줍니다 — 입금 건을 놓치지 않습니다
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
