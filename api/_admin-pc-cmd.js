/* ═══════════════════════════════════════════════════════════════
   랙PC 에 명령 걸기 — 재부팅 · 취소

   POST /api/admin?do=pc-cmd   { pn:"Y-042", cmd:"reboot" }
                               { pn:"Y-042", cmd:"cancel" }

   ★ 어떻게 전달되나
     랙PC 로 직접 연결하지 않습니다. PC 줄에 명령을 적어만 두고,
     그 PC 가 2분마다 보내는 신호에 답할 때 딸려 보냅니다.
     통신을 새로 만들지 않아 1,200대에 부담이 없습니다.
     대신 누른 뒤 **최대 2분**까지 기다릴 수 있습니다.

   ★ 안전장치
     · 신호가 끊긴 PC 에는 걸지 않습니다 (어차피 못 받습니다)
     · 이미 걸어둔 명령이 있으면 알려주고 덮어쓰지 않습니다
     · 누가 언제 걸었는지 기록을 남깁니다
   ═══════════════════════════════════════════════════════════════ */
const { ready, sb } = require('./_supa');
const { verify } = require('./admin-login');

const ALLOWED = {
  reboot: '재부팅',
  cancel: '재부팅 취소',
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!verify(req)) return res.status(401).json({ error: '관리자 로그인이 필요합니다' });
  if (!ready()) return res.status(503).json({ error: 'DB 미연결' });

  const b = req.body || {};
  const pn = String(b.pn || '').toUpperCase().trim();
  const cmd = String(b.cmd || '').trim();

  if (!/^[KYD]-\d{3}$/.test(pn)) return res.status(400).json({ error: '품번이 올바르지 않습니다' });
  if (!ALLOWED[cmd]) return res.status(400).json({ error: '할 수 없는 명령입니다' });

  try {
    const rows = await sb('pcs', {
      query: `?select=pn,status,online,last_beat,cmd&pn=eq.${encodeURIComponent(pn)}&limit=1`,
    });
    const p = rows && rows[0];
    if (!p) return res.status(404).json({ error: '없는 품번입니다' });

    /* 살아 있는 PC 인지 — 죽은 PC 에 걸어봐야 받지 못합니다 */
    const beatSec = p.last_beat ? (Date.now() - Date.parse(p.last_beat)) / 1000 : null;
    if (cmd === 'reboot') {
      if (!p.online || beatSec === null || beatSec > 420) {
        return res.status(409).json({
          error: `${pn} 은 지금 신호가 오지 않습니다.\n` +
                 `꺼져 있거나 인터넷이 끊긴 상태라 재부팅 명령을 받을 수 없습니다.`,
        });
      }
      if (p.cmd) {
        return res.status(409).json({
          error: `${pn} 에 이미 「${ALLOWED[p.cmd] || p.cmd}」 명령이 걸려 있습니다.\n` +
                 `2분 안에 실행됩니다. 잠시 기다려 주세요.`,
        });
      }
    }

    const now = new Date().toISOString();
    await sb('pcs', {
      method: 'PATCH', prefer: 'return=minimal',
      query: `?pn=eq.${encodeURIComponent(pn)}`,
      body: { cmd, cmd_at: now, cmd_by: '관리자' },
    });

    try {
      await sb('view_log', {
        method: 'POST', prefer: 'return=minimal',
        body: [{ pn, act: ALLOWED[cmd] + ' 요청', who: '관리자' }],
      });
    } catch (e) {}

    res.status(200).json({
      ok: true, pn, cmd,
      label: ALLOWED[cmd],
      /* 마지막 신호가 언제였는지 알려주면 언제쯤 실행될지 가늠할 수 있습니다 */
      lastBeatSec: beatSec === null ? null : Math.round(beatSec),
      note: '다음 신호가 올 때 실행됩니다 (최대 2분)',
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
};
