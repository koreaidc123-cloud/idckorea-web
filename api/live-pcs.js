/* ═══════════════════════════════════════════════════════════════
   고객이 보는 실시간 PC 목록 — 로그인 없이 누구나 봅니다

   GET /api/live-pcs

   ★ 고객에게 나가면 안 되는 것 (여기서 아예 select 하지 않습니다)
       애니데스크 번호 · 비밀번호 · 접속 토큰 · 내부 IP
       랙 위치(rack·fl·slot) · 메인보드 번호
     서버실은 알파벳(K/Y/D)만 나갑니다. 실명은 절대 나가지 않습니다.

   ★ 나가는 것
       품번(고객 문의번호) · 사양 · 임대 가능 여부

   관리자 화면(/api/pcs)과 같은 대장을 보므로 숫자가 어긋나지 않습니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  if (!ready()) {
    /* DB 연결 전에는 "아직 준비 중"임을 분명히 알립니다.
       화면이 지어낸 숫자를 보여주는 일은 이제 없습니다. */
    return res.status(200).json({ ready: false, pcs: [], total: 0, available: 0 });
  }

  try {
    const [rows, setRows] = await Promise.all([
      sb('pcs', {
        query: '?select=pn,room,spec_id,cpu,core,ram_gb,ssd_gb,gpu,status,online,last_beat' +
               '&status=neq.new&order=pn.asc&limit=5000',
      }),
      sb('settings', { query: '?select=k,v&k=eq.down_sec' }),
    ]);

    const downSec = Number((setRows && setRows[0] && setRows[0].v) || 180);
    const now = Date.now();

    const pcs = (rows || []).map(p => {
      const age = p.last_beat ? (now - Date.parse(p.last_beat)) / 1000 : null;
      const dead = age === null || age > downSec;
      /* 고객 화면에서는 세 가지로만 보여줍니다.
         free = 임대 가능 / busy = 임대중 / fix = 점검중
         신호가 끊긴 PC 는 임대 가능으로 내보내면 안 됩니다. */
      let st = 'fix';
      if (p.status === 'rent') st = 'busy';
      else if (p.status === 'ok' && !dead && p.online) st = 'free';
      return {
        id: p.pn,
        room: p.room,
        g: p.spec_id || null,
        st,
        cpu: p.cpu || null,
        core: p.core || null,
        ram: p.ram_gb || null,
        ssd: p.ssd_gb || null,
        gpu: p.gpu || null,
      };
    });

    /* 상품별 재고 — 메인 화면의 "지금 N대 즉시 임대 가능" 에 씁니다 */
    const bySpec = {};
    for (const p of pcs) {
      if (!p.g) continue;
      const s = bySpec[p.g] || (bySpec[p.g] = { specId: p.g, total: 0, available: 0 });
      s.total++;
      if (p.st === 'free') s.available++;
    }

    res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=20');
    res.status(200).json({
      ready: true,
      at: new Date().toISOString(),
      total: pcs.length,
      available: pcs.filter(p => p.st === 'free').length,
      specs: Object.values(bySpec).sort((a, b) => a.specId - b.specId),
      pcs,
    });
  } catch (e) {
    res.status(500).json({ ready: false, error: String(e.message || e).slice(0, 200), pcs: [] });
  }
};
