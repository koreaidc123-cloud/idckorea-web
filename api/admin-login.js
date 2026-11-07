/* ═══════════════════════════════════════════════════════════════
   관리자 로그인

   예전 admin.html 은 이 서버가 응답을 못 하면 화면에 적힌 숫자(4060)로 열렸습니다.
   브라우저 소스를 열면 그 숫자가 그대로 보이니 잠금장치가 아니었습니다.
   2026-11-07 그 길을 없앴습니다 — 이제 이 서버가 "맞다" 할 때만 열립니다.

   POST /api/admin-login              { pw }   로그인 (출입증 쿠키 발급)
   POST /api/admin-login?do=logout             로그아웃 (출입증 쿠키 지움)

   그래서 진짜 열쇠는 서버에만 둡니다.
     Vercel 환경변수  KVC_ADMINS        관리자별 비밀번호   예) 대표:긴비번;현장:다른긴비번
     Vercel 환경변수  KVC_ADMIN_PW      (예전 방식) 비밀번호 하나 — KVC_ADMINS 가 없을 때만 '대표' 로 씁니다
     Vercel 환경변수  KVC_SECRET        서명용 문자열 (아무거나 길게)

   ★ 2026-11-08 관리자별 비밀번호 (B1)
     예전엔 모두가 같은 비밀번호를 써서, 기록에 늘 "관리자" 라고만 남았습니다.
     누가 고객 비밀번호를 열어봤는지·누가 환불했는지 알 수 없었습니다.
     이제 비밀번호마다 이름이 붙고, 출입증(쿠키)에 그 이름이 서명되어 들어갑니다.
     모든 기록(view_log.who)에 그 이름이 남습니다.
     · 이름 칸에는 : 과 ; 를 쓸 수 없습니다 (구분 기호라서). 비밀번호에는 ; 를 쓸 수 없습니다.
     · 한 사람을 빼려면 KVC_ADMINS 에서 그 사람 몫을 지우고 Redeploy 하면 됩니다.
       그 사람이 가진 출입증도 바로 무효가 됩니다 (이름이 목록에 없으면 거절).

   비밀번호가 맞으면 서버가 8시간짜리 출입증(쿠키)을 발급합니다.
   이 쿠키는 httpOnly 라 자바스크립트로 훔칠 수 없습니다.
   ═══════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

const kv = require('./_crypto');
const supa = require('./_supa');

const HOURS = 8;

/* ── 관리자 목록 읽기 ──────────────────────────────────────────
   환경변수는 부를 때마다 다시 읽습니다 (시험에서 바꿔 끼울 수 있게 · 값은 어디에도 출력하지 않습니다).
   이름은 1~20자, : ; 와 줄바꿈 없이. 이름이 겹치면 앞의 것만 씁니다. */
const NAME_OK = /^[^:;\r\n]{1,20}$/;
function accounts() {
  const raw = String(process.env.KVC_ADMINS || '').trim();
  const out = [];
  if (raw) {
    for (const part of raw.split(';')) {
      const i = part.indexOf(':');
      if (i < 1) continue;
      const name = part.slice(0, i).trim();
      const pw = part.slice(i + 1).trim();
      if (!NAME_OK.test(name) || !pw) continue;
      if (out.some(a => a.name === name)) continue;
      out.push({ name, pw });
    }
  }
  /* KVC_ADMINS 가 없거나 형식이 다 틀렸으면 예전 비밀번호 하나를 '대표' 로 씁니다 */
  if (!out.length && process.env.KVC_ADMIN_PW) out.push({ name: '대표', pw: String(process.env.KVC_ADMIN_PW) });
  return out;
}

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64 = s => { try { return Buffer.from(String(s), 'base64url').toString('utf8'); } catch (e) { return ''; } };
const mac = (exp, name) => crypto.createHmac('sha256', kv.signKey()).update(String(exp) + '.' + name).digest('hex');

/* 출입증 만들기: "만료시각.이름(base64url).서명"  — 서명은 만료시각+'.'+이름 에 겁니다 */
function sign(expMs, name) {
  return expMs + '.' + b64(name) + '.' + mac(expMs, name);
}

/* 출입증 확인 — 서버 어디서든 이 함수로 검사합니다.
   맞으면 { name } , 아니면 false.
   (예전처럼 if (!verify(req)) 로만 쓰는 곳도 그대로 동작합니다)
   ★ 예전 모양(만료.서명 두 칸) 출입증은 그냥 "로그인 안 됨" 으로 봅니다 → 다시 로그인하면 됩니다. */
function verify(req) {
  if (!kv.ready()) return false;
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim())
    .find(s => s.startsWith('kvc_adm='));
  if (!raw) return false;
  let val;
  try { val = decodeURIComponent(raw.slice(8)); } catch (e) { return false; }
  const parts = val.split('.');
  if (parts.length !== 3) return false;
  const [exp, nm, sig] = parts;
  if (!/^\d{10,16}$/.test(String(exp)) || Number(exp) < Date.now()) return false;  // 만료값은 숫자만
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(nm) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const name = unb64(nm);
  if (!NAME_OK.test(name)) return false;
  const want = mac(exp, name);
  /* 바이트로 바꾼 뒤 길이를 비교합니다 (서명은 늘 64글자 16진수라 길이가 같습니다) */
  const a = Buffer.from(want), b = Buffer.from(sig);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return false;
  /* 목록에서 빠진 사람의 출입증은 서명이 맞아도 받지 않습니다 */
  if (!accounts().some(x => x.name === name)) return false;
  return { name };
}

/* 기록(view_log.who)에 남길 이름 — 로그인한 관리자 이름 */
function who(req) {
  const v = verify(req);
  return (v && v.name) || '관리자';
}

/* 비밀번호 비교 — 두 값을 각각 sha256 으로 바꿔(항상 32바이트) 비교합니다.
   ★ 2026-11-07 — 예전엔 글자 수만 같으면 바로 timingSafeEqual 에 넣었는데,
     한글처럼 한 글자가 여러 바이트인 값을 넣으면 길이가 달라 오류(500)가 났고,
     그 시도는 "틀린 횟수" 에도 안 세졌습니다 (자동 대입 잠금을 피해 갈 수 있었음).
     이제 길이가 늘 같아서 오류가 날 수 없고, 틀리면 무조건 셉니다. */
function samePw(got, want) {
  const h = s => crypto.createHash('sha256').update(String(s), 'utf8').digest();
  return crypto.timingSafeEqual(h(got), h(want));
}

/* 모든 관리자와 비교합니다.
   ★ 맞는 사람을 찾아도 멈추지 않고 끝까지 다 비교합니다 — 몇 번째에서 멈췄는지로
     걸린 시간이 달라지면, 시간을 재서 비밀번호를 짐작하는 공격의 실마리가 됩니다. */
function findAccount(got) {
  let hit = null;
  for (const a of accounts()) {
    const same = samePw(got, a.pw);
    if (same && !hit) hit = a;
  }
  return hit;
}

/* ── 자동 대입 막기 ────────────────────────────────────────────
   짧은 비밀번호(예: 네 자리)는 프로그램으로 1만 번 시도하면 뚫립니다.
   그래서 같은 곳에서 15분 안에 10번 틀리면 잠급니다.
   사람이 오타로 10번 틀릴 일은 없고, 자동 시도는 사실상 불가능해집니다.
   (15분에 10번 = 하루 960번 = 1만 번 채우는 데 열흘 넘게 걸립니다)

   기록은 이미 있는 view_log 표를 씁니다. IP 는 그대로 남기지 않고
   섞어서(해시) 남기므로, 누가 접속했는지 추적하는 용도로는 쓰이지 않습니다. */
const WINDOW_MIN = 15;
const MAX_FAIL = 10;

function whoHash(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '')
    .split(',')[0].trim() || 'unknown';
  return 'ip:' + crypto.createHmac('sha256', kv.signKey()).update(ip).digest('hex').slice(0, 16);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Cache-Control', 'no-store');

  /* ── 로그아웃 — 출입증 쿠키를 바로 만료시킵니다 (Max-Age=0) ──
     설정이 안 돼 있어도 지우는 건 항상 됩니다. */
  if (String((req.query && req.query.do) || '') === 'logout') {
    res.setHeader('Set-Cookie', 'kvc_adm=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    return res.status(200).json({ ok: true });
  }

  if (!accounts().length || !kv.ready()) {
    return res.status(503).json({ error: '미설정', hint: 'KVC_ADMINS(또는 KVC_ADMIN_PW) / KVC_SECRET 을 Vercel 환경변수에 넣어 주세요' });
  }

  const ipWho = whoHash(req);
  const since = new Date(Date.now() - WINDOW_MIN * 60 * 1000).toISOString();

  /* 이미 너무 많이 틀렸으면 비밀번호를 확인하지도 않고 돌려보냅니다 */
  if (supa.ready()) {
    try {
      const rows = await supa.sb('view_log', {
        query: `?select=at&act=eq.${encodeURIComponent('관리자 로그인 실패')}` +
               `&who=eq.${encodeURIComponent(ipWho)}&at=gte.${since}&order=at.asc&limit=${MAX_FAIL}`,
      });
      if (rows && rows.length >= MAX_FAIL) {
        const wait = Math.ceil((Date.parse(rows[0].at) + WINDOW_MIN * 60 * 1000 - Date.now()) / 60000);
        return res.status(429).json({
          error: `비밀번호를 여러 번 틀리셨습니다. ${Math.max(1, wait)}분 뒤에 다시 시도해 주세요.`,
        });
      }
    } catch (e) { /* 기록을 못 읽어도 로그인 자체는 막지 않습니다 */ }
  }

  const got = String((req.body || {}).pw || '');
  const acc = findAccount(got);

  /* 비밀번호가 틀리면 왜 틀렸는지 알려주지 않습니다 (자동 대입 공격 대비) */
  if (!acc) {
    if (supa.ready()) {
      try {
        await supa.sb('view_log', {
          method: 'POST', prefer: 'return=minimal',
          body: [{ pn: null, act: '관리자 로그인 실패', who: ipWho }],
        });
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 700));      // 연속 시도를 느리게
    return res.status(401).json({ error: '비밀번호가 맞지 않습니다' });
  }

  /* 누가 언제 들어왔는지 남깁니다 — [설정 → 관리자 기록] 의 "로그인 기록" 에서 봅니다 */
  if (supa.ready()) {
    try {
      await supa.sb('view_log', {
        method: 'POST', prefer: 'return=minimal',
        body: [{ pn: null, act: '관리자 로그인', who: acc.name }],
      });
    } catch (e) {}
  }

  const exp = Date.now() + HOURS * 3600 * 1000;
  res.setHeader('Set-Cookie',
    `kvc_adm=${encodeURIComponent(sign(exp, acc.name))}; Path=/; Max-Age=${HOURS * 3600}; HttpOnly; Secure; SameSite=Strict`);
  res.status(200).json({ ok: true, name: acc.name, until: new Date(exp).toISOString() });
};

module.exports.verify = verify;
module.exports.who = who;
/* 진단 화면(/api/health)이 "관리자 몇 명 등록됨" 을 보여줄 때 씁니다 — 비밀번호는 내보내지 않습니다 */
module.exports.adminCount = () => accounts().length;
