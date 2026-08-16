/* ═══════════════════════════════════════════════════════════════
   하트비트 수신 — 서버실 중계기가 랙PC 상태를 모아서 보내는 곳

   누가 부르나 : 각 서버실의 중계기 PC 1대 (agent/kvc-relay.ps1)
   얼마나 자주 : 1분마다, 단 "달라진 PC만". 10분마다 한 번은 전체.
                 (1,200대가 각자 쏘면 하루 172만 건이지만,
                  중계기가 모아서 변경분만 보내면 하루 수천 건입니다)

   보내는 모양
   POST /api/heartbeat
   Header  x-kvc-key: <KVC_RELAY_KEY>
   Body    {
             "room": "Y",
             "full": false,
             "pcs": [
               { "pn":"Y-042", "hwId":"MB123", "online":true, "inUse":true,
                 "ip":"192.168.0.42", "cpu":"AMD Ryzen 7 3700X", "core":"8코어",
                 "ramGb":32, "ssdGb":480, "gpu":"GTX 1060 6G",
                 "anydesk":"1042887613", "upSec":38210 }
             ]
           }

   ※ 애니데스크 비밀번호는 이 길로 보내지 않습니다.
      비밀번호는 세팅할 때 관리자 화면으로만 등록합니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb, upsert, authed } = require('./_supa');

const MAX = 3000;                       // 한 번에 받을 수 있는 PC 수
const isPn = s => /^[KYD]-\d{3}$/.test(s || '');
const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
};
const str = (v, len) => (typeof v === 'string' ? v.trim().slice(0, len) : null) || null;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authed(req, 'KVC_RELAY_KEY')) return res.status(401).json({ error: '인증 실패' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결', hint: 'SUPABASE 환경변수를 먼저 등록해 주세요' });

  const body = req.body || {};
  const room = str(body.room, 1);
  if (!['K', 'Y', 'D'].includes(room)) return res.status(400).json({ error: 'room 은 K/Y/D 중 하나' });
  if (!Array.isArray(body.pcs)) return res.status(400).json({ error: 'pcs 배열이 필요합니다' });
  if (body.pcs.length > MAX) return res.status(413).json({ error: `한 번에 ${MAX}대까지` });

  const now = new Date().toISOString();
  const known = [];      // 품번이 붙은 PC
  const unknown = [];    // 품번이 아직 없는 PC → 관리자 "미등록 PC" 화면으로

  for (const p of body.pcs) {
    const common = {
      ip: str(p.ip, 45),
      cpu: str(p.cpu, 80),
      core: str(p.core, 20),
      ram_gb: num(p.ramGb, 1, 1024),
      ssd_gb: num(p.ssdGb, 1, 100000),
      gpu: str(p.gpu, 80),
      anydesk: /^\d{6,12}$/.test(p.anydesk || '') ? p.anydesk : null,
    };

    if (isPn(p.pn)) {
      // 품번 앞글자와 서버실이 어긋나면 잘못 꽂힌 것 — 받지 않고 넘깁니다
      if (p.pn.charAt(0) !== room) continue;
      known.push(Object.assign({ pn: p.pn, room }, common, {
        online: p.online !== false,
        in_use: !!p.inUse,
        up_sec: num(p.upSec, 0, 4e9),
        last_beat: now,
        updated_at: now,
      }));
    } else if (str(p.hwId, 64)) {
      unknown.push(Object.assign({ hw_id: str(p.hwId, 64), room }, common, { last_beat: now }));
    }
  }

  try {
    /* 자리(rack·fl·slot)와 상태(status)는 건드리지 않습니다.
       그건 관리자가 정하는 값이고, 하트비트는 "지금 살아있는가"만 갱신합니다. */
    if (known.length) await upsert('pcs', known, 'pn');
    if (unknown.length) await upsert('pcs_unregistered', unknown, 'hw_id');

    /* 전체 스냅샷일 때만: 이번에 목록에 없던 PC 는 신호가 끊긴 것으로 표시 */
    let markedOffline = 0;
    if (body.full === true && known.length) {
      const pns = known.map(x => `"${x.pn}"`).join(',');
      const r = await sb('pcs', {
        method: 'PATCH',
        query: `?room=eq.${room}&pn=not.in.(${pns})&online=is.true`,
        body: { online: false, in_use: false, updated_at: now },
        prefer: 'return=representation',
      });
      markedOffline = Array.isArray(r) ? r.length : 0;
    }

    res.status(200).json({ ok: true, saved: known.length, unregistered: unknown.length, markedOffline });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
