-- ═══════════════════════════════════════════════════════════════
--  한국 가상컴 — 연락 끊긴 PC 를 다시 찾기
--
--  Supabase SQL Editor 에 붙여넣고 Run 하시면 됩니다.
--
--  ★ 무엇을 고치나
--    랙PC 는 2분마다 "나 살아있다" 고 신호를 보냅니다. 그때 자기 품번과
--    전용 열쇠(토큰)를 같이 보내는데, 둘이 안 맞으면 서버가 그냥 버렸습니다.
--
--    그런데 열쇠는 이런 경우에 어긋납니다.
--      · 다른 PC 가 같은 품번을 가져가면서 열쇠를 새로 발급받았을 때
--        (2026-08-17 영태리 Y-001 이 이렇게 사라졌습니다)
--      · PC 를 다시 등록하면서 열쇠가 바뀌었을 때
--
--    그러면 그 PC 는 멀쩡히 켜져 있는데도 관리 화면에서 완전히 사라집니다.
--    어디에 꽂혀 있는지, 애니데스크 번호가 뭔지 알 길이 없어집니다.
--
--    이제는 버리지 않고 [미등록 PC] 목록에 올립니다.
--    사양·애니데스크 번호·IP 가 그대로 올라오므로, 그 번호로 원격 접속해서
--    다시 등록하시면 됩니다. 현장에 가지 않아도 됩니다.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. 어떤 품번이라고 주장했는지 적어 둘 칸 ──────────────────
alter table pcs_unregistered add column if not exists claimed_pn text;
alter table pcs_unregistered add column if not exists note       text;


-- ── 2. beat 함수 교체 ────────────────────────────────────────
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
  v_key text;
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

  -- ★ 열쇠가 안 맞는 신호 — 버리지 않고 [미등록 PC] 로 올립니다.
  --   이 PC 는 멀쩡히 켜져 있는데 대장에서만 사라진 상태입니다.
  --   애니데스크 번호가 같이 올라오므로 원격으로 찾아갈 수 있습니다.
  if n = 0 then
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
       p_pn, '대장에서 사라진 PC — ' || p_pn || ' 이라고 신호를 보내고 있습니다', now(), now())
    on conflict (hw_id) do update set
      ip         = coalesce(excluded.ip, pcs_unregistered.ip),
      cpu        = coalesce(excluded.cpu, pcs_unregistered.cpu),
      core       = coalesce(excluded.core, pcs_unregistered.core),
      ram_gb     = coalesce(excluded.ram_gb, pcs_unregistered.ram_gb),
      ssd_gb     = coalesce(excluded.ssd_gb, pcs_unregistered.ssd_gb),
      gpu        = coalesce(excluded.gpu, pcs_unregistered.gpu),
      anydesk    = coalesce(excluded.anydesk, pcs_unregistered.anydesk),
      claimed_pn = excluded.claimed_pn,
      note       = excluded.note,
      last_beat  = now();

    return 'DENIED';
  end if;

  -- 걸어둔 명령이 있으면 한 번만 주고 지웁니다
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
-- 지금 미등록으로 잡힌 것이 있는지 (영태리 PC 가 여기 나타날 겁니다)
select claimed_pn as "주장하는 품번", anydesk as "애니데스크", cpu, ram_gb, ip,
       last_beat as "마지막 신호", note
  from pcs_unregistered
 order by last_beat desc;
