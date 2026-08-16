/* ═══════════════════════════════════════════════════════════════
   Supabase 연결 — 서버(Vercel 함수)에서만 씁니다.

   Vercel → 프로젝트 → Settings → Environment Variables 에 3개를 넣습니다.
     SUPABASE_URL          https://xxxx.supabase.co
     SUPABASE_SERVICE_KEY  service_role 키 (절대 공개 금지)
     KVC_RELAY_KEY         서버실 중계기가 쓸 암호 (아무 문자열이나 길게)
     KVC_ADMIN_KEY         관리자 화면이 쓸 암호

   ※ 아직 안 넣었으면 ready() 가 false 를 돌려주고,
      화면은 지금처럼 목업 데이터로 계속 돌아갑니다. 터지지 않습니다.
   ═══════════════════════════════════════════════════════════════ */
const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';

const ready = () => !!(URL && KEY);

/* Supabase 키는 두 가지 형식이 있습니다.
     새 형식  sb_secret_...   ← 2026년부터 새로 만든 프로젝트
     옛 형식  eyJhbGci...     ← service_role (JWT 라는 긴 문자열)

   새 형식은 JWT 가 아니라서 Authorization 헤더에 넣으면
   Supabase 가 JWT 로 해석하려다 실패합니다. apikey 헤더에만 넣어야 합니다.
   어느 쪽 키를 넣으셔도 알아서 맞춰 보내도록 아래처럼 나눕니다. */
const IS_NEW_KEY = /^sb_/.test(KEY);

/* Supabase REST 호출. 패키지 설치 없이 fetch 만 씁니다. */
async function sb(table, { method = 'GET', query = '', body, prefer } = {}) {
  if (!ready()) throw new Error('DB_NOT_READY');
  const headers = {
    apikey: KEY,
    'Content-Type': 'application/json',
  };
  if (!IS_NEW_KEY) headers.Authorization = 'Bearer ' + KEY;
  if (prefer) headers.Prefer = prefer;

  const r = await fetch(`${URL}/rest/v1/${table}${query}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SUPABASE ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/* 여러 줄을 한 번에 넣거나 갱신 (있으면 갱신, 없으면 추가) */
const upsert = (table, rows, onConflict) =>
  sb(table, {
    method: 'POST',
    query: onConflict ? `?on_conflict=${onConflict}` : '',
    body: rows,
    prefer: 'resolution=merge-duplicates,return=minimal',
  });

/* 요청자가 정당한지 확인 — 암호가 다르면 아무것도 안 알려줍니다 */
function authed(req, envName) {
  const want = process.env[envName] || '';
  if (!want) return false;
  const got = req.headers['x-kvc-key'] || '';
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

module.exports = { ready, sb, upsert, authed };
