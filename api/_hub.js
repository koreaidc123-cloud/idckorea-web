/* ═══════════════════════════════════════════════════════════════
   AI 허브 공용 도구 — RSS 읽기 · 수집 · 표 확인 (2026-11-08)

   api/hub.js (공개 창구)와 api/_admin-hub.js (관리자 화면)가 함께 씁니다.
   ※ 밑줄로 시작하는 파일이라 Vercel 함수 개수(12개 한도)에 세지 않습니다.

   ★ 바깥 패키지를 쓰지 않습니다 (npm 설치 없음).
     RSS·Atom 은 "글 하나 = <item> 또는 <entry>" 라는 단순한 모양이라,
     정해진 칸(제목·주소·날짜·요약·썸네일·조회수)만 정규식으로 골라 읽습니다.
     · 한 피드는 2MB 까지만 읽고, 글은 피드마다 40개까지만 씁니다.
     · 제목·요약의 HTML 태그는 전부 벗겨 "글자만" 저장합니다.
     · 주소는 http(s) 만, 썸네일은 https 만 받습니다 (javascript: 같은 것은 버림).

   ★ 유료 API 를 쓰지 않습니다.
     유튜브는 공개 채널 RSS (https://www.youtube.com/feeds/videos.xml?channel_id=…) 만 읽습니다.
     API 키가 필요 없고, 피드에 들어 있는 조회수(media:statistics)를 그대로 씁니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');

const MAX_BYTES = 2 * 1024 * 1024;   // 피드 하나 최대 크기
const MAX_PER_FEED = 40;             // 피드 하나에서 쓰는 글 수
const MAX_ITEM = 200 * 1024;         // 글 하나 최대 크기
const MAX_PLAIN = 10000;             // 태그를 벗기기 전 최대 글자 수 (요약은 어차피 200자)
const TIMEOUT_MS = 6000;             // 피드 하나 기다리는 시간 (전부 동시에 받으므로 전체도 약 6초)
const KEEP_DAYS = 30;                // 이보다 오래된 글은 지웁니다 (고정한 글은 남김)
const SUMMARY_MAX = 200;
const LAST_KEY = 'hub_last_collect'; // settings 표에 마지막 수집 결과를 남기는 이름

/* ── 표가 아직 없다는 오류인지 (db/11 을 아직 안 돌린 Supabase) ── */
const missingTable = e => /42P01|PGRST205|does not exist|Could not find the table/.test(String((e && e.message) || e || ''));

/* ── 글자 다듬기 ───────────────────────────────────────────── */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };
function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, k) => {
    if (k[0] === '#') {
      const n = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      /* 제어 문자·잘못된 번호는 버립니다 */
      if (!Number.isFinite(n) || n < 32 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return ' ';
      return String.fromCodePoint(n);
    }
    const v = ENT[k.toLowerCase()];
    return v === undefined ? m : v;
  });
}
/* CDATA 를 풀고 → 엔티티를 풀고 → 태그를 벗기고 → 공백을 한 칸으로.
   엔티티를 먼저 풀어야 &lt;b&gt; 처럼 "글자로 숨긴 태그" 까지 벗겨집니다. */
function plain(raw, max) {
  let s = String(raw || '').slice(0, MAX_PLAIN).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s);
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^<>]*>/g, ' ');
  s = decodeEntities(s);                          // &amp;nbsp; 처럼 두 번 감싼 것
  s = s.replace(/[<>]/g, ' ');                    // 남은 꺾쇠는 글자로도 두지 않습니다
  s = s.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max - 1).trim() + '…';
  return s;
}
const httpUrl = u => {
  const s = decodeEntities(String(u || '').trim());
  if (!/^https?:\/\//i.test(s) || s.length > 1000 || /[\s"'<>`]/.test(s)) return '';
  try { const x = new URL(s); return /^https?:$/.test(x.protocol) ? x.toString() : ''; } catch (e) { return ''; }
};
const httpsUrl = u => { const s = httpUrl(u); return /^https:/i.test(s) ? s : ''; };

/* ── 날짜 — RSS(Sun, 08 Nov 2026 00:38:34 GMT) · Atom(2026-11-08T12:35:41+00:00)
   · AI타임스처럼 시간대 없는 "2026-11-08 18:14:24" 는 한국 시각으로 봅니다 ── */
function parseDate(s) {
  const t = plain(s);
  if (!t) return null;
  let ms;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+09:00`);
  else ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  /* 미래 날짜(피드 오류)는 지금으로 맞춥니다 — 맨 위에 계속 붙어 있지 않게 */
  const now = Date.now();
  if (ms > now + 3600000) ms = now;
  return new Date(ms).toISOString();
}

/* ── 작은 XML 읽기 ─────────────────────────────────────────── */
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* <tag ...>값</tag> 의 값 (처음 하나) */
/* ★ Codex T-0222: 닫는 태그가 없는 글자가 반복되면 정규식이 같은 곳을 몇 번이고 다시 훑어 느려집니다.
   여는 태그는 [^<>]* (다음 < 에서 멈춤)로 찾고, 닫는 태그는 indexOf 로 한 번만 찾습니다. */
function tagText(block, tag) {
  const m = new RegExp('<' + reEsc(tag) + '(?:\\s[^<>]*)?>', 'i').exec(block);
  if (!m) return '';
  const start = m.index + m[0].length;
  const end = block.toLowerCase().indexOf('</' + tag.toLowerCase(), start);
  return end < 0 ? '' : block.slice(start, end);
}
/* <tag ... attr="값"> 의 값 (처음 하나 · 조건 attrs 가 맞는 것) */
function tagAttr(block, tag, attr, need) {
  const re = new RegExp('<' + reEsc(tag) + '\\b([^<>]*)>', 'gi');
  let m;
  while ((m = re.exec(block))) {
    const a = m[1];
    if (need && !Object.entries(need).every(([k, v]) => new RegExp('\\b' + reEsc(k) + '\\s*=\\s*["\']' + reEsc(v) + '["\']', 'i').test(a))) continue;
    const v = a.match(new RegExp('\\b' + reEsc(attr) + '\\s*=\\s*"([^"]*)"', 'i')) || a.match(new RegExp('\\b' + reEsc(attr) + "\\s*=\\s*'([^']*)'", 'i'));
    if (v) return v[1];
  }
  return '';
}

/* 피드 글자 → 글 목록 [{title,url,summary,thumb,published_at,views,channelTitle}]
   kind: 'youtube' 이면 유튜브 Atom 으로 읽습니다 (조회수·썸네일) */
function parseFeed(xml, kind) {
  const text = String(xml || '').slice(0, MAX_BYTES);
  const out = [];
  const seen = new Set();
  /* 글 묶음(<item>…</item> · <entry>…</entry>)을 앞에서부터 한 번만 훑습니다.
     닫는 태그가 없으면 거기서 멈춥니다 (깨진 피드에서 같은 곳을 다시 훑지 않게 · Codex T-0222) */
  const low = text.toLowerCase();
  const open = /<(item|entry)(?=[\s>/])[^<>]*>/g;
  let m;
  while (out.length < MAX_PER_FEED && (m = open.exec(low))) {
    const name = m[1];
    const from = m.index + m[0].length;
    const close = low.indexOf('</' + name, from);
    if (close < 0) break;
    open.lastIndex = close + name.length + 2;
    if (close - from > MAX_ITEM) continue;          // 글 하나가 너무 크면 건너뜀
    const b = text.slice(from, close);
    const atom = name === 'entry';
    const title = plain(tagText(b, 'title') || tagText(b, 'media:title'), 200);
    let url = '';
    if (atom) url = tagAttr(b, 'link', 'href', { rel: 'alternate' }) || tagAttr(b, 'link', 'href');
    if (!url) url = plain(tagText(b, 'link'));
    if (!url && kind === 'youtube') {
      const vid = plain(tagText(b, 'yt:videoId'));
      if (/^[A-Za-z0-9_-]{6,20}$/.test(vid)) url = 'https://www.youtube.com/watch?v=' + vid;
    }
    url = httpUrl(url);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const published = parseDate(tagText(b, 'published') || tagText(b, 'pubDate') || tagText(b, 'dc:date') || tagText(b, 'updated'));
    let summary = '';
    let thumb = '';
    let views = null;
    if (kind === 'youtube') {
      summary = plain(tagText(b, 'media:description'), SUMMARY_MAX);
      thumb = httpsUrl(tagAttr(b, 'media:thumbnail', 'url'));
      const v = tagAttr(b, 'media:statistics', 'views');
      if (/^\d{1,15}$/.test(v)) views = Number(v);
    } else {
      /* 구글 뉴스는 요약 대신 "제목 + 언론사" 만 줍니다 — 그때는 언론사 이름만 남깁니다 */
      const src = plain(tagText(b, 'source'), 60);
      summary = src ? '출처 ' + src
        : plain(tagText(b, 'description') || tagText(b, 'summary') || tagText(b, 'content'), SUMMARY_MAX);
      thumb = httpsUrl(tagAttr(b, 'media:thumbnail', 'url') || tagAttr(b, 'media:content', 'url', { medium: 'image' }) ||
        tagAttr(b, 'enclosure', 'url', { type: 'image/jpeg' }) || tagAttr(b, 'enclosure', 'url', { type: 'image/png' }));
    }
    /* 구글 뉴스 제목 끝의 " - 언론사" 는 요약 칸에 이미 있으니 뗍니다 */
    const src2 = kind === 'youtube' ? '' : plain(tagText(b, 'source'), 60);
    const title2 = src2 && title.endsWith(' - ' + src2) ? title.slice(0, -(src2.length + 3)).trim() || title : title;
    out.push({ title: title2, url, summary: summary || null, thumb: thumb || null, published_at: published, views });
  }
  return out;
}

/* 유튜브 점수 = 올린 뒤 지난 시간당 조회수 (1시간 미만은 1시간으로 셈) */
function ytScore(views, publishedIso, now = Date.now()) {
  if (!Number.isFinite(views) || views <= 0) return 0;
  const t = publishedIso ? Date.parse(publishedIso) : NaN;
  const hours = Number.isFinite(t) ? Math.max(1, (now - t) / 3600000) : 24 * 30;
  return Math.round((views / hours) * 10) / 10;
}

/* ── 출처 확인 — 관리자가 넣는 값도, 표에서 읽은 값도 이 검사를 거칩니다 ── */
const CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;
/* 내부망·내 컴퓨터 주소는 받지 않습니다 (서버가 남의 내부망을 대신 열어 보는 일 막기) */
function publicHost(h) {
  const x = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!x || x === 'localhost' || x.endsWith('.localhost') || x.endsWith('.local') || x.endsWith('.internal')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(x)) return false;        // 숫자 주소(IPv4)는 전부 거절
  if (x.includes(':')) return false;                       // IPv6 숫자 주소도 거절
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)) return false;
  return true;
}
function feedUrlOf(src) {
  if (!src) return '';
  const v = String(src.url_or_channel_id || '').trim();
  if (src.kind === 'youtube') return CHANNEL_RE.test(v) ? 'https://www.youtube.com/feeds/videos.xml?channel_id=' + v : '';
  if (src.kind !== 'rss') return '';
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return '';
    if (!publicHost(u.hostname)) return '';
    return u.toString();
  } catch (e) { return ''; }
}

/* ── 피드 받기 (시간 제한 · 크기 제한 · 다른 곳으로 넘기면 거절) ── */
async function fetchFeed(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let r = await fetch(url, {
      signal: ctl.signal, redirect: 'manual',
      headers: { 'User-Agent': 'KVC-Hub/1.0 (+https://idckorea-dusky.vercel.app/hub)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' },
    });
    /* 한 번까지는 따라갑니다 — 단, 넘겨준 곳도 https 공개 주소여야 합니다 */
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location') || '';
      let next = '';
      try { next = new URL(loc, url).toString(); } catch (e) {}
      if (!feedUrlOf({ kind: 'rss', url_or_channel_id: next })) throw new Error('다른 주소로 넘김 (따라가지 않음)');
      r = await fetch(next, { signal: ctl.signal, redirect: 'manual', headers: { 'User-Agent': 'KVC-Hub/1.0' } });
    }
    if (!r.ok) throw new Error('응답 ' + r.status);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error('피드가 너무 큽니다');
    /* ★ Codex T-0222: Content-Length 가 없는 큰 응답도 막도록, 받으면서 세다가 2MB 를 넘으면 끊습니다 */
    let text;
    if (r.body && typeof r.body.getReader === 'function') {
      const reader = r.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > MAX_BYTES) { try { await reader.cancel(); } catch (e) {} throw new Error('피드가 너무 큽니다'); }
        parts.push(Buffer.from(value));
      }
      text = Buffer.concat(parts).toString('utf8');
    } else text = await r.text();
    if (!/<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 4000))) throw new Error('RSS 가 아닙니다');
    return text;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(TIMEOUT_MS / 1000 + '초 안에 응답 없음');
    throw e;
  } finally { clearTimeout(timer); }
}

/* ── 마지막 수집 결과 읽기 ── */
async function lastCollect() {
  try {
    const rows = await sb('settings', { query: `?select=v&k=eq.${LAST_KEY}&limit=1` });
    if (!rows || !rows[0]) return null;
    return JSON.parse(rows[0].v);
  } catch (e) { return null; }
}

/* ── 한 번 수집하기 ────────────────────────────────────────────
   켜진 출처를 전부 동시에 받아 → 글로 나누고 → 주소(url) 기준으로 넣거나 덮어씁니다.
   숨김·고정 표시는 덮어쓰지 않습니다 (보내는 칸에 아예 넣지 않음).
   30일 지난 글은 지웁니다 (고정한 글은 남김).
   결과(시각·개수·출처별 오류)는 settings 표 hub_last_collect 에 남깁니다. */
async function collect(by) {
  if (!ready()) return { ok: false, status: 503, error: 'DB 미연결' };
  let sources;
  try {
    sources = await sb('hub_sources', { query: '?select=id,kind,name,url_or_channel_id,enabled&enabled=is.true&order=id.asc&limit=100' });
  } catch (e) {
    if (missingTable(e)) return { ok: false, status: 409, error: 'AI 허브 표가 없습니다 — db/11-AI허브.sql 을 실행해 주세요', missing: true };
    throw e;
  }
  const now = Date.now();
  const errors = [];
  const perSource = [];
  const rows = [];
  const urls = new Set();
  /* 받기는 전부 동시에, 정리는 출처 번호 순서대로 (같은 글이 두 곳에 있으면 늘 앞 출처 것을 씀) */
  const got = await Promise.all((sources || []).map(async src => {
    const url = feedUrlOf(src);
    if (!url) return { src, err: '주소 형식이 올바르지 않습니다' };
    try { return { src, items: parseFeed(await fetchFeed(url), src.kind) }; }
    catch (e) { return { src, err: String((e && e.message) || e).slice(0, 120) }; }
  }));
  for (const g of got) {
    const src = g.src;
    if (g.err) { errors.push({ id: src.id, name: src.name, error: g.err }); continue; }
    perSource.push({ id: src.id, name: src.name, count: g.items.length });
    for (const it of g.items) {
      if (urls.has(it.url)) continue;          // 두 출처에 같은 글이 있으면 하나만
      urls.add(it.url);
      const kind = src.kind === 'youtube' ? 'youtube' : 'news';
      rows.push({
        source_id: src.id, kind, title: it.title, url: it.url, summary: it.summary, thumb: it.thumb,
        published_at: it.published_at, views: kind === 'youtube' ? it.views : null,
        score: kind === 'youtube' ? ytScore(it.views, it.published_at, now) : 0,
      });
    }
  }

  /* 30일보다 오래된 글은 처음부터 넣지 않습니다 */
  const cutoff = now - KEEP_DAYS * 86400000;
  const fresh = rows.filter(r => !r.published_at || Date.parse(r.published_at) >= cutoff);
  let saved = 0;
  for (let i = 0; i < fresh.length; i += 200) {
    const chunk = fresh.slice(i, i + 200);
    await sb('hub_items', {
      method: 'POST', query: '?on_conflict=url', body: chunk,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    saved += chunk.length;
  }

  /* 정리 — 30일 지난 글 (고정 제외) */
  const cutIso = new Date(cutoff).toISOString();
  let pruned = 0;
  try {
    const a = await sb('hub_items', { method: 'DELETE', query: `?published_at=lt.${cutIso}&pinned=is.false&select=id`, prefer: 'return=representation' });
    const b = await sb('hub_items', { method: 'DELETE', query: `?published_at=is.null&created_at=lt.${cutIso}&pinned=is.false&select=id`, prefer: 'return=representation' });
    pruned = (a || []).length + (b || []).length;
  } catch (e) { errors.push({ id: null, name: '정리', error: String((e && e.message) || e).slice(0, 120) }); }

  /* ★ Codex T-0222: 예전엔 JSON 글자를 8,000자에서 잘라 저장해, 출처가 많으면 깨진 JSON 이 되어
     "수집 기록 없음" 으로 보였습니다. 저장 전에 목록 길이·글자 수를 줄여 늘 올바른 JSON 이 되게 합니다. */
  const result = {
    at: new Date(now).toISOString(), by: String(by || '').slice(0, 40),
    sources: (sources || []).length, fetched: rows.length, saved, pruned,
    errorCount: errors.length,
    perSource: perSource.slice(0, 100).map(p => ({ id: p.id, name: String(p.name || '').slice(0, 40), count: p.count })),
    errors: errors.slice(0, 30).map(e => ({ id: e.id, name: String(e.name || '').slice(0, 40), error: String(e.error || '').slice(0, 100) })),
  };
  try {
    await sb('settings', {
      method: 'POST', query: '?on_conflict=k', body: [{ k: LAST_KEY, v: JSON.stringify(result) }],
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  } catch (e) {}
  return Object.assign({ ok: true }, result);
}

/* 있는 날짜인지 — 2026-02-30 처럼 다음 달로 넘어가는 날짜는 거절 (Codex T-0222) */
function validDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  const x = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2020 && y <= 2100 && x.getUTCFullYear() === y && x.getUTCMonth() === mo - 1 && x.getUTCDate() === d;
}
/* 한국 날짜 (YYYY-MM-DD) */
const kstDay = (ms = Date.now()) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);

/* 브리핑 본문 정리 — 글자만, 줄바꿈은 유지, 제어 문자 제거 */
function cleanBody(s, max = 20000) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\uFEFF]/g, '')
    .slice(0, max).trim();
}
const cleanLine = (s, max) => plain(String(s == null ? '' : s), max);

module.exports = {
  parseFeed, plain, ytScore, feedUrlOf, publicHost, collect, lastCollect, missingTable,
  kstDay, validDay, cleanBody, cleanLine, CHANNEL_RE, LAST_KEY, KEEP_DAYS,
};
