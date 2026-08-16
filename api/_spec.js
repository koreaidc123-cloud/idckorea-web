/* ═══════════════════════════════════════════════════════════════
   하드웨어 → 판매 상품 알아맞히기

   ★ 왜 필요한가
     현장에서 등록하면 CPU 이름이 "AMD Ryzen 7 3700X 8-Core Processor"
     같은 실제 하드웨어 문자열로 들어옵니다.
     그런데 고객이 결제하면 서버는 "라이젠 3700X 상품(5번)의 임대 가능한 PC"
     를 찾아 배정합니다. 상품 번호가 안 붙어 있으면 **자동 배정이 아무것도
     못 찾습니다.** 그래서 등록할 때 자동으로 붙여 줍니다.

     확실하지 않으면 아무것도 붙이지 않습니다(null).
     그런 PC 는 관리자 화면에서 사람이 직접 지정합니다.

   ※ 상품을 바꾸면 api/_price.js · product.html · live.html 과 함께 고쳐야 합니다.
   ═══════════════════════════════════════════════════════════════ */

/* 위에서부터 먼저 맞는 것을 씁니다 (구체적인 것이 위) */
const RULES = [
  { id: 5, re: /3700\s*x/i },                                  // 라이젠 3700X
  { id: 4, re: /ryzen\s*7?\s*1700|\b1700\b/i },                // 라이젠 1700
  { id: 3, re: /5600\s*g|5700\s*g|5600\s*x|5700\s*x|\b5600\b|\b5700\b/i },
  { id: 2, re: /2200\s*g|2400\s*g|3200\s*g|3400\s*g/i },       // 라이젠 G 시리즈
  { id: 1, re: /4690|4670|i5[\s-]*4\d{3}/i },                  // 인텔 i5 4세대
];

function guessSpec(cpu, ramGb, ssdGb, gpu) {
  const s = String(cpu || '');
  for (const r of RULES) if (r.re.test(s)) return r.id;

  /* 이름으로 못 맞히면 사양으로 짐작해 봅니다 — 아주 뚜렷할 때만 */
  const ram = Number(ramGb) || 0;
  const g = String(gpu || '');
  const hasGtx10 = /1050|1060/i.test(g);
  if (ram >= 32 && hasGtx10) return null;   // 1700 인지 3700X 인지 알 수 없음 → 사람이 지정
  if (ram <= 8 && /vega|내장|integrated|radeon graphics/i.test(g)) return 2;

  return null;                              // 모르면 붙이지 않습니다
}

module.exports = { guessSpec };
