/* ═══════════════════════════════════════════════════════════════
   PC 정보 수정 — 관리자 화면에서 고친 것을 서버에 저장합니다

   POST /api/pc-update
   { key:"Y-001",                 ← 지금 품번 (누구를 고칠지)
     pn:"Y-042",                  ← 새 품번 (품번 부여·변경)
     room:"Y", rack:5, fl:4, slot:1,
     anydesk:"1042887613",
     pw:"한국1212",               ← 애니데스크 비밀번호 (자물쇠 채워 저장)
     status:"ok",
     note:"..." }

   ★ 이게 없으면 관리자에서 고쳐도 화면에만 반영되고,
     30초 뒤 서버에서 다시 받아올 때 원래대로 돌아갑니다.

   고친 내용은 view_log 에 남습니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify } = require('./admin-login');
const kv = require('./_crypto');

const isPn = s => /^[KYD]-\d{3}$/.test(s || '');
const ST = ['new', 'unv', 'ok', 'rent', 'fix', 'down'];
const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const b = req.body || {};
  const key = String(b.key || '').toUpperCase().trim();
  if (!isPn(key)) return res.status(400).json({ error: '어느 PC 를 고칠지 알 수 없습니다' });

  const patch = {};
  const logs = [];

  /* 지금 값을 먼저 읽어서, 실제로 달라진 것만 고치고 기록합니다 */
  let cur;
  try {
    const rows = await sb('pcs', {
      query: `?select=pn,room,rack,fl,slot,anydesk,status,note&pn=eq.${encodeURIComponent(key)}&limit=1`,
    });
    cur = rows && rows[0];
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
  if (!cur) return res.status(404).json({ error: '없는 품번입니다' });

  /* ── 품번 ── */
  if (b.pn !== undefined && b.pn !== null && String(b.pn).trim() !== '') {
    const pn = String(b.pn).toUpperCase().trim();
    if (!isPn(pn)) return res.status(400).json({ error: '품번 형식은 K-001 · Y-042 · D-113 입니다' });
    if (pn !== cur.pn) {
      const room = String(b.room || cur.room).toUpperCase();
      if (pn.charAt(0) !== room) {
        return res.status(400).json({ error: `품번 앞글자(${pn.charAt(0)})와 서버실(${room})이 다릅니다` });
      }
      patch.pn = pn;
      logs.push(`품번 변경 ${cur.pn} → ${pn}`);
    }
  }

  /* ── 서버실·자리 ── */
  const room = b.room !== undefined ? String(b.room).toUpperCase() : null;
  if (room && !['K', 'Y', 'D'].includes(room)) return res.status(400).json({ error: '서버실은 K/Y/D 입니다' });
  const rack = b.rack !== undefined ? num(b.rack, 0, 999) : null;
  const fl = b.fl !== undefined ? num(b.fl, 0, 99) : null;
  const slot = b.slot !== undefined ? num(b.slot, 0, 99) : null;
  if (room && room !== cur.room) patch.room = room;
  if (rack !== null && rack !== cur.rack) patch.rack = rack;
  if (fl !== null && fl !== cur.fl) patch.fl = fl;
  if (slot !== null && slot !== cur.slot) patch.slot = slot;
  if (patch.room || patch.rack !== undefined || patch.fl !== undefined || patch.slot !== undefined) {
    logs.push(`위치 이동 ${cur.room}${cur.rack}-${cur.fl}-${cur.slot} → ` +
              `${room || cur.room}${rack ?? cur.rack}-${fl ?? cur.fl}-${slot ?? cur.slot}`);
  }

  /* ── 애니데스크 번호 ── */
  if (b.anydesk !== undefined && String(b.anydesk).trim() !== '') {
    const ad = String(b.anydesk).trim();
    if (!/^\d{6,12}$/.test(ad)) return res.status(400).json({ error: '애니데스크 번호는 숫자 6~12자리입니다' });
    if (ad !== cur.anydesk) { patch.anydesk = ad; logs.push('애니데스크 번호 변경'); }
  }

  /* ── 애니데스크 비밀번호 (자물쇠를 채워 넣습니다) ── */
  if (b.pw !== undefined && String(b.pw).trim() !== '') {
    const pw = String(b.pw).trim();
    if (pw.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다' });
    if (!kv.ready()) return res.status(503).json({ error: 'KVC_SECRET 이 없어 비밀번호를 보관할 수 없습니다' });
    patch.pw_enc = kv.seal(pw);
    logs.push('애니데스크 비밀번호 변경');
  }

  /* ── 상태 ── */
  if (b.status !== undefined && b.status !== null && String(b.status).trim() !== '') {
    const st = String(b.status);
    if (!ST.includes(st)) return res.status(400).json({ error: '알 수 없는 상태입니다' });
    if (st !== cur.status) { patch.status = st; logs.push(`상태 ${cur.status} → ${st}`); }
  }

  /* ── 메모 ── */
  if (b.note !== undefined && String(b.note) !== String(cur.note || '')) {
    patch.note = String(b.note).slice(0, 500) || null;
    logs.push('메모 수정');
  }

  if (!Object.keys(patch).length) return res.status(200).json({ ok: true, changed: 0 });

  patch.updated_at = new Date().toISOString();

  try {
    await sb('pcs', {
      method: 'PATCH',
      query: `?pn=eq.${encodeURIComponent(key)}`,
      body: patch,
      prefer: 'return=minimal',
    });
  } catch (e) {
    const m = String(e.message || e);
    /* 겹치는 값이면 사람이 알아볼 수 있게 알려줍니다 */
    if (/23505|duplicate key/.test(m)) {
      if (/pcs_pkey/.test(m)) return res.status(409).json({ error: '그 품번은 이미 다른 PC 가 쓰고 있습니다' });
      if (/pcs_slot_unique/.test(m)) return res.status(409).json({ error: '그 자리에는 이미 다른 PC 가 있습니다' });
      return res.status(409).json({ error: '이미 쓰이고 있는 값입니다' });
    }
    return res.status(500).json({ error: m.slice(0, 200) });
  }

  /* 무엇을 고쳤는지 남깁니다 */
  try {
    if (logs.length) {
      await sb('view_log', {
        method: 'POST', prefer: 'return=minimal',
        body: logs.map(act => ({ pn: patch.pn || key, act, who: '관리자' })),
      });
    }
  } catch (e) {}

  res.status(200).json({ ok: true, pn: patch.pn || key, changed: logs.length, logs });
};
