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
const { ready, sb, authed, baseUrl } = require('./_supa');
const kv = require('./_crypto');
const { guessSpec } = require('./_spec');
const { checkLoc } = require('./_rooms');

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
  const room = String(b.room || (b.pn || '').charAt(0)).toUpperCase();
  if (!['K', 'Y', 'D'].includes(room)) {
    return res.status(400).json({ error: '서버실을 고르지 않으셨습니다' });
  }
  /* 품번을 직접 주시면 그대로 쓰고, 안 주시면 서버가 다음 번호를 발급합니다.
     현장에서는 번호를 적을 필요 없이 서버실만 고르면 됩니다. */
  const pn = String(b.pn || '').toUpperCase().trim();
  const autoPn = !pn;
  if (pn && !isPn(pn)) return res.status(400).json({ error: '품번 형식은 K-001 · Y-042 · D-113 입니다' });
  if (pn && pn.charAt(0) !== room) return res.status(400).json({ error: '품번 앞글자와 서버실이 다릅니다' });

  /* 애니데스크 비밀번호 — 현장에서 세팅하신 그 값을 함께 받습니다.
     받는 즉시 자물쇠를 채워서 넣고, 원래 값은 어디에도 남기지 않습니다.
     (기록에도, 응답에도 담지 않습니다) */
  const adPw = str(b.adPw, 64);
  let pwSealed = null;
  if (adPw) {
    if (!kv.ready()) return res.status(503).json({ error: 'KVC_SECRET 이 등록되지 않아 비밀번호를 안전하게 보관할 수 없습니다' });
    pwSealed = kv.seal(adPw);
  }

  /* 이 PC 전용 열쇠. 32바이트 무작위 = 사실상 추측 불가 */
  const token = crypto.randomBytes(24).toString('base64url');
  const now = new Date().toISOString();

  /* 랙 위치 — 현장에서 세팅하시는 분이 적어 주십니다 (예: 1-2-1)
     세 값이 모두 있으면 그 자리로 등록하고, 없으면 0 으로 두어
     관리자가 나중에 지정하게 합니다. */
  const rack = num(b.rack, 1, 9999);
  const fl = num(b.fl, 1, 999);
  const slot = num(b.slot, 1, 999);
  const hasLoc = rack !== null && fl !== null && slot !== null;

  /* ★ 자리를 셋 중 일부만 적어 보내면 되돌려보냅니다.
     예전에는 조용히 "자리 없음" 으로 처리해서, 현장에서는 적었다고 생각하는데
     서버에는 자리 없이 등록되는 일이 있었습니다. */
  const 적은게있나 = [b.rack, b.fl, b.slot]
    .some(v => v !== undefined && v !== null && String(v).trim() !== '');
  if (적은게있나 && !hasLoc) {
    return res.status(400).json({ error: '랙 · 층 · 자리를 세 칸 모두 숫자로 적어 주세요' });
  }

  /* ★ 그 서버실에 실제로 있는 자리인지 확인합니다.
     예전에는 1~999 면 다 통과시켜서 "등원리 99번 랙" 같은 것이 그대로
     저장됐습니다. 실제로 엉뚱한 서버실에 한 대가 등록됐습니다. */
  if (hasLoc) {
    const 안되는이유 = checkLoc(room, rack, fl, slot);
    if (안되는이유) return res.status(400).json({ error: 안되는이유 });
  }

  const row = {
    room,
    rack: hasLoc ? rack : 0,
    fl: hasLoc ? fl : 0,
    slot: hasLoc ? slot : 0,
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
  /* 어느 판매 상품인지 자동으로 붙입니다.
     이게 없으면 고객이 결제해도 배정할 PC 를 못 찾습니다. */
  const guessed = guessSpec(row.cpu, row.ram_gb, row.ssd_gb, row.gpu);
  if (guessed) row.spec_id = guessed;
  if (pwSealed) row.pw_enc = pwSealed;   // 비밀번호를 안 보내면 기존 값을 그대로 둡니다

  /* 같은 기계를 다시 세팅한 경우, 새 번호를 또 뽑지 않고 원래 품번을 씁니다.

     ★ 2026-08-17 사고 — 여기서 서로 다른 PC 가 한 품번을 덮어썼습니다.
       옛 프로그램은 메인보드 일련번호를 검사 없이 그대로 보냈는데,
       조립 PC 는 그 값이 'Default string' 인 경우가 흔합니다.
       그래서 모든 PC 가 같은 값을 갖고, 3대를 등록해도 1대만 남았습니다.
       (Y-001 이 영태리 1700 에서 금촌 5700G 로 덮어써졌습니다)

     막는 방법 두 가지
       1) 새 프로그램이 만든 값(hw1-…)만 신뢰합니다.
          옛 형식이 오면 무시하고 새 품번을 줍니다.
       2) 서버실이 같을 때만 물려받습니다.
          영태리에서 등록하는데 금촌 품번을 물려받는 일이 없어야 합니다. */
  const looksLikeOurHwId = s => /^hw1-[0-9a-f]{28}$/.test(s || '');
  let finalPn = pn;
  let exists = false;

  try {
    if (autoPn && looksLikeOurHwId(row.hw_id)) {
      const same = await sb('pcs', {
        query: `?select=pn,room&hw_id=eq.${encodeURIComponent(row.hw_id)}&limit=1`,
      });
      /* 서버실까지 같아야 물려받습니다 */
      if (same && same[0] && same[0].room === room) { finalPn = same[0].pn; }
    }
    /* 옛 형식이거나 못 믿을 값이면 아예 저장하지 않습니다.
       나중에 이 값으로 또 잘못 묶이는 것을 막습니다. */
    if (!looksLikeOurHwId(row.hw_id)) row.hw_id = null;
    if (finalPn) {
      const found = await sb('pcs', { query: `?select=pn&pn=eq.${encodeURIComponent(finalPn)}&limit=1` });
      exists = !!(found && found[0]);
    }

    /* 그 자리에 이미 다른 PC 가 있으면 미리 알려줍니다.
       (데이터베이스도 막아주지만, 현장에서 알아보기 쉬운 문구로 돌려줍니다) */
    if (hasLoc) {
      const taken = await sb('pcs', {
        query: `?select=pn&room=eq.${room}&rack=eq.${rack}&fl=eq.${fl}&slot=eq.${slot}&limit=1`,
      });
      if (taken && taken[0] && taken[0].pn !== finalPn) {
        return res.status(409).json({
          error: `${room}실 ${rack}-${fl}-${slot} 자리에는 이미 ${taken[0].pn} 이 있습니다.\n자리 번호를 다시 확인해 주세요.`,
        });
      }
    }

    if (exists) {
      /* 이미 있는 품번이면 토큰을 새로 발급합니다.
         위치를 적어 오셨으면 그 위치로 옮기고, 안 적으셨으면 원래 자리를 둡니다. */
      if (!hasLoc) { delete row.rack; delete row.fl; delete row.slot; }
      await sb('pcs', {
        method: 'PATCH',
        query: `?pn=eq.${encodeURIComponent(finalPn)}`,
        body: row,
        prefer: 'return=minimal',
      });
    } else {
      /* 자리까지 적어 오셨으면 "검증 대기", 안 적으셨으면 "미등록" 으로 둡니다.
         검증 대기 = 담당자가 실제 접속만 확인하면 판매 재고로 올라갑니다. */
      row.status = hasLoc ? 'unv' : 'new';

      if (finalPn) {
        row.pn = finalPn;
        await sb('pcs', { method: 'POST', body: [row], prefer: 'return=minimal' });
      } else {
        /* 자동 발급 — 그 서버실의 다음 번호를 찾아 넣습니다.
           같은 순간에 두 대가 등록되면 번호가 겹칠 수 있으므로,
           겹치면(중복 오류) 다음 번호로 다시 시도합니다. */
        const last = await sb('pcs', {
          query: `?select=pn&room=eq.${room}&order=pn.desc&limit=1`,
        });
        let n = 1;
        if (last && last[0]) {
          const m = String(last[0].pn).match(/^[KYD]-(\d{3})$/);
          if (m) n = parseInt(m[1], 10) + 1;
        }
        let saved = false;
        for (let i = 0; i < 20 && n <= 999; i++, n++) {
          row.pn = room + '-' + String(n).padStart(3, '0');
          try {
            await sb('pcs', { method: 'POST', body: [row], prefer: 'return=minimal' });
            saved = true;
            break;
          } catch (e) {
            const m = String(e.message || e);
            // 자리가 겹치면 번호를 바꿔도 소용없습니다 — 바로 알려줍니다
            if (/pcs_slot_unique/.test(m)) {
              return res.status(409).json({
                error: `${room}실 ${rack}-${fl}-${slot} 자리에는 이미 다른 PC 가 있습니다.\n자리 번호를 다시 확인해 주세요.`,
              });
            }
            // 23505 = 이미 그 품번이 있음 → 다음 번호로
            if (!/23505|duplicate key/.test(m)) throw e;
          }
        }
        if (!saved) return res.status(409).json({ error: '남은 품번을 찾지 못했습니다. 관리자에게 문의해 주세요' });
        finalPn = row.pn;
      }
    }

    res.status(200).json({
      ok: true,
      pn: finalPn,
      token,
      /* ★ 반드시 baseUrl() 을 씁니다.
         환경변수를 그대로 쓰면 주소 끝에 /rest/v1 이 붙어 있을 수 있어,
         랙PC 가 .../rest/v1/rest/v1/rpc/beat 를 부르며 전부 404 가 납니다.
         (실제로 겪었습니다 — 현장 나가기 전에 잡았습니다) */
      supabaseUrl: baseUrl(),
      publicKey: pubKey,
      beatSec: Number(process.env.KVC_BEAT_SEC || 120),   // 몇 초마다 보낼지
      renewed: !!exists,
      pwSaved: !!pwSealed,
      loc: hasLoc ? `${rack}-${fl}-${slot}` : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};
