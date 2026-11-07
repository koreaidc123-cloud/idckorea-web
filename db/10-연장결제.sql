-- ═══════════════════════════════════════════════════════════════
--  6단계 — 고객이 직접 연장 결제 (같은 PC 그대로 기간만 늘리기)   (2026-11-08)
--
--  ※ 이 SQL 은 실제 PostgreSQL 에서 한 번도 실행해 보지 않았습니다.
--    (개발 PC 에는 진짜 Supabase 를 부르지 않는 가짜 DB 만 있습니다)
--    처음 돌리실 때 오류가 나면 그 문구를 그대로 개발 담당에게 보내 주세요.
--
--  ★ 언제 돌리나
--    월요일 결제 시험이 끝나고, 연장 결제 코드(extend-payment 가지)를 합친 "뒤에" 돌립니다.
--    순서가 바뀌어도 사고는 안 납니다 — 코드는 이 SQL 이 없으면 연장 버튼을 숨기고
--    예전처럼 [카카오톡으로 연장 요청] 을 보여 줍니다.
--
--  ★ 먼저 돌려야 하는 것: db/08-반납초기화.sql (반납 유예 hold 칸을 씁니다)
--
--  ★ 대표님이 하실 일 (한 번만)
--    Supabase → 왼쪽 SQL Editor → New query → 이 파일 내용을 통째로 붙여넣고 [Run]
--    GitHub 에 올리거나(push) 배포해도 이 파일은 실행되지 않습니다. 꼭 직접 돌려 주세요.
--    여러 번 돌려도 안전합니다 (있으면 건너뛰고, 함수는 바꿔 끼웁니다).
--
--  ★ 무엇이 바뀌나
--    · 연장 한 번 = 주문 표에 "연장 줄" 한 줄 (kind='extend', 원 주문 번호 parent_id).
--      원 주문은 그대로 두고 끝나는 날(ends_at)만 늘립니다.
--      연장 줄마다 결제키·금액이 따로 있어서, 연장분만 따로 환불할 수 있습니다.
--    · 기간을 늘리는 일은 데이터베이스 함수(apply_extension) 하나가 "한 번에" 합니다.
--      주문을 잠그고 → PC 상태를 보고 → 기간·PC 를 같이 바꿉니다.
--      중간에 끊겨서 "돈은 받았는데 기간은 그대로" 나 "PC 만 잡히고 주문은 그대로" 가 생기지 않습니다.
--    · 관리자 화면의 [30일 연장] 도 이제 같은 방식(admin_extend_order)으로 연장 줄을 남깁니다.
--      (Codex T-0182 가 찾은 두 가지 경쟁 상태 — PC 를 잡고 주문을 고치기 전의 틈,
--       응답이 끊겨 성공한 연장을 되돌리던 문제 — 가 이 방식으로 없어집니다)
--    · settings 에 ext_pay = 1 이 들어갑니다. 이 값이 1 일 때만 고객 화면에 [연장하기] 가 보입니다.
--
--  ★ 잠깐 끄는 법 (고객 화면의 [연장하기] 만 숨기기 — 관리자 연장은 계속 됨)
--      update settings set v = '0' where k = 'ext_pay';
--    다시 켜려면 '0' 을 '1' 로.
--
--  ★ 완전히 되돌리는 법 (문제가 생겼을 때)
--      update settings set v = '0' where k = 'ext_pay';
--      drop function if exists public.admin_extend_order(text, int, int, text, text);
--      drop function if exists public.revert_extension(text, text);
--      drop function if exists public.apply_extension(text);
--    새로 만든 칸(kind · parent_id · ext_from · ext_to · applied_at)은 남겨 두셔도 됩니다.
--    코드는 함수가 없으면 관리자 연장을 예전 방식으로 하고, 고객 [연장하기] 를 숨깁니다.
--    이미 만들어진 연장 줄은 기록으로 남습니다 (지우지 마세요 — 결제 기록입니다).
-- ═══════════════════════════════════════════════════════════════

-- ── 0. db/08 을 먼저 돌렸는지 확인 ─────────────────────────────
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pcs' and column_name = 'hold_until') then
    raise exception '먼저 db/08-반납초기화.sql 을 실행해 주세요 (pcs.hold_until 칸이 없습니다)';
  end if;
end $$;


-- ── 1. 새 칸 ──────────────────────────────────────────────────
-- 주문 종류: new(처음 산 것) · extend(연장 결제). 예전 주문은 전부 new 로 채워집니다.
alter table orders add column if not exists kind       text not null default 'new';
-- 연장 줄이면 원 주문 번호
alter table orders add column if not exists parent_id  text references orders(order_id);
-- 이 연장으로 늘어난 기간 (어디서부터 어디까지) — 환불할 때 이 값으로 되돌립니다
alter table orders add column if not exists ext_from   timestamptz;
alter table orders add column if not exists ext_to     timestamptz;
-- 기간이 실제로 늘어난 시각
alter table orders add column if not exists applied_at timestamptz;

-- 종류는 두 가지만
do $$
begin
  alter table orders add constraint orders_kind_check check (kind in ('new', 'extend'));
exception when duplicate_object then null;
end $$;

-- 한 원 주문에 "결제 대기 중인 연장" 은 하나만 (두 창에서 동시에 눌러도 두 줄이 안 생김)
create unique index if not exists orders_one_ready_ext
  on orders (parent_id) where kind = 'extend' and status = 'ready';
-- 원 주문의 연장 줄을 빨리 찾기
create index if not exists orders_parent_idx on orders (parent_id) where parent_id is not null;


-- ── 2. 연장 적용 함수 ──────────────────────────────────────────
-- 결제가 끝난(paid) 연장 줄 하나를 받아 원 주문의 기간을 늘립니다.
-- 돌려주는 값 (jsonb)
--   {ok:true, pn, endsAt, from, parent}     늘렸음
--   {ok:true, skip:'done', ...}             이미 처리된 줄 (두 번 불려도 한 번만 늘어남)
--   {ok:false, reason:'...'}                못 늘림 → 연장 줄은 결제완료(paid)로 남고
--                                           관리자 [오늘 할 일] 에 뜹니다. 자동 환불은 하지 않습니다.
--     reason: no_order · not_extend · no_parent · parent_state(원 주문이 해지됨 등)
--             pc_taken(그 PC 를 다른 주문이 씀) · pc_gone(PC 가 초기화 대기·점검 등)
create or replace function public.apply_extension(p_order text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c      orders%rowtype;
  p      orders%rowtype;
  v_pc   text;
  v_base timestamptz;
  v_end  timestamptz;
begin
  -- ① 연장 줄을 잠급니다 (같은 결제가 동시에 두 번 와도 한 쪽은 기다렸다가 아래 skip 으로 빠짐)
  select * into c from orders where order_id = p_order for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_order');
  end if;
  if c.kind <> 'extend' then
    return jsonb_build_object('ok', false, 'reason', 'not_extend');
  end if;
  if c.status <> 'paid' then
    return jsonb_build_object('ok', true, 'skip', 'done', 'status', c.status,
                              'pn', c.pn, 'endsAt', c.ext_to);
  end if;

  -- ② 원 주문을 잠급니다
  select * into p from orders where order_id = c.parent_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_parent');
  end if;
  if p.status not in ('assigned', 'expired') or p.pn is null then
    return jsonb_build_object('ok', false, 'reason', 'parent_state', 'status', p.status);
  end if;

  -- ③ 그 PC 를 다른 주문이 쓰고 있으면 안 됩니다
  if exists (select 1 from orders
              where pn = p.pn and status in ('assigned', 'paid') and order_id <> p.order_id) then
    return jsonb_build_object('ok', false, 'reason', 'pc_taken', 'pn', p.pn);
  end if;

  -- ④ PC 는 임대중(rent) 이거나 반납 유예(hold) 일 때만 — 초기화 대기(wipe)면 자료가 지워졌을 수 있음
  select status into v_pc from pcs where pn = p.pn for update;
  if v_pc is null or v_pc not in ('rent', 'hold') then
    return jsonb_build_object('ok', false, 'reason', 'pc_gone', 'pn', p.pn, 'pcStatus', v_pc);
  end if;

  -- ⑤ 남은 기간이 있으면 그 뒤에, 이미 끝났으면 지금부터 붙입니다
  v_base := greatest(coalesce(p.ends_at, now()), now());
  v_end  := v_base + make_interval(days => c.days);

  update orders set ends_at = v_end, status = 'assigned' where order_id = p.order_id;
  update pcs set status = 'rent', hold_until = null, updated_at = now() where pn = p.pn;
  update orders
     set status = 'applied', pn = p.pn, ext_from = v_base, ext_to = v_end,
         starts_at = v_base, ends_at = v_end, applied_at = now()
   where order_id = c.order_id;

  insert into view_log (pn, act, who)
  values (p.pn, '연장 결제 적용 ' || c.order_id || ' · ' || c.days || '일 · 원 주문 ' || p.order_id
                || ' · 새 만료 ' || to_char(v_end at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'),
          'system:extend');

  return jsonb_build_object('ok', true, 'pn', p.pn, 'endsAt', v_end, 'from', v_base, 'parent', p.order_id);
end;
$$;


-- ── 3. 연장 되돌리기 (환불할 때) ───────────────────────────────
-- "가장 마지막" 연장만 되돌립니다. 중간 것을 빼면 그 뒤 연장들의 기간이 어긋나기 때문입니다.
-- 원 주문의 끝나는 날을 이 연장 전(ext_from)으로 돌리고, 연장 줄은 p_status(refunded/canceled)로.
-- 돌려놓은 날이 이미 지났으면 원 주문은 만료, PC 는 바로 초기화 대기(wipe) — 해지·환불과 같은 규칙입니다.
create or replace function public.revert_extension(p_order text, p_status text default 'refunded')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c     orders%rowtype;
  p     orders%rowtype;
  v_end timestamptz;
  v_st  text;
begin
  if p_status not in ('refunded', 'canceled') then
    return jsonb_build_object('ok', false, 'reason', 'bad_status');
  end if;
  select * into c from orders where order_id = p_order for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_order');
  end if;
  if c.kind <> 'extend' or c.status <> 'applied' then
    return jsonb_build_object('ok', false, 'reason', 'not_applied', 'status', c.status);
  end if;
  select * into p from orders where order_id = c.parent_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_parent');
  end if;
  -- 이 뒤에 적용된 연장이 있으면 그것부터
  if exists (select 1 from orders
              where parent_id = c.parent_id and kind = 'extend' and status = 'applied'
                and order_id <> c.order_id and ext_to > c.ext_to) then
    return jsonb_build_object('ok', false, 'reason', 'not_latest');
  end if;
  -- 원 주문의 끝나는 날이 이 연장이 만든 날과 다르면 누가 따로 고친 것 — 사람이 봐야 합니다
  if p.ends_at is distinct from c.ext_to then
    return jsonb_build_object('ok', false, 'reason', 'parent_changed');
  end if;

  v_end := c.ext_from;
  if v_end > now() then
    update orders set ends_at = v_end where order_id = p.order_id;
    v_st := p.status;
  else
    update orders set ends_at = v_end, status = 'expired'
     where order_id = p.order_id and status = 'assigned';
    v_st := 'expired';
    -- 다른 주문이 그 PC 를 쓰지 않을 때만 초기화 대기로
    update pcs set status = 'wipe', wipe_at = now(), updated_at = now()
     where pn = p.pn and status in ('rent', 'hold')
       and not exists (select 1 from orders o
                        where o.pn = p.pn and o.status in ('assigned', 'paid') and o.order_id <> p.order_id);
  end if;

  update orders set status = p_status, canceled_at = now(), ends_at = least(c.ends_at, now())
   where order_id = c.order_id;

  insert into view_log (pn, act, who)
  values (p.pn, '연장 되돌림 ' || c.order_id || ' · 원 주문 ' || p.order_id || ' 만료 '
                || to_char(v_end at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI'), 'system:extend');

  return jsonb_build_object('ok', true, 'pn', p.pn, 'parentEnd', v_end, 'parentStatus', v_st);
end;
$$;


-- ── 4. 관리자 수동 연장 (계좌이체·전화로 받은 연장) ────────────────
-- 연장 줄(결제완료 · 수동 결제수단)을 만들고 같은 거래 안에서 바로 적용합니다.
-- 적용이 안 되면 만든 줄까지 통째로 없던 일로 하고 {ok:false, reason} 을 돌려줍니다.
create or replace function public.admin_extend_order(p_parent text, p_days int, p_amount int,
                                                     p_method text, p_who text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  p    orders%rowtype;
  v_id text;
  r    jsonb;
begin
  if p_days not in (30, 60, 90) then
    return jsonb_build_object('ok', false, 'reason', 'bad_days');
  end if;
  select * into p from orders where order_id = p_parent for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_parent');
  end if;
  if p.status not in ('assigned', 'expired') then
    return jsonb_build_object('ok', false, 'reason', 'parent_state', 'status', p.status);
  end if;

  v_id := 'MXT' || to_char(now() at time zone 'Asia/Seoul', 'YYMMDD') || '-'
          || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  begin
    insert into orders (order_id, member_id, spec_id, days, amount, setup_fee, status,
                        pay_method, paid_at, payer_name, user_name, user_phone, kind, parent_id)
    values (v_id, p.member_id, p.spec_id, p_days, greatest(coalesce(p_amount, 0), 0), 0, 'paid',
            left(coalesce(nullif(p_method, ''), '수동'), 30), now(),
            p.payer_name, p.user_name, p.user_phone, 'extend', p.order_id);
    r := public.apply_extension(v_id);
    if not coalesce((r->>'ok')::boolean, false) or r ? 'skip' then
      raise exception using errcode = 'P0001', message = coalesce(r->>'reason', 'fail');
    end if;
  exception when sqlstate 'P0001' then
    -- 위 begin 안에서 한 일(연장 줄 넣기 · 적용)은 전부 취소됩니다
    return jsonb_build_object('ok', false, 'reason', sqlerrm,
                              'pcStatus', (select status from pcs where pn = p.pn));
  end;

  update view_log set who = left(coalesce(p_who, 'admin'), 60)
   where id = (select max(id) from view_log where who = 'system:extend' and act like '연장 결제 적용 ' || v_id || '%');

  return r || jsonb_build_object('child', v_id);
end;
$$;


-- ── 5. 권한 — 서버(service_role)만 부릅니다 ─────────────────────
-- 고객 브라우저(공개키 anon · 로그인 authenticated)로는 절대 못 부르게 막습니다.
revoke all on function public.apply_extension(text)                         from public, anon, authenticated;
revoke all on function public.revert_extension(text, text)                  from public, anon, authenticated;
revoke all on function public.admin_extend_order(text, int, int, text, text) from public, anon, authenticated;
grant execute on function public.apply_extension(text)                         to service_role;
grant execute on function public.revert_extension(text, text)                  to service_role;
grant execute on function public.admin_extend_order(text, int, int, text, text) to service_role;


-- ── 6. 고객 화면 [연장하기] 켜기 ───────────────────────────────
insert into settings (k, v) values ('ext_pay', '1')
  on conflict (k) do nothing;


-- ── 확인 ──────────────────────────────────────────────────────
-- 아래 세 줄이 나오면 성공입니다.
select k, v from settings where k = 'ext_pay';
select count(*) as "예전 주문 (전부 new 여야 함)" from orders where kind = 'new';
select proname as "만든 함수" from pg_proc
 where proname in ('apply_extension', 'revert_extension', 'admin_extend_order') order by proname;
