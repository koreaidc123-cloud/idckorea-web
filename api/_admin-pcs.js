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
      unregistered: unreg || [],
      pcs,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
