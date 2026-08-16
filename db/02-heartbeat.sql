-- ═══════════════════════════════════════════════════════════════
--  한국 가상컴 — 하트비트 직접 전송 (중계기 없는 방식)
--
--  schema.sql 을 이미 실행하셨다면, 이 파일을 이어서 실행하시면 됩니다.
--  기존 표는 건드리지 않고 필요한 것만 덧붙입니다.
--
--  ★ 이 파일이 하는 일
--    랙PC 1,200대가 서버를 거치지 않고 데이터베이스에 직접 자기 상태를 씁니다.
--    그런데 아무나 아무 PC 상태를 고칠 수 있으면 안 되므로,
--    PC 한 대마다 전용 열쇠(토큰)를 주고 "자기 한 줄"만 고치게 막습니다.
--
--    · 랙PC 가 아는 것 : 자기 품번 + 자기 토큰 + 공개키(공개돼도 되는 키)
--    · 랙PC 가 못 하는 것 : 남의 PC 수정, 고객·주문 조회, 표 읽기
-- ═══════════════════════════════════════════════════════════════

-- ── 1. PC 마다 전용 열쇠 ──────────────────────────────────────
alter table pcs add column if not exists beat_token text;
alter table pcs add column if not exists hw_id      text;   -- 메인보드 일련번호(기계 고유값)
create index if not exists pcs_token_idx on pcs (pn, beat_token);

-- 자리(rack·fl·slot)는 등록 직후엔 아직 정해지지 않았으므로 0 을 허용합니다.
-- 관리자가 랙맵에서 자리를 지정하면 그때 실제 값이 들어갑니다.
alter table pcs alter column rack drop not null;
alter table pcs alter column fl   drop not null;
alter table pcs alter column slot drop not null;

-- 자리가 정해지지 않은(0) PC 들이 서로 부딪히지 않도록,
-- "같은 자리 중복 금지" 규칙을 실제 자리가 있는 PC 에만 적용합니다.
alter table pcs drop constraint if exists pcs_room_rack_fl_slot_key;
drop index if exists pcs_slot_unique;
create unique index pcs_slot_unique on pcs (room, rack, fl, slot)
  where rack > 0 and fl > 0 and slot > 0;


-- ── 2. 하트비트 접수 창구 ─────────────────────────────────────
-- 랙PC 는 오직 이 함수 하나만 부를 수 있습니다.
-- 품번과 토큰이 맞을 때만 그 한 줄이 갱신됩니다. 틀리면 DENIED 를 돌려줍니다.
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
security definer                 -- 함수 안에서는 주인 권한으로 돕니다
set search_path = public
as $$
declare
  n int;
begin
  -- 토큰이 비었으면 즉시 거절 (빈 값끼리 맞아떨어지는 사고 방지)
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
  where pn = p_pn and beat_token = p_token;

  get diagnostics n = row_count;
  if n = 0 then
    return 'DENIED';             -- 품번이 없거나 토큰이 틀립니다
  end if;
  return 'OK';
end;
$$;

-- 이 함수만 열어줍니다. 표 자체는 여전히 아무도 못 봅니다.
revoke all on function public.beat(text,text,boolean,boolean,text,text,text,int,int,text,text,bigint) from public;
grant execute on function public.beat(text,text,boolean,boolean,text,text,text,int,int,text,text,bigint) to anon;


-- ── 3. 확인 ───────────────────────────────────────────────────
-- 아래를 실행하면 DENIED 가 나와야 정상입니다.
-- (없는 품번 + 아무 토큰이므로 거절되는 게 맞습니다)
select public.beat('Z-999', 'thisisafaketokenvalue123') as "가짜 토큰 테스트";
