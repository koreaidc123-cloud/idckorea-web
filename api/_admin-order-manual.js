/* ═══════════════════════════════════════════════════════════════
   수동 주문 등록 — 홈페이지에서 결제하지 않은 고객을 넣습니다

   이런 경우에 씁니다
     · 스마트스토어에서 주문이 들어왔을 때
     · 전화·카톡으로 주문받고 계좌로 입금받았을 때
     · 기존 고객을 시스템으로 옮길 때

   POST /api/order-manual   (관리자 로그인 필요)
   { pn:"Y-042",              ← 어느 PC 를 줄지 (비우면 사양으로 자동 배정)
     specId:5, days:30,
     name:"김민준", phone:"010-1234-5678",
     payerName:"김철수",       ← 입금자가 다르면 (선택)
     userName:"이영희", userPhone:"010-...",   ← 실제 쓰는 분이 다르면 (선택)
     payMethod:"스마트스토어",
     amount:65000,            ← 비우면 정가로 계산합니다
     startsAt:"2026-08-16"    ← 비우면 오늘부터
   }

   ★ 금액을 직접 넣을 수 있게 한 이유
     스마트스토어 수수료·현장 할인 등으로 실제 받은 금액이 정가와
     다를 수 있습니다. 다만 정가와 다르면 기록에 남깁니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify } = require('./admin-login');
const { quote } = require('./_price');

const phoneOk = s => /^01[016789]-?\d{3,4}-?\d{4}$/.test(String(s || '').trim());
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null) || null;

function newOrderId() {
  const d = new Date();
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  return `MAN${ymd}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const b = req.body || {};
  const name = str(b.name, 30);
  const phone = String(b.phone || '').trim();
  if (!name) return res.status(400).json({ error: '고객명을 입력해 주세요' });
  if (!phoneOk(phone)) return res.status(400).json({ error: '연락처 형식을 확인해 주세요 (010-0000-0000)' });

  const q = quote(b.specId, b.days);
  if (!q) return res.status(400).json({ error: '상품 또는 이용 기간이 올바르지 않습니다' });

  const amount = (b.amount === undefined || b.amount === null || b.amount === '')
    ? q.amount : Math.round(Number(b.amount));
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: '금액이 올바르지 않습니다' });

  const now = new Date();
  const starts = b.startsAt ? new Date(b.startsAt) : now;
  if (isNaN(starts.getTime())) return res.status(400).json({ error: '시작일이 올바르지 않습니다' });
  const ends = new Date(starts); ends.setDate(ends.getDate() + q.days);

  try {
    /* ── 어느 PC 를 줄지 정합니다 ── */
    let pc = null;
    const wantPn = String(b.pn || '').toUpperCase().trim();
    if (wantPn) {
      const rows = await sb('pcs', {
        query: `?select=pn,anydesk,status,spec_id&pn=eq.${encodeURIComponent(wantPn)}&limit=1`,
      });
      pc = rows && rows[0];
      if (!pc) return res.status(404).json({ error: `${wantPn} 은 없는 품번입니다` });
      if (pc.status !== 'ok') {
        return res.status(409).json({ error: `${wantPn} 은 지금 임대할 수 있는 상태가 아닙니다 (현재: ${pc.status})` });
      }
    } else {
      /* 사양만 정하고 PC 는 자동으로 — 살아있는 것만 고릅니다 */
      const fresh = new Date(now.getTime() - Number(process.env.KVC_ASSIGN_FRESH_SEC || 420) * 1000).toISOString();
      const cand = await sb('pcs', {
        query: `?select=pn,anydesk&status=eq.ok&online=is.true&last_beat=gte.${fresh}` +
               `&spec_id=eq.${q.specId}&order=updated_at.asc&limit=1`,
      });
      pc = cand && cand[0];
      if (!pc) return res.status(409).json({ error: '지금 배정할 수 있는 PC 가 없습니다. 품번을 직접 지정해 주세요' });
    }

    /* ── ★ PC 부터 잡습니다 ────────────────────────────────────────
       예전에는 주문을 먼저 만들고 PC 를 나중에 잡았습니다. 그 사이에
       다른 고객이 홈페이지에서 결제하면 같은 PC 를 가져갈 수 있고,
       그러면 주문만 남고 PC 는 남의 것이 됩니다.
       두 고객이 같은 애니데스크 번호와 비밀번호를 받게 됩니다.

       status=eq.ok 를 조건으로 걸면 이미 남이 가져간 PC 는 한 줄도
       안 바뀝니다. 예전에는 return=minimal 이라 안 바뀐 것을 알 수가
       없어서 그냥 넘어갔습니다. 이제 바뀐 줄을 실제로 받아 확인합니다. */
    const locked = await sb('pcs', {
      method: 'PATCH',
      query: `?pn=eq.${encodeURIComponent(pc.pn)}&status=eq.ok&select=pn`,
      body: { status: 'rent', updated_at: now.toISOString() },
      prefer: 'return=representation',
    });
    if (!(locked && locked[0])) {
      return res.status(409).json({
        error: `${pc.pn} 은 방금 다른 주문에 배정됐습니다. 새로고침 후 다시 확인해 주세요`,
      });
    }
    /* 뒤에서 실패하면 잡아둔 PC 를 반드시 놓아줍니다.
       안 그러면 아무도 안 쓰는데 임대중으로 남아 영영 안 팔립니다. */
    const unlock = async () => {
      try {
        await sb('pcs', {
          method: 'PATCH', prefer: 'return=minimal',
          query: `?pn=eq.${encodeURIComponent(pc.pn)}&status=eq.rent`,
          body: { status: 'ok', updated_at: new Date().toISOString() },
        });
      } catch (e) {}
    };

    /* ── 회원 — 전화번호가 같으면 같은 사람으로 봅니다 ── */
    let memberId = null;
    const orderId = newOrderId();
    try {
      const found = await sb('members', {
        query: `?select=id&phone=eq.${encodeURIComponent(phone)}&limit=1`,
      });
      if (found && found[0]) memberId = found[0].id;
      else {
        const made = await sb('members', {
          method: 'POST', prefer: 'return=representation',
          body: [{ via: 'manual', social_id: 'manual:' + phone, name, phone }],
        });
        memberId = made && made[0] ? made[0].id : null;
      }

      /* ── 주문 ── */
      await sb('orders', {
        method: 'POST', prefer: 'return=minimal',
        body: [{
          order_id: orderId, member_id: memberId, pn: pc.pn,
          spec_id: q.specId, days: q.days, amount,
          status: 'assigned',
          pay_method: str(b.payMethod, 30) || '수동 등록',
          paid_at: now.toISOString(),
          starts_at: starts.toISOString(), ends_at: ends.toISOString(),
          payer_name: str(b.payerName, 30) || name,
          user_name: str(b.userName, 30) || name,
          user_phone: str(b.userPhone, 20) || phone,
        }],
      });
    } catch (e) {
      await unlock();   /* 주문을 못 만들었으면 PC 를 다시 판매 가능으로 */
      throw e;
    }

    /* ── 기록 ── */
    const note = amount !== q.amount
      ? `수동 주문 ${orderId} · ${name} · ${amount.toLocaleString('ko-KR')}원 (정가 ${q.amount.toLocaleString('ko-KR')}원과 다름)`
      : `수동 주문 ${orderId} · ${name}`;
    try {
      await sb('view_log', { method: 'POST', prefer: 'return=minimal',
        body: [{ pn: pc.pn, act: note, who: '관리자' }] });
    } catch (e) {}

    res.status(200).json({
      ok: true, orderId, pn: pc.pn, anydesk: pc.anydesk || null,
      amount, listPrice: q.amount, priceDiff: amount !== q.amount,
      startsAt: starts.toISOString(), endsAt: ends.toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 250) });
  }
};
