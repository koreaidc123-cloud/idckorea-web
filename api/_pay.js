/* ═══════════════════════════════════════════════════════════════
   결제 공통 도구 — 승인 · 웹훅 · 관리자 배정이 함께 씁니다

   ★ 왜 한곳에 모았나
     PC 를 잡는 법, PC 를 놓아주는 법, 토스에 결제 상태를 묻는 법이
     파일마다 조금씩 달랐습니다. 한 곳만 고치고 다른 곳을 잊으면
     "한 PC 를 두 사람이 쓰는" 일이 다시 생깁니다.
     그래서 이 파일 하나에 두고 모두 이것을 부릅니다.

   ※ 밑줄로 시작하는 파일이라 Vercel 함수 개수(12개 한도)에 세지 않습니다.
   ═══════════════════════════════════════════════════════════════ */
const { sb } = require('./_supa');

/* 토스 시크릿 키 — 환경변수에서만 읽습니다.
   없을 때 쓰는 값은 토스 문서에 공개된 샌드박스 키입니다 (실결제 불가). */
const tossSecret = () => process.env.TOSS_SECRET_KEY || 'test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R';
const tossAuth = () => 'Basic ' + Buffer.from(tossSecret() + ':').toString('base64');

/* ── 토스에 결제 상태를 직접 물어봅니다 ─────────────────────────
   웹훅으로 들어온 내용은 누구나 흉내 낼 수 있습니다.
   그래서 "토스가 지금 뭐라고 하는지" 를 우리가 직접 물어 확인합니다.
   돌려주는 값
     { ok:true,  pay:{...} }      토스가 알려준 결제 정보
     { ok:false, notFound:true }  토스에 없는 결제 (가짜 요청)
     { ok:false }                 연결 실패 — 잠시 뒤 다시 해야 합니다 */
async function tossGet({ paymentKey, orderId }) {
  const path = paymentKey
    ? `/v1/payments/${encodeURIComponent(paymentKey)}`
    : `/v1/payments/orders/${encodeURIComponent(orderId)}`;
  let r, data;
  try {
    r = await fetch('https://api.tosspayments.com' + path, {
      headers: { Authorization: tossAuth() },
    });
    data = await r.json().catch(() => ({}));
  } catch (e) {
    return { ok: false };
  }
  if (r.status === 200) return { ok: true, pay: data };
  if (r.status === 404 || r.status === 400) return { ok: false, notFound: true, code: data.code || null };
  return { ok: false, code: data.code || null };
}

/* 이 시간(초) 안에 신호가 온 PC 만 배정 대상으로 봅니다.
   하트비트가 2분 주기라 딱 맞추면 잠깐 끊긴 것도 빠지므로 여유를 둡니다. */
const freshIso = now =>
  new Date(now.getTime() - Number(process.env.KVC_ASSIGN_FRESH_SEC || 420) * 1000).toISOString();

/* ── 같은 사양의 살아있는 PC 한 대를 잡습니다 ──────────────────
   · status=eq.ok 조건을 건 PATCH 로 잡고, 바뀐 줄을 실제로 받아 확인합니다.
     이미 남이 가져간 PC 는 한 줄도 안 바뀌므로 다음 후보로 넘어갑니다.
   · wantPn — 고객이 목록에서 고른 PC. 같은 상품일 때만 맨 앞에 둡니다
     (주소를 조작해 비싼 PC 를 싼 값에 가져가는 것을 막습니다).
   못 잡으면 null 을 돌려줍니다. */
async function grabPc({ specId, wantPn, now }) {
  now = now || new Date();
  const fresh = freshIso(now);
  const cols = 'pn,anydesk,room,rack,fl,slot';
  const cand = await sb('pcs', {
    query: `?select=${cols}&status=eq.ok&online=is.true&last_beat=gte.${fresh}` +
           `&spec_id=eq.${Number(specId)}&order=updated_at.asc&limit=5`,
  }) || [];

  const want = String(wantPn || '').toUpperCase().trim();
  if (/^[KYD]-\d{3}$/.test(want)) {
    if (cand.some(c => c.pn === want)) {
      cand.sort((a, b) => (a.pn === want ? -1 : b.pn === want ? 1 : 0));
    } else {
      try {
        const w = await sb('pcs', {
          query: `?select=${cols}&pn=eq.${encodeURIComponent(want)}` +
                 `&status=eq.ok&online=is.true&last_beat=gte.${fresh}` +
                 `&spec_id=eq.${Number(specId)}&limit=1`,
        });
        if (w && w[0]) cand.unshift(w[0]);
      } catch (e) {}
    }
  }

  for (const c of cand) {
    if (await lockPc(c.pn, now)) return c;
  }
  return null;
}

/* 품번을 정해서 잡기 — 임대 가능(ok)일 때만 임대중(rent)으로 바뀝니다.
   잡았으면 true, 그 사이 남이 가져갔으면 false */
async function lockPc(pn, now) {
  const got = await sb('pcs', {
    method: 'PATCH',
    query: `?pn=eq.${encodeURIComponent(pn)}&status=eq.ok&select=pn`,
    body: { status: 'rent', updated_at: (now || new Date()).toISOString() },
    prefer: 'return=representation',
  });
  return !!(got && got[0]);
}

/* ── PC 를 판매 재고로 되돌립니다 (해지·환불·취소 때) ──────────
   ★ 그 PC 를 지금 다른 주문이 쓰고 있으면 건드리지 않습니다.
     만료된 옛 주문을 뒤늦게 해지하면, 그 사이 같은 PC 를 받은
     새 고객의 PC 가 "임대 가능" 으로 풀려 또 팔릴 수 있었습니다.
   돌려주는 값: 'released' 풀었음 · 'busy' 다른 주문이 씀 · 'none' 품번 없음 */
async function releasePc(pn, orderId, now) {
  if (!pn) return 'none';
  const other = await sb('orders', {
    query: `?select=order_id&pn=eq.${encodeURIComponent(pn)}` +
           `&status=in.(assigned,paid)&order_id=neq.${encodeURIComponent(orderId)}&limit=1`,
  });
  if (other && other[0]) return 'busy';
  await sb('pcs', {
    method: 'PATCH',
    query: `?pn=eq.${encodeURIComponent(pn)}&status=eq.rent`,
    body: { status: 'ok', updated_at: (now || new Date()).toISOString() },
    prefer: 'return=minimal',
  });
  return 'released';
}

/* 다른 주문이 이 PC 를 쓰고 있는지만 봅니다 (PC 이전 때 옛 PC 처리용) */
async function pcBusyByOther(pn, orderId) {
  if (!pn) return false;
  const other = await sb('orders', {
    query: `?select=order_id&pn=eq.${encodeURIComponent(pn)}` +
           `&status=in.(assigned,paid)&order_id=neq.${encodeURIComponent(orderId)}&limit=1`,
  });
  return !!(other && other[0]);
}

/* 주문 기간 — 지금부터 days 일 */
function period(days, now) {
  now = now || new Date();
  const ends = new Date(now); ends.setDate(ends.getDate() + Number(days));
  return { starts_at: now.toISOString(), ends_at: ends.toISOString() };
}

module.exports = { tossSecret, tossAuth, tossGet, grabPc, lockPc, releasePc, pcBusyByOther, period, freshIso };
