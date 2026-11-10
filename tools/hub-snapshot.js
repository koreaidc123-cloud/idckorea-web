// AI 소식 기본 자료 만들기 — DB(db/11)가 아직 없거나 비어 있을 때 /hub 에 대신 보여 줄 뉴스·영상 묶음
// 실행: node tools/hub-snapshot.js   → data/hub-snapshot.json 을 새로 씁니다 (2026-11-09)
//   · db/11-AI허브.sql 의 기본 출처 19곳을 그대로 읽습니다 (같은 RSS 읽기·안전 검사 코드 api/_hub.js 사용)
//   · 사진이 없는 기사는 원문의 대표 사진(og:image)과 설명을 읽어 옵니다
//   · DB 수집이 돌기 시작하면 화면은 DB 값을 쓰고, 이 파일은 쓰지 않습니다
const fs = require('fs'), path = require('path');
const hub = require('../api/_hub');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'db', '11-AI허브.sql'), 'utf8');
const srcs = [...sql.matchAll(/\('(rss|youtube)', '([^']+)', '([^']+)', '([^']*)'\)/g)].map((m, i) => ({ id: i + 1, kind: m[1], name: m[2], url_or_channel_id: m[3], topic: m[4] }));
const catOf = t => /^news_en/.test(t) ? 'en' : /^official/.test(t) ? 'official' : /^(tools|dev)/.test(t) ? 'tools' : 'ko';
(async () => {
  const now = Date.now(), news = [], yt = [], seen = new Set();
  await Promise.all(srcs.map(async s => {
    const url = hub.feedUrlOf(s);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'KVC-Hub/1.0' } });
      let items = hub.parseFeed(await r.text(), s.kind);
      if (/_f$/.test(s.topic)) items = items.filter(hub.aiTopic);
      items = items.filter(it => hub.KO_RE.test(it.title || ''));   // 한국어만 (2026-11-10)
      for (const it of items) {
        if (seen.has(it.url)) continue; seen.add(it.url);
        if (it.published_at && now - Date.parse(it.published_at) > 21 * 86400000) continue;
        if (s.kind === 'youtube') yt.push({ title: it.title, url: it.url, thumb: it.thumb || '', at: it.published_at, views: it.views, perHour: hub.ytScore(it.views, it.published_at, now), channel: s.name, pinned: false });
        else news.push({ title: it.title, url: it.url, summary: it.summary || '', thumb: it.thumb || '', at: it.published_at, source: s.name, cat: catOf(s.topic), pinned: false });
      }
      console.log('✔', s.name, items.length);
    } catch (e) { console.log('✘', s.name, String(e.message || e).slice(0, 80)); }
  }));
  news.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  /* 분류마다 고르게 — 국내 70 · 해외 30 · 공식 30 · 도구 30 까지 */
  const cap = { ko: 120, en: 0, official: 40, tools: 40 }, used = {};
  const top = news.filter(n => (used[n.cat] = (used[n.cat] || 0) + 1) <= cap[n.cat]);
  /* 저작권(2026-11-10): 허락 확인된 출처(MEDIA_OK)만 사진·요약을 남기고, 나머지는 제목·매체명·링크만 */
  for (const n of top) if (!hub.MEDIA_OK.has(n.source)) { n.thumb = ''; n.summary = /^출처 /.test(n.summary) ? n.summary.slice(0, 63) : ''; }
  const need = top.filter(n => !n.thumb && hub.MEDIA_OK.has(n.source));
  for (let i = 0; i < need.length; i += 8) {
    await Promise.all(need.slice(i, i + 8).map(async n => {
      const m = await hub.fetchMeta(n.url);
      if (!m) return;
      if (m.thumb) n.thumb = m.thumb;
      if (m.summary && (!n.summary || n.summary.startsWith('출처 ') || n.summary.length < 40)) n.summary = m.summary;
    }));
  }
  yt.sort((a, b) => b.perHour - a.perHour);
  const wk = news.concat(yt).filter(n => { const t = Date.parse(n.at); return t >= now - 7 * 86400000 && t <= now + 3600000; })
    .map(n => String(n.title || ''));   // 순위 계산용 제목만 (요약문은 공개하지 않음)
  const out = { ok: true, ready: true, snapshot: true, brief: null, news: top, youtube: yt.slice(0, 80), week: wk, updatedAt: new Date(now).toISOString() };
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'hub-snapshot.json'), JSON.stringify(out));
  console.log(`뉴스 ${top.length}건 (사진 ${top.filter(n => n.thumb).length}) · 영상 ${out.youtube.length}편 → data/hub-snapshot.json`);
})();
