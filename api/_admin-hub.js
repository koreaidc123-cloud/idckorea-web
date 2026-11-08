/* ═══════════════════════════════════════════════════════════════
   관리자 — AI 허브 관리 (2026-11-08)

   GET  /api/admin?do=hub                      한눈에 보기 (마지막 수집 · 출처 · 글 · 브리핑)
        &q=검색어 &kind=news|youtube &show=hidden|pinned
   POST /api/admin?do=hub  { act:'collect' }                        지금 수집
   POST /api/admin?do=hub  { act:'item', id, hidden?, pinned? }     글 숨기기 · 고정
   POST /api/admin?do=hub  { act:'source-add', kind, name, target, topic }   출처 추가
   POST /api/admin?do=hub  { act:'source-toggle', id, enabled }     출처 켜기 · 끄기
   POST /api/admin?do=hub  { act:'brief-save', id?, day, title, body }      브리핑 쓰기 · 고치기
   POST /api/admin?do=hub  { act:'brief-publish', id }              [게시]  — 고객 화면에 보임
   POST /api/admin?do=hub  { act:'brief-unpublish', id }            [내리기] — 다시 초안으로

   ★ 게시는 이 화면에서 사람이 버튼을 눌렀을 때만 일어납니다.
     AI 본부가 올리는 길(/api/hub?do=brief)은 초안만 만들 수 있습니다.
   ★ 바뀐 것은 전부 view_log 에 누가 했는지 남깁니다.
   ★ 화면에 넣을 때는 admin.html 의 esc() 로 글자 그대로 넣습니다 (제목 안의 <태그> 가 실행되지 않게).
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify, who } = require('./admin-login');
const hub = require('./_hub');

const log = async (act, by) => {
  try { await sb('view_log', { method: 'POST', prefer: 'return=minimal', body: [{ pn: null, act: String(act).slice(0, 300), who: by }] }); }
  catch (e) {}
};
const idOf = v => (/^\d{1,15}$/.test(String(v)) ? Number(v) : null);

async function overview(req, res) {
  const qy = req.query || {};
  const kind = ['news', 'youtube'].includes(qy.kind) ? qy.kind : '';
  const show = ['hidden', 'pinned'].includes(qy.show) ? qy.show : '';
  /* 검색어는 PostgREST 조건에 들어가므로 특수 기호(, ( ) * \ " ' 등)를 빼고 씁니다 */
  const q = String(qy.q || '').replace(/[,()*\\"'%:.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  let iq = '?select=id,source_id,kind,title,url,published_at,views,score,hidden,pinned';
  if (kind) iq += `&kind=eq.${kind}`;
  if (show === 'hidden') iq += '&hidden=is.true';
  if (show === 'pinned') iq += '&pinned=is.true';
  if (q) iq += `&title=ilike.${encodeURIComponent('*' + q + '*')}`;
  iq += '&order=published_at.desc.nullslast&limit=150';
  const [sources, items, briefs, last] = await Promise.all([
    sb('hub_sources', { query: '?select=id,kind,name,url_or_channel_id,topic,enabled,created_at&order=id.asc&limit=200' }),
    sb('hub_items', { query: iq }),
    sb('hub_briefs', { query: '?select=id,day,title,body,status,source,created_at,published_at,who&order=day.desc&limit=30' }),
    hub.lastCollect(),
  ]);
  return res.status(200).json({ ok: true, ready: true, last, sources: sources || [], items: items || [], briefs: briefs || [],
    cronSecret: !!process.env.CRON_SECRET, hubToken: !!process.env.HUB_TOKEN });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });
  const by = who(req);

  try {
    if (req.method === 'GET') return await overview(req, res);
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET 또는 POST' });

    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const act = String(b.act || '');

    if (act === 'collect') {
      const r = await hub.collect(by);
      if (!r.ok) return res.status(r.status || 500).json({ error: r.error, missing: !!r.missing });
      await log(`AI 허브 수집 · 저장 ${r.saved} · 오류 ${r.errorCount}`, by);
      return res.status(200).json(r);
    }

    if (act === 'item') {
      const id = idOf(b.id);
      if (!id) return res.status(400).json({ error: '글 번호가 없습니다' });
      const patch = {};
      if (typeof b.hidden === 'boolean') patch.hidden = b.hidden;
      if (typeof b.pinned === 'boolean') patch.pinned = b.pinned;
      if (!Object.keys(patch).length) return res.status(400).json({ error: '바꿀 것이 없습니다' });
      const r = await sb('hub_items', { method: 'PATCH', query: `?id=eq.${id}&select=id,title`, body: patch, prefer: 'return=representation' });
      if (!r || !r.length) return res.status(404).json({ error: '그 글이 없습니다' });
      await log(`AI 허브 글 ${id} · ${Object.entries(patch).map(([k, v]) => (k === 'hidden' ? (v ? '숨김' : '보이기') : (v ? '고정' : '고정 풀기'))).join(' · ')}`, by);
      return res.status(200).json({ ok: true });
    }

    if (act === 'source-add') {
      const kind = b.kind === 'youtube' ? 'youtube' : b.kind === 'rss' ? 'rss' : '';
      const name = hub.cleanLine(b.name, 60);
      const target = String(b.target || '').trim();
      const topic = hub.cleanLine(b.topic, 30) || null;
      if (!kind || !name) return res.status(400).json({ error: '종류와 이름을 적어 주세요' });
      if (!hub.feedUrlOf({ kind, url_or_channel_id: target })) {
        return res.status(400).json({ error: kind === 'youtube'
          ? '유튜브 채널 번호는 UC 로 시작하는 24글자입니다 (채널 주소의 /channel/ 뒤)'
          : 'RSS 주소는 https:// 로 시작하는 공개 주소여야 합니다' });
      }
      try {
        await sb('hub_sources', { method: 'POST', prefer: 'return=minimal', body: [{ kind, name, url_or_channel_id: target, topic, enabled: true }] });
      } catch (e) {
        if (/23505|duplicate/.test(String(e.message))) return res.status(409).json({ error: '이미 등록된 출처입니다' });
        throw e;
      }
      await log(`AI 허브 출처 추가 · ${kind} · ${name}`, by);
      return res.status(200).json({ ok: true });
    }

    if (act === 'source-toggle') {
      const id = idOf(b.id);
      if (!id || typeof b.enabled !== 'boolean') return res.status(400).json({ error: '출처 번호와 켜기/끄기가 필요합니다' });
      const r = await sb('hub_sources', { method: 'PATCH', query: `?id=eq.${id}&select=id,name`, body: { enabled: b.enabled }, prefer: 'return=representation' });
      if (!r || !r.length) return res.status(404).json({ error: '그 출처가 없습니다' });
      await log(`AI 허브 출처 ${b.enabled ? '켜기' : '끄기'} · ${r[0].name}`, by);
      return res.status(200).json({ ok: true });
    }

    if (act === 'brief-save') {
      const title = hub.cleanLine(b.title, 120);
      const body = hub.cleanBody(b.body);
      if (!title || !body) return res.status(400).json({ error: '제목과 본문을 적어 주세요' });
      const id = b.id == null || b.id === '' ? null : idOf(b.id);
      if (id) {
        /* 고치기 — 상태(초안/게시)는 그대로 둡니다. 게시 여부는 [게시]·[내리기] 로만 바꿉니다 */
        const r = await sb('hub_briefs', { method: 'PATCH', query: `?id=eq.${id}&select=id,day`, body: { title, body, who: by }, prefer: 'return=representation' });
        if (!r || !r.length) return res.status(404).json({ error: '그 브리핑이 없습니다' });
        await log(`AI 허브 브리핑 고침 · ${r[0].day}`, by);
        return res.status(200).json({ ok: true, id });
      }
      const day = String(b.day || hub.kstDay()).trim();
      if (!hub.validDay(day)) return res.status(400).json({ error: '날짜는 YYYY-MM-DD 모양이어야 합니다' });
      const ex = await sb('hub_briefs', { query: `?select=id&day=eq.${day}&limit=1` });
      if (ex && ex[0]) return res.status(409).json({ error: '그 날짜 브리핑이 이미 있습니다 — 목록에서 열어 고쳐 주세요', id: ex[0].id });
      let r;
      try {
        r = await sb('hub_briefs', { method: 'POST', prefer: 'return=representation',
          body: [{ day, title, body, status: 'draft', source: 'admin', who: by }] });
      } catch (e) {
        /* 그 사이 AI 본부가 같은 날짜 초안을 올린 경우 */
        if (/23505|duplicate/.test(String(e && e.message))) return res.status(409).json({ error: '그 날짜 브리핑이 방금 생겼습니다 — 새로고침 후 목록에서 열어 고쳐 주세요' });
        throw e;
      }
      await log(`AI 허브 브리핑 새로 씀 (초안) · ${day}`, by);
      return res.status(200).json({ ok: true, id: r && r[0] && r[0].id });
    }

    if (act === 'brief-publish' || act === 'brief-unpublish') {
      const id = idOf(b.id);
      if (!id) return res.status(400).json({ error: '브리핑 번호가 없습니다' });
      const pub = act === 'brief-publish';
      const r = await sb('hub_briefs', {
        method: 'PATCH', query: `?id=eq.${id}&select=id,day`, prefer: 'return=representation',
        body: pub ? { status: 'published', published_at: new Date().toISOString(), who: by } : { status: 'draft', published_at: null, who: by },
      });
      if (!r || !r.length) return res.status(404).json({ error: '그 브리핑이 없습니다' });
      await log(`AI 허브 브리핑 ${pub ? '게시' : '내림'} · ${r[0].day}`, by);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: '알 수 없는 동작입니다' });
  } catch (e) {
    if (hub.missingTable(e)) {
      const msg = 'AI 허브 표가 없습니다 — db/11-AI허브.sql 을 실행해 주세요';
      return req.method === 'GET' ? res.status(200).json({ ok: true, ready: false, error: msg }) : res.status(503).json({ error: msg });
    }
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
};
