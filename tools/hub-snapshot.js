// AI 소식 기본 자료 만들기 — DB(db/11)가 아직 없거나 비어 있을 때 /hub 에 대신 보여 줄 뉴스·영상 묶음
// 실행: node tools/hub-snapshot.js   → data/hub-snapshot.json 을 새로 씁니다 (2026-11-09)
//   · db/11-AI허브.sql 의 기본 출처 19곳을 그대로 읽습니다 (같은 RSS 읽기·안전 검사 코드 api/_hub.js 사용)
//   · 사진이 없는 기사는 원문의 대표 사진(og:image)과 설명을 읽어 옵니다
//   · DB 수집이 돌기 시작하면 화면은 DB 값을 쓰고, 이 파일은 쓰지 않습니다
const fs = require('fs'), path = require('path');
const hub = require('../api/_hub');
const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'db', '11-AI허브.sql'), 'utf8');
const srcs = [...sql.matchAll(/\('(rss|youtube)', '([^']+)', '([^']+)', '[^']*'\)/g)].map((m, i) => ({ id: i + 1, kind: m[1], name: m[2], url_or_channel_id: m[3] }));
(async () => {
  const now = Date.now(), news = [], yt = [], seen = new Set();
  await Promise.all(srcs.map(async s => {
    const url = hub.feedUrlOf(s);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'KVC-Hub/1.0' } });
      const items = hub.parseFeed(await r.text(), s.kind);
      for (const it of items) {
        if (seen.has(it.url)) continue; seen.add(it.url);
        if (it.published_at && now - Date.parse(it.published_at) > 21 * 86400000) continue;
        if (s.kind === 'youtube') yt.push({ title: it.title, url: it.url, thumb: it.thumb || '', at: it.published_at, views: it.views, perHour: hub.ytScore(it.views, it.published_at, now), channel: s.name, pinned: false });
        else news.push({ title: it.title, url: it.url, summary: it.summary || '', thumb: it.thumb || '', at: it.published_at, source: s.name, pinned: false });
      }
      console.log('✔', s.name, items.length);
    } catch (e) { console.log('✘', s.name, String(e.message || e).slice(0, 80)); }
  }));
  news.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const top = news.slice(0, 90);
  /* 사진 없는 기사 — 6건씩 동시에 원문 대표 사진 */
  const need = top.filter(n => !n.thumb);
  for (let i = 0; i < need.length; i += 6) {
    await Promise.all(need.slice(i, i + 6).map(async n => {
      const m = await hub.fetchMeta(n.url);
      if (!m) return;
      if (m.thumb) n.thumb = m.thumb;
      if (m.summary && (!n.summary || n.summary.startsWith('출처 ') || n.summary.length < 40)) n.summary = m.summary;
    }));
  }
  yt.sort((a, b) => b.perHour - a.perHour);
  const out = { ok: true, ready: true, snapshot: true, brief: null, news: top, youtube: yt.slice(0, 12), updatedAt: new Date(now).toISOString() };
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'hub-snapshot.json'), JSON.stringify(out));
  console.log(`뉴스 ${top.length}건 (사진 ${top.filter(n => n.thumb).length}) · 영상 ${out.youtube.length}편 → data/hub-snapshot.json`);
})();
