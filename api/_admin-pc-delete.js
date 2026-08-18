/* ═══════════════════════════════════════════════════════════════
   PC 대장에서 빼기

   POST /api/admin?do=pc-delete   { pn:"D-001" }

   ★ 왜 필요한가
     현장에서 서버실을 잘못 고르거나 랙 번호를 잘못 적어 등록되는 일이
     있습니다. 그동안은 지울 방법이 관리자에 없어서 Supabase 표 편집기를
     직접 열어야 했습니다. 랙 앞에 서서 할 수 있는 일이 아닙니다.

   ★ 함부로 지우면 안 되는 이유 — 두 가지를 막습니다
     1) 임대중인 PC
        고객이 쓰는 중입니다. 해지 처리를 먼저 해야 합니다.
     2) 지난 주문이 이 PC 를 가리키는 경우
        지우면 "그 고객이 어느 PC 를 썼는지" 이력이 통째로 끊깁니다.
        orders.pn 은 pcs.pn 을 참조하므로 데이터베이스도 거부합니다.
        이런 PC 는 지우지 말고 [점검중] 으로 돌려 판매에서만 빼야 합니다.

     그래서 실제로 지워지는 것은 "한 번도 팔린 적 없는 PC" 뿐입니다.
     잘못 등록한 PC 가 정확히 여기에 해당합니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify } = require('./admin-login');

const isPn = s => /^[KYD]-\d{3}$/.test(s || '');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const b = req.body || {};
  const pn = String(b.pn || '').toUpperCase().trim();
  const hwId = String(b.hwId || '').trim();

  /* ── 아직 품번이 없는 PC (pcs_unregistered) ────────────────────
     예전에 테스트하던 PC 가 신호만 계속 보내서 목록에 남아 있는 경우입니다.
     품번이 없으니 주문이 걸릴 수 없어, 이력 검사 없이 바로 지웁니다.

     ※ 그 PC 가 켜져 있으면 다음 신호에 다시 올라옵니다.
       지우는 것은 "목록에서 치우는 것" 이지 그 PC 를 멈추는 게 아닙니다.
       화면에서도 그렇게 안내합니다. */
  if (!pn && hwId) {
    if (hwId.length < 4 || hwId.length > 128) {
      return res.status(400).json({ error: '어느 PC 를 뺄지 알 수 없습니다' });
    }
    try {
      await sb('pcs_unregistered', {
        method: 'DELETE',
        query: `?hw_id=eq.${encodeURIComponent(hwId)}`,
        prefer: 'return=minimal',
      });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
    }
    try {
      await sb('view_log', {
        method: 'POST', prefer: 'return=minimal',
        body: [{ pn: null, act: `미등록 PC 삭제 (${hwId})`, who: '관리자' }],
      });
    } catch (e) {}
    return res.status(200).json({ ok: true, hwId });
  }

  if (!isPn(pn)) return res.status(400).json({ error: '어느 PC 를 뺄지 알 수 없습니다' });

  /* 지금 상태를 먼저 봅니다 */
  let cur;
  try {
    const rows = await sb('pcs', {
      query: `?select=pn,room,rack,fl,slot,status,anydesk&pn=eq.${encodeURIComponent(pn)}&limit=1`,
    });
    cur = rows && rows[0];
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
  if (!cur) return res.status(404).json({ error: '없는 품번입니다' });

  if (cur.status === 'rent') {
    return res.status(409).json({
      error: `${pn} 은 지금 임대중입니다.\n해지 처리를 먼저 하신 뒤에 빼주세요.`,
    });
  }

  /* 지난 주문이 걸려 있으면 지우지 않습니다 (이력 보호) */
  try {
    const used = await sb('orders', {
      query: `?select=order_id&pn=eq.${encodeURIComponent(pn)}&limit=1`,
    });
    if (used && used.length) {
      return res.status(409).json({
        error: `${pn} 은 지난 주문 기록이 있어 뺄 수 없습니다.\n` +
               `빼면 그 고객이 어느 PC 를 썼는지 이력이 끊깁니다.\n\n` +
               `대신 [점검중] 으로 돌려 두시면 고객 화면에서는 빠집니다.`,
      });
    }
  } catch (e) { /* 주문을 못 읽어도 아래 삭제에서 데이터베이스가 한 번 더 막습니다 */ }

  try {
    await sb('pcs', {
      method: 'DELETE',
      query: `?pn=eq.${encodeURIComponent(pn)}`,
      prefer: 'return=minimal',
    });
  } catch (e) {
    const m = String(e.message || e);
    /* 외래키 위반 — 주문이 아직 이 PC 를 가리키고 있습니다 */
    if (/23503|foreign key|violates/.test(m)) {
      return res.status(409).json({
        error: `${pn} 을 쓰는 주문이 남아 있어 뺄 수 없습니다.\n[점검중] 으로 돌려 주세요.`,
      });
    }
    return res.status(500).json({ error: m.slice(0, 200) });
  }

  /* 누가 언제 무엇을 뺐는지 남깁니다 */
  try {
    await sb('view_log', {
      method: 'POST', prefer: 'return=minimal',
      body: [{
        pn,
        act: `PC 대장에서 삭제 (${cur.room}${cur.rack}-${cur.fl}-${cur.slot}` +
             (cur.anydesk ? ` · 애니데스크 ${cur.anydesk}` : '') + ')',
        who: '관리자',
      }],
    });
  } catch (e) {}

  res.status(200).json({ ok: true, pn });
};
