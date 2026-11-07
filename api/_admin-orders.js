/* ═══════════════════════════════════════════════════════════════
   주문 · 회원 조회 — 관리자 화면이 읽는 곳

   GET /api/orders          이용중 + 최근 끝난 것
   GET /api/orders?all=1    진행중 전부 + 끝난 것 최근 2000건 (넘으면 historyCut=true)

   · 관리자 출입증(쿠키)이 없으면 아무것도 안 줍니다.
   · 애니데스크 비밀번호는 여기로 나가지 않습니다 (/api/pc-secret 에서 한 대씩).
   · 회원 목록은 주문에서 뽑아 만들어 줍니다 — 화면이 따로 계산할 필요가 없게.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb, missingCol } = require('./_supa');
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
    /* ★ 2026-11-07 — 예전엔 all=1 일 때 전부를 만료일 오름차순으로 3000건만 받았습니다.
         지난 주문(만료·환불)이 쌓여 3000건을 넘으면, 만료일이 늦은 "지금 쓰는 주문" 이
         뒤로 밀려 잘렸습니다 — 이용중인 고객이 관리자 화면에서 사라지는 사고입니다.
       이제 두 번에 나눠 받습니다.
         ① 진행중(결제 대기·결제완료·이용중) — 개수 제한 없이 전부 (1000건씩 여러 번)
         ② 끝난 것(만료·환불·취소) — 최근 것부터 2000건까지만. 넘으면 historyCut=true
       ※ Supabase 는 한 번에 최대 1000줄만 주므로 1000건씩 끊어 받습니다. */
    /* max 를 안 주면 마지막 페이지까지 끝까지 받습니다 (진행중 주문은 절대 자르지 않음 — Codex T-0179) */
    const fetchAll = async (q, max = Infinity) => {
      const out = [];
      for (let off = 0; off < max; off += 1000) {
        const n = Math.min(1000, max - off);
        const page = await sb('orders', { query: `${q}&limit=${n}&offset=${off}` }) || [];
        out.push(...page);
        if (page.length < n) break;
      }
      return out;
    };
    const HIST_MAX = 2000;
    /* 환불 송금 추적 칸(refund_state·refund_done_at)은 db/08 SQL 을 돌려야 생깁니다.
       없으면 그 칸만 빼고 다시 받습니다 — 목록 전체가 안 나오면 안 되므로. */
    let refundCols = true;
    /* ★ 연장 결제 칸(kind·parent_id·ext_from·ext_to·applied_at)은 db/10 SQL 을 돌려야 생깁니다 (2026-11-08).
         없으면 그 칸만 빼고 받습니다. 있으면
           · 기간을 늘려 둔 연장 줄(applied) 중 아직 안 끝난 것은 개수 제한 없이 받습니다
             (원 주문 상세에 "연장 내역" 을 보여주고, 마지막 연장만 환불할 수 있게)
           · 끝난 연장 줄은 지난 주문과 같이 최근 2000건 안에서 받습니다 */
    let extCols = true;
    const load = async (c, withRefund, withExt) => {
      const active = await fetchAll(
        `?select=${c}&status=in.(paid,assigned,ready)&order=ends_at.asc.nullslast,order_id.asc`);
      /* 1건 더 받아 봐서, 정말 2000건을 넘을 때만 "생략됨" 이라고 합니다 (딱 2000건이면 생략 아님) */
      const hist = all ? await fetchAll(
        `?select=${c}&status=in.(expired,refunded,canceled${withExt ? ',applied' : ''})&order=ends_at.desc.nullslast,order_id.asc`, HIST_MAX + 1) : [];
      /* ★ 직접 송금 대기 환불은 오래됐어도 끝까지 받습니다. 2000건 밖으로 밀려
           [오늘 할 일] 에서 사라지면 고객에게 돈을 안 보낸 채 잊게 됩니다 (Codex T-0179) */
      const owed = withRefund ? await fetchAll(
        `?select=${c}&status=in.(refunded,canceled)&refund_state=eq.manual_pending&order=order_id.asc`) : [];
      const ext = withExt ? await fetchAll(
        `?select=${c}&status=eq.applied&ends_at=gte.${new Date().toISOString()}&order=order_id.asc`) : [];
      return { active, hist, owed, ext };
    };
    const EXT_SEL = ',kind,parent_id,ext_from,ext_to,applied_at';
    const REF_SEL = ',refund_state,refund_done_at';
    let got;
    /* 칸이 없다는 오류가 나면 그 묶음만 빼고 다시 — 08 · 10 을 각각 돌렸는지와 상관없이 목록이 나와야 합니다 */
    for (let tries = 0; ; tries++) {
      try {
        got = await load(cols + (refundCols ? REF_SEL : '') + (extCols ? EXT_SEL : ''), refundCols, extCols);
        break;
      } catch (e) {
        if (tries < 2 && extCols && /kind|parent_id|ext_from|ext_to|applied_at/.test(String(e.message || '')) && missingCol(e)) { extCols = false; continue; }
        if (tries < 2 && refundCols && missingCol(e, 'refund_')) { refundCols = false; continue; }
        throw e;
      }
    }
    const historyCut = got.hist.length > HIST_MAX;
    const hist = got.hist.slice(0, HIST_MAX);
    const seen = new Set(got.active.concat(hist).map(o => o.order_id));
    const extra = got.owed.concat(got.ext).filter(o => !seen.has(o.order_id) && (seen.add(o.order_id), true));
    const rows = got.active.concat(hist, extra);

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
        /* 결제 대기(ready) 주문을 "최근 24시간" 것만 보여주려고 언제 만들어졌는지 같이 줍니다 */
        createdAt: o.created_at || null,
        canceledAt: o.canceled_at,
        refundAmt: o.refund_amt,
        refundWhy: o.refund_why,
        taxInvoice: !!o.tax_invoice,
        bizNo: o.biz_no || null,
        /* 환불 송금 상태 — toss_done · manual_pending(직접 보내야 함) · manual_done */
        refundState: o.refund_state || null,
        refundDoneAt: o.refund_done_at || null,
        /* 연장 결제 (db/10) — kind:'extend' 면 원 주문 parent 의 기간을 extFrom ~ extTo 만큼 늘린 줄 */
        kind: o.kind || 'new',
        parent: o.parent_id || null,
        extFrom: o.ext_from || null,
        extTo: o.ext_to || null,
        appliedAt: o.applied_at || null,
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
      historyCut,          // 지난 주문이 너무 많아 오래된 것은 빼고 보냈는가
      refundCols,          // 환불 송금 추적 칸이 있는가 (false 면 db/08 SQL 실행 필요)
      counts: {
        live: orders.filter(o => o.st === 'assigned').length,
        waiting: orders.filter(o => o.st === 'ready').length,
        unassigned: orders.filter(o => o.st === 'paid').length,   // 결제됐는데 배정 안 된 것
        /* 연장 줄은 원 주문과 같은 날 끝나므로 두 번 세지 않습니다 */
        expiring: orders.filter(o => o.kind !== 'extend' && o.left !== null && o.left <= 5 && o.left >= 0).length,
        expired: orders.filter(o => o.kind !== 'extend' && o.left !== null && o.left < 0).length,
      },
      extCols,             // 연장 결제 칸이 있는가 (false 면 db/10 SQL 전)
      revenue: orders.reduce((s, o) => s + (o.amt || 0), 0),
      members,
      orders,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 250) });
  }
};
