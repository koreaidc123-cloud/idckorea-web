/* ═══════════════════════════════════════════════════════════════
   애니데스크 비밀번호 열람 — 한 번에 한 대만, 기록을 남기고

   GET /api/pc-secret?pn=Y-042

   · 관리자 출입증(쿠키)이 없으면 아무것도 안 줍니다.
   · 한 번 열람할 때마다 view_log 에 기록이 남습니다.
     (나중에 "누가 언제 이 고객 비밀번호를 봤나"를 확인할 수 있어야 합니다)
   · 목록 조회(/api/pcs)로는 절대 나가지 않습니다. 반드시 여기로 한 대씩입니다.

   ※ 고객에게 전달할 때 쓰는 copyText 에는 위치 정보가 들어가지 않습니다.
      서버실 이름·랙 번호가 고객에게 새는 것을 막기 위해서입니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify } = require('./admin-login');
const kv = require('./_crypto');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const pn = String(req.query.pn || '').toUpperCase().trim();
  if (!/^[KYD]-\d{3}$/.test(pn)) return res.status(400).json({ error: '품번 형식이 올바르지 않습니다' });

  try {
    const rows = await sb('pcs', {
      query: `?select=pn,anydesk,pw_enc&pn=eq.${encodeURIComponent(pn)}&limit=1`,
    });
    const p = rows && rows[0];
    if (!p) return res.status(404).json({ error: '없는 품번입니다' });

    const pw = kv.open(p.pw_enc);

    /* 기록을 먼저 남깁니다. 기록이 실패해도 열람은 되게 하되, 조용히 넘기지 않습니다. */
    let logged = true;
    try {
      await sb('view_log', {
        method: 'POST',
        body: [{ pn, act: '비밀번호 열람', who: '관리자' }],
        prefer: 'return=minimal',
      });
    } catch (e) { logged = false; }

    res.status(200).json({
      pn: p.pn,
      anydesk: p.anydesk || null,
      pw: pw,
      /* 고객에게 그대로 붙여넣어 보낼 수 있는 문구 — 위치는 들어가지 않습니다 */
      copyText: pw && p.anydesk
        ? `[한국 가상컴] 접속 정보\n접속 주소 : ${p.anydesk}\n비밀번호 : ${pw}\n문의번호 : ${p.pn}`
        : null,
      logged,
      note: pw ? null : '비밀번호가 아직 등록되지 않았습니다',
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
