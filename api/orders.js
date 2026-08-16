/* ═══════════════════════════════════════════════════════════════
   주문 · 회원 조회 — 관리자 화면이 읽는 곳

   GET /api/orders          이용중 + 최근 끝난 것
   GET /api/orders?all=1    전부

   · 관리자 출입증(쿠키)이 없으면 아무것도 안 줍니다.
   · 애니데스크 비밀번호는 여기로 나가지 않습니다 (/api/pc-secret 에서 한 대씩).
   · 회원 목록은 주문에서 뽑아 만들어 줍니다 — 화면이 따로 계산할 필요가 없게.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify } = require('./admin-login');

const DAY = 86400000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const all = String(req.query.all || '') === '1';

  try {
    /* 주문에 회원·PC 정보를 붙여서 한 번에 가져옵니다 */
    const cols = 'order_id,member_id,pn,spec_id,days,amount,setup_fee,status,' +
                 'pay_method,paid_at,starts_at,ends_at,payer_name,user_name,user_phone,' +
                 'canceled_at,refund_amt,refund_why,tax_invoice,biz_no,created_at,' +
                 'members(name,phone,email,via),' +
                 'pcs(pn,room,rack,fl,slot,anydesk,spec_id,status,cpu,core,ram_gb,ssd_gb,gpu)';
    const where = all ? '' : '&status=in.(paid,assigned,ready)';
    const rows = await sb('orders', {
      query: `?select=${cols}${where}&order=ends_at.asc.nullslast&limit=3000`,
    });

    const now = Date.now();
    const orders = (rows || []).map(o => {
      const m = o.members || {};
      const ends = o.ends_at ? Date.parse(o.ends_at) : null;
      return {
        no: o.order_id,
        pn: o.pn,
        pc: o.pcs || null,
        specId: o.spec_id,
        nm: m.name || o.user_name || '(이름 없음)',
        ph: m.phone || o.user_phone || '',
        via: m.via || 'manual',
        email: m.email || null,
        payer: o.payer_name || m.name || null,
        userNm: o.user_name || m.name || null,
        userPh: o.user_phone || m.phone || null,
        /* 입금자와 실제 쓰는 분이 다르면 관리자 화면에서 경고로 띄웁니다 */
        mis: !!(o.payer_name && o.user_name && o.payer_name !== o.user_name),
        pm: o.pay_method || '—',
        days: o.days,
        amt: o.amount,
        setup: o.setup_fee,
        st: o.status,
        start: o.starts_at,
        end: o.ends_at,
        left: ends === null ? null : Math.ceil((ends - now) / DAY),
        paidAt: o.paid_at,
        canceledAt: o.canceled_at,
        refundAmt: o.refund_amt,
        refundWhy: o.refund_why,
        taxInvoice: !!o.tax_invoice,
        bizNo: o.biz_no || null,
      };
    });

    /* 회원 — 전화번호로 묶습니다 (같은 분이 여러 대를 쓰실 수 있습니다) */
    const byPhone = {};
    for (const o of orders) {
      const key = o.ph || o.nm;
      const m = byPhone[key] || (byPhone[key] = {
        nm: o.nm, ph: o.ph, via: o.via, email: o.email,
        pcs: [], orders: [], total: 0, firstAt: o.paidAt || o.start,
      });
      if (o.pn && !m.pcs.includes(o.pn)) m.pcs.push(o.pn);
      m.orders.push(o.no);
      m.total += (o.amt || 0);
      if (o.paidAt && (!m.firstAt || o.paidAt < m.firstAt)) m.firstAt = o.paidAt;
    }
    const members = Object.values(byPhone).sort((a, b) => b.total - a.total);

    res.status(200).json({
      ok: true,
      at: new Date().toISOString(),
      counts: {
        live: orders.filter(o => o.st === 'assigned').length,
        waiting: orders.filter(o => o.st === 'ready').length,
        unassigned: orders.filter(o => o.st === 'paid').length,   // 결제됐는데 배정 안 된 것
        expiring: orders.filter(o => o.left !== null && o.left <= 5 && o.left >= 0).length,
        expired: orders.filter(o => o.left !== null && o.left < 0).length,
      },
      revenue: orders.reduce((s, o) => s + (o.amt || 0), 0),
      members,
      orders,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 250) });
  }
};
