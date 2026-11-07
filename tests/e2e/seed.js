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
  db.settings.push(
    { k: 'setup_fee', v: '5000' }, { k: 'down_sec', v: '300' }, { k: 'noti_day', v: '5' },
    { k: 'off60', v: '3' }, { k: 'off90', v: '5' },
  );
}

module.exports = { seed, XSS };
