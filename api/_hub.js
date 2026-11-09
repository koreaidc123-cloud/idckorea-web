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
const dns = require('dns');
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
/* ★ Codex T-0225: toLowerCase() 는 İ 같은 글자를 두 칸으로 늘려 위치가 어긋납니다 → 영문 대문자만 바꿉니다 (길이 그대로) */
const asciiLow = s => s.replace(/[A-Z]+/g, c => c.toLowerCase());
/* 닫는 태그 </name> 찾기 — 이름 바로 뒤가 > 나 공백이어야 진짜 닫는 태그입니다 (</titleExtra> 같은 것은 건너뜀) */
function findClose(low, name, from) {
  const key = '</' + name;
  let i = from;
  for (;;) {
    i = low.indexOf(key, i);
    if (i < 0) return -1;
    let j = i + key.length;
    while (j < low.length && /\s/.test(low[j])) j++;
    if (low[j] === '>') return i;
    i += key.length;
  }
}
/* <tag ...>값</tag> 의 값 (처음 하나) */
/* ★ Codex T-0222: 닫는 태그가 없는 글자가 반복되면 정규식이 같은 곳을 몇 번이고 다시 훑어 느려집니다.
   여는 태그는 [^<>]* (다음 < 에서 멈춤)로 찾고, 닫는 태그는 indexOf 로 한 번만 찾습니다. */
function tagText(block, tag) {
  const m = new RegExp('<' + reEsc(tag) + '(?:\\s[^<>]*)?>', 'i').exec(block);
  if (!m) return '';
  const start = m.index + m[0].length;
  const end = findClose(asciiLow(block), tag.toLowerCase(), start);
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

/* 본문 HTML 속 첫 사진 주소 (https 만) — &lt;img&gt; 처럼 글자로 감싼 것도 풉니다 (2026-11-09) */
function firstImg(raw) {
  const h = decodeEntities(String(raw || '').slice(0, MAX_PLAIN).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  const m = h.match(/<img\b[^<>]*?\bsrc\s*=\s*["'](https:\/\/[^"'\s<>]{8,900})["']/i);
  return m ? m[1] : '';
}

/* 피드 글자 → 글 목록 [{title,url,summary,thumb,published_at,views,channelTitle}]
   kind: 'youtube' 이면 유튜브 Atom 으로 읽습니다 (조회수·썸네일) */
function parseFeed(xml, kind) {
  const text = String(xml || '').slice(0, MAX_BYTES);
  const out = [];
  const seen = new Set();
  /* 글 묶음(<item>…</item> · <entry>…</entry>)을 앞에서부터 한 번만 훑습니다.
     닫는 태그가 없으면 거기서 멈춥니다 (깨진 피드에서 같은 곳을 다시 훑지 않게 · Codex T-0222) */
  const low = asciiLow(text);
  const open = /<(item|entry)(?=[\s>/])[^<>]*>/g;
  let m;
  while (out.length < MAX_PER_FEED && (m = open.exec(low))) {
    const name = m[1];
    const from = m.index + m[0].length;
    if (/\/>$/.test(m[0])) continue;               // <item/> 처럼 빈 묶음
    const close = findClose(low, name, from);
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
      const body = tagText(b, 'description') || tagText(b, 'summary') || tagText(b, 'content:encoded') || tagText(b, 'content');
      summary = src ? '출처 ' + src : plain(body, SUMMARY_MAX);
      thumb = httpsUrl(tagAttr(b, 'media:thumbnail', 'url') || tagAttr(b, 'media:content', 'url', { medium: 'image' }) ||
        tagAttr(b, 'enclosure', 'url', { type: 'image/jpeg' }) || tagAttr(b, 'enclosure', 'url', { type: 'image/png' }) ||
        firstImg(body) || firstImg(tagText(b, 'content:encoded')));
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
/* ── 내부망 주소 막기 (Codex T-0225) ─────────────────────────────
   이름만 봐서는 "공개 도메인인데 내부 IP 로 가리키는" 경우를 못 막습니다.
   받기 직전에 DNS 로 실제 주소를 모두 확인해, 하나라도 내부·내 컴퓨터 주소면 받지 않습니다.
   ※ 확인과 실제 연결 사이에 DNS 답이 바뀌는 공격(DNS 재바인딩)까지는 막지 못합니다.
     출처는 관리자만 추가할 수 있어 위험은 낮습니다 (남은 위험으로 기록). */
function privateIp(ip) {
  let s = String(ip || '').toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) s = mapped[1];
  const v4 = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = +v4[1], b = +v4[2], c = +v4[3];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (s === '::' || s === '::1') return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
}
let lookupAll = h => dns.promises.lookup(h, { all: true, verbatim: true });
async function assertPublicHost(host) {
  let addrs;
  try { addrs = await lookupAll(host); } catch (e) { throw new Error('주소를 찾을 수 없습니다'); }
  if (!addrs || !addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('내부망 주소로 연결되는 출처라 받지 않습니다');
}

async function fetchFeed(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    await assertPublicHost(new URL(url).hostname);
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
      await assertPublicHost(new URL(next).hostname);
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
    } else if (!r.body) text = '';
    else throw new Error('응답을 나눠 읽을 수 없어 받지 않았습니다');   // 크기를 셀 수 없으면 받지 않습니다 (Codex T-0225)
    if (!/<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 4000))) throw new Error('RSS 가 아닙니다');
    return text;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(TIMEOUT_MS / 1000 + '초 안에 응답 없음');
    throw e;
  } finally { clearTimeout(timer); }
}

/* ── 기사 대표 사진·설명 (og:image · og:description) — 2026-11-09 ─────────
   RSS 에 사진이 없는 뉴스만, 한 번 수집에 ENRICH_MAX 건까지 기사 주소를 열어 머리(head) 부분만 읽습니다.
   · https 공개 주소만 · 다른 곳으로 넘기면 한 번까지 (넘긴 곳도 같은 검사) · 앞 256KB 만 읽음 · 4초 제한
   · 구글 뉴스 주소는 기사 원문이 아니라서 열지 않습니다
   · 이미 사진을 받아 둔 기사는 다시 열지 않습니다 (표에 있는 값을 그대로 씀) */
const ENRICH_MAX = 24, ENRICH_BYTES = 256 * 1024, ENRICH_MS = 4000;
function metaContent(html, key) {
  const re = /<meta\b[^<>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = m[0];
    const k = t.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i);
    if (!k || k[1].toLowerCase() !== key) continue;
    const v = t.match(/\bcontent\s*=\s*"([^"]*)"/i) || t.match(/\bcontent\s*=\s*'([^']*)'/i);
    if (v) return v[1];
  }
  return '';
}
function pageMeta(html, base) {
  const head = String(html || '').slice(0, ENRICH_BYTES);
  let img = metaContent(head, 'og:image') || metaContent(head, 'og:image:secure_url') || metaContent(head, 'twitter:image');
  img = decodeEntities(img.trim());
  if (img && !/^https?:/i.test(img)) { try { img = new URL(img, base).toString(); } catch (e) { img = ''; } }
  const desc = plain(metaContent(head, 'og:description') || metaContent(head, 'description') || metaContent(head, 'twitter:description'), SUMMARY_MAX);
  return { thumb: httpsUrl(img), summary: desc };
}
const articleUrlOk = u => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && !x.username && !x.password && (!x.port || x.port === '443') &&
      publicHost(x.hostname) && !/(^|\.)news\.google\.com$/i.test(x.hostname);
  } catch (e) { return false; }
};
/* ★ Codex T-0245: DNS 로 확인한 그 공개 IP 로만 연결합니다 (확인과 연결 사이에 주소가 바뀌는 DNS 재바인딩 차단).
   인증서는 원래 도메인 이름으로 확인합니다(servername). 전체 4초 안에 DNS·연결·읽기가 끝나야 하고,
   쓰지 않는 응답은 바로 끊으며, 256KB 를 넘는 부분은 담지도 않습니다. */
const https = require('https');
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' 시간 초과')), Math.max(1, ms)); })])
    .finally(() => clearTimeout(t));
}
function pinnedGet(url, addr, ms) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const fam = addr.family === 6 ? 6 : 4;
    const req = https.request({
      hostname: u.hostname, servername: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: fam }]) : cb(null, addr.address, fam)),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KVC-Hub/1.0)', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'identity' },
    }, res => {
      const status = res.statusCode || 0, ctype = String(res.headers['content-type'] || ''), location = String(res.headers.location || '');
      if (status >= 300 && status < 400) { res.destroy(); return resolve({ status, location }); }
      if (status !== 200 || !/html/i.test(ctype)) { res.destroy(); return resolve({ status, ctype }); }
      const parts = []; let got = 0; let done = false;
      const finish = () => { if (done) return; done = true; res.destroy(); resolve({ status, ctype, text: Buffer.concat(parts).toString('utf8') }); };
      res.on('data', c => {
        if (done) return;
        const room = ENRICH_BYTES - got;
        const piece = c.length > room ? c.subarray(0, room) : c;
        parts.push(piece); got += piece.length;
        if (got >= ENRICH_BYTES || /<\/head\s*>/i.test(piece.toString('latin1'))) finish();
      });
      res.on('end', finish);
      res.on('error', e => { if (!done) { done = true; reject(e); } });
    });
    req.setTimeout(Math.max(1, ms), () => req.destroy(new Error('시간 초과')));
    req.on('error', reject);
    req.end();
  });
}
let articleGet = pinnedGet;   // 시험에서는 가짜로 바꿉니다 (__setArticleGet)
async function fetchMeta(url) {
  const end = Date.now() + ENRICH_MS;
  try {
    let at = url;
    for (let hop = 0; hop < 2; hop++) {
      if (!articleUrlOk(at)) return null;
      const host = new URL(at).hostname;
      const addrs = await withTimeout(lookupAll(host), end - Date.now(), 'DNS');
      if (!addrs || !addrs.length || addrs.some(a => privateIp(a.address))) return null;
      const left = end - Date.now();
      if (left <= 0) return null;
      const r = await withTimeout(articleGet(at, addrs[0], left), left, '기사');
      if (r.status >= 300 && r.status < 400) {
        try { at = new URL(r.location || '', at).toString(); } catch (e) { return null; }
        continue;
      }
      if (r.status !== 200 || typeof r.text !== 'string') return null;
      return pageMeta(r.text, at);
    }
    return null;
  } catch (e) { return null; }
}
/* 표에 이미 있는 사진·요약을 먼저 채우고, 없는 것만 기사에서 읽어 옵니다 */
async function enrich(rows) {
  const need = rows.filter(r => r.kind === 'news' && !r.thumb);
  if (!need.length) return { reused: 0, fetched: 0 };
  let reused = 0, fetched = 0;
  try {
    for (let i = 0; i < need.length; i += 40) {
      const part = need.slice(i, i + 40);
      const list = part.map(r => '"' + r.url.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',');
      const old = await sb('hub_items', { query: '?select=url,thumb,summary&thumb=not.is.null&url=in.(' + encodeURIComponent(list) + ')' }) || [];
      const byUrl = new Map(old.map(o => [o.url, o]));
      for (const r of part) {
        const o = byUrl.get(r.url);
        if (o && o.thumb) { r.thumb = o.thumb; if ((!r.summary || r.summary.startsWith('출처 ')) && o.summary) r.summary = o.summary; reused++; }
      }
    }
  } catch (e) {}
  /* 새 글부터 ENRICH_MAX 건 — 6건씩 동시에 */
  const todo = need.filter(r => !r.thumb && articleUrlOk(r.url))
    .sort((a, b) => (Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0)).slice(0, ENRICH_MAX);
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async r => {
      const m = await fetchMeta(r.url);
      if (!m) return;
      if (m.thumb) { r.thumb = m.thumb; fetched++; }
      if (m.summary && (!r.summary || r.summary.startsWith('출처 ') || r.summary.length < 40)) r.summary = m.summary;
    }));
  }
  return { reused, fetched };
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
  let pics = { reused: 0, fetched: 0 };
  try { pics = await enrich(fresh); } catch (e) { errors.push({ id: null, name: '사진', error: String((e && e.message) || e).slice(0, 120) }); }
  let saved = 0;
  /* 저장이 중간에 실패해도 멈추지 않고 오류로 남깁니다 — 마지막 수집 기록은 꼭 남도록 (Codex T-0225).
     다음 수집 때 같은 주소는 덮어쓰므로 다시 돌려도 겹치지 않습니다. */
  for (let i = 0; i < fresh.length; i += 200) {
    const chunk = fresh.slice(i, i + 200);
    try {
      await sb('hub_items', {
        method: 'POST', query: '?on_conflict=url', body: chunk,
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      saved += chunk.length;
    } catch (e) { errors.push({ id: null, name: '저장', error: String((e && e.message) || e).slice(0, 120) }); }
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
    sources: (sources || []).length, fetched: rows.length, saved, pruned, pics,
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
  /* 시험 전용 — 가짜 DNS 를 끼웁니다 (tests/e2e/server.js). 운영 코드는 부르지 않습니다 */
  __setLookup(fn) { lookupAll = fn; }, __setArticleGet(fn) { articleGet = fn; }, privateIp,
  parseFeed, pageMeta, firstImg, fetchMeta, plain, ytScore, feedUrlOf, publicHost, collect, lastCollect, missingTable,
  kstDay, validDay, cleanBody, cleanLine, CHANNEL_RE, LAST_KEY, KEEP_DAYS,
};
