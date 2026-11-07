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
const { checkLoc } = require('./_rooms');
const { guessSpec } = require('./_spec');

const isPn = s => /^[KYD]-\d{3}$/.test(s || '');
/* hold = 반납 유예 (기간이 끝났지만 며칠은 손님 자료를 남겨 둠 · 연장하면 그대로 돌아감)
   wipe = 초기화 대기 (앞 손님 자료를 지우고 애니데스크 비밀번호를 바꿔야 함)
   둘 다 고객에게는 "임대중" 으로 보이고, 자동 배정도 되지 않습니다 (2026-11-07) */
const ST = ['new', 'unv', 'ok', 'rent', 'fix', 'down', 'hold', 'wipe'];
const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
};

/* ── 품번 없이 신호만 오던 PC 에 품번 붙이기 ───────────────────────
   { hwId:"MB-...", pn:"D-002", room:"D", rack:1, fl:1, slot:2, status:"unv" }

   pcs_unregistered 의 한 줄(사양·애니데스크 번호)을 대장(pcs)에 "미검증" 으로 올리고
   미등록 목록에서는 지웁니다. 미검증이라 고객 화면에는 나가지 않습니다.

   ※ 이 PC 는 아직 전용 열쇠(beat_token)가 없어 신호가 대장에 이어지지 않습니다.
     그 PC 에서 PC등록을 한 번 더 실행해야 신호가 붙습니다 — 응답 note 로 알려 드립니다.
   ※ "대장에서 사라진 PC"(claimed_pn 있음)는 여기서 품번을 붙이지 않습니다.
     원래 품번이 따로 있어 겹치므로 그 PC 에서 다시 등록하는 것이 맞습니다. */
async function fromUnregistered(b, res) {
  const hwId = String(b.hwId || '').trim();
  if (hwId.length < 4 || hwId.length > 128) return res.status(400).json({ error: '어느 PC 인지 알 수 없습니다' });
  const pn = String(b.pn || '').toUpperCase().trim();
  if (!isPn(pn)) return res.status(400).json({ error: '품번 형식은 K-001 · Y-042 · D-113 입니다' });
  const room = pn.charAt(0);
  if (b.room !== undefined && String(b.room).toUpperCase() !== room) {
    return res.status(400).json({ error: `품번 앞글자(${room})와 서버실(${String(b.room).toUpperCase()})이 다릅니다` });
  }
  const rack = b.rack !== undefined ? num(b.rack, 0, 999) : 0;
  const fl = b.fl !== undefined ? num(b.fl, 0, 99) : 0;
  const slot = b.slot !== undefined ? num(b.slot, 0, 99) : 0;
  if (rack === null || fl === null || slot === null) return res.status(400).json({ error: '자리 번호가 올바르지 않습니다' });
  if (rack || fl || slot) {
    const 안되는이유 = checkLoc(room, rack, fl, slot);
    if (안되는이유) return res.status(400).json({ error: 안되는이유 });
  }

  let u;
  try {
    const rows = await sb('pcs_unregistered', {
      query: `?select=*&hw_id=eq.${encodeURIComponent(hwId)}&limit=1`,
    });
    u = rows && rows[0];
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
  if (!u) return res.status(404).json({ error: '미등록 목록에 없는 PC 입니다. 새로고침해 주세요' });
  if (u.claimed_pn) {
    return res.status(409).json({
      error: `이 PC 는 원래 ${u.claimed_pn} 이라고 신호를 보내는 "대장에서 사라진 PC" 입니다.\n` +
             `여기서 품번을 붙이지 말고, 애니데스크로 접속해 PC등록을 다시 실행해 주세요.`,
    });
  }

  const row = {
    pn, room, rack, fl, slot,
    cpu: u.cpu || null, core: u.core || null, ram_gb: u.ram_gb || null, ssd_gb: u.ssd_gb || null,
    gpu: u.gpu || null, ip: u.ip || null,
    anydesk: /^\d{6,12}$/.test(String(b.anydesk || '').trim()) ? String(b.anydesk).trim()
           : /^\d{6,12}$/.test(u.anydesk || '') ? u.anydesk : null,
    /* [정보 수정] 창에서 비밀번호·메모를 같이 적으셨으면 함께 넣습니다 (비밀번호는 자물쇠를 채워서) */
    pw_enc: String(b.pw || '').trim().length >= 4 && kv.ready() ? kv.seal(String(b.pw).trim()) : null,
    note: b.note ? String(b.note).slice(0, 500) : null,
    spec_id: guessSpec(u.cpu, u.ram_gb, u.ssd_gb, u.gpu) || null,
    /* 등록 프로그램이 만든 일련번호(hw1-…)만 남깁니다 — 다시 등록할 때 같은 품번을 물려받습니다 */
    hw_id: /^hw1-[0-9a-f]{28}$/.test(hwId) ? hwId : null,
    status: 'unv', online: false, last_beat: u.last_beat || null,
    updated_at: new Date().toISOString(),
  };
  try {
    await sb('pcs', { method: 'POST', body: [row], prefer: 'return=minimal' });
  } catch (e) {
    const m = String(e.message || e);
    if (/23505|duplicate key/.test(m)) {
      if (/pcs_slot_unique/.test(m)) return res.status(409).json({ error: '그 자리에는 이미 다른 PC 가 있습니다' });
      return res.status(409).json({ error: '그 품번은 이미 다른 PC 가 쓰고 있습니다' });
    }
    return res.status(500).json({ error: m.slice(0, 200) });
  }
  try {
    await sb('pcs_unregistered', { method: 'DELETE', prefer: 'return=minimal',
      query: `?hw_id=eq.${encodeURIComponent(hwId)}` });
  } catch (e) {}
  try {
    await sb('view_log', { method: 'POST', prefer: 'return=minimal',
      body: [{ pn, act: `미등록 PC 품번 부여 (${hwId})`.slice(0, 120), who: '관리자' }] });
  } catch (e) {}
  return res.status(200).json({
    ok: true, pn, changed: 1,
    note: `${pn} 을 미검증으로 올렸습니다.\n그 PC 에서 PC등록을 한 번 더 실행해야 신호(하트비트)가 이어집니다.`,
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const b = req.body || {};
  const key = String(b.key || '').toUpperCase().trim();
  /* ★ 2026-11-07 E2E 시험에서 잡은 것 — 품번이 아직 없는 PC([미등록 PC] 의
     "품번 없이 신호만 오는 PC") 에 [저장 · 품번 부여] 를 누르면 key 가 비어
     늘 400 "어느 PC 를 고칠지 알 수 없습니다" 가 났습니다.
     이제 hwId 로 그 줄을 찾아 대장(pcs)에 새로 올립니다. */
  if (!isPn(key) && b.hwId) return fromUnregistered(b, res);
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
    /* ★ 옮긴 뒤의 자리가 그 서버실에 실제로 있는 자리인지 확인합니다.
       0-0-0 (자리 미지정) 은 그대로 둡니다 — 현장에서 아직 안 정한 PC 입니다. */
    const nRoom = room || cur.room;
    const nRack = rack !== null ? rack : cur.rack;
    const nFl   = fl   !== null ? fl   : cur.fl;
    const nSlot = slot !== null ? slot : cur.slot;
    if (nRack || nFl || nSlot) {
      const 안되는이유 = checkLoc(nRoom, nRack, nFl, nSlot);
      if (안되는이유) return res.status(400).json({ error: 안되는이유 });
    }
    logs.push(`위치 이동 ${cur.room}${cur.rack}-${cur.fl}-${cur.slot} → ` +
              `${nRoom}${nRack}-${nFl}-${nSlot}`);
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
    /* ★ 반납된 PC(유예·초기화 대기)를 판매로 돌릴 때는 새 애니데스크 비밀번호가 꼭 있어야 합니다.
       앞 손님이 알던 비밀번호 그대로 팔면, 그분이 다음 손님 PC 에 그대로 들어올 수 있습니다.
       화면의 체크리스트(윈도우 초기화 · 계정·파일 정리 · 비밀번호 교체)를 건너뛰고
       버튼만 눌러도 여기서 막힙니다. */
    const fromReturn = cur.status === 'wipe' || cur.status === 'hold';
    /* ★ 반납 PC 는 다른 상태(점검·미검증 등)를 거쳐 판매로 가는 길을 막습니다.
       예전 검토(Codex T-0179)에서 wipe → fix → [점검 완료 → 판매] 로 비밀번호 교체를
       건너뛸 수 있다고 나왔습니다. 반납 PC 는 유예 → 초기화 대기 → (비밀번호) 판매 만 됩니다. */
    if (fromReturn && st !== cur.status && !['wipe', 'ok'].includes(st)) {
      return res.status(409).json({
        error: '반납된 PC(유예·초기화 대기)는 다른 상태로 바꿀 수 없습니다.\n'
             + '[초기화 완료 → 판매로] 로 초기화와 비밀번호 교체를 먼저 해 주세요.',
      });
    }
    if (st === 'ok' && fromReturn) {
      if (!(b.pw !== undefined && String(b.pw).trim().length >= 4)) {
        return res.status(409).json({
          error: '반납된 PC 는 초기화 후 애니데스크 비밀번호를 새로 바꿔야 판매로 돌릴 수 있습니다.\n'
               + '[초기화 완료 → 판매로] 에서 새 비밀번호(4자 이상)를 적어 주세요.',
        });
      }
      /* 그 PC 를 아직 쓰는(기간이 남은) 주문이 있으면 판매로 돌리지 않습니다 — 한 PC 를 두 분이 쓰게 됩니다 */
      /* 조건을 DB 에 맡겨 한 건이라도 있으면 막습니다 (앞 5건만 보고 판단하면 놓칠 수 있음 — Codex T-0179)
         결제완료(paid) · 기간이 남은 이용중 · 끝나는 날이 비어 있는 이용중 */
      try {
        const pnQ = `pn=eq.${encodeURIComponent(key)}`;
        const nowIso = new Date().toISOString();
        const hits = await Promise.all([
          sb('orders', { query: `?select=order_id&${pnQ}&status=eq.paid&limit=1` }),
          sb('orders', { query: `?select=order_id&${pnQ}&status=eq.assigned&ends_at=gte.${nowIso}&limit=1` }),
          sb('orders', { query: `?select=order_id&${pnQ}&status=eq.assigned&ends_at=is.null&limit=1` }),
        ]);
        const live = hits.map(h => h && h[0]).find(Boolean);
        if (live) {
          return res.status(409).json({ error: `${key} 은 아직 주문(${live.order_id})이 쓰고 있어 판매로 돌릴 수 없습니다` });
        }
      } catch (e) {
        return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
      }
    }
    if (st !== cur.status) {
      patch.status = st;
      logs.push(st === 'ok' && fromReturn ? '반납 초기화 완료 → 판매 가능' : `상태 ${cur.status} → ${st}`);
    }
  }

  /* ── 메모 ──
     ★ 메모 칸을 아예 안 보냈으면(undefined·null) 손대지 않습니다.
       예전 관리자 화면은 서버 메모를 읽어오지 않은 채 빈 칸('')을 보내서,
       위치만 고쳐도 현장 메모가 지워졌습니다. 지우려면 '' 를 일부러 보내야 합니다. */
  if (b.note !== undefined && b.note !== null && String(b.note) !== String(cur.note || '')) {
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
