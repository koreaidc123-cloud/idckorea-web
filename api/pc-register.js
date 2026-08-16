/* ═══════════════════════════════════════════════════════════════
   랙PC 등록 — 현장에서 PC 한 대당 딱 한 번만 부릅니다

   세팅하시는 분이 kvc-agent.ps1 -Setup 을 돌리면 여기로 옵니다.
     보내는 것 : 품번(Y-042) + 현장 등록 암호 + 읽어온 사양
     받는 것   : 그 PC 전용 토큰 + 데이터베이스 주소 + 공개키

   이후로는 서버를 거치지 않고 데이터베이스에 직접 하트비트를 씁니다.
   그래서 이 함수는 PC 한 대당 평생 한 번만 호출됩니다.

   ※ 현장 등록 암호(KVC_SETUP_KEY)로 할 수 있는 일은
      "새 PC 를 미등록 상태로 올리고 토큰을 받는 것" 뿐입니다.
      고객 정보도, 주문도, 다른 PC 도 건드릴 수 없습니다.
   ═══════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const { ready, sb, authed } = require('./_supa');

const isPn = s => /^[KYD]-\d{3}$/.test(s || '');
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null) || null;
const num = (v, lo, hi) => {
  const x = Number(v);
  return Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x) : null;
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!process.env.KVC_SETUP_KEY) {
    return res.status(503).json({ error: 'KVC_SETUP_KEY 가 등록되지 않았습니다' });
  }
  if (!authed(req, 'KVC_SETUP_KEY')) {
    await new Promise(r => setTimeout(r, 700));
    return res.status(401).json({ error: '현장 등록 암호가 맞지 않습니다' });
  }
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const pubKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
  if (!pubKey) {
    return res.status(503).json({ error: 'SUPABASE_PUBLISHABLE_KEY 가 등록되지 않았습니다' });
  }

  const b = req.body || {};
  const pn = String(b.pn || '').toUpperCase().trim();
  if (!isPn(pn)) return res.status(400).json({ error: '품번 형식은 K-001 · Y-042 · D-113 입니다' });

  /* 이 PC 전용 열쇠. 32바이트 무작위 = 사실상 추측 불가 */
  const token = crypto.randomBytes(24).toString('base64url');
  const now = new Date().toISOString();

  const row = {
    pn,
    room: pn.charAt(0),
    /* 자리는 관리자가 정합니다. 등록 시점에는 0 으로 두고 "미등록"으로 올립니다. */
    rack: 0, fl: 0, slot: 0,
    hw_id: str(b.hwId, 64),
    cpu: str(b.cpu, 80),
    core: str(b.core, 20),
    ram_gb: num(b.ramGb, 1, 1024),
    ssd_gb: num(b.ssdGb, 1, 100000),
    gpu: str(b.gpu, 80),
    ip: str(b.ip, 45),
    anydesk: /^\d{6,12}$/.test(b.anydesk || '') ? b.anydesk : null,
    beat_token: token,
    online: true,
    last_beat: now,
    updated_at: now,
  };

  try {
    /* 이미 있는 품번이면 토큰만 새로 발급합니다 (PC 를 다시 세팅한 경우).
       자리·상태는 관리자가 정한 값을 그대로 둡니다. */
    const found = await sb('pcs', { query: `?select=pn,rack,fl,slot,status&pn=eq.${encodeURIComponent(pn)}&limit=1` });
    const exists = found && found[0];

    if (exists) {
      delete row.rack; delete row.fl; delete row.slot;
      await sb('pcs', {
        method: 'PATCH',
        query: `?pn=eq.${encodeURIComponent(pn)}`,
        body: row,
        prefer: 'return=minimal',
      });
    } else {
      row.status = 'new';                       // 관리자 "미등록 PC" 화면으로 갑니다
      await sb('pcs', { method: 'POST', body: [row], prefer: 'return=minimal' });
    }

    res.status(200).json({
      ok: true,
      pn,
      token,
      supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
      publicKey: pubKey,
      beatSec: Number(process.env.KVC_BEAT_SEC || 120),   // 몇 초마다 보낼지
      renewed: !!exists,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
