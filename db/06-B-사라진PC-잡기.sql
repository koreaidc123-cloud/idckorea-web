-- ═══════════════════════════════════════════════════════════════
--  2단계 — 사라진 영태리 PC 를 잡습니다  (2026-08-18)
--
--  Supabase → SQL Editor → 통째로 붙여넣고 [Run]
--  여러 번 돌려도 안전합니다. 기존 표와 자료는 지우지 않습니다.
--  ※ 1단계(06-A)를 먼저 돌려 상태를 보신 뒤에 실행하세요.
--
--  ★ 지금 무슨 일이 벌어져 있나
--    랙PC 는 2분마다 "나 살아있다" 고 신호를 보냅니다.
--    그때 자기 품번(Y-001)과 전용 열쇠를 같이 보냅니다.
--
--    그런데 다른 PC 가 Y-001 자리를 가져가면서 열쇠를 새로 발급받았습니다.
--    그래서 진짜 영태리 PC 가 보내는 열쇠는 이제 안 맞습니다.
--    서버는 안 맞는 신호를 "그냥 버리고" 있었습니다.
--
--    → 그 PC 는 지금도 멀쩡히 켜져서 2분마다 신호를 보내는데,
--      우리 화면에는 아무 흔적도 안 남습니다. 그래서 못 찾았습니다.
--
--  ★ 이 파일이 하는 일
--    버리지 말고 [미등록 PC] 목록에 올려놓습니다.
--    애니데스크 번호가 같이 올라오므로, 현장에 가지 않고
--    그 번호로 원격 접속해서 되살릴 수 있습니다.
-- ═══════════════════════════════════════════════════════════════


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  1. 원격 명령 칸  (03 번 내용 — 아직 안 하셨다면 여기서 같이 됩니다)
--     ※ 아래 2번의 beat 함수가 이 칸을 쓰므로 반드시 먼저 만들어야 합니다.
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
alter table pcs add column if not exists cmd    text;         -- reboot 등
alter table pcs add column if not exists cmd_at timestamptz;  -- 언제 걸었나
alter table pcs add column if not exists cmd_by text;         -- 누가 걸었나


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  2. 사라진 PC 를 잡아 두는 칸
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
alter table pcs_unregistered add column if not exists claimed_pn text;
alter table pcs_unregistered add column if not exists note       text;


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  3. beat 함수 교체 — 열쇠 안 맞는 신호를 버리지 않습니다
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
  n     int;
  v_cmd text;
  v_key text;
begin
  if p_token is null or length(p_token) < 16 then
    return 'DENIED';
  end if;

  update pcs set
    online     = p_online,
    in_use     = p_in_use,
    ip         = coalesce(p_ip,      ip),
    cpu        = coalesce(p_cpu,     cpu),
    core       = coalesce(p_core,    core),
    ram_gb     = coalesce(p_ram_gb,  ram_gb),
    ssd_gb     = coalesce(p_ssd_gb,  ssd_gb),
    gpu        = coalesce(p_gpu,     gpu),
    anydesk    = coalesce(p_anydesk, anydesk),
    up_sec     = p_up_sec,
    last_beat  = now(),
    updated_at = now()
  where pn = p_pn and beat_token = p_token
  returning cmd into v_cmd;

  get diagnostics n = row_count;

  -- ★ 여기가 이번에 고치는 부분입니다.
  --   열쇠가 안 맞는 신호를 버리지 않고 [미등록 PC] 로 올립니다.
  if n = 0 then
    -- 우리 품번 형식(K-001 / Y-001 / D-001)이 아니면 그냥 버립니다.
    -- 엉뚱한 요청으로 목록이 지저분해지지 않게 하는 울타리입니다.
    if p_pn !~ '^[KYD]-[0-9]{3}$' then
      return 'DENIED';
    end if;

    -- 같은 PC 가 2분마다 계속 보내므로, 한 줄로만 쌓이게 묶습니다.
    if p_anydesk is not null and p_anydesk <> '' then
      v_key := 'lost:' || p_anydesk;
    else
      v_key := 'lost:' || p_pn;
    end if;

    insert into pcs_unregistered
      (hw_id, room, ip, cpu, core, ram_gb, ssd_gb, gpu, anydesk,
       claimed_pn, note, first_seen, last_beat)
    values
      (v_key, substr(p_pn, 1, 1), p_ip, p_cpu, p_core, p_ram_gb, p_ssd_gb, p_gpu, p_anydesk,
       p_pn, '대장에서 사라진 PC — ' || p_pn || ' 이라고 신호를 보내고 있습니다',
       now(), now())
    on conflict (hw_id) do update set
      ip         = coalesce(excluded.ip,     pcs_unregistered.ip),
      cpu        = coalesce(excluded.cpu,    pcs_unregistered.cpu),
      core       = coalesce(excluded.core,   pcs_unregistered.core),
      ram_gb     = coalesce(excluded.ram_gb, pcs_unregistered.ram_gb),
      ssd_gb     = coalesce(excluded.ssd_gb, pcs_unregistered.ssd_gb),
      gpu        = coalesce(excluded.gpu,    pcs_unregistered.gpu),
      anydesk    = coalesce(excluded.anydesk, pcs_unregistered.anydesk),
      claimed_pn = excluded.claimed_pn,
      note       = excluded.note,
      last_beat  = now();

    return 'DENIED';
  end if;

  -- 걸어둔 명령이 있으면 한 번만 주고 지웁니다 (반복 재부팅 방지)
  if v_cmd is not null and v_cmd <> '' then
    update pcs set cmd = null, cmd_at = null, cmd_by = null where pn = p_pn;
    return 'CMD:' || v_cmd;
  end if;

  return 'OK';
end;
$$;

revoke all on function public.beat(text,text,boolean,boolean,text,text,text,int,int,text,text,bigint) from public;
grant  execute on function public.beat(text,text,boolean,boolean,text,text,text,int,int,text,text,bigint) to anon;


-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  4. 확인 — 2분쯤 기다렸다가 이것만 다시 [Run] 해 주세요
--     (랙PC 가 2분에 한 번 신호를 보내므로 그때 잡힙니다)
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
select claimed_pn as "본인이 주장하는 품번",
       anydesk    as "★ 애니데스크 번호",
       cpu, ram_gb as "램", ssd_gb as "SSD", ip,
       last_beat  as "마지막 신호",
       note       as "설명"
  from pcs_unregistered
 order by last_beat desc;
