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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const b = req.body || {};
  const no = str(b.no, 64);
  const act = str(b.act, 12);
  if (!no) return res.status(400).json({ error: '주문번호가 필요합니다' });
  if (!['extend', 'cancel', 'move', 'tax', 'quote'].includes(act)) {
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
      await log(order.pn, `해지 · 환불 ${asked.toLocaleString('ko-KR')}원 (${q.rule} · ${q.used}일 사용) · ${str(b.why, 100) || '고객 요청'}`);
      return res.status(200).json({ ok: true, refund: asked, quote: q, pcReturned: !!order.pn });
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
      await sb('orders', { method: 'PATCH', prefer: 'return=minimal',
        query: `?order_id=eq.${encodeURIComponent(no)}`,
        body: { pn: toPn, spec_id: to.spec_id || order.spec_id } });
      await sb('pcs', { method: 'PATCH', prefer: 'return=minimal',
        query: `?pn=eq.${encodeURIComponent(toPn)}`,
        body: { status: 'rent', updated_at: now.toISOString() } });
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
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 250) });
  }
};
