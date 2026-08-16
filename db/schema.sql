-- ═══════════════════════════════════════════════════════════════
--  한국 가상컴 — 데이터베이스 설계
--
--  Supabase 에서 이 파일 내용을 그대로 붙여넣고 실행하면 됩니다.
--    supabase.com → 프로젝트 → 왼쪽 SQL Editor → New query → 붙여넣기 → Run
--
--  ※ 서버실 실명(금촌·영태리·등원리)은 이 표에 넣지 않습니다.
--     room 은 K / Y / D 알파벳만 저장하고, 실명은 관리자 화면에서만 붙입니다.
--  ※ 애니데스크 비밀번호는 평문으로 저장하지 않습니다 (pw_enc = 암호화된 값).
-- ═══════════════════════════════════════════════════════════════

-- ── 1. PC 대장 ────────────────────────────────────────────────
-- 랙에 실제로 꽂혀 있는 컴퓨터 한 대 = 이 표의 한 줄
create table if not exists pcs (
  pn          text primary key,              -- 품번 K-001 / Y-042 / D-113 (고객 문의번호)
  room        char(1)     not null check (room in ('K','Y','D')),
  rack        int         not null,          -- 몇 번째 랙
  fl          int         not null,          -- 몇 층 (1층 = 맨 아래)
  slot        int         not null,          -- 몇 번 자리 (1번 = 오른쪽 끝)

  -- 사양 (하트비트가 실제 하드웨어에서 읽어와 자동으로 채웁니다)
  cpu         text,
  core        text,
  ram_gb      int,
  ssd_gb      int,
  gpu         text,
  spec_id     int,                           -- 판매 상품 번호 (1~5)

  -- 접속 정보
  anydesk     text,                          -- 애니데스크 번호 (숫자 6~12자리)
  pw_enc      text,                          -- 애니데스크 비밀번호 (암호화된 값)
  ip          text,                          -- 내부망 IP

  -- 상태
  status      text        not null default 'new',
                                             -- new(미등록) unv(미검증) ok(임대가능)
                                             -- rent(임대중) fix(점검중) down(다운)
  online      boolean     not null default false,   -- 하트비트가 살아있는가
  in_use      boolean     not null default false,   -- 지금 누가 원격으로 붙어 있는가
  up_sec      bigint,                        -- 마지막 부팅 이후 흐른 시간(초)
  last_beat   timestamptz,                   -- 마지막 신호를 받은 시각

  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (room, rack, fl, slot)              -- 같은 자리에 두 대가 있을 수 없다
);

create index if not exists pcs_room_idx   on pcs (room, rack, fl, slot);
create index if not exists pcs_status_idx on pcs (status);
create index if not exists pcs_beat_idx   on pcs (last_beat desc);


-- ── 2. 미등록 PC ──────────────────────────────────────────────
-- 랙에 꽂혀서 신호는 오는데 품번이 아직 안 붙은 컴퓨터.
-- 관리자 "미등록 PC" 화면에 뜨고, 품번을 붙이면 pcs 로 옮겨집니다.
create table if not exists pcs_unregistered (
  hw_id       text primary key,              -- 메인보드 일련번호 (기계 고유값)
  room        char(1),
  ip          text,
  cpu         text,
  core        text,
  ram_gb      int,
  ssd_gb      int,
  gpu         text,
  anydesk     text,
  first_seen  timestamptz not null default now(),
  last_beat   timestamptz not null default now()
);


-- ── 3. 회원 ───────────────────────────────────────────────────
create table if not exists members (
  id          uuid primary key default gen_random_uuid(),
  via         text not null,                 -- kakao / google
  social_id   text not null,                 -- 카카오 회원번호 / 구글 sub
  name        text,
  phone       text,
  email       text,
  marketing   boolean default false,
  created_at  timestamptz not null default now(),
  unique (via, social_id)
);
create index if not exists members_phone_idx on members (phone);


-- ── 4. 주문 ───────────────────────────────────────────────────
-- ★ 결제 금액은 반드시 이 표에 먼저 적어두고, 결제 승인 때 대조합니다.
--   (고객 화면에서 올려보낸 금액을 그대로 믿으면 금액을 고쳐 결제할 수 있습니다)
create table if not exists orders (
  order_id    text primary key,              -- 우리가 만드는 주문번호
  member_id   uuid references members(id),
  pn          text references pcs(pn),

  spec_id     int  not null,
  days        int  not null,                 -- 30 / 60 / 90
  amount      int  not null,                 -- 원 단위 (이 값이 기준)
  setup_fee   int  not null default 5000,

  status      text not null default 'ready',
                                             -- ready(결제대기) paid(결제완료)
                                             -- assigned(PC배정) canceled(취소) refunded(환불)
  pay_key     text,                          -- 토스 paymentKey
  pay_method  text,                          -- 카드 / 가상계좌 / 간편결제
  paid_at     timestamptz,
  va_secret   text,                          -- 가상계좌 입금 웹훅 대조용 (토스가 준 값)
  tax_invoice boolean default false,         -- 세금계산서 요청 여부
  biz_no      text,                          -- 세금계산서용 사업자등록번호

  starts_at   timestamptz,
  ends_at     timestamptz,

  -- 입금자와 사용자가 다른 경우 (관리자 화면에서 경고로 뜹니다)
  payer_name  text,
  user_name   text,
  user_phone  text,

  canceled_at timestamptz,
  refund_amt  int,
  refund_why  text,

  created_at  timestamptz not null default now()
);
create index if not exists orders_status_idx on orders (status);
create index if not exists orders_ends_idx   on orders (ends_at);
create index if not exists orders_member_idx on orders (member_id);


-- ── 5. 열람 기록 ──────────────────────────────────────────────
-- 애니데스크 비밀번호를 누가 언제 열어봤는지 남깁니다 (개인정보 감사 대비)
create table if not exists view_log (
  id         bigserial primary key,
  pn         text,
  act        text,                           -- 열람 / 복사 / 변경
  who        text,
  at         timestamptz not null default now()
);


-- ── 6. 운영 설정 ──────────────────────────────────────────────
-- 초기셋팅비, 다운 판정 시간, 만료 알림 시점 등을 코드가 아닌 여기에 둡니다
create table if not exists settings (
  k text primary key,
  v text not null
);
insert into settings (k, v) values
  ('setup_fee', '5000'),    -- 초기 셋팅비
  ('down_sec',  '180'),     -- 이 시간(초) 넘게 신호가 없으면 다운으로 봅니다
  ('noti_day',  '5'),       -- 만료 며칠 전에 알림을 보낼지
  ('off60',     '3'),       -- 60일 결제 할인율(%)
  ('off90',     '5')        -- 90일 결제 할인율(%)
on conflict (k) do nothing;


-- ── 7. 보안 ───────────────────────────────────────────────────
-- 이 표들은 서버(Vercel 함수)만 접근합니다. 고객 브라우저는 직접 못 봅니다.
alter table pcs              enable row level security;
alter table pcs_unregistered enable row level security;
alter table members          enable row level security;
alter table orders           enable row level security;
alter table view_log         enable row level security;
alter table settings         enable row level security;
-- 정책을 하나도 만들지 않으면 = 아무도 못 읽습니다.
-- 서버는 service_role 키를 쓰므로 정책을 무시하고 통과합니다. 이게 우리가 원하는 상태입니다.
