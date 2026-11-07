/* ═══════════════════════════════════════════════════════════════
   정산 · 대사 — 토스 거래내역과 우리 주문을 맞대 봅니다 (2026-11-08 · C1)

   GET /api/admin?do=recon&from=2026-11-01&to=2026-11-07     (최대 31일)

   ★ 왜 필요한가
     결제는 토스가 받고, PC 배정은 우리 DB 가 합니다. 둘 사이 통신이 끊기거나
     오류가 나면 "돈은 빠져나갔는데 PC 가 없는 손님" 이 생길 수 있습니다.
     손님이 문의하기 전에 우리가 먼저 찾으려고 만든 화면입니다.

   ★ 이 기능은 아무것도 바꾸지 않습니다 (읽기 전용).
     토스에는 GET(조회)만, DB 에도 읽기만 합니다. 고치는 일은 사람이 주문 상세에서 합니다.

   돌려주는 묶음 다섯 가지
     tossOnly           토스에는 결제가 있는데 우리 DB 에 그 주문이 아예 없음
     doneButNotPaid     토스는 결제 완료(DONE)인데 DB 는 결제 대기(ready)·취소(canceled)
                        → 돈은 받았는데 PC 를 못 드린 손님 (가장 급함)
     canceledButActive  토스는 전액 취소인데 DB 는 아직 결제완료·이용중
     amountDiff         토스가 받은 금액 ≠ DB 주문 금액
     refundDiff         토스가 돌려준 금액 ≠ DB 환불 금액 (직접 송금 환불은 토스에 없으므로 뺍니다)

   ★ 토스 거래내역 API (GET /v1/transactions) 를 쓰는 방식
     · startDate · endDate 는 한국 시각 'YYYY-MM-DDTHH:mm:ss' 로 보냅니다.
     · 한 번에 최대 5000건, 더 있으면 마지막 transactionKey 를 startingAfter 로 넘겨 이어 받습니다.
     · 거래 한 줄 = 승인 한 번 또는 취소 한 번 입니다. 같은 주문의 줄을 모아
       승인(DONE) 금액 합계 = 받은 돈, 취소(CANCELED·PARTIAL_CANCELED) 금액 합계 = 돌려준 돈 으로 봅니다.
       (실제 토스 응답 모양은 실결제 후 한 번 확인이 필요합니다 — 사용설명서에 적어 두었습니다)
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify } = require('./admin-login');
const { tossAuth, tossGet } = require('./_pay');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 31;
const PAGE = 5000;
const MAX_PAGES = 20;                       // 10만 건 — 이보다 많으면 기간을 줄여 달라고 합니다

/* 'YYYY-MM-DD' 가 진짜 있는 날짜인지 (2026-02-31 같은 것 거르기) */
function realDay(s) {
  if (!DAY.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00+09:00');
  if (!Number.isFinite(t)) return null;
  const back = new Date(t + 9 * 3600000).toISOString().slice(0, 10);
  return back === s ? t : null;
}

/* 토스 거래내역 전부 받아오기 (쪽 넘김) */
async function tossTransactions(from, to) {
  const all = [];
  let after = '';
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = new URLSearchParams({ startDate: from + 'T00:00:00', endDate: to + 'T23:59:59', limit: String(PAGE) });
    if (after) qs.set('startingAfter', after);
    let r, data;
    try {
      r = await fetch('https://api.tosspayments.com/v1/transactions?' + qs.toString(), {
        headers: { Authorization: tossAuth() },
      });
      data = await r.json().catch(() => null);
    } catch (e) {
      return { ok: false, error: '토스에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
    }
    if (r.status !== 200 || !Array.isArray(data)) {
      const code = data && data.code ? String(data.code).slice(0, 60) : String(r.status);
      return { ok: false, error: '토스 거래내역을 받지 못했습니다 (' + code + ')' };
    }
    all.push(...data);
    if (data.length < PAGE) return { ok: true, rows: all };
    /* ★ (Codex T-0185) 꽉 찬 쪽인데 다음 쪽 열쇠가 없거나 같은 열쇠가 또 오면 "다 받았다" 고 하지 않습니다.
       일부만 받은 채 "어긋난 것 없음" 이라고 보여주면 더 위험하기 때문입니다. */
    const last = data[data.length - 1];
    if (!last || !last.transactionKey || String(last.transactionKey) === after) {
      return { ok: false, error: '토스 거래내역을 끝까지 받지 못했습니다 (다음 쪽 정보 없음). 기간을 줄여 다시 해 주세요.' };
    }
    after = String(last.transactionKey);
  }
  return { ok: false, error: '거래가 너무 많습니다. 기간을 줄여서 다시 해 주세요.' };
}

/* 같은 주문의 거래 줄을 하나로 모읍니다 */
function groupToss(rows) {
  const by = {};
  for (const t of rows) {
    const id = String(t.orderId || '');
    if (!id) continue;
    const g = by[id] || (by[id] = { orderId: id, paymentKey: t.paymentKey || null, method: t.method || null,
      paid: 0, canceled: 0, last: null, lastAt: '', waiting: false });
    const amt = Math.abs(Number(t.amount) || 0);
    const st = String(t.status || '');
    if (st === 'DONE') g.paid += amt;
    else if (st === 'CANCELED' || st === 'PARTIAL_CANCELED') g.canceled += amt;
    else if (st === 'WAITING_FOR_DEPOSIT') g.waiting = true;
    const at = String(t.transactionAt || '');
    if (!g.last || at >= g.lastAt) { g.last = st; g.lastAt = at; }
    if (!g.paymentKey && t.paymentKey) g.paymentKey = t.paymentKey;
  }
  return by;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });
  /* 토스 키가 없으면 공개 시험 키로 조회하게 되어 엉뚱한(빈) 결과가 나옵니다 — 아예 막습니다.
     (키 값은 읽기만 하고 어디에도 내보내지 않습니다) */
  if (!process.env.TOSS_SECRET_KEY) return res.status(503).json({ error: '토스 시크릿 키(TOSS_SECRET_KEY)가 아직 등록되지 않았습니다' });

  const from = String((req.query || {}).from || '').trim();
  const to = String((req.query || {}).to || '').trim();
  const tf = realDay(from), tt = realDay(to);
  if (tf === null || tt === null) return res.status(400).json({ error: '날짜는 2026-11-01 처럼 적어 주세요' });
  if (tt < tf) return res.status(400).json({ error: '끝 날짜가 시작 날짜보다 앞입니다' });
  if ((tt - tf) / 86400000 + 1 > MAX_DAYS) return res.status(400).json({ error: `한 번에 ${MAX_DAYS}일까지만 대조할 수 있습니다` });

  const tx = await tossTransactions(from, to);
  if (!tx.ok) return res.status(502).json({ error: tx.error });
  const toss = groupToss(tx.rows);

  /* 우리 주문 — 그 기간(한국 날짜)에 만들어진 것 + 토스에 나온 주문번호 (기간 경계에 걸친 것) */
  const cols = 'order_id,pn,status,amount,refund_amt,pay_method,pay_key,created_at,paid_at,refund_state';
  const startIso = new Date(tf).toISOString();
  const endIso = new Date(tt + 86400000).toISOString();
  const db = {};
  try {
    let rows;
    try {
      rows = await sb('orders', { query: `?select=${cols}&created_at=gte.${startIso}&created_at=lt.${endIso}&order=created_at.asc&limit=5000` });
    } catch (e) {
      /* db/08 을 아직 안 돌려 refund_state 칸이 없을 때 — 그 칸만 빼고 다시 */
      if (!/refund_state/.test(String(e.message || e))) throw e;
      rows = await sb('orders', { query: `?select=${cols.replace(',refund_state', '')}&created_at=gte.${startIso}&created_at=lt.${endIso}&order=created_at.asc&limit=5000` });
    }
    for (const o of rows || []) db[o.order_id] = o;
    const missing = Object.keys(toss).filter(id => !db[id] && /^[A-Za-z0-9_-]{6,64}$/.test(id));
    for (let i = 0; i < missing.length; i += 100) {
      const list = missing.slice(i, i + 100).join(',');
      let more;
      try {
        more = await sb('orders', { query: `?select=${cols}&order_id=in.(${list})` });
      } catch (e) {
        if (!/refund_state/.test(String(e.message || e))) throw e;
        more = await sb('orders', { query: `?select=${cols.replace(',refund_state', '')}&order_id=in.(${list})` });
      }
      for (const o of more || []) db[o.order_id] = o;
    }
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }

  /* 한 주문을 다섯 묶음 중 어디에 넣을지 정합니다 (paid = 받은 돈, canceled = 돌려준 돈) */
  const judge = (t, o) => {
    const hit = [];
    if (!o) { if (t.paid > 0) hit.push('tossOnly'); return hit; }   // 입금 대기만 있는 것은 아직 돈이 안 들어온 것
    const net = t.paid - t.canceled;
    /* 돈은 받았는데(남은 금액 > 0) DB 는 결제 대기·취소 */
    if (net > 0 && ['ready', 'canceled'].includes(o.status)) hit.push('doneButNotPaid');
    /* 전액 취소됐는데 DB 는 아직 쓰는 중 */
    const activeButCanceled = t.paid > 0 && net <= 0 && ['paid', 'assigned'].includes(o.status);
    if (activeButCanceled) hit.push('canceledButActive');
    /* 받은 금액이 주문 금액과 다름 */
    if (t.paid > 0 && Number(o.amount) !== t.paid) hit.push('amountDiff');
    /* 돌려준 금액이 DB 환불 금액과 다름 — 직접 송금 환불(manual_*)은 토스와 무관해서 뺍니다.
       (위 "취소인데 이용중" 에 이미 나온 주문은 같은 일을 두 번 보여주지 않게 뺍니다) */
    const manual = /^manual_/.test(String(o.refund_state || ''));
    const dbRefund = Number(o.refund_amt) || 0;
    if (!activeButCanceled && !manual && (t.canceled > 0 || dbRefund > 0) && dbRefund !== t.canceled) hit.push('refundDiff');
    return hit;
  };

  /* ★ (Codex T-0185) 기간 안의 거래만 보면 틀릴 수 있습니다.
     예) 지난달에 결제 → 이번 달에 전액 취소 : 이번 달 거래에는 취소 줄만 있어 "받은 돈 0" 으로 보입니다.
     그래서 어긋나 보이는 주문과 "취소 줄만 있는" 주문은 토스에 그 결제의 지금 상태를 한 번 더 묻고
     (GET /v1/payments/{paymentKey} — 결제 총액 totalAmount · 남은 금액 balanceAmount) 그 값으로 다시 판정합니다.
     토스가 모르는 결제(시험 데이터 등)면 거래내역 합계를 그대로 씁니다. 조회는 최대 MAX_CHECK 건. */
  const MAX_CHECK = 150;
  let checked = 0, checkCut = false, checkFail = 0;
  const out = { tossOnly: [], doneButNotPaid: [], canceledButActive: [], amountDiff: [], refundDiff: [] };
  for (const id of Object.keys(toss)) {
    let t = toss[id];
    const o = db[id];
    let hit = judge(t, o);
    const partial = t.paid === 0 && t.canceled > 0;
    if ((hit.length || partial) && t.paymentKey) {
      if (checked >= MAX_CHECK) checkCut = true;
      else {
        checked++;
        const g = await tossGet({ paymentKey: t.paymentKey });
        /* ★ (Codex T-0186) 토스가 "그런 결제 없음" 이라고 한 것만 거래 합계로 대신합니다.
           연결 실패·토스 오류는 checkFail 로 세어, 화면이 "어긋난 것 없음" 이라고 말하지 못하게 합니다. */
        if (!g.ok && !g.notFound) checkFail++;
        const total = g.ok ? Number(g.pay.totalAmount) : NaN;
        if (g.ok && Number.isFinite(total)) {
          const bal = Number.isFinite(Number(g.pay.balanceAmount)) ? Number(g.pay.balanceAmount)
                    : (g.pay.status === 'CANCELED' ? 0 : total);
          const paidNow = ['DONE', 'CANCELED', 'PARTIAL_CANCELED'].includes(g.pay.status) ? total : 0;
          t = Object.assign({}, t, { paid: paidNow, canceled: paidNow ? Math.max(0, total - bal) : 0, last: g.pay.status, verified: true });
          hit = judge(t, o);
        }
      }
    }
    if (!hit.length) continue;
    const row = {
      orderId: id, method: t.method, tossStatus: t.last, tossPaid: t.paid, tossCanceled: t.canceled, tossAt: t.lastAt,
      verified: !!t.verified,
      dbStatus: o ? o.status : null, dbAmount: o ? o.amount : null, dbRefund: o ? o.refund_amt : null, pn: o ? o.pn : null,
    };
    for (const k of hit) out[k].push(row);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => String(a.tossAt).localeCompare(String(b.tossAt)));

  return res.status(200).json({
    ok: true, from, to,
    tossCount: tx.rows.length, tossOrders: Object.keys(toss).length, dbOrders: Object.keys(db).length,
    checked, checkCut, checkFail,
    groups: out,
  });
};
