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
const kv = require('./_crypto');
const { readTicket } = require('./_ticket');

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
    /* ★ 매진 확인 — 결제창을 열기 전에 지금 배정 가능한 PC 가 있는지 봅니다.
       이걸 안 보면 재고 0 인 상품도 결제가 되고, 돈은 받았는데 배정할
       PC 가 없어 "결제 완료·미배정" 이 쌓입니다 (지금 인텔 i5 가 0대).
       결제 승인(toss-confirm)과 같은 기준(살아있고 임대 가능)으로 봅니다. */
    const freshSec = Number(process.env.KVC_ASSIGN_FRESH_SEC || 420);
    const fresh = new Date(Date.now() - freshSec * 1000).toISOString();
    const stock = await sb('pcs', {
      query: `?select=pn&status=eq.ok&online=is.true&last_beat=gte.${fresh}` +
             `&spec_id=eq.${q.specId}&limit=1`,
    });
    if (!stock || !stock[0]) {
      return res.status(409).json({
        error: '죄송합니다. 이 사양은 지금 모두 임대중입니다.\n' +
               '다른 사양을 골라 주시거나, 카톡 상담으로 입고 알림을 요청해 주세요.',
      });
    }

    /* ── 회원 찾기 ───────────────────────────────────────────────
       ★ 로그인 출입증(httpOnly 쿠키)으로 찾습니다 (2026-11-07 결제 점검).
         예전에는 브라우저가 보낸 카카오·구글 번호(socialId)로 찾았는데,
         내 가상컴 화면이 저장소를 덮어쓰면서 그 번호가 사라졌습니다.
         그러면 주문에 회원이 안 붙어(member_id 빈 값) 결제를 해도
         내 가상컴에 PC 가 안 보이고 비밀번호도 "고객님의 PC 가 아닙니다" 로 막혔습니다.
         출입증은 서버가 카카오·구글에 직접 확인하고 발급한 것이라 믿을 수 있습니다. */
    let memberId = null;
    const ticketId = readTicket(req);
    if (ticketId) {
      const me = await sb('members', { query: `?select=id&id=eq.${encodeURIComponent(ticketId)}&limit=1` });
      if (me && me[0]) memberId = me[0].id;
    }
    if (!memberId && !kv.ready()) {
      /* ★ 2026-11-07 Codex 검토 — 출입증을 못 쓰는 환경에서 브라우저가 보낸
         카카오·구글 번호를 믿으면, 남의 번호로 남의 회원에 주문을 붙일 수 있습니다.
         KVC_SECRET 이 없으면 주문을 받지 않습니다. */
      return res.status(503).json({ error: 'KVC_SECRET 이 등록되지 않아 주문을 받을 수 없습니다' });
    }
    if (!memberId) {
      /* 출입증이 없거나 만료 → 다시 로그인 */
      return res.status(401).json({ error: '로그인이 만료됐습니다. 다시 로그인해 주세요.' });
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
