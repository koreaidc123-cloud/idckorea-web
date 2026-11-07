/* ═══════════════════════════════════════════════════════════════
   시험용 데이터 — 매 시험마다 처음 상태로 되돌립니다

   PC (상태별로 하나씩 이상)
     Y-001 · Y-002 · Y-007 · Y-008  3700X(5번)  임대 가능 · 신호 정상
     Y-003          2200G(2번)  임대 가능
     Y-004          3700X       임대중 (고객A 주문)
     Y-005          1700(4번)   미등록(new) — 자리 없음
     Y-006          5600G(3번)  미검증(unv)
     K-001          3700X       임대 가능이지만 신호 끊김 (다운)
     K-002          i5(1번)     점검중(fix) → 1번 상품은 재고 0
     D-001          1700        임대 가능
     ── 반납 초기화 시험용 (2026-11-07) ──
     Y-010          3700X       초기화 대기(wipe) — 지난 주문 SEEDW1(5일 전 만료)
     Y-011          3700X       반납 유예(hold) — 고객C 의 지난 주문 SEEDC1(어제 만료 · 60일 123,500원)
     Y-012          3700X       임대중이지만 주문 SEEDH1 이 1시간 전에 끝남 → 만료 정리가 유예로 보냄
     Y-013          3700X       임대중 · 고객E 주문 SEEDE1 이 2일 뒤 만료 (D-3 목록)
     ── 점검 → 판매 시험용 (2026-11-08) ──
     Y-016          3700X       점검중(fix) — 20일 전 끝난 주문 SEEDF1 (최근 손님 있음 → 새 비밀번호 필요)
     Y-017          3700X       점검중(fix) — 200일 전 끝난 주문 SEEDF2 (90일 지남 → 예전처럼 바로 판매)
   주문 (그 밖)
     SEEDR1   해지됨 · 스마트스토어 · 직접 송금 대기(manual_pending) 30,000원 (고객D)
     SEEDVA   가상계좌 입금 대기 (구매자B)
   미등록 신호 (pcs_unregistered)
     MB-NEW-0001    품번 없이 신호만 오는 PC (등록 대기 목록)
     lost:999888777 대장에서 사라진 PC (Y-009 라고 주장)
   ═══════════════════════════════════════════════════════════════ */
const kv = require('../../api/_crypto');
const fakeDb = require('./fake-supabase');

const XSS = '<img src=x onerror=alert(1)>';

function seed() {
  fakeDb.reset();
  const db = fakeDb.db;
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const fresh = iso(now - 30 * 1000);       // 30초 전 신호
  const stale = iso(now - 3600 * 1000);     // 1시간 전 신호
  const pc = (o) => Object.assign({
    room: o.pn.charAt(0), rack: 1, fl: 1, slot: 1, cpu: 'AMD Ryzen 7 3700X 8-Core Processor', core: '8코어',
    ram_gb: 32, ssd_gb: 480, gpu: 'NVIDIA GeForce GTX 1060 3GB', spec_id: 5,
    anydesk: '1' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'),
    pw_enc: kv.seal('pw-' + o.pn), ip: '59.45.10.' + (10 + db.pcs.length), status: 'ok',
    online: true, in_use: false, up_sec: 1000, last_beat: fresh, note: null,
    created_at: iso(now - 86400000 * 10), updated_at: iso(now - 86400000 * 10 + db.pcs.length * 1000),
    beat_token: 'tok-' + o.pn + '-0123456789abcdef', hw_id: 'HW-' + o.pn, cmd: null, cmd_at: null, cmd_by: null,
  }, o);

  db.pcs.push(
    pc({ pn: 'Y-001', rack: 1, fl: 1, slot: 1, anydesk: '1042887613' }),
    pc({ pn: 'Y-002', rack: 1, fl: 1, slot: 2, anydesk: '1042887614' }),
    pc({ pn: 'Y-003', rack: 1, fl: 1, slot: 3, spec_id: 2, cpu: 'AMD Ryzen 3 2200G', core: '4코어', ram_gb: 8, ssd_gb: 120, gpu: 'Radeon Vega 8', anydesk: '1042887615' }),
    pc({ pn: 'Y-004', rack: 1, fl: 1, slot: 4, status: 'rent', anydesk: '1042887616' }),
    pc({ pn: 'Y-005', rack: 0, fl: 0, slot: 0, spec_id: 4, cpu: 'AMD Ryzen 7 1700', status: 'new', anydesk: '1042887617' }),
    pc({ pn: 'Y-006', rack: 1, fl: 2, slot: 1, spec_id: 3, cpu: 'AMD Ryzen 5 5600G', status: 'unv', anydesk: '1042887618' }),
    pc({ pn: 'K-001', rack: 1, fl: 1, slot: 1, last_beat: stale, online: true, anydesk: '1042887619' }),
    pc({ pn: 'K-002', rack: 1, fl: 1, slot: 2, spec_id: 1, cpu: 'Intel Core i5-4690', ram_gb: 8, ssd_gb: 120, status: 'fix', anydesk: '1042887620' }),
    pc({ pn: 'D-001', rack: 1, fl: 1, slot: 1, spec_id: 4, cpu: 'AMD Ryzen 7 1700', anydesk: '1042887621' }),
    pc({ pn: 'Y-007', rack: 1, fl: 1, slot: 5, anydesk: '1042887622' }),
    pc({ pn: 'Y-008', rack: 1, fl: 1, slot: 6, anydesk: '1042887623' }),
    pc({ pn: 'Y-010', rack: 1, fl: 2, slot: 2, status: 'wipe', wipe_at: iso(now - 86400000 * 2), anydesk: '1042887624' }),
    pc({ pn: 'Y-011', rack: 1, fl: 2, slot: 3, status: 'hold', hold_until: iso(now + 86400000 * 2), anydesk: '1042887625' }),
    pc({ pn: 'Y-012', rack: 1, fl: 2, slot: 4, status: 'rent', anydesk: '1042887626' }),
    pc({ pn: 'Y-013', rack: 1, fl: 2, slot: 5, status: 'rent', anydesk: '1042887627' }),
    /* 점검(fix) → 판매 시험용 (2026-11-08) — 최근 손님이 있으면 새 비밀번호 필요 */
    pc({ pn: 'Y-016', rack: 1, fl: 2, slot: 6, status: 'fix', anydesk: '1042887628' }),
    pc({ pn: 'Y-017', rack: 1, fl: 2, slot: 7, status: 'fix', anydesk: '1042887629' }),
  );
  db.pcs_unregistered.push(
    { hw_id: 'MB-NEW-0001', room: 'D', ip: '59.45.20.1', cpu: 'AMD Ryzen 7 1700', core: '8코어', ram_gb: 32, ssd_gb: 240,
      gpu: 'GTX 1050 Ti', anydesk: '777666555', first_seen: iso(now - 600000), last_beat: fresh, claimed_pn: null, note: null },
    { hw_id: 'lost:999888777', room: 'Y', ip: '59.45.20.2', cpu: 'AMD Ryzen 7 3700X', core: '8코어', ram_gb: 32, ssd_gb: 480,
      gpu: 'GTX 1060', anydesk: '999888777', first_seen: iso(now - 600000), last_beat: fresh,
      claimed_pn: 'Y-009', note: '대장에서 사라진 PC — Y-009 이라고 신호를 보내고 있습니다' },
  );
  db.members.push(
    { id: '11111111-1111-4111-8111-111111111111', via: 'kakao', social_id: 'k-1001', name: '고객A',
      phone: '010-1111-2222', email: null, marketing: false, created_at: iso(now - 86400000 * 20) },
    { id: '22222222-2222-4222-8222-222222222222', via: 'kakao', social_id: 'k-1002', name: XSS,
      phone: '010-3333-4444', email: null, marketing: false, created_at: iso(now - 86400000 * 5) },
    { id: '33333333-3333-4333-8333-333333333333', via: 'google', social_id: 'g-2001', name: '구매자B',
      phone: '010-5555-6666', email: 'b@example.com', marketing: false, created_at: iso(now - 86400000) },
  );
  db.orders.push({
    order_id: 'KVC260101-SEEDA1', member_id: '11111111-1111-4111-8111-111111111111', pn: 'Y-004',
    spec_id: 5, days: 30, amount: 65000, setup_fee: 5000, status: 'assigned', pay_key: null,
    pay_method: '카드', paid_at: iso(now - 86400000 * 10), va_secret: null, tax_invoice: false, biz_no: null,
    starts_at: iso(now - 86400000 * 10), ends_at: iso(now + 86400000 * 20),
    payer_name: '고객A', user_name: '고객A', user_phone: '010-1111-2222',
    canceled_at: null, refund_amt: null, refund_why: null, created_at: iso(now - 86400000 * 10),
  });
  db.members.push(
    { id: '44444444-4444-4444-8444-444444444444', via: 'kakao', social_id: 'k-1004', name: '고객C',
      phone: '010-4444-0003', email: null, marketing: false, created_at: iso(now - 86400000 * 70) },
    { id: '55555555-5555-4555-8555-555555555555', via: 'kakao', social_id: 'k-1005', name: '고객E',
      phone: '010-4444-0005', email: null, marketing: false, created_at: iso(now - 86400000 * 30) },
  );
  /* 주문 한 줄 만들기 — 안 적은 칸은 빈 값 */
  const ord = o => Object.assign({
    member_id: null, pn: null, spec_id: 5, days: 30, amount: 65000, setup_fee: 5000, status: 'assigned',
    pay_key: null, pay_method: '카드', paid_at: null, va_secret: null, tax_invoice: false, biz_no: null,
    starts_at: null, ends_at: null, payer_name: null, user_name: null, user_phone: null,
    canceled_at: null, refund_amt: null, refund_why: null, created_at: iso(now - 86400000 * 3),
    refund_state: null, refund_done_at: null,
  }, o);
  db.orders.push(
    /* 어제 끝난 60일 주문 — PC(Y-011)는 반납 유예 중. 연장하면 그대로 돌아와야 합니다 */
    ord({ order_id: 'KVC260101-SEEDC1', member_id: '44444444-4444-4444-8444-444444444444', pn: 'Y-011',
      days: 60, amount: 123500, status: 'expired', paid_at: iso(now - 86400000 * 61),
      starts_at: iso(now - 86400000 * 61), ends_at: iso(now - 86400000),
      payer_name: '고객C', user_name: '고객C', user_phone: '010-4444-0003' }),
    /* 5일 전 끝난 주문 — PC(Y-010)는 이미 초기화 대기. 연장하면 거절돼야 합니다 */
    ord({ order_id: 'KVC260101-SEEDW1', member_id: '33333333-3333-4333-8333-333333333333', pn: 'Y-010',
      status: 'expired', paid_at: iso(now - 86400000 * 35), starts_at: iso(now - 86400000 * 35),
      ends_at: iso(now - 86400000 * 5), payer_name: '구매자B', user_name: '구매자B', user_phone: '010-5555-6666' }),
    /* 1시간 전에 끝났는데 아직 이용중으로 남은 주문 — 만료 정리가 돌면 Y-012 가 반납 유예로 */
    ord({ order_id: 'KVC260101-SEEDH1', member_id: '11111111-1111-4111-8111-111111111111', pn: 'Y-012',
      paid_at: iso(now - 86400000 * 30), starts_at: iso(now - 86400000 * 30), ends_at: iso(now - 3600 * 1000),
      payer_name: '고객A', user_name: '고객A', user_phone: '010-1111-2222' }),
    /* 2일 뒤 끝나는 주문 — [오늘 할 일] 3일 안에 만료 */
    ord({ order_id: 'KVC260101-SEEDE1', member_id: '55555555-5555-4555-8555-555555555555', pn: 'Y-013',
      paid_at: iso(now - 86400000 * 28), starts_at: iso(now - 86400000 * 28), ends_at: iso(now + 86400000 * 2 - 3600 * 1000),
      payer_name: '고객E', user_name: '고객E', user_phone: '010-4444-0005' }),
    /* 스마트스토어 주문을 해지 — 토스가 못 돌려줘서 직접 송금해야 함 */
    ord({ order_id: 'MAN260101-SEEDR1', pn: null, status: 'refunded', pay_method: '스마트스토어',
      paid_at: iso(now - 86400000 * 4), starts_at: iso(now - 86400000 * 4), ends_at: iso(now - 86400000),
      canceled_at: iso(now - 86400000), refund_amt: 30000, refund_why: '고객 요청', refund_state: 'manual_pending',
      payer_name: '고객D', user_name: '고객D', user_phone: '010-4444-0004' }),
    /* 20일 전에 끝난 주문 — 그 PC(Y-016)는 지금 점검중. 판매로 돌리려면 새 비밀번호가 필요 */
    ord({ order_id: 'KVC260101-SEEDF1', pn: 'Y-016', status: 'expired', paid_at: iso(now - 86400000 * 50),
      starts_at: iso(now - 86400000 * 50), ends_at: iso(now - 86400000 * 20), created_at: iso(now - 86400000 * 50),
      payer_name: '고객F', user_name: '고객F', user_phone: '010-4444-0006' }),
    /* 200일 전에 끝난 주문 — 그 PC(Y-017)는 점검중이지만 90일이 지나 예전처럼 바로 판매 가능 */
    ord({ order_id: 'KVC250101-SEEDF2', pn: 'Y-017', status: 'expired', paid_at: iso(now - 86400000 * 230),
      starts_at: iso(now - 86400000 * 230), ends_at: iso(now - 86400000 * 200), created_at: iso(now - 86400000 * 230),
      payer_name: '고객G', user_name: '고객G', user_phone: '010-4444-0007' }),
    /* 가상계좌 입금 대기 */
    ord({ order_id: 'KVC260101-SEEDVA', member_id: '33333333-3333-4333-8333-333333333333', spec_id: 3,
      amount: 55000, status: 'ready', pay_method: '가상계좌', created_at: iso(now - 3600 * 1000),
      payer_name: '구매자B', user_name: '구매자B', user_phone: '010-5555-6666' }),
  );
  db.settings.push(
    { k: 'setup_fee', v: '5000' }, { k: 'down_sec', v: '300' }, { k: 'noti_day', v: '5' },
    { k: 'off60', v: '3' }, { k: 'off90', v: '5' },
    /* db/08-반납초기화.sql 이 넣는 값 — 있으면 "08 을 돌린 Supabase" */
    { k: 'hold_days', v: '3' },
  );
}

module.exports = { seed, XSS };
