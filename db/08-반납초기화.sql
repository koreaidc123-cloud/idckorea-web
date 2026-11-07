-- ═══════════════════════════════════════════════════════════════
--  4단계 — 반납 PC 초기화 확인 · 환불 송금 추적   (2026-11-07)
--
--  ★ 대표님이 직접 하실 일 (한 번만)
--    Supabase → 왼쪽 SQL Editor → New query → 이 파일 내용을 통째로 붙여넣고 [Run]
--    GitHub 에 올리거나(push) 배포해도 이 파일은 실행되지 않습니다. 꼭 직접 돌려 주세요.
--    여러 번 돌려도 안전합니다 (있으면 건너뛰고, 함수는 바꿔 끼웁니다).
--    07-만료정리.sql 을 돌리셨든 안 돌리셨든 상관없이 이것 하나면 됩니다.
--
--  ★ 왜 필요한가 — 개인정보 사고를 막습니다
--    지금은 기간이 끝나면 PC 가 바로 [임대 가능] 으로 돌아갑니다.
--    그러면 앞 손님의 파일·로그인 기록·애니데스크 비밀번호가 그대로 남은 채
--    다음 손님에게 팔릴 수 있습니다.
--    이제는 이렇게 흐릅니다.
--
--      임대중 ─(기간 끝)→ 반납 유예(hold) ─(3일 뒤)→ 초기화 대기(wipe)
--             ─(관리자가 초기화 + 비밀번호 교체 후 버튼)→ 임대 가능(ok)
--
--    · 반납 유예 3일 = 손님이 늦게 연장하셔도 자료가 그대로 있는 기간입니다.
--      이 동안은 판매되지 않습니다. 연장하면 바로 임대중으로 돌아옵니다.
--    · 초기화 대기 = 관리자 [오늘 할 일] 에 "반납 초기화 대기" 로 뜹니다.
--      새 애니데스크 비밀번호를 넣어야만 [임대 가능] 으로 바뀝니다.
--    · 해지·환불한 PC 는 유예 없이 바로 초기화 대기로 갑니다 (코드에서 처리).
--
--  ★ 같이 생기는 것 — 직접 송금해야 하는 환불 추적
--    계좌이체·스마트스토어 주문을 해지하면 토스가 돈을 돌려줄 수 없어
--    관리자가 직접 보내야 합니다. 그동안은 기록에 한 줄만 남아 잊기 쉬웠습니다.
--    orders 에 refund_state 칸을 만들어 "보내야 함 → 보냄" 을 따라갑니다.
--
--  ★ 되돌리는 법 (문제가 생겼을 때)
--    1) db/07-만료정리.sql 을 다시 돌리면 예전 정리 방식(만료 → 바로 임대 가능)으로 돌아갑니다.
--    2) 새로 만든 칸(wipe_at · hold_until · refund_state · refund_done_at)은 남겨 두셔도
--       아무 문제 없습니다. 코드는 칸이 있든 없든 동작합니다.
--    3) 유예·초기화 대기 PC 를 한꺼번에 판매로 돌리는 줄은 맨 아래에 주석으로 두었습니다.
--       앞 손님 자료가 남은 채 팔리므로 정말 필요할 때만 쓰십시오.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. 새 칸 ──────────────────────────────────────────────────
-- 초기화 대기로 넘어간 시각 (얼마나 오래 밀렸는지 볼 때)
alter table pcs    add column if not exists wipe_at        timestamptz;
-- 반납 유예가 끝나는 시각 (이 시각이 지나면 초기화 대기로)
alter table pcs    add column if not exists hold_until     timestamptz;
-- 환불 송금 상태: toss_done(토스가 돌려줌) · manual_pending(직접 보내야 함) · manual_done(보냄)
alter table orders add column if not exists refund_state   text;
-- 직접 송금을 끝낸 시각
alter table orders add column if not exists refund_done_at timestamptz;

-- ── 2. 반납 유예 일수 (기본 3일) ───────────────────────────────
-- 관리자 화면은 이 값이 있으면 "08 을 돌렸다" 고 보고 안내 문구를 지웁니다.
insert into settings (k, v) values ('hold_days', '3')
  on conflict (k) do nothing;

-- ── 3. 만료 정리 함수 바꿔 끼우기 ─────────────────────────────
-- 07-만료정리.sql 의 함수와 같고, 바뀐 곳은 ★ 표시한 세 곳뿐입니다.
--   · 결제완료(paid) 주문은 여전히 절대 자동 만료하지 않습니다.
--   · 같은 PC 를 지금 쓰는 다른 주문이 있으면 여전히 건드리지 않습니다.
create index if not exists orders_expire_idx on orders (status, ends_at);

create or replace function public.sweep_expired()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last timestamptz;
  v_days int;
  n int;
begin
  -- 1분에 한 번만 실제로 돕니다 (-1 은 "이번엔 건너뜀" 이라는 뜻)
  select v::timestamptz into v_last from settings where k = 'last_sweep';
  if v_last is not null and v_last > now() - interval '1 minute' then
    return -1;
  end if;
  insert into settings (k, v) values ('last_sweep', now()::text)
    on conflict (k) do update set v = excluded.v;

  -- 반납 유예 일수 — 숫자가 아니거나 없으면 3일
  select case when v ~ '^\d{1,3}$' then v::int end into v_days
    from settings where k = 'hold_days';
  v_days := coalesce(v_days, 3);

  -- ① ★ 기간이 끝난 주문의 PC 를 "반납 유예" 로 보냅니다 (예전: 바로 임대 가능).
  --    점검중(fix)·다운(down) 인 PC 는 건드리지 않습니다 — 사람이 볼 일이 남아 있습니다.
  update pcs set status = 'hold',
                 hold_until = now() + make_interval(days => v_days),
                 updated_at = now()
   where status = 'rent'
     and pn in (select pn from orders
                 where status = 'assigned' and ends_at < now() and pn is not null)
     -- 같은 PC 를 지금 쓰는 다른 주문이 있으면 건드리지 않습니다.
     -- ★ 결제완료(paid)는 끝나는 날과 상관없이 항상 "쓰는 중" 으로 봅니다
     --   (07 은 paid 도 끝나는 날로 걸러서, 날짜가 지난 paid 주문의 PC 가 풀릴 수 있었습니다 — Codex T-0179)
     and pn not in (select pn from orders
                     where pn is not null
                       and (status = 'paid'
                            or (status = 'assigned' and (ends_at is null or ends_at >= now()))));

  -- ② 주문을 만료로 표시합니다.
  update orders set status = 'expired'
   where status = 'assigned' and ends_at < now();
  get diagnostics n = row_count;

  -- ③ 결제완료(paid) 주문은 자동으로 만료시키지 않습니다 (07 과 같음).

  -- ④ ★ 유예가 끝난 PC 를 "초기화 대기" 로 보냅니다.
  --    여기서부터는 관리자가 초기화하고 비밀번호를 바꿔야만 다시 팔립니다.
  update pcs set status = 'wipe', wipe_at = now(), updated_at = now()
   where status = 'hold' and hold_until is not null and hold_until < now();

  return n;
end;
$$;

-- 서버(service_role)만 부릅니다. 고객 브라우저에는 열지 않습니다.
revoke all on function public.sweep_expired() from public;


-- ── 확인 ──────────────────────────────────────────────────────
-- 아래 두 줄이 나오면 성공입니다.
select k, v from settings where k = 'hold_days';
select public.sweep_expired() as "이번에 만료 처리한 건수 (-1 이면 방금 돌아서 건너뜀)";

-- (참고) 지금 반납 유예 · 초기화 대기인 PC
select pn, status, hold_until, wipe_at from pcs where status in ('hold', 'wipe') order by pn;


-- ── (비상용 · 평소엔 쓰지 마세요) 유예·초기화 대기 PC 를 한꺼번에 판매로 ──────
-- 앞 손님 자료와 비밀번호가 그대로 남은 채 팔립니다. 맨 앞 -- 를 지워야 실행됩니다.
-- update pcs set status = 'ok', updated_at = now() where status in ('hold', 'wipe');
