/* ═══════════════════════════════════════════════════════════════
   AI 허브 창구 (2026-11-08) — /hub 화면 · 매일 수집 · AI 본부 브리핑 올리기

   GET  /api/hub?do=feed      누구나 · 게시된 최신 브리핑 + 뉴스 · 유튜브 (숨긴 글 제외 · 고정 먼저)
   GET  /api/hub?do=me        로그인한 회원 · 지금 쓰는 PC (켜짐 여부 · 마지막 신호 · 끝나는 날)
   GET  /api/hub?do=collect   매일 아침 Vercel 크론이 부름 (Authorization: Bearer CRON_SECRET)
   POST /api/hub?do=collect   관리자 화면 [지금 수집] (관리자 출입증 쿠키)
   POST /api/hub?do=brief     AI 본부가 오늘 브리핑 초안을 올림 (Authorization: Bearer HUB_TOKEN)

   ★ 브리핑은 "초안" 으로만 들어갑니다.
     고객 화면에 보이려면 관리자 화면에서 사람이 [게시] 를 눌러야 합니다.
     이미 게시된 날의 브리핑은 덮어쓰지 않습니다 (409) — 관리자가 [내리기] 한 뒤에만 바뀝니다.

   ★ 이 파일은 Vercel 함수 1개로 셉니다 (지금 11개 · 한도 12개).
     기능을 더 붙일 때는 새 파일을 만들지 말고 아래 do 목록에 넣으세요.

   ★ 비밀 값(CRON_SECRET · HUB_TOKEN)은 Vercel 환경변수에만 둡니다. 화면·기록에 내보내지 않습니다.
   ═══════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const { ready, sb } = require('./_supa');
const hub = require('./_hub');
const { readTicket } = require('./_ticket');
const { verify, who } = require('./admin-login');

const DAY = 86400000;

/* 길이까지 같게 비교 (시간 차이로 열쇠를 알아내지 못하게) */
function sameSecret(got, want) {
  if (!want || want.length < 16) return false;          // 너무 짧은 열쇠는 아예 안 받습니다
  const a = crypto.createHash('sha256').update(String(got || '')).digest();
  const b = crypto.createHash('sha256').update(String(want)).digest();
  return crypto.timingSafeEqual(a, b);
}
const bearerOf = req => {
  const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
};

/* ── 공개 목록 ───────────────────────────────────────────────── */
async function feed(req, res) {
  /* 5분 동안은 Vercel 이 저장해 둔 답을 그대로 줍니다 (DB 부담 ↓) */
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  const empty = { ok: true, ready: false, brief: null, news: [], youtube: [], updatedAt: null };
  if (!ready()) return res.status(200).json(empty);
  try {
    const [briefs, news, yt, srcs, week] = await Promise.all([
      sb('hub_briefs', { query: '?select=day,title,body,published_at&status=eq.published&order=day.desc&limit=1' }),
      sb('hub_items', { query: '?select=id,source_id,title,url,summary,thumb,published_at,pinned&kind=eq.news&hidden=is.false&order=pinned.desc,published_at.desc.nullslast&limit=150' }),
      sb('hub_items', { query: '?select=id,source_id,title,url,thumb,published_at,views,score,pinned&kind=eq.youtube&hidden=is.false&order=pinned.desc,score.desc&limit=80' }),
      sb('hub_sources', { query: '?select=id,name,topic&limit=200' }),
      /* ★ Codex T-0248: 도구 순위는 최근 7일 글 전체(제목·요약)로 셉니다 — 공개 목록 개수 제한과 따로 */
      sb('hub_items', { query: '?select=title,published_at&kind=eq.news&hidden=is.false&published_at=gte.' + new Date(Date.now() - 7 * 86400000).toISOString() + '&limit=2000' }),
    ]);
    const nameOf = new Map((srcs || []).map(s => [s.id, s.name]));
    /* 분류: 국내 · 해외 · 공식 발표 · 도구·개발 (출처 topic 으로) */
    const catOf = new Map((srcs || []).map(s => [s.id, /^news_en/.test(s.topic) ? 'en' : /^official/.test(s.topic) ? 'official' : /^(tools|dev)/.test(s.topic) ? 'tools' : 'ko']));
    const last = await hub.lastCollect();
    const b = briefs && briefs[0];
    return res.status(200).json({
      ok: true, ready: true,
      brief: b ? { day: b.day, title: b.title, body: b.body, publishedAt: b.published_at } : null,
      /* 저작권: 허락 확인된 출처(MEDIA_OK)만 사진·요약을 보냅니다. 나머지는 제목·매체명·링크만 (2026-11-10) */
      news: (news || []).filter(n => hub.KO_RE.test(n.title || '')).map(n => { const ok = hub.MEDIA_OK.has(nameOf.get(n.source_id)); const sm = String(n.summary || ''); return { title: n.title, url: n.url,
        summary: ok ? sm : '', thumb: ok ? (n.thumb || '') : '',
        at: n.published_at, source: nameOf.get(n.source_id) || '', cat: catOf.get(n.source_id) || 'ko', pinned: !!n.pinned }; }),
      youtube: (hub.YT_RSS_OK() ? (yt || []) : []).filter(v => hub.KO_RE.test(v.title || '')).map(v => ({ title: v.title, url: v.url, thumb: v.thumb || '', at: v.published_at,
        views: v.views == null ? null : Number(v.views), perHour: Number(v.score) || 0,
        channel: nameOf.get(v.source_id) || '', pinned: !!v.pinned })),
      week: (week || []).filter(w => !(Date.parse(w.published_at) > Date.now() + 3600000)).map(w => String(w.title || '')).filter(t => hub.KO_RE.test(t)),   // 순위 계산용 제목만
      ytOk: hub.YT_RSS_OK(),
      updatedAt: last && last.at || null,
    });
  } catch (e) {
    /* 표가 아직 없으면(db/11 전) 빈 화면으로 — 고객 화면이 깨지지 않게 */
    if (hub.missingTable(e)) return res.status(200).json(empty);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: '잠시 뒤 다시 시도해 주세요' });
  }
}

/* ── 내 AI PC ── (비밀번호·애니데스크 번호는 주지 않습니다 · 그건 내 가상컴 화면에서만) */
async function me(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const memberId = readTicket(req);
  if (!memberId) return res.status(401).json({ login: false });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });
  /* 회원 번호는 uuid 모양만 받습니다 (주소 조작 방지) */
  if (!/^[0-9a-f-]{36}$/i.test(memberId)) return res.status(401).json({ login: false });
  try {
    const os = await sb('orders', {
      query: `?select=pn,ends_at,status,pcs(pn,status,online,last_beat)&member_id=eq.${encodeURIComponent(memberId)}&status=eq.assigned&order=ends_at.asc&limit=50`,
    });
    const now = Date.now();
    const pcs = [];
    for (const o of (os || [])) {
      if (!o.pcs || !o.pn) continue;
      const ends = o.ends_at ? Date.parse(o.ends_at) : null;
      if (ends !== null && ends < now) continue;                 // 이미 끝난 주문
      if (pcs.some(p => p.pn === o.pn)) continue;
      const beat = o.pcs.last_beat ? Date.parse(o.pcs.last_beat) : null;
      pcs.push({
        pn: o.pcs.pn,
        live: !!(o.pcs.online && beat !== null && now - beat < 300000),   // 내 가상컴 화면과 같은 기준 (5분)
        lastBeat: o.pcs.last_beat || null,
        endsAt: o.ends_at || null,
        left: ends === null ? null : Math.ceil((ends - now) / DAY),
      });
    }
    return res.status(200).json({ ok: true, login: true, pcs });
  } catch (e) {
    return res.status(500).json({ error: '잠시 뒤 다시 시도해 주세요' });
  }
}

/* ── 수집 ── 크론(CRON_SECRET) 또는 관리자 쿠키 */
async function collect(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET 또는 POST' });
  let by = '';
  if (sameSecret(bearerOf(req), process.env.CRON_SECRET || '')) by = 'cron';
  else if (verify(req)) {
    /* 관리자는 POST 로만 (주소만 열어서 수집이 돌지 않게) */
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST 로 요청해 주세요' });
    by = who(req);
  } else return res.status(401).json({ error: '권한이 없습니다' });
  try {
    const r = await hub.collect(by);
    if (!r.ok) return res.status(r.status || 500).json({ error: r.error, missing: !!r.missing });
    if (by !== 'cron') {
      try {
        await sb('view_log', { method: 'POST', prefer: 'return=minimal',
          body: [{ pn: null, act: `AI 허브 수집 · 저장 ${r.saved} · 오류 ${r.errorCount}`, who: by }] });
      } catch (e) {}
    }
    return res.status(200).json(r);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
}

/* ── AI 본부 브리핑 올리기 (초안만) ── */
async function brief(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!sameSecret(bearerOf(req), process.env.HUB_TOKEN || '')) return res.status(401).json({ error: '권한이 없습니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const day = String(b.day || hub.kstDay()).trim();
  if (!hub.validDay(day)) {
    return res.status(400).json({ error: '날짜는 YYYY-MM-DD 모양이어야 합니다' });
  }
  const title = hub.cleanLine(b.title, 120);
  const body = hub.cleanBody(b.body);
  if (!title || !body) return res.status(400).json({ error: '제목과 본문이 필요합니다' });
  try {
    const ex = await sb('hub_briefs', { query: `?select=id,status&day=eq.${day}&limit=1` });
    if (ex && ex[0] && ex[0].status === 'published') {
      return res.status(409).json({ error: '이 날짜 브리핑은 이미 게시되어 있습니다. 관리자 화면에서 [내리기] 한 뒤 다시 올려 주세요.' });
    }
    /* ★ Codex T-0222: 읽은 뒤 바꾸기 전에 관리자가 [게시] 를 누르면, 조건(status=draft) 때문에 0줄이 바뀝니다.
       바뀐 줄을 돌려받아 0줄이면 "그 사이 게시됨" 으로 409 를 줍니다. 처음 만들 때 겹치면(23505) 역시 409. */
    const busy = () => res.status(409).json({ error: '그 사이 이 날짜 브리핑이 게시되었거나 다른 곳에서 만들어졌습니다. 관리자 화면을 확인한 뒤 다시 올려 주세요.' });
    if (ex && ex[0]) {
      /* 아직 초안이면 내용만 바꿉니다 — 상태는 언제나 draft */
      const done = await sb('hub_briefs', { method: 'PATCH', query: `?id=eq.${Number(ex[0].id)}&status=eq.draft&select=id`, prefer: 'return=representation',
        body: { title, body, status: 'draft', source: 'ai_hq', who: 'ai_hq', published_at: null } });
      if (!done || !done.length) return busy();
    } else {
      try {
        await sb('hub_briefs', { method: 'POST', prefer: 'return=minimal',
          body: [{ day, title, body, status: 'draft', source: 'ai_hq', who: 'ai_hq' }] });
      } catch (e) {
        if (/23505|duplicate/.test(String(e && e.message))) return busy();
        throw e;
      }
    }
    return res.status(200).json({ ok: true, day, status: 'draft', note: '관리자 화면에서 [게시] 를 눌러야 고객 화면에 보입니다' });
  } catch (e) {
    if (hub.missingTable(e)) return res.status(503).json({ error: 'AI 허브 표가 없습니다 — db/11-AI허브.sql 을 실행해 주세요' });
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
}

const ROUTES = { feed, me, collect, brief };

module.exports = async (req, res) => {
  const what = String((req.query && req.query.do) || '').trim();
  const fn = ROUTES[what];
  if (!fn) return res.status(404).json({ error: '알 수 없는 요청입니다', hint: 'do 값은 ' + Object.keys(ROUTES).join(' / ') });
  if ((what === 'feed' || what === 'me') && req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  return fn(req, res);
};
