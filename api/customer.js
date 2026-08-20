/* ═══════════════════════════════════════════════════════════════
   고객 로그인 · 내 가상컴

   POST /api/customer?do=login   { via:'kakao', token:'<접근토큰>' }
                                 { via:'google', token:'<ID 토큰>' }
   GET  /api/customer?do=me      내 PC · 주문
   GET  /api/customer?do=secret&pn=Y-042   내 PC 의 비밀번호
   POST /api/customer?do=logout

   ★ 왜 서버가 확인해야 하나
     전에는 카카오·구글에서 받은 이름과 전화번호를 브라우저에 저장해 두고
     그걸 그대로 믿었습니다. 그러면 브라우저 저장소를 고쳐서
     **남의 계정인 척** 할 수 있습니다.
     이제 카카오·구글에 직접 물어서 진짜 그 사람인지 확인한 뒤,
     서버가 발급한 출입증(httpOnly 쿠키)으로만 내 정보를 봅니다.

   ★ 비밀번호는 자기 PC 것만 볼 수 있습니다.
     남의 품번을 넣어도 자기 주문에 없으면 돌려주지 않습니다.
   ═══════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const { ready, sb } = require('./_supa');
const kv = require('./_crypto');

const DAYS = 30;
const DAY = 86400000;

/* ── 출입증 ── */
function signKey() {
  return crypto.createHmac('sha256', kv.signKey()).update('kvc-customer').digest();
}
function makeTicket(memberId) {
  const exp = Date.now() + DAYS * DAY;
  const body = `${memberId}.${exp}`;
  const sig = crypto.createHmac('sha256', signKey()).update(body).digest('hex');
  return `${body}.${sig}`;
}
function readTicket(req) {
  if (!kv.ready()) return null;
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim())
    .find(s => s.startsWith('kvc_cust='));
  if (!raw) return null;
  const parts = decodeURIComponent(raw.slice(9)).split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  const want = crypto.createHmac('sha256', signKey()).update(`${id}.${exp}`).digest('hex');
  if (want.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  return id;
}

/* ── 카카오·구글에 진짜 그 사람인지 물어봅니다 ── */
async function checkKakao(token) {
  const r = await fetch('https://kapi.kakao.com/v2/user/me', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!r.ok) return null;
  const d = await r.json();
  const acc = d.kakao_account || {};
  let phone = (acc.phone_number || '').replace('+82 ', '0').replace(/-/g, '');
  if (phone) phone = phone.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
  return {
    via: 'kakao', socialId: String(d.id),
    name: (acc.profile && acc.profile.nickname) || '회원',
    phone, email: acc.email || null,
  };
}
async function checkGoogle(token) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token));
  if (!r.ok) return null;
  const d = await r.json();
  /* 우리 앱으로 발급된 토큰이 맞는지 확인합니다 — 이걸 빼면 남의 앱 토큰도 통과합니다 */
  const want = process.env.GOOGLE_CLIENT_ID || '';
  if (!want || d.aud !== want) return null;
  if (d.exp && Number(d.exp) * 1000 < Date.now()) return null;
  return { via: 'google', socialId: d.sub, name: d.name || '회원', phone: '', email: d.email || null };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const what = String((req.query && req.query.do) || (req.body && req.body.do) || '').trim();

  /* ── 로그아웃 ── */
  if (what === 'logout') {
    res.setHeader('Set-Cookie', 'kvc_cust=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    return res.status(200).json({ ok: true });
  }

  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });
  if (!kv.ready()) return res.status(503).json({ error: 'KVC_SECRET 이 없습니다' });

  /* ── 로그인 ── */
  if (what === 'login') {
    const b = req.body || {};
    const via = String(b.via || '');
    const token = String(b.token || '');
    if (!token) return res.status(400).json({ error: '인증 정보가 없습니다' });

    let who = null;
    try {
      if (via === 'kakao') who = await checkKakao(token);
      else if (via === 'google') who = await checkGoogle(token);
    } catch (e) { who = null; }
    if (!who) return res.status(401).json({ error: '로그인 확인에 실패했습니다. 다시 시도해 주세요.' });

    try {
      /* 회원 찾기 — 없으면 만듭니다 */
      const found = await sb('members', {
        query: `?select=id,name,phone,email&via=eq.${who.via}&social_id=eq.${encodeURIComponent(who.socialId)}&limit=1`,
      });
      let m = found && found[0];
      if (!m) {
        const made = await sb('members', {
          method: 'POST', prefer: 'return=representation',
          body: [{ via: who.via, social_id: who.socialId, name: who.name, phone: who.phone || null, email: who.email }],
        });
        m = made && made[0];
      } else if (who.phone && who.phone !== m.phone) {
        /* 카카오에서 확인된 번호가 바뀌었으면 갱신합니다 */
        await sb('members', { method: 'PATCH', prefer: 'return=minimal',
          query: `?id=eq.${m.id}`, body: { phone: who.phone, name: who.name } });
        m.phone = who.phone;
      }
      if (!m) return res.status(500).json({ error: '회원 등록에 실패했습니다' });

      res.setHeader('Set-Cookie',
        `kvc_cust=${encodeURIComponent(makeTicket(m.id))}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);
      return res.status(200).json({
        ok: true,
        user: { name: m.name || who.name, phone: m.phone || '', via: who.via, email: m.email || who.email },
        needPhone: !(m.phone || who.phone),
      });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
    }
  }

  /* ── 여기서부터는 출입증이 있어야 합니다 ── */
  const memberId = readTicket(req);
  if (!memberId) return res.status(401).json({ error: '로그인이 필요합니다' });

  /* ── 내 PC · 주문 ── */
  if (what === 'me') {
    try {
      const [ms, os] = await Promise.all([
        sb('members', { query: `?select=name,phone,email,via&id=eq.${memberId}&limit=1` }),
        sb('orders', {
          query: `?select=order_id,pn,spec_id,days,amount,status,pay_method,starts_at,ends_at,` +
                 `pcs(pn,anydesk,cpu,core,ram_gb,ssd_gb,gpu,status,online,last_beat)` +
                 `&member_id=eq.${memberId}&order=ends_at.desc&limit=200`,
        }),
      ]);
      const me = (ms && ms[0]) || {};
      const now = Date.now();

      const pcs = [], orders = [];
      for (const o of (os || [])) {
        orders.push({
          no: o.order_id, name: o.pn, days: o.days, amt: o.amount,
          pm: o.pay_method || '—', st: o.status,
          start: o.starts_at, end: o.ends_at,
        });
        /* 지금 쓰고 계신 PC 만 카드로 보여줍니다 */
        if (o.status !== 'assigned' || !o.pcs) continue;
        const ends = o.ends_at ? Date.parse(o.ends_at) : null;
        const left = ends === null ? null : Math.ceil((ends - now) / DAY);
        if (left !== null && left < 0) continue;                 // 이미 끝난 것
        const p = o.pcs;
        const beat = p.last_beat ? (now - Date.parse(p.last_beat)) / 1000 : null;
        pcs.push({
          pn: p.pn, ad: p.anydesk || '',
          spec: [p.cpu, p.core, p.ram_gb ? `램 ${p.ram_gb}GB` : null, p.ssd_gb ? `SSD ${p.ssd_gb}GB` : null]
                  .filter(Boolean).join(' · '),
          gpu: p.gpu || '', days: o.days, left,
          start: o.starts_at, end: o.ends_at,
          live: !!(p.online && beat !== null && beat < 300),      // 지금 켜져 있는가
          orderNo: o.order_id,
        });
      }
      return res.status(200).json({
        ok: true,
        user: { name: me.name || '회원', phone: me.phone || '', via: me.via || '', email: me.email || '' },
        pcs, orders,
      });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
    }
  }

  /* ── 연락처 등록 (인증번호 받기) ─────────────────────────────
     구글은 전화번호를 안 주고, 카카오도 사업자 등록 전에는 못 받습니다.
     그래서 가입 때 번호를 직접 받는데, 전에는 그 번호가 브라우저에만
     저장되고 서버로는 오지 않았습니다. 그래서 결제 때마다
     "연락처 형식이 올바르지 않습니다" 로 막혔습니다 (정환님 확인 2026-08-20).

     알리고 키(ALIGO_*)가 등록돼 있으면 → 진짜 인증번호 문자를 보냅니다.
     아직이면 → direct:true 를 돌려주고, 번호 형식만 확인하고 저장합니다.
     키를 넣는 순간부터 자동으로 진짜 인증으로 바뀝니다. */
  if (what === 'phone-code') {
    const sms = require('./_sms');
    const phone = String((req.body || {}).phone || '').replace(/[^\d]/g, '');
    if (!/^01[016789]\d{7,8}$/.test(phone)) {
      return res.status(400).json({ error: '연락처를 정확히 입력해 주세요 (010-0000-0000)' });
    }
    if (!sms.ready()) return res.status(200).json({ ok: true, direct: true });

    /* 6자리 코드를 만들어 5분간 보관합니다. 시도는 5번까지 받습니다. */
    const code = String(crypto.randomInt(100000, 1000000));
    try {
      await sb('settings', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: [{ k: 'otp:' + memberId,
                 v: JSON.stringify({ c: code, ph: phone, exp: Date.now() + 5 * 60000, n: 0 }) }],
      });
    } catch (e) {
      return res.status(500).json({ error: '인증번호를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요' });
    }
    const sent = await sms.send(phone, `[한국 가상컴] 인증번호 ${code} 를 입력해 주세요. (5분 안에)`);
    if (!sent) return res.status(502).json({ error: '문자를 보내지 못했습니다. 번호를 확인하고 다시 시도해 주세요' });
    return res.status(200).json({ ok: true, direct: false });
  }

  /* ── 연락처 저장 ── */
  if (what === 'phone') {
    const sms = require('./_sms');
    const b2 = req.body || {};
    const phone = String(b2.phone || '').replace(/[^\d]/g, '');
    if (!/^01[016789]\d{7,8}$/.test(phone)) {
      return res.status(400).json({ error: '연락처를 정확히 입력해 주세요 (010-0000-0000)' });
    }

    if (sms.ready()) {
      /* 문자 인증이 켜져 있으면 코드가 맞아야만 저장합니다 */
      const code = String(b2.code || '').trim();
      let saved = null;
      try {
        const r = await sb('settings', { query: `?select=v&k=eq.${encodeURIComponent('otp:' + memberId)}&limit=1` });
        saved = r && r[0] ? JSON.parse(r[0].v) : null;
      } catch (e) {}
      if (!saved || saved.exp < Date.now()) {
        return res.status(400).json({ error: '인증번호가 만료됐습니다. [인증번호 받기] 를 다시 눌러 주세요' });
      }
      if (saved.n >= 5) return res.status(429).json({ error: '너무 많이 틀렸습니다. 인증번호를 다시 받아 주세요' });
      if (saved.c !== code || saved.ph !== phone) {
        try {
          saved.n = (saved.n || 0) + 1;
          await sb('settings', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
            body: [{ k: 'otp:' + memberId, v: JSON.stringify(saved) }] });
        } catch (e) {}
        return res.status(400).json({ error: '인증번호가 맞지 않습니다' });
      }
      /* 통과 — 코드는 한 번 쓰고 버립니다 */
      try { await sb('settings', { method: 'DELETE', query: `?k=eq.${encodeURIComponent('otp:' + memberId)}`, prefer: 'return=minimal' }); } catch (e) {}
    }

    const pretty = phone.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
    try {
      await sb('members', { method: 'PATCH', prefer: 'return=minimal',
        query: `?id=eq.${memberId}`, body: { phone: pretty } });
    } catch (e) {
      return res.status(500).json({ error: '연락처를 저장하지 못했습니다' });
    }
    return res.status(200).json({ ok: true, phone: pretty });
  }

  /* ── 내 PC 의 비밀번호 (내 것만) ── */
  if (what === 'secret') {
    const pn = String((req.query && req.query.pn) || '').toUpperCase().trim();
    if (!/^[KYD]-\d{3}$/.test(pn)) return res.status(400).json({ error: '품번이 올바르지 않습니다' });
    try {
      /* 이 품번이 정말 내 주문에 있는지부터 확인합니다 */
      const mine = await sb('orders', {
        query: `?select=order_id&member_id=eq.${memberId}&pn=eq.${encodeURIComponent(pn)}` +
               `&status=eq.assigned&limit=1`,
      });
      if (!mine || !mine[0]) return res.status(403).json({ error: '고객님의 PC 가 아닙니다' });

      const rows = await sb('pcs', { query: `?select=pn,anydesk,pw_enc&pn=eq.${encodeURIComponent(pn)}&limit=1` });
      const p = rows && rows[0];
      if (!p) return res.status(404).json({ error: '없는 품번입니다' });

      try {
        await sb('view_log', { method: 'POST', prefer: 'return=minimal',
          body: [{ pn, act: '고객 본인 열람', who: 'member:' + memberId }] });
      } catch (e) {}

      return res.status(200).json({ pn: p.pn, anydesk: p.anydesk || '', pw: kv.open(p.pw_enc) || '' });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
    }
  }

  res.status(404).json({ error: '알 수 없는 요청입니다' });
};
