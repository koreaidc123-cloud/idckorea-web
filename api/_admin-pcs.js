/* ═══════════════════════════════════════════════════════════════
   PC 목록 조회 — 관리자 화면(랙맵·PC관리·대시보드)이 읽는 곳

   GET  /api/pcs            전체
   GET  /api/pcs?room=Y     서버실별

   · 관리자 출입증(쿠키)이 없으면 아무것도 안 줍니다.
   · 애니데스크 비밀번호는 이 길로 절대 나가지 않습니다.
     비밀번호는 /api/pc-secret 에서 한 대씩, 열람 기록을 남기고 꺼냅니다.
   · "다운" 판정은 서버가 합니다 — 마지막 신호가 down_sec 보다 오래됐으면 다운.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { sweepExpired } = require('./_sweep');
const { verify } = require('./admin-login');
const { guessSpec } = require('./_spec');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const room = String(req.query.room || '').toUpperCase();
  const where = ['K', 'Y', 'D'].includes(room) ? `&room=eq.${room}` : '';

  /* 기간이 끝난 주문을 먼저 정리합니다.
     이걸 안 하면 만료된 PC 가 계속 임대중으로 남아 다시 팔 수 없습니다. */
  await sweepExpired();

  try {
    /* 비밀번호(pw_enc)는 select 목록에서 아예 빼둡니다 — 실수로 새어나갈 길을 막습니다 */
    const cols = 'pn,room,rack,fl,slot,cpu,core,ram_gb,ssd_gb,gpu,spec_id,' +
                 'anydesk,ip,status,online,in_use,up_sec,last_beat,note';

    const [rows, setRows, unreg] = await Promise.all([
      sb('pcs', { query: `?select=${cols}${where}&order=room.asc,rack.asc,fl.asc,slot.asc&limit=5000` }),
      sb('settings', { query: '?select=k,v' }),
      sb('pcs_unregistered', { query: '?select=*&order=last_beat.desc&limit=200' }),
    ]);

    /* ── 상품번호가 빠진 PC 를 그 자리에서 채웁니다 ────────────────
       ★ 2026-08-20 정환님 지적 — Y-006(3800XT) 이 고객 화면에
         실제 칩 이름 그대로 + 0원으로 나갔습니다.
         어제 _spec.js 에 3800XT 규칙을 넣었지만 그건 "새로 등록할 때"만
         돕습니다. 규칙이 생기기 전에 등록된 PC 는 상품번호가 빈 채 남고,
         그런 PC 는 ① 고객 화면에서 상품표를 못 찾아 0원으로 보이고
         ② 결제 자동배정이 spec_id 로 찾으므로 영영 배정이 안 됩니다.

       그래서 관리자 화면을 열 때마다 빈 것을 다시 맞혀 봅니다.
       등록 때 쓰는 것과 같은 guessSpec 이라 판단 기준도 같고,
       확실하지 않으면 그대로 두므로(null) 잘못 붙을 걱정이 없습니다.
       실패해도 목록 조회는 계속돼야 하므로 조용히 넘어갑니다. */
    for (const p of (rows || [])) {
      if (p.spec_id) continue;
      const g = guessSpec(p.cpu, p.ram_gb, p.ssd_gb, p.gpu);
      if (!g) continue;
      try {
        await sb('pcs', {
          method: 'PATCH', prefer: 'return=minimal',
          query: `?pn=eq.${encodeURIComponent(p.pn)}&spec_id=is.null`,
          body: { spec_id: g },
        });
        p.spec_id = g;
        try {
          await sb('view_log', { method: 'POST', prefer: 'return=minimal',
            body: [{ pn: p.pn, act: `상품번호 자동 지정 → ${g}번 (${p.cpu || ''})`.slice(0, 120), who: '시스템' }] });
        } catch (e) {}
      } catch (e) {}
    }

    /* 걸어둔 명령(재부팅 등) — 지금 대기중인 것만 따로 물어봅니다.
       ★ 왜 따로 물어보나
         cmd 칸은 03/06-B SQL 을 돌려야 생깁니다. 아직 안 돌린 곳에서 위
         목록에 cmd 를 끼워 넣으면 PC 목록 "전체" 가 안 나옵니다.
         재부팅 하나 때문에 관리자 화면이 통째로 죽으면 안 되므로,
         따로 물어보고 실패하면 조용히 넘어갑니다. */
    let cmdRows = [];
    try {
      cmdRows = await sb('pcs', {
        query: '?select=pn,cmd,cmd_at&cmd=not.is.null&limit=1000',
      }) || [];
    } catch (e) { cmdRows = []; }
    const pending = Object.fromEntries(cmdRows.map(r => [r.pn, r]));

    const set = Object.fromEntries((setRows || []).map(r => [r.k, r.v]));

    /* 관리자가 지운 미등록 PC 는 다시 신호가 와도 안 보이게 걸러냅니다.
       그 PC 가 켜져 있으면 2분마다 계속 올라오기 때문입니다.
       지운 것이 영영 안 보이면 그것도 위험하므로, 몇 대를 숨겼는지는
       화면에 알려주고 [다시 보이기] 로 되돌릴 수 있게 했습니다. */
    let hidden = [];
    try {
      const h = JSON.parse(set.lost_hidden || '[]');
      if (Array.isArray(h)) hidden = h;
    } catch (e) {}
    const unregShown = (unreg || []).filter(u => !hidden.includes(u.hw_id));
    const downSec = Number(set.down_sec || 180);
    const now = Date.now();

    const pcs = (rows || []).map(p => {
      const age = p.last_beat ? Math.round((now - Date.parse(p.last_beat)) / 1000) : null;
      // 신호가 끊긴 지 오래면 상태와 무관하게 다운으로 봅니다
      const dead = age === null || age > downSec;
      const q = pending[p.pn];
      return Object.assign({}, p, {
        beatAge: age,
        live: !dead && p.online,
        status: dead && p.status !== 'new' ? 'down' : p.status,
        /* 대기중인 명령 — 화면에 "재부팅 대기중" 으로 보여줍니다.
           그 PC 가 다음 신호를 보낼 때 받아가고 이 값은 사라집니다. */
        cmd: q ? q.cmd : null,
        cmdAt: q ? q.cmd_at : null,
      });
    });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      at: new Date().toISOString(),
      settings: set,
      counts: pcs.reduce((o, p) => (o[p.status] = (o[p.status] || 0) + 1, o), {}),
      unregistered: unregShown,
      hiddenLost: hidden.length,
      pcs,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
