/* ═══════════════════════════════════════════════════════════════
   운영 설정 저장 — 셋팅비 · 다운 판정 시간 · 만료 알림 시점 · 할인율

   POST /api/admin?do=settings   { setup:5000, downSec:180, notiDay:5, off60:3, off90:5 }

   ★ 왜 서버에 두는가
     전에는 브라우저 저장소에만 있었습니다. 그래서
       · 다른 PC 에서 관리자를 열면 설정이 달랐고
       · 서버가 쓰는 값(다운 판정 시간)과 화면이 쓰는 값이 어긋났습니다.
     이제 한 곳(settings 표)만 보므로 어긋날 수 없습니다.

   ※ 여기서 바꾼 down_sec 은 서버가 "이 PC 가 살아있나"를 판정할 때
     바로 쓰입니다. 너무 짧게 잡으면 멀쩡한 PC 가 다운으로 보입니다.
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify } = require('./admin-login');

/* 화면에서 쓰는 이름 ↔ 표에 저장하는 이름, 그리고 허용 범위 */
const FIELDS = {
  setup:   { key: 'setup_fee', lo: 0,  hi: 100000, label: '초기 셋팅비' },
  downSec: { key: 'down_sec',  lo: 60, hi: 3600,   label: '다운 판정 시간' },
  notiDay: { key: 'noti_day',  lo: 1,  hi: 30,     label: '만료 알림 시점' },
  off60:   { key: 'off60',     lo: 0,  hi: 50,     label: '60일 할인율' },
  off90:   { key: 'off90',     lo: 0,  hi: 50,     label: '90일 할인율' },
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  /* ── 읽기 ── */
  if (req.method === 'GET') {
    try {
      const rows = await sb('settings', { query: '?select=k,v' });
      const raw = Object.fromEntries((rows || []).map(r => [r.k, r.v]));
      const out = {};
      for (const [name, f] of Object.entries(FIELDS)) {
        out[name] = raw[f.key] !== undefined ? Number(raw[f.key]) : null;
      }
      return res.status(200).json({ ok: true, settings: out });
    } catch (e) {
      return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET 또는 POST' });

  /* ── 저장 ── */
  const b = req.body || {};
  const rows = [];
  for (const [name, f] of Object.entries(FIELDS)) {
    if (b[name] === undefined || b[name] === null || b[name] === '') continue;
    const n = Number(b[name]);
    if (!Number.isFinite(n) || n < f.lo || n > f.hi) {
      return res.status(400).json({ error: `${f.label}은(는) ${f.lo} ~ ${f.hi} 사이여야 합니다` });
    }
    rows.push({ k: f.key, v: String(Math.round(n)) });
  }
  if (!rows.length) return res.status(400).json({ error: '바꿀 값이 없습니다' });

  try {
    await sb('settings', {
      method: 'POST',
      query: '?on_conflict=k',
      body: rows,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    try {
      await sb('view_log', { method: 'POST', prefer: 'return=minimal',
        body: [{ pn: null, act: '설정 변경 · ' + rows.map(r => `${r.k}=${r.v}`).join(', '), who: '관리자' }] });
    } catch (e) {}
    res.status(200).json({ ok: true, saved: rows.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
};
