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
const { tossSecret, tossAuth, tossGet, grabPc, period, applyExtension, logExtFail } = require('./_pay');

const LIVE_KEY = () => /^live_sk_/.test(tossSecret());

/* 가상계좌 웹훅 대조값 — 토스 결제 정보의 맨 바깥(secret)에 들어 있습니다.
   예전에는 virtualAccount 안에서 찾아서 늘 빈 값이 저장됐습니다. */
const vaSecretOf = d => (d && (d.secret || (d.virtualAccount && d.virtualAccount.secret))) || null;

/* 연장 결제는 됐는데 기간을 못 늘렸을 때 고객에게 보여줄 말 (자동 환불은 하지 않습니다) */
const EXT_WAIT = '결제 완료 — 담당자가 곧 연락드립니다';

/* ── 이미 처리된 주문 — 지금 상태를 그대로 돌려줍니다 ─────────────
   결제 성공 화면을 새로고침하거나, 승인 요청이 두 번 들어오면 여기로 옵니다.
   예전에는 "이미 결제가 끝난 주문입니다" 오류가 떠서 고객이 결제가
   실패한 줄 알았습니다. 이제는 배정된 PC 를 다시 보여줍니다. */
async function existing(orderId, paymentKey) {
  const rows = await sb('orders', {
    query: `?select=*,pcs(pn,anydesk)&order_id=eq.${encodeURIComponent(orderId)}&limit=1`,
  });
  const o = rows && rows[0];
  if (!o) return { code: 400, body: { error: '없는 주문번호입니다' } };
  if (o.pay_key && o.pay_key !== paymentKey) {
    return { code: 409, body: { error: '이미 다른 결제로 처리된 주문입니다' } };
  }
  const t = await tossGet({ paymentKey });
  const pay = (t.ok && t.pay.orderId === orderId) ? t.pay : {
    /* 토스에 못 물어봤으면 우리 기록으로 대신 보여줍니다 */
    status: (o.status === 'paid' || o.status === 'assigned') ? 'DONE' : 'UNKNOWN',
    totalAmount: o.amount, method: o.pay_method || null, orderId,
  };
  /* 연장 결제 — 새 PC 가 아니라 "같은 PC · 새 만료일" 을 보여줍니다 (2026-11-08) */
  if (o.kind === 'extend') {
    const ext = o.status === 'applied'
      ? { extended: true, pn: o.pn, endsAt: o.ext_to || o.ends_at || null }
      : o.status === 'paid' ? { extended: false, extendFailed: true, warn: EXT_WAIT } : { extended: false };
    return { code: 200, body: Object.assign({ assigned: null, again: true }, ext, pay) };
  }
  const pc = o.status === 'assigned' && o.pn ? { pn: o.pn, anydesk: (o.pcs && o.pcs.anydesk) || '' } : null;
  return { code: 200, body: Object.assign({ assigned: pc, endsAt: o.ends_at || null, again: true }, pay) };
}

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

    /* 이미 이 결제로 처리된 주문 (새로고침·중복 요청) → 지금 상태를 보여줍니다 */
    if (order.pay_key && order.pay_key === paymentKey) {
      try {
        const x = await existing(orderId, paymentKey);
        return res.status(x.code).json(x.body);
      } catch (e) {
        return res.status(500).json({ error: '주문 조회 실패' });
      }
    }
    if (order.status !== 'ready') {
      return res.status(409).json({ error: '이미 처리가 끝난 주문입니다. 내 가상컴에서 확인해 주세요' });
    }
    if (Number(order.amount) !== paid) {
      // 화면에서 올려보낸 금액이 우리가 적어둔 금액과 다르면 승인하지 않습니다
      return res.status(400).json({ error: '결제 금액이 주문 금액과 다릅니다', expected: order.amount, got: paid });
    }
  } else if (LIVE_KEY()) {
    // 실결제 키인데 대조할 DB 가 없으면 위험하므로 막습니다
    return res.status(503).json({ error: 'DB 미연결 상태에서는 실결제를 승인하지 않습니다' });
  }

  /* ── 2. 토스 승인 ──────────────────────────────────────────── */
  let data, status;
  try {
    const r = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        Authorization: tossAuth(),
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
  if (status !== 200) {
    /* 이미 승인된 결제 (두 요청이 거의 동시에 온 경우) — 토스에 다시 물어 이어갑니다 */
    if (data && data.code === 'ALREADY_PROCESSED_PAYMENT') {
      const t = await tossGet({ paymentKey });
      /* 주문번호·결제키·금액이 모두 맞을 때만 이어갑니다 (Codex 검토) */
      if (t.ok && t.pay.orderId === orderId && t.pay.paymentKey === paymentKey &&
          Number(t.pay.totalAmount) === Number(paid)) { data = t.pay; status = 200; }
    }
    if (status !== 200) return res.status(status).json(data);
  }

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
        query: `?order_id=eq.${encodeURIComponent(orderId)}&status=eq.ready`,
        body: {
          pay_key: paymentKey, pay_method: '가상계좌',
          va_secret: vaSecretOf(data),
          payer_name: (data.virtualAccount && data.virtualAccount.customerName) || null,
        },
        prefer: 'return=minimal',
      });
    } catch (e) { /* 계좌는 이미 발급됐으므로 고객에게는 정상으로 보여줍니다 */ }
    return res.status(200).json(Object.assign({ assigned: null }, data));
  }
  if (data.status !== 'DONE') return res.status(200).json(Object.assign({ assigned: null }, data));

  /* ── 3. 결제 확정 — 이 주문을 "내가 처리한다" 고 먼저 찜합니다 ──
     ★ 결제중(ready)일 때만 결제완료(paid)로 바뀌게 조건을 겁니다.
       같은 주문의 승인이 두 번 동시에 들어오거나 토스 웹훅이 먼저 도착해도
       딱 한 쪽만 통과합니다. 예전에는 둘 다 통과해서 PC 를 두 대 잡을 수 있었습니다.
     ★ 결제는 이미 승인됐으므로, 여기부터는 실패해도 고객에게 실패라고 하지 않습니다. */
  const now = new Date();
  const per = period(order.days, now);
  const isExt = order.kind === 'extend';
  let assigned = null;
  try {
    const claimBody = {
      status: 'paid',
      pay_key: paymentKey,
      pay_method: data.method || null,
      payer_name: (data.card && data.card.ownerType) || null,
      paid_at: now.toISOString(),
    };
    /* 연장 결제는 기간을 여기서 정하지 않습니다 — apply_extension 이 원 주문 끝 뒤에 붙여 정합니다 */
    if (!isExt) { claimBody.starts_at = per.starts_at; claimBody.ends_at = per.ends_at; }
    const claimed = await sb('orders', {
      method: 'PATCH',
      query: `?order_id=eq.${encodeURIComponent(orderId)}&status=eq.ready&select=order_id`,
      body: claimBody,
      prefer: 'return=representation',
    });
    if (!(claimed && claimed[0])) {
      /* 다른 요청(또는 웹훅)이 이미 처리했습니다 — 그 결과를 보여줍니다 */
      const x = await existing(orderId, paymentKey);
      return res.status(x.code).json(x.body);
    }

    /* ── 4'. 연장 결제 — PC 를 새로 잡지 않고 같은 PC 의 기간을 늘립니다 (2026-11-08) ──
       못 늘렸으면(그 사이 PC 가 초기화 대기로 넘어감 등) 결제완료(paid)로 남깁니다.
       관리자 [오늘 할 일] 에 "연장 결제 — 원래 PC 반납됨" 으로 뜹니다. 자동 환불은 하지 않습니다. */
    if (isExt) {
      const r = await applyExtension(orderId);
      if (r.ok && !r.skip) {
        return res.status(200).json(Object.assign({ assigned: null, extended: true, pn: r.pn, endsAt: r.endsAt }, data));
      }
      if (r.ok && r.skip) {
        const x = await existing(orderId, paymentKey);
        return res.status(x.code).json(x.body);
      }
      await logExtFail(orderId, r, '결제 승인');
      return res.status(200).json(Object.assign({ assigned: null, extended: false, extendFailed: true, warn: EXT_WAIT }, data));
    }

    /* ── 4. PC 자동 배정 ──────────────────────────────────────
       같은 사양 중 지금 살아있고 임대 가능한 PC 를 한 대 잡습니다.
       고객이 목록에서 고른 PC(wantPn)가 있으면 그것부터 봅니다. */
    assigned = await grabPc({ specId: order.spec_id, wantPn: (req.body || {}).wantPn, now });

    if (assigned) {
      const done = await sb('orders', {
        method: 'PATCH',
        query: `?order_id=eq.${encodeURIComponent(orderId)}&status=eq.paid&select=order_id`,
        body: { status: 'assigned', pn: assigned.pn },
        prefer: 'return=representation',
      });
      if (!(done && done[0])) {
        /* 그 사이 관리자가 손으로 배정했거나 취소됐습니다 — 잡은 PC 는 놓아줍니다 */
        await sb('pcs', {
          method: 'PATCH', prefer: 'return=minimal',
          query: `?pn=eq.${encodeURIComponent(assigned.pn)}&status=eq.rent`,
          body: { status: 'ok', updated_at: new Date().toISOString() },
        });
        const x = await existing(orderId, paymentKey);
        return res.status(x.code).json(x.body);
      }
    }
    /* 한 대도 못 잡으면 결제완료(paid)·미배정으로 남습니다.
       관리자 화면 [오늘 할 일] 과 주문 상세에 "배정 대기" 로 뜨고, 거기서 배정합니다. */
  } catch (e) {
    return res.status(200).json(Object.assign({
      assigned: null,
      warn: '결제는 완료됐지만 자동 배정에 실패했습니다. 관리자가 곧 배정합니다.',
    }, data));
  }

  /* ── 5. 고객에게 알리기 ────────────────────────────────────── */
  // TODO: 알림톡 연동 후 여기서 접속 정보를 발송합니다.
  //       애니데스크 비밀번호는 이 응답에 담지 않습니다 — 마이페이지에서만 보여줍니다.

  res.status(200).json(Object.assign({
    assigned: assigned ? { pn: assigned.pn, anydesk: assigned.anydesk } : null,
    endsAt: per.ends_at,
  }, data));
};
