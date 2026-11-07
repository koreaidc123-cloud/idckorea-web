/* ═══════════════════════════════════════════════════════════════
   주문 만들기 — 결제창을 띄우기 "전에" 서버가 먼저 주문을 적어둡니다

   흐름
     ① 고객이 상품·기간 선택
     ② 여기로 요청  →  서버가 금액을 계산해서 주문을 저장하고 주문번호를 줍니다
     ③ 그 주문번호·금액으로 토스 결제창을 엽니다
     ④ 결제가 끝나면 /api/toss-confirm 이 ②에서 적어둔 금액과 대조합니다

   ②를 건너뛰면 금액을 고쳐서 결제할 수 있습니다. 그래서 이 단계가 있습니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb, missingCol } = require('./_supa');
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

/* ═══ 연장 결제 주문 (2026-11-08) ═══════════════════════════════════
   고객이 [내 가상컴] 에서 [연장하기] 를 누르면 여기로 extendOf(원 주문번호)가 옵니다.
   ★ 새 PC 를 사는 주문이 아니라 "같은 PC 기간만 늘리는" 주문입니다.
     · 원 주문은 그대로 두고, 연장 줄(kind='extend', parent_id=원 주문)을 하나 새로 만듭니다.
       연장마다 결제키·금액이 따로 있어야 연장분만 따로 환불할 수 있기 때문입니다.
     · 재고 확인은 하지 않습니다 (새 PC 를 잡지 않으므로).
     · 금액은 원 주문 상품의 가격표(_price.js)로만 정합니다. 셋팅비는 0원 (이미 셋팅된 PC).
     · 실제로 기간을 늘리는 일은 결제 승인 뒤 데이터베이스 함수(apply_extension)가 한 번에 합니다.
   ★ db/10-연장결제.sql 을 안 돌렸으면(칸·함수 없음, settings.ext_pay 가 1 이 아님) 받지 않습니다.
     그때 고객 화면은 [카카오톡으로 연장 요청] 을 그대로 보여 줍니다. */
function newExtId() {
  const d = new Date();
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `KVX${ymd}-${rnd}`;          // KVX = 연장 결제 (KVC 새 주문과 한눈에 구분)
}
const REUSE_MS = 30 * 60000;          // 30분 안에 다시 누르면 같은 주문으로 결제창을 엽니다

async function createExtension(req, res, b) {
  if (!ready()) return res.status(503).json({ error: '지금은 연장 결제를 받을 수 없습니다. 카카오톡으로 요청해 주세요' });
  const parentId = String(b.extendOf || '').trim().slice(0, 64);
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(parentId)) return res.status(400).json({ error: '주문번호가 올바르지 않습니다' });
  const days = Number(b.days);

  /* 회원 — 출입증(쿠키)으로만 찾습니다. 남의 주문은 연장할 수 없습니다 */
  const memberId = readTicket(req);
  if (!memberId) return res.status(401).json({ error: '로그인이 만료됐습니다. 다시 로그인해 주세요.' });

  /* 기능이 켜져 있는지 (db/10 을 돌렸는지) */
  const NOT_READY = { error: '지금은 화면에서 바로 연장할 수 없습니다.\n카카오톡 상담으로 연장을 요청해 주세요.' };
  const flag = await sb('settings', { query: '?select=v&k=eq.ext_pay&limit=1' });
  if (!(flag && flag[0] && flag[0].v === '1')) return res.status(409).json(NOT_READY);

  let parent;
  try {
    const rows = await sb('orders', {
      query: `?select=order_id,member_id,pn,spec_id,status,ends_at,kind,user_name,user_phone` +
             `&order_id=eq.${encodeURIComponent(parentId)}&limit=1`,
    });
    parent = rows && rows[0];
  } catch (e) {
    if (missingCol(e, 'kind')) return res.status(409).json(NOT_READY);
    throw e;
  }
  if (!parent || parent.member_id !== memberId) {
    return res.status(404).json({ error: '고객님의 주문이 아닙니다. 내 가상컴을 새로고침해 주세요.' });
  }
  const NEW = '같은 PC 로는 연장할 수 없는 주문입니다.\n새로 신청해 주세요.';
  if (!parent.pn || !['assigned', 'expired'].includes(parent.status)) {
    return res.status(409).json({ error: NEW, needNew: true });
  }

  /* PC 상태 — 이용중이면 rent, 끝난 주문이면 반납 유예(hold) 중이어야 자료가 그대로 있습니다.
     초기화 대기(wipe)로 넘어갔으면 자료가 지워졌을 수 있어 같은 PC 연장을 받지 않습니다. */
  const pr = await sb('pcs', { query: `?select=pn,status&pn=eq.${encodeURIComponent(parent.pn)}&limit=1` });
  const pcSt = pr && pr[0] ? pr[0].status : null;
  if (parent.status === 'expired' && pcSt !== 'hold') {
    return res.status(409).json({
      error: '자료 보관 기간(반납 유예)이 지나 같은 PC 로 연장할 수 없습니다.\n새로 신청해 주세요.', needNew: true });
  }
  if (parent.status === 'assigned' && !['rent', 'hold'].includes(pcSt)) {
    return res.status(409).json({ error: '지금 이 PC 는 점검 중이라 바로 연장할 수 없습니다.\n카카오톡 상담으로 알려 주세요.' });
  }
  /* 그 PC 를 다른 주문이 쓰고 있으면 안 됩니다 (만료 뒤 다른 손님에게 간 경우) */
  const other = await sb('orders', {
    query: `?select=order_id&pn=eq.${encodeURIComponent(parent.pn)}&status=in.(assigned,paid)` +
           `&order_id=neq.${encodeURIComponent(parent.order_id)}&limit=1`,
  });
  if (other && other[0]) return res.status(409).json({ error: NEW, needNew: true });

  const q = quote(parent.spec_id, days);
  if (!q) return res.status(400).json({ error: '연장 기간은 30 · 60 · 90일입니다' });
  const orderName = `연장 · ${parent.pn} · ${q.days}일`;

  /* 이미 만든 연장 주문이 있는지 — 결제 대기(ready)·결제완료 대기(paid) */
  const mine = await sb('orders', {
    query: `?select=order_id,status,days,amount,pay_key,member_id,created_at` +
           `&parent_id=eq.${encodeURIComponent(parent.order_id)}&kind=eq.extend&status=in.(ready,paid)`,
  }) || [];
  /* 돈은 받았는데 아직 기간이 안 늘어난 연장이 있으면 또 받지 않습니다 (두 번 결제 방지) */
  if (mine.some(x => x.status === 'paid')) {
    return res.status(409).json({ error: '이미 결제하신 연장이 처리 대기 중입니다.\n담당자가 곧 연락드립니다.' });
  }
  const wait = mine.find(x => x.status === 'ready');
  if (wait) {
    /* 가상계좌가 발급된 연장(결제키 있음)은 건드리지 않습니다.
       지우면 나중에 입금돼도 "이미 처리됨" 으로 무시돼 돈만 받고 연장이 안 됩니다. */
    if (wait.pay_key) {
      return res.status(409).json({ error: '입금을 기다리는 연장 결제(가상계좌)가 있습니다.\n발급받으신 계좌로 입금해 주시거나, 기한이 지난 뒤 다시 시도해 주세요.' });
    }
    const fresh = wait.created_at && Date.now() - Date.parse(wait.created_at) < REUSE_MS;
    if (fresh && Number(wait.days) === q.days && Number(wait.amount) === q.amount && wait.member_id === memberId) {
      return res.status(200).json({ orderId: wait.order_id, orderName, amount: q.amount, days: q.days,
        verified: true, extend: true, pn: parent.pn, reused: true });
    }
    /* 오래됐거나 기간을 바꿨으면 옛 연장 주문은 취소하고 새로 만듭니다.
       (결제키가 없는 = 토스 승인 전이라, 그 창에서 결제를 마쳐도 승인 단계에서 막혀 돈이 안 나갑니다) */
    await sb('orders', { method: 'PATCH', prefer: 'return=minimal',
      query: `?order_id=eq.${encodeURIComponent(wait.order_id)}&status=eq.ready&pay_key=is.null`,
      body: { status: 'canceled', canceled_at: new Date().toISOString() } });
  }

  const name = String(b.name || parent.user_name || '').trim().slice(0, 30) || null;
  const phone = phoneOk(b.phone) ? String(b.phone).trim() : (parent.user_phone || null);
  const orderId = newExtId();
  try {
    await sb('orders', {
      method: 'POST', prefer: 'return=minimal',
      body: [{
        order_id: orderId, member_id: memberId, spec_id: parent.spec_id, days: q.days, amount: q.amount,
        setup_fee: 0, status: 'ready', user_name: name, user_phone: phone,
        kind: 'extend', parent_id: parent.order_id,
      }],
    });
  } catch (e) {
    /* 두 창에서 거의 동시에 눌러 "결제 대기 연장은 하나" 규칙에 걸린 경우 */
    if (/23505|orders_one_ready_ext/.test(String(e.message || e))) {
      return res.status(409).json({ error: '다른 창에서 연장 결제를 진행 중입니다. 잠시 후 다시 시도해 주세요.' });
    }
    throw e;
  }
  return res.status(200).json({ orderId, orderName, amount: q.amount, days: q.days, verified: true, extend: true, pn: parent.pn });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = req.body || {};
  /* 연장 결제 — 새 주문과 길을 완전히 나눕니다 (새 주문 흐름은 한 줄도 바뀌지 않게) */
  if (b.extendOf) {
    try { return await createExtension(req, res, b); }
    catch (e) { return res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  }
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
