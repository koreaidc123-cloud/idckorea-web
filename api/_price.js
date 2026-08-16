/* ═══════════════════════════════════════════════════════════════
   가격표 — 서버가 가진 진짜 가격

   ★ 왜 서버에도 가격표가 필요한가
     결제 금액을 고객 브라우저가 정해서 보내면, 브라우저 개발자도구로
     65,000원을 100원으로 바꿔 결제할 수 있습니다.
     그래서 "얼마짜리 주문인가"는 반드시 서버가 정하고,
     결제 승인 때 서버가 적어둔 금액과 다르면 승인을 거절합니다.

   ※ 상품을 바꾸면 product.html 과 이 파일을 함께 고쳐야 합니다.
   ═══════════════════════════════════════════════════════════════ */
const SPECS = {
  1: { name: '인텔 I5 4690 4코어',        price: 40000 },
  2: { name: '라이젠 2200G~2400G 4코어',  price: 40000 },
  3: { name: '라이젠 5600G~5700G 6~8코어', price: 55000 },
  4: { name: '라이젠 1700 8코어',         price: 60000 },
  5: { name: '라이젠 3700X 8코어',        price: 65000 },
};

const DAYS = [30, 60, 90];
const OFF = { 30: 0, 60: 3, 90: 5 };      // 장기 결제 할인율(%)

/* 최종 금액 계산 — 이 함수 하나만 믿습니다 */
function quote(specId, days) {
  const s = SPECS[specId];
  if (!s) return null;
  if (!DAYS.includes(Number(days))) return null;
  const d = Number(days);
  const amount = Math.round(s.price * (d / 30) * (100 - OFF[d]) / 100);
  return { specId: Number(specId), days: d, name: s.name, unit: s.price, off: OFF[d], amount };
}

module.exports = { SPECS, DAYS, OFF, quote };
