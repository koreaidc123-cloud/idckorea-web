/* ═══════════════════════════════════════════════════════════════
   AI 허브 시험용 가짜 출처 · 가짜 피드 (2026-11-08)

   진짜 RSS·유튜브를 부르지 않습니다. server.js 의 feeds.byUrl 에 주소별 답을 넣어 두고,
   fake-supabase 의 hub_sources 에 그 주소를 출처로 넣습니다.
     1 테스트 뉴스(RSS)   — 글 4개: 정상 2 · 같은 주소 겹침 1 · 40일 전 글 1 · 제목에 <img onerror> 숨김
     2 테스트 아톰(Atom)  — 글 2개: 1번 피드와 같은 주소 1 (출처 사이 겹침) · 새 글 1
     3 테스트 채널(유튜브) — 영상 3개: 조회수·썸네일 · 시간당 조회수 순서 확인용
     4 고장난 출처        — 500 을 돌려줌 (출처별 오류 확인)
     5 꺼 둔 출처         — enabled=false · 불리면 안 됨
   ※ 값은 전부 시험용 가짜입니다.
   ═══════════════════════════════════════════════════════════════ */
const CH = 'UCe2eTestChannel000000aa';            // 24글자 가짜 채널 번호
const URLS = {
  rss: 'https://news.e2e.test/rss.xml',
  atom: 'https://atom.e2e.test/feed.xml',
  yt: 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CH,
  broken: 'https://broken.e2e.test/rss.xml',
  off: 'https://off.e2e.test/rss.xml',
};
const iso = ms => new Date(ms).toISOString();
const rfc = ms => new Date(ms).toUTCString();

function rssXml(now) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>테스트 뉴스</title>
<item><title>클로드 코드 새 기능 발표</title><link>https://news.e2e.test/a/1</link>
<description><![CDATA[<p>원격PC 에서 <b>24시간</b> 돌리는 방법이 늘었습니다.</p><script>alert(1)</script>]]></description>
<pubDate>${rfc(now - 2 * 3600000)}</pubDate></item>
<item><title>&lt;img src=x onerror=alert(1)&gt;위험한 제목 &amp; 기호</title><link>https://news.e2e.test/a/2</link>
<description>&lt;b&gt;요약&lt;/b&gt; 입니다</description><pubDate>${rfc(now - 5 * 3600000)}</pubDate></item>
<item><title>클로드 코드 새 기능 발표 (겹침)</title><link>https://news.e2e.test/a/1</link><pubDate>${rfc(now - 3600000)}</pubDate></item>
<item><title>40일 지난 옛 기사</title><link>https://news.e2e.test/a/old</link><pubDate>${rfc(now - 40 * 86400000)}</pubDate></item>
<item><title>스크립트 주소 기사</title><link>javascript:alert(1)</link><pubDate>${rfc(now - 3600000)}</pubDate></item>
</channel></rss>`;
}
function atomXml(now) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>테스트 아톰</title>
<entry><title type="html"><![CDATA[클로드 코드 새 기능 발표 — 다른 출처]]></title>
<link rel="alternate" type="text/html" href="https://news.e2e.test/a/1"/><published>${iso(now - 90 * 60000)}</published>
<summary type="html"><![CDATA[같은 기사입니다]]></summary></entry>
<entry><title>코덱스 업데이트 소식</title><link rel="alternate" href="https://atom.e2e.test/b/1"/>
<published>${iso(now - 30 * 60000)}</published><summary>새 글</summary></entry>
</feed>`;
}
function ytXml(now) {
  const e = (id, title, hoursAgo, views) => `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><yt:channelId>${CH}</yt:channelId>
<title>${title}</title><link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/>
<published>${iso(now - hoursAgo * 3600000)}</published>
<media:group><media:title>${title}</media:title><media:thumbnail url="https://i1.ytimg.com/vi/${id}/hqdefault.jpg" width="480" height="360"/>
<media:description>설명 ${id}</media:description><media:community><media:starRating count="1" average="5.00" min="1" max="5"/>
<media:statistics views="${views}"/></media:community></media:group></entry>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<title>테스트 채널</title>
${e('vidSlow0001', '천천히 오르는 영상', 100, 10000)}
${e('vidFast0002', '빠르게 오르는 영상', 2, 5000)}
${e('vidMid00003', '보통 영상 &amp; 강의', 10, 20000)}
</feed>`;
}

/* 피드 답 · 출처 줄을 다시 깝니다 (매 시나리오 처음에 부름) */
function setup(srv) {
  const now = Date.now();
  srv.feeds.calls.length = 0;
  for (const k of Object.keys(srv.feeds.byUrl)) delete srv.feeds.byUrl[k];
  Object.assign(srv.feeds.byUrl, {
    [URLS.rss]: { body: rssXml(now) },
    [URLS.atom]: { body: atomXml(now) },
    [URLS.yt]: { body: ytXml(now) },
    [URLS.broken]: { status: 500, body: 'server error' },
    [URLS.off]: { body: rssXml(now) },
  });
  const db = srv.fakeDb.db;
  db.hub_sources.length = 0; db.hub_items.length = 0; db.hub_briefs.length = 0;
  db.settings = db.settings.filter(s => s.k !== 'hub_last_collect');
  const at = iso(now - 86400000);
  db.hub_sources.push(
    { id: 9001, kind: 'rss', name: '테스트 뉴스', url_or_channel_id: URLS.rss, topic: 'news_ko', enabled: true, created_at: at },
    { id: 9002, kind: 'rss', name: '테스트 아톰', url_or_channel_id: URLS.atom, topic: 'news_en', enabled: true, created_at: at },
    { id: 9003, kind: 'youtube', name: '테스트 채널', url_or_channel_id: CH, topic: 'ai_tools', enabled: true, created_at: at },
    { id: 9004, kind: 'rss', name: '고장난 출처', url_or_channel_id: URLS.broken, topic: null, enabled: true, created_at: at },
    { id: 9005, kind: 'rss', name: '꺼 둔 출처', url_or_channel_id: URLS.off, topic: null, enabled: false, created_at: at },
  );
}

module.exports = { setup, URLS, CH };
