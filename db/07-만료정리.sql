-- ═══════════════════════════════════════════════════════════════
--  3단계 — 이용 기간 만료 자동 처리   (04번 내용을 따로 뺀 것입니다)
--
--  Supabase → SQL Editor → 통째로 붙여넣고 [Run]
--  급하지 않습니다. 06-A / 06-B 를 먼저 하신 뒤에 하셔도 됩니다.
--
--  ★★ 2026-11-07 고침 — 예전에 이 파일을 돌리셨어도 "한 번 더" 돌려 주세요.
--     · 결제완료(paid)·배정 대기 주문을 하루 뒤 만료시키던 부분을 뺐습니다.
--       (돈은 받았는데 관리자 화면에서 주문이 사라졌습니다)
--     · 같은 PC 를 다른 주문이 쓰고 있으면 풀지 않도록 했습니다.
--     함수를 바꿔 끼우는 것(create or replace)이라 여러 번 돌려도 안전합니다.
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
--
--  ※ 이 파일은 beat 함수를 건드리지 않습니다.
--    그래서 06-B 앞뒤 어느 쪽에 돌리셔도 안전합니다.
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
                 where status = 'assigned' and ends_at < now() and pn is not null)
     -- ★ 같은 PC 를 지금 쓰는(아직 안 끝난) 다른 주문이 있으면 풀지 않습니다 (2026-11-07)
     and pn not in (select pn from orders
                     where status in ('assigned', 'paid') and pn is not null
                       and (ends_at is null or ends_at >= now()));

  -- ② 주문을 만료로 표시합니다.
  update orders set status = 'expired'
   where status = 'assigned' and ends_at < now();
  get diagnostics n = row_count;

  -- ③ (2026-11-07 삭제) 예전에는 결제만 되고 배정을 못 받은 채 하루가 지난 주문(paid)을
  --    만료로 바꿨습니다. 그러면 돈은 받았는데 관리자 화면에서 사라졌습니다.
  --    결제완료(paid) 주문은 절대 자동으로 만료시키지 않습니다.
  --    관리자 [오늘 할 일] 의 "결제 완료 · PC 배정 대기" 에서 사람이 배정합니다.

  return n;
end;
$$;

-- 서버(service_role)만 부릅니다. 고객 브라우저에는 열지 않습니다.
revoke all on function public.sweep_expired() from public;


-- ── 확인 ──────────────────────────────────────────────────────
-- 실제로 한 번 돌려봅니다 (-1 이면 방금 돌아서 건너뛴 것입니다)
select public.sweep_expired() as "이번에 만료 처리한 건수";

-- ── (확인용) 예전 규칙 때문에 "만료" 로 사라진 결제완료 주문 ──────
-- 결제는 됐는데(paid_at 있음) PC 를 한 번도 못 받고(pn 없음) 만료된 주문입니다.
-- 한 줄이라도 나오면 돈을 받고 PC 를 못 드린 고객입니다.
select order_id, user_name, user_phone, amount, paid_at
  from orders
 where status = 'expired' and pn is null and paid_at is not null and canceled_at is null
 order by paid_at desc;

-- 위 목록이 맞다면, 아래 줄 맨 앞의 -- 두 개를 지우고 그 한 줄만 다시 실행하시면
-- 관리자 [오늘 할 일] 의 "결제 완료 · PC 배정 대기" 로 되돌아옵니다.
-- update orders set status = 'paid' where status = 'expired' and pn is null and paid_at is not null and canceled_at is null;
