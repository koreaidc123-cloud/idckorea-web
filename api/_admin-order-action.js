/* ═══════════════════════════════════════════════════════════════
   주문 처리 — 연장 · 해지환불 · PC 이전 · 세금계산서

   POST /api/order-action   (관리자 로그인 필요)
   { no:"MAN260816-ABC", act:"extend"|"cancel"|"move"|"tax", ... }

   act = extend  기간 연장      { days:30, amount:65000, payMethod:"계좌이체" }
   act = cancel  해지·환불      { refund:12000, why:"고객 요청", force:false }
   act = move    PC 이전        { toPn:"Y-055", why:"그래픽카드 고장" }
   act = tax     세금계산서 요청 { bizNo:"123-45-67890" }

   ★ 환불 규정 (대표님이 정하신 것)
       7일 이내 — 초기 셋팅비 5,000원 + 쓰신 기간을 뺀 나머지 환불
       7일 이후 — 환불 불가
     서버가 이 규칙대로 금액을 계산해 알려줍니다.
     관리자가 다른 금액을 넣으면 그 사실이 기록에 남습니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify } = require('./admin-login');

const DAY = 86400000;
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null) || null;

/* 환불 금액 계산 — 화면에서도 같은 값을 보여줄 수 있게 따로 뺐습니다 */
function refundQuote(order, setupFee, at) {
  const start = order.starts_at ? Date.parse(order.starts_at) : Date.parse(order.paid_at || 0);
  const used = Math.max(1, Math.ceil((at - start) / DAY));          // 하루라도 쓰면 1일
  const perDay = order.days > 0 ? order.amount / order.days : 0;
  const rule = used <= 7 ? '7일 이내' : '7일 초과';
  if (used > 7) {
    return { used, perDay: Math.round(perDay), setupFee, refund: 0, rule, allowed: false };
  }
  const refund = Math.max(0, Math.floor(order.amount - setupFee - perDay * used));
  return { used, perDay: Math.round(perDay), setupFee, refund, rule, allowed: true };
}

/* ═══ 토스에 실제 취소를 요청합니다 ═══════════════════════════════

   ★ 왜 필요한가
     예전에는 데이터베이스에만 "환불됨" 이라고 적었습니다. 화면에는 환불이
     끝난 것처럼 보이는데 고객 카드로는 돈이 돌아가지 않았습니다.
     관리자가 토스 콘솔에서 따로 눌러야 했고, 잊으면 그대로 민원이 됩니다.

   ★ 순서
     토스가 성공한 뒤에 데이터베이스를 고칩니다. 반대로 하면
     "환불됨인데 돈은 그대로" 인 상태가 또 생깁니다.

   ★ 토스로 결제하지 않은 주문
     계좌이체·무통장으로 받아 관리자가 직접 등록한 주문은 취소할 대상이
     없습니다. 이때는 건너뛰고 "직접 送金하셔야 합니다" 라고 알려 줍니다.

   ★ 가상계좌
     카드와 달리 돌려받을 통장을 토스에 같이 알려줘야 취소됩니다.
     없으면 관리자에게 물어봅니다.
   ═══════════════════════════════════════════════════════════════ */
const TOSS_SECRET = process.env.TOSS_SECRET_KEY || 'test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R';

async function tossCancel(order, amount, why, acct) {
  if (!order.pay_key) return { done: false, reason: '수동' };
  if (!(amount > 0)) return { done: false, reason: '환불액0' };

  const body = { cancelReason: why || '고객 요청' };
  /* 일부만 돌려줄 때만 금액을 적습니다 (전액이면 적지 않는 편이 안전합니다) */
  if (amount < Number(order.amount)) body.cancelAmount = amount;

  if (/가상계좌/.test(order.pay_method || '')) {
    const bank = acct && str(acct.bank, 20);
    const numb = acct && str(acct.num, 30);
    const hold = acct && str(acct.holder, 30);
    if (!bank || !numb || !hold) return { done: false, reason: '계좌필요' };
    body.refundReceiveAccount = { bank, accountNumber: numb, holderName: hold };
  }

  let r, data;
  try {
    r = await fetch(
      `https://api.tosspayments.com/v1/payments/${encodeURIComponent(order.pay_key)}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(TOSS_SECRET + ':').toString('base64'),
          'Content-Type': 'application/json',
          /* 두 번 눌러도 두 번 취소되지 않게 토스가 막아 줍니다 */
          'Idempotency-Key': 'cancel-' + order.order_id,
        },
        body: JSON.stringify(body),
      });
    data = await r.json().catch(() => ({}));
  } catch (e) {
    return { done: false, reason: '연결실패', detail: String(e.message || e).slice(0, 200) };
  }
  if (r.status !== 200) {
    return { done: false, reason: '거절', code: data.code || null,
             detail: String(data.message || '').slice(0, 200) };
  }
  return { done: true };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const b = req.body || {};
  const no = str(b.no, 64);
  const act = str(b.act, 12);
  if (!no) return res.status(400).json({ error: '주문번호가 필요합니다' });
  if (!['extend', 'cancel', 'move', 'tax', 'quote', 'cust'].includes(act)) {
    return res.status(400).json({ error: '알 수 없는 처리입니다' });
  }

  const now = new Date();
  let order, setupFee = 5000;
  try {
    const [rows, setRows] = await Promise.all([
      sb('orders', { query: `?select=*&order_id=eq.${encodeURIComponent(no)}&limit=1` }),
      sb('settings', { query: '?select=v&k=eq.setup_fee' }),
    ]);
    order = rows && rows[0];
    if (setRows && setRows[0]) setupFee = Number(setRows[0].v) || 5000;
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
  if (!order) return res.status(404).json({ error: '없는 주문번호입니다' });

  const log = async (pn, act2) => {
    try { await sb('view_log', { method: 'POST', prefer: 'return=minimal',
      body: [{ pn, act: act2, who: '관리자' }] }); } catch (e) {}
  };

  try {
    /* ── 환불 금액만 미리 계산해 보기 (화면에 보여주는 용도) ── */
    if (act === 'quote') {
      return res.status(200).json({ ok: true, quote: refundQuote(order, setupFee, now.getTime()) });
    }

    /* ── 기간 연장 ── */
    if (act === 'extend') {
      const days = Math.round(Number(b.days));
      if (![30, 60, 90].includes(days)) return res.status(400).json({ error: '연장 기간은 30 · 60 · 90일입니다' });
      if (order.status === 'canceled' || order.status === 'refunded') {
        return res.status(409).json({ error: '이미 해지된 주문입니다' });
      }
      /* ★ 그 PC 를 지금 다른 주문이 쓰고 있지 않은지 먼저 봅니다.
         만료돼서 반납된 PC 는 [임대 가능] 으로 돌아가고, 그 사이 다른
         고객에게 팔릴 수 있습니다. 그걸 모르고 예전 주문을 연장하면
         한 대를 두 사람이 쓰게 됩니다.
         연장을 마친 뒤에 알려드려 봐야 늦으므로 여기서 막습니다. */
      if (order.pn) {
        const other = await sb('orders', {
          query: `?select=order_id&pn=eq.${encodeURIComponent(order.pn)}` +
                 `&status=in.(assigned,paid)` +
                 `&order_id=neq.${encodeURIComponent(no)}&limit=1`,
        });
        if (other && other[0]) {
          return res.status(409).json({
            error: `${order.pn} 은 지금 다른 주문(${other[0].order_id})이 쓰고 있습니다. `
                 + `연장 대신 [PC 이전] 으로 빈 PC 를 배정해 주세요`,
          });
        }
      }

      /* 남은 기간이 있으면 그 뒤에 붙이고, 이미 끝났으면 오늘부터 시작합니다 */
      const curEnd = order.ends_at ? Date.parse(order.ends_at) : now.getTime();
      const base = Math.max(curEnd, now.getTime());
      const newEnd = new Date(base + days * DAY);
      const addAmt = Math.round(Number(b.amount) || 0);

      await sb('orders', {
        method: 'PATCH', prefer: 'return=minimal',
        query: `?order_id=eq.${encodeURIComponent(no)}`,
        body: {
          days: Number(order.days) + days,
          amount: Number(order.amount) + addAmt,
          ends_at: newEnd.toISOString(),
          status: 'assigned',
        },
      });
      /* 만료돼서 반납했던 PC 라면 다시 임대중으로 */
      if (order.pn) {
        await sb('pcs', { method: 'PATCH', prefer: 'return=minimal',
          query: `?pn=eq.${encodeURIComponent(order.pn)}&status=eq.ok`,
          body: { status: 'rent', updated_at: now.toISOString() } });
      }
      await log(order.pn, `연장 ${days}일 · ${addAmt.toLocaleString('ko-KR')}원 · ${str(b.payMethod, 30) || '수동'}`);
      return res.status(200).json({ ok: true, endsAt: newEnd.toISOString(), days: Number(order.days) + days });
    }

    /* ── 해지 · 환불 ── */
    if (act === 'cancel') {
      if (order.status === 'canceled' || order.status === 'refunded') {
        return res.status(409).json({ error: '이미 해지된 주문입니다' });
      }
      const q = refundQuote(order, setupFee, now.getTime());
      const asked = (b.refund === undefined || b.refund === null || b.refund === '')
        ? q.refund : Math.round(Number(b.refund));
      if (!Number.isFinite(asked) || asked < 0) return res.status(400).json({ error: '환불 금액이 올바르지 않습니다' });
      if (asked > Number(order.amount)) return res.status(400).json({ error: '받은 금액보다 많이 환불할 수 없습니다' });
      /* 규정을 벗어나는 금액은 확인 한 번을 더 받습니다 */
      if (asked !== q.refund && !b.force) {
        return res.status(409).json({
          error: `규정대로면 ${q.refund.toLocaleString('ko-KR')}원입니다 (${q.rule} · ${q.used}일 사용).\n` +
                 `${asked.toLocaleString('ko-KR')}원으로 처리하시려면 한 번 더 눌러 주세요.`,
          quote: q, needForce: true,
        });
      }

      /* ── 토스에 실제 취소를 먼저 요청합니다 ──────────────────────
         여기서 실패하면 아무것도 바꾸지 않고 돌아갑니다.
         화면에만 환불됐다고 적히는 일이 없어야 합니다. */
      const tc = await tossCancel(order, asked, str(b.why, 100), b.account);
      if (!tc.done && tc.reason === '계좌필요') {
        return res.status(409).json({
          error: '가상계좌로 받은 결제입니다. 돌려드릴 통장을 알려 주셔야 취소됩니다.\n'
               + '은행 · 계좌번호 · 예금주를 입력해 주세요.',
          needAccount: true, quote: q,
        });
      }
      if (!tc.done && (tc.reason === '거절' || tc.reason === '연결실패')) {
        return res.status(502).json({
          error: '토스에서 취소되지 않았습니다. 아무것도 바꾸지 않았습니다.\n'
               + (tc.detail || '') + '\n\n계속 안 되면 토스 콘솔에서 직접 취소하신 뒤 다시 눌러 주세요.',
          tossCode: tc.code || null,
        });
      }

      await sb('orders', {
        method: 'PATCH', prefer: 'return=minimal',
        query: `?order_id=eq.${encodeURIComponent(no)}`,
        body: {
          status: asked > 0 ? 'refunded' : 'canceled',
          canceled_at: now.toISOString(),
          refund_amt: asked,
          refund_why: str(b.why, 200) || '고객 요청',
          ends_at: now.toISOString(),
        },
      });
      /* 쓰던 PC 를 판매 재고로 되돌립니다 */
      if (order.pn) {
        await sb('pcs', { method: 'PATCH', prefer: 'return=minimal',
          query: `?pn=eq.${encodeURIComponent(order.pn)}&status=eq.rent`,
          body: { status: 'ok', updated_at: now.toISOString() } });
      }
      /* 돈이 실제로 돌아갔는지를 기록에 남깁니다.
         나중에 "환불했다는데 안 들어왔다" 는 문의가 오면 여기를 봅니다. */
      const 방법 = tc.done ? '토스 취소 완료'
                 : asked > 0 ? '⚠ 직접 송금 필요 (토스 결제가 아님)'
                 : '환불액 없음';
      await log(order.pn, `해지 · 환불 ${asked.toLocaleString('ko-KR')}원 `
        + `(${q.rule} · ${q.used}일 사용) · ${방법} · ${str(b.why, 100) || '고객 요청'}`);
      return res.status(200).json({
        ok: true, refund: asked, quote: q, pcReturned: !!order.pn,
        moneyBack: tc.done,                                   // 토스가 실제로 돌려줬는가
        manualRefund: !tc.done && asked > 0,                  // 관리자가 직접 보내야 하는가
      });
    }

    /* ── PC 이전 (고장 · 사양 변경) ── */
    if (act === 'move') {
      const toPn = String(b.toPn || '').toUpperCase().trim();
      if (!/^[KYD]-\d{3}$/.test(toPn)) return res.status(400).json({ error: '옮길 품번을 정확히 적어 주세요' });
      if (toPn === order.pn) return res.status(400).json({ error: '같은 PC 입니다' });

      const rows = await sb('pcs', { query: `?select=pn,status,spec_id,anydesk&pn=eq.${encodeURIComponent(toPn)}&limit=1` });
      const to = rows && rows[0];
      if (!to) return res.status(404).json({ error: `${toPn} 은 없는 품번입니다` });
      if (to.status !== 'ok') return res.status(409).json({ error: `${toPn} 은 지금 임대할 수 있는 상태가 아닙니다 (현재: ${to.status})` });

      const from = order.pn;

      /* ★ 옮겨 갈 PC 부터 잡습니다.
         예전에는 조건 없이 그냥 임대중으로 바꿨습니다. 위에서 상태를
         확인한 뒤 여기까지 오는 사이에 다른 고객이 결제로 그 PC 를
         가져갔으면, 남이 쓰는 PC 를 빼앗아 두 주문이 같은 PC 를
         가리키게 됩니다. 두 사람에게 같은 접속 정보가 나갑니다.

         status=eq.ok 조건을 걸고 바뀐 줄을 실제로 받아 확인합니다. */
      const got = await sb('pcs', { method: 'PATCH', prefer: 'return=representation',
        query: `?pn=eq.${encodeURIComponent(toPn)}&status=eq.ok&select=pn`,
        body: { status: 'rent', updated_at: now.toISOString() } });
      if (!(got && got[0])) {
        return res.status(409).json({
          error: `${toPn} 은 방금 다른 주문에 배정됐습니다. 다른 PC 를 골라 주세요` });
      }

      try {
        await sb('orders', { method: 'PATCH', prefer: 'return=minimal',
          query: `?order_id=eq.${encodeURIComponent(no)}`,
          body: { pn: toPn, spec_id: to.spec_id || order.spec_id } });
      } catch (e) {
        /* 주문을 못 고쳤으면 잡아둔 PC 를 놓아줍니다 */
        try { await sb('pcs', { method: 'PATCH', prefer: 'return=minimal',
          query: `?pn=eq.${encodeURIComponent(toPn)}&status=eq.rent`,
          body: { status: 'ok', updated_at: new Date().toISOString() } }); } catch (e2) {}
        throw e;
      }
      if (from) {
        /* 원래 쓰던 PC 는 점검으로 보냅니다 — 고장이라 옮기는 경우가 대부분입니다 */
        await sb('pcs', { method: 'PATCH', prefer: 'return=minimal',
          query: `?pn=eq.${encodeURIComponent(from)}`,
          body: { status: str(b.oldStatus, 4) === 'ok' ? 'ok' : 'fix', updated_at: now.toISOString() } });
      }
      await log(toPn, `PC 이전 ${from || '없음'} → ${toPn} · ${str(b.why, 100) || '사유 없음'}`);
      return res.status(200).json({ ok: true, from, to: toPn, anydesk: to.anydesk || null });
    }

    /* ── 세금계산서 요청 ── */
    if (act === 'tax') {
      const bizNo = String(b.bizNo || '').replace(/[^\d]/g, '');
      if (bizNo && bizNo.length !== 10) return res.status(400).json({ error: '사업자등록번호는 숫자 10자리입니다' });
      await sb('orders', { method: 'PATCH', prefer: 'return=minimal',
        query: `?order_id=eq.${encodeURIComponent(no)}`,
        body: { tax_invoice: true, biz_no: bizNo || null } });
      await log(order.pn, `세금계산서 요청${bizNo ? ' · ' + bizNo : ''}`);
      return res.status(200).json({ ok: true });
    }

    /* ── 고객 정보 수정 ────────────────────────────────────────────
       스마트스토어·전화 주문은 이름과 연락처를 사람이 받아 적습니다.
       오타가 나거나, 나중에 번호가 바뀌거나, 결제한 분과 실제 쓰시는 분이
       다르다는 걸 뒤늦게 아는 일이 흔합니다.
       그동안은 고칠 방법이 Supabase 표를 직접 여는 것밖에 없었습니다.

       ※ 관리자 목록에 보이는 이름은 회원 표(members)를 먼저 씁니다.
         그래서 주문 표만 고치면 화면이 안 바뀝니다 — 둘 다 고칩니다. */
    if (act === 'cust') {
      const nm  = str(b.name, 30);
      const ph  = String(b.phone || '').replace(/[^\d-]/g, '').slice(0, 20);
      const pnm = str(b.payerName, 30);
      const unm = str(b.userName, 30);
      const uph = String(b.userPhone || '').replace(/[^\d-]/g, '').slice(0, 20);
      if (!nm) return res.status(400).json({ error: '고객 성함을 적어 주세요' });

      await sb('orders', { method: 'PATCH', prefer: 'return=minimal',
        query: `?order_id=eq.${encodeURIComponent(no)}`,
        body: {
          payer_name: pnm || nm,
          user_name:  unm || nm,
          user_phone: uph || ph || null,
        } });

      if (order.member_id) {
        await sb('members', { method: 'PATCH', prefer: 'return=minimal',
          query: `?id=eq.${encodeURIComponent(order.member_id)}`,
          body: { name: nm, phone: ph || null } });
      }
      await log(order.pn, `고객 정보 수정 — ${nm}${ph ? ' · ' + ph : ''}`);
      return res.status(200).json({ ok: true });
    }
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 250) });
  }
};
