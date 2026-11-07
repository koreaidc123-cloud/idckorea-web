/* ═══════════════════════════════════════════════════════════════
   관리자 기록 보기 (2026-11-08 · B4)

   GET /api/admin?do=log                         최근 7일 변경·열람 기록 (최근 것부터 200건)
   GET /api/admin?do=log&pn=Y-042                그 PC 의 기록만
   GET /api/admin?do=log&q=KVC2611..             주문번호가 들어간 기록만
   GET /api/admin?do=log&days=30                 기간 (1~90일, 기본 7일)
   GET /api/admin?do=log&kind=login              로그인 기록만 (성공 · 실패)

   ★ 왜 만들었나
     예전 관리자 화면의 "변경 · 열람 기록" 은 그 브라우저(localStorage)에만 남는 메모였습니다.
     다른 PC·휴대폰에서 연 사람의 기록은 안 보였고, 브라우저를 지우면 사라졌습니다.
     진짜 기록은 서버의 view_log 표에 이미 쌓이고 있어서, 그것을 그대로 보여줍니다.

   ★ 로그인 실패 기록(who 가 'ip:' 로 시작)은 kind=login 일 때만 보여줍니다.
     자동 대입 공격이 오면 수천 줄이 쌓여 평소 기록을 덮어 버리기 때문입니다.
     IP 는 원래 값이 아니라 섞은 값(해시)만 남아 있습니다.

   · 읽기만 합니다. 기록을 고치거나 지우는 길은 없습니다.
   · 화면에 넣을 때는 admin.html 의 esc() 로 글자 그대로 넣습니다 (기록 안의 <태그> 가 실행되지 않게).
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify } = require('./admin-login');

const LIMIT = 200;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const qy = req.query || {};
  const pn = String(qy.pn || '').toUpperCase().trim();
  const q = String(qy.q || '').trim();
  const kind = String(qy.kind || '').trim();
  let days = Math.round(Number(qy.days || 7));
  if (!Number.isFinite(days) || days < 1) days = 7;
  if (days > 90) days = 90;

  /* 받은 값은 형식을 확인한 것만 조건에 넣습니다 (주소 조작으로 다른 조건이 끼어들지 않게) */
  if (pn && !/^[KYD]-\d{3}$/.test(pn)) return res.status(400).json({ error: '품번 형식은 K-001 · Y-042 · D-113 입니다' });
  if (q && !/^[A-Za-z0-9_-]{3,64}$/.test(q)) return res.status(400).json({ error: '주문번호는 영문·숫자·- 만 3자 이상 적어 주세요' });

  const since = new Date(Date.now() - days * 86400000).toISOString();
  let query = `?select=id,at,pn,act,who&at=gte.${since}`;
  if (pn) query += `&pn=eq.${encodeURIComponent(pn)}`;
  if (q) query += `&act=ilike.${encodeURIComponent('*' + q + '*')}`;
  if (kind === 'login') {
    /* '관리자 로그인' · '관리자 로그인 실패' 둘 다 */
    query += `&act=like.${encodeURIComponent('관리자 로그인*')}`;
  } else {
    /* 평소에는 로그인 실패(ip:...)를 뺍니다 */
    query += `&who=not.like.${encodeURIComponent('ip:*')}`;
  }
  query += `&order=at.desc&limit=${LIMIT + 1}`;

  try {
    const rows = await sb('view_log', { query }) || [];
    const cut = rows.length > LIMIT;
    return res.status(200).json({
      ok: true, days, cut,
      rows: rows.slice(0, LIMIT).map(r => ({ at: r.at, pn: r.pn || null, act: r.act || '', who: r.who || '' })),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
};
