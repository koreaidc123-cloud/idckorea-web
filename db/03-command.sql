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
