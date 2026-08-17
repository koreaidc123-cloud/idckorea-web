/* ═══════════════════════════════════════════════════════════════
   관리자 창구 하나로 모음

   ★ 왜 합쳤나
     Vercel 무료 요금제는 서버 함수를 12개까지만 허용합니다.
     기능을 늘리다 14개가 되면서 배포가 통째로 실패했습니다
     (한 개만 넘쳐도 전부 안 올라갑니다).
     기능별 파일은 그대로 두고(밑줄로 시작하면 함수로 세지 않습니다),
     이 파일 하나가 받아서 알맞은 곳으로 넘깁니다.

   쓰는 법
     GET  /api/admin?do=pcs                 PC 목록
     GET  /api/admin?do=pc-secret&pn=Y-042  애니데스크 비밀번호 (기록 남음)
     GET  /api/admin?do=orders              주문 · 회원
     POST /api/admin?do=pc-update           PC 정보 수정
     POST /api/admin?do=pc-delete           PC 대장에서 빼기 (잘못 등록한 것)
     POST /api/admin?do=order-manual        수동 주문 등록
     POST /api/admin?do=order-action        연장 · 해지환불 · 이전 · 세금계산서

   ※ 각 기능 파일이 스스로 관리자 출입증을 확인합니다.
      여기서는 넘기기만 합니다.
   ═══════════════════════════════════════════════════════════════ */
const HANDLERS = {
  'pcs':          require('./_admin-pcs'),
  'pc-secret':    require('./_admin-pc-secret'),
  'pc-update':    require('./_admin-pc-update'),
  'pc-delete':    require('./_admin-pc-delete'),
  'orders':       require('./_admin-orders'),
  'order-manual': require('./_admin-order-manual'),
  'order-action': require('./_admin-order-action'),
  'settings':     require('./_admin-settings'),
};

module.exports = async (req, res) => {
  const what = String(
    (req.query && req.query.do) || (req.body && req.body.do) || ''
  ).trim();

  const fn = HANDLERS[what];
  if (!fn) {
    return res.status(404).json({
      error: '알 수 없는 요청입니다',
      hint: 'do 값은 ' + Object.keys(HANDLERS).join(' / ') + ' 중 하나여야 합니다',
    });
  }
  return fn(req, res);
};
