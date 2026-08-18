-- ═══════════════════════════════════════════════════════════════
--  한국 가상컴 — 오늘 실행할 SQL (03 + 04 합본)
--  Supabase SQL Editor 에 통째로 붙여넣고 Run 하시면 됩니다.
--
--    03  원격 재부팅  — 관리자 [↻ 원격 재부팅] 버튼이 동작합니다
--    04  만료 자동정리 — 기간 끝난 PC 가 다시 판매 재고로 돌아옵니다
--
--  이미 만든 표는 건드리지 않고 필요한 것만 덧붙입니다.
-- ═══════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════
--  한국 가상컴 — 원격 명령 (재부팅 등)
--
--  Supabase SQL Editor 에 붙여넣고 Run 하시면 됩니다.
--  이미 만든 표는 건드리지 않고 필요한 것만 덧붙입니다.
--
--  ★ 어떻게 동작하나
--    랙PC 는 2분마다 자기 상태를 보냅니다(beat 함수).
--    관리자가 [재부팅] 을 누르면 그 PC 줄에 명령을 적어 둡니다.
--    다음 신호가 올 때 beat 가 'CMD:reboot' 이라고 답해 주고,
--    랙PC 프로그램이 그걸 보고 재부팅합니다. 명령은 한 번 주면 지워집니다.
--
--    통신을 새로 만들지 않아 랙PC 1,200대에 부담이 없습니다.
--    다만 누른 뒤 최대 2분까지 기다릴 수 있습니다.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. 명령을 적어 둘 칸 ──────────────────────────────────────
alter table pcs add column if not exists cmd      text;         -- reboot 등
alter table pcs add column if not exists cmd_at   timestamptz;  -- 언제 걸었나
alter table pcs add column if not exists cmd_by   text;         -- 누가 걸었나


-- ── 2. beat 함수 교체 — 명령이 있으면 실어 보냅니다 ───────────
create or replace function public.beat(
  p_pn      text,
  p_token   text,
  p_online  boolean default true,
  p_in_use  boolean default false,
  p_ip      text    default null,
  p_cpu     text    default null,
  p_core    text    default null,
  p_ram_gb  int     default null,
  p_ssd_gb  int     default null,
  p_gpu     text    default null,
  p_anydesk text    default null,
  p_up_sec  bigint  default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  v_cmd text;
begin
  if p_token is null or length(p_token) < 16 then
    return 'DENIED';
  end if;

  update pcs set
    online    = p_online,
    in_use    = p_in_use,
    ip        = coalesce(p_ip,      ip),
    cpu       = coalesce(p_cpu,     cpu),
    core      = coalesce(p_core,    core),
    ram_gb    = coalesce(p_ram_gb,  ram_gb),
    ssd_gb    = coalesce(p_ssd_gb,  ssd_gb),
    gpu       = coalesce(p_gpu,     gpu),
    anydesk   = coalesce(p_anydesk, anydesk),
    up_sec    = p_up_sec,
    last_beat = now(),
    updated_at = now()
  where pn = p_pn and beat_token = p_token
  returning cmd into v_cmd;

  get diagnostics n = row_count;
  if n = 0 then
    return 'DENIED';
  end if;

  -- 걸어둔 명령이 있으면 한 번만 주고 지웁니다.
  -- (지우지 않으면 재부팅이 무한히 반복됩니다)
  if v_cmd is not null and v_cmd <> '' then
    update pcs set cmd = null, cmd_at = null, cmd_by = null where pn = p_pn;
    return 'CMD:' || v_cmd;
  end if;

  return 'OK';
end;
$$;

revoke all on function public.beat(text,text,boolean,boolean,text,text,text,int,int,text,text,bigint) from public;
grant execute on function public.beat(text,text,boolean,boolean,text,text,text,int,int,text,text,bigint) to anon;


-- ── 3. 확인 ───────────────────────────────────────────────────
-- DENIED 가 나와야 정상입니다 (없는 품번 + 가짜 토큰)
select public.beat('Z-999', 'thisisafaketokenvalue123') as "가짜 토큰 테스트";


-- ═══════════════════════════════════════════════════════════════
--  한국 가상컴 — 이용 기간 만료 자동 처리
--
--  Supabase SQL Editor 에 붙여넣고 Run 하시면 됩니다.
--
--  ★ 왜 필요한가
--    지금은 30일이 지나도 주문이 "이용중" 으로 남아 있고,
--    그 PC 도 계속 "임대중" 입니다. 그러면
--      · 그 PC 를 다시 팔 수 없습니다 (재고가 계속 줄어듭니다)
--      · 고객 화면에도 임대중으로 보여 새 손님이 못 삽니다
--      · 매출 집계에 끝난 주문이 계속 잡힙니다
--    랙PC 1,200대 규모에서는 몇 달만 지나도 재고가 바닥난 것처럼 보입니다.
--
--  ★ 어떻게 도나
--    누가 관리자 화면이나 고객 목록을 열 때마다 이 함수를 부릅니다.
--    별도 예약 작업이 필요 없습니다.
--    다만 1분에 한 번만 실제로 돌게 해서, 사람이 많이 봐도 부담이 없습니다.
-- ═══════════════════════════════════════════════════════════════

-- 만료일로 빨리 찾을 수 있게
create index if not exists orders_expire_idx on orders (status, ends_at);

create or replace function public.sweep_expired()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last timestamptz;
  n int;
begin
  -- 1분에 한 번만 실제로 돕니다 (-1 은 "이번엔 건너뜀" 이라는 뜻)
  select v::timestamptz into v_last from settings where k = 'last_sweep';
  if v_last is not null and v_last > now() - interval '1 minute' then
    return -1;
  end if;
  insert into settings (k, v) values ('last_sweep', now()::text)
    on conflict (k) do update set v = excluded.v;

  -- ① 기간이 끝난 주문의 PC 를 판매 재고로 되돌립니다.
  --    점검중(fix)·다운(down) 인 PC 는 건드리지 않습니다 — 사람이 볼 일이 남아 있습니다.
  update pcs set status = 'ok', updated_at = now()
   where status = 'rent'
     and pn in (select pn from orders
                 where status = 'assigned' and ends_at < now() and pn is not null);

  -- ② 주문을 만료로 표시합니다.
  update orders set status = 'expired'
   where status = 'assigned' and ends_at < now();
  get diagnostics n = row_count;

  -- ③ 결제만 되고 배정을 못 받은 채 하루가 지난 주문도 표시합니다.
  --    (배정 실패 후 사람이 처리하지 않은 것 — 관리자 화면에서 눈에 띄게)
  update orders set status = 'expired'
   where status = 'paid' and paid_at < now() - interval '1 day';

  return n;
end;
$$;

-- 서버(service_role)만 부릅니다. 고객 브라우저에는 열지 않습니다.
revoke all on function public.sweep_expired() from public;


-- ── 확인 ──────────────────────────────────────────────────────
-- 지금 만료 대상이 몇 건인지 미리 봅니다
select count(*) as "만료 처리될 주문"
  from orders where status = 'assigned' and ends_at < now();

-- 실제로 한 번 돌려봅니다 (-1 이면 방금 돌아서 건너뛴 것입니다)
select public.sweep_expired() as "이번에 만료 처리한 건수";
