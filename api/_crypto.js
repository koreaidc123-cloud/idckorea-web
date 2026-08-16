/* ═══════════════════════════════════════════════════════════════
   애니데스크 비밀번호 잠그기

   비밀번호를 데이터베이스에 그대로 적어두면, 데이터베이스가 한 번
   새어나갈 때 고객 1,200명의 PC 가 전부 열립니다.
   그래서 자물쇠를 채워서 넣습니다. 자물쇠 열쇠는 서버에만 둡니다.
   (Vercel 환경변수 KVC_SECRET — 데이터베이스에는 없습니다)

   ★ 열쇠 하나로 두 가지 용도를 쓰되, 서로 섞이지 않게 갈라 씁니다.
     · 관리자 출입증 서명용
     · 비밀번호 잠금용
     같은 열쇠를 그대로 두 곳에 쓰면 한쪽이 뚫릴 때 다른 쪽도 뚫립니다.
   ═══════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

/* 이름이 두 가지인 이유: 예전 안내에서 KVC_ADMIN_SECRET 로 알려드렸던 적이
   있어, 그 이름으로 넣으셨어도 그대로 동작하게 둘 다 받습니다. */
const MASTER = process.env.KVC_SECRET || process.env.KVC_ADMIN_SECRET || '';

const ready = () => MASTER.length >= 8;

/* 용도별로 다른 열쇠를 만들어 냅니다 */
function derive(label) {
  return crypto.createHmac('sha256', MASTER).update('kvc-v1|' + label).digest();
}

/* 잠그기 — 결과 예: v1.aGVsbG8.d29ybGQ.Y2lwaGVy */
function seal(plain) {
  if (!ready()) throw new Error('KVC_SECRET 이 없습니다');
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', derive('pw'), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/* 열기 — 관리자가 열람 버튼을 눌렀을 때만 부릅니다 */
function open(sealed) {
  if (!ready() || !sealed) return null;
  const p = String(sealed).split('.');
  if (p.length !== 4 || p[0] !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', derive('pw'), Buffer.from(p[1], 'base64url'));
    d.setAuthTag(Buffer.from(p[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    return null;                 // 열쇠가 바뀌었거나 값이 훼손된 경우
  }
}

/* 관리자 출입증 서명용 열쇠 (비밀번호 열쇠와 다른 값이 나옵니다) */
const signKey = () => derive('admin-cookie');

module.exports = { ready, seal, open, signKey };
