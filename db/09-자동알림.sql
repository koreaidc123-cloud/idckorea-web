-- ═══════════════════════════════════════════════════════════════
--  5단계 — 텔레그램 자동 알림 + 만료 정리 자동 실행   (2026-11-08)
--
--  ※ 이 SQL 은 실제 PostgreSQL 에서 한 번도 실행해 보지 않았습니다.
--    (개발 PC 에는 진짜 Supabase 를 부르지 않는 가짜 DB 만 있습니다)
--    처음 돌리실 때 오류가 나면 그 문구를 그대로 개발 담당에게 보내 주세요.
--
--  ★ 무엇이 생기나
--    · 1분마다 만료 정리(sweep_expired)가 저절로 돕니다.
--      지금은 관리자 화면을 열어야만 돌아서, 아무도 안 열면 끝난 주문이 계속 "이용중" 으로 남습니다.
--    · 5분마다 아래를 살펴 텔레그램으로 알려 드립니다 (같은 일은 한 번만).
--        ① 임대중 PC 가 10분 넘게 신호가 없을 때 (손님이 못 쓰고 있을 수 있음)
--        ② 결제는 끝났는데 PC 배정을 10분 넘게 못 한 주문이 있을 때
--        ③ 같은 랙 같은 층에서 2대 이상이 동시에 신호가 끊겼을 때 (전원·공유기 의심)
--        ④ 매일 아침 9시(한국 시각) 요약 — 3일 안 만료 · 반납 초기화 대기 · 직접 송금할 환불 · 배정 대기
--    · 알림에는 품번(Y-001 같은 것)과 숫자만 들어갑니다.
--      손님 이름·전화번호·서버실 이름은 절대 넣지 않습니다 (텔레그램 서버를 거치기 때문).
--    · 이 기능은 Vercel 함수를 하나도 늘리지 않습니다 (Supabase 안에서만 돕니다).
--
--  ★ 먼저 돌려야 하는 것: db/08-반납초기화.sql (아직 안 돌리셨으면 08 먼저)
--
--  ═══ 대표님이 하실 일 (처음 한 번만 · 순서대로) ═══
--
--  1) 텔레그램 봇 만들기 (휴대폰 텔레그램 앱)
--     · 검색창에 @BotFather 를 찾아 대화를 열고  /newbot  을 보냅니다.
--     · 봇 이름(예: 한국가상컴 알림)과 아이디(예: kvc_alert_bot, 끝이 bot)를 차례로 보냅니다.
--     · BotFather 가 "토큰" 을 줍니다. 숫자:영문 이 섞인 긴 글자입니다.
--       ★ 이 토큰은 비밀번호와 같습니다. 카톡·메일·이 파일에 붙여 두지 마세요.
--
--  2) 알림 받을 대화방 번호(chat id) 알아내기
--     · 방금 만든 봇과 대화를 열고 아무 말이나 한 번 보냅니다 (예: 안녕).
--       여러 사람이 같이 받으려면 단톡방을 만들고 봇을 초대한 뒤 그 방에서 한 번 말합니다.
--     · PC 브라우저 주소창에  https://api.telegram.org/bot토큰/getUpdates  를 넣습니다
--       (토큰 자리에 1)의 토큰). 화면에 "chat":{"id":123456789 처럼 나오는 숫자가 chat id 입니다.
--       단톡방이면 -100 으로 시작하는 음수입니다. 빼기(-)까지 그대로 씁니다.
--     · 다 보셨으면 그 브라우저 탭은 닫고, 방문 기록에서도 지워 두시면 좋습니다 (주소에 토큰이 있음).
--
--  3) 토큰과 chat id 를 Supabase 금고(Vault)에 넣기 — 둘 중 편한 방법 하나
--     [방법 A · 권장] Supabase 대시보드 → 왼쪽 Project Settings(또는 Integrations) → Vault
--        → [Add new secret]
--          Name: kvc_tg_token   Secret: 1)의 토큰
--          Name: kvc_tg_chat    Secret: 2)의 숫자
--     [방법 B] SQL Editor → New query 에 아래 두 줄을 붙이고 '여기에…' 만 바꿔 [Run]
--          select vault.create_secret('여기에_봇_토큰', 'kvc_tg_token', '한국가상컴 텔레그램 봇 토큰');
--          select vault.create_secret('여기에_chat_id', 'kvc_tg_chat',  '한국가상컴 텔레그램 대화방');
--        ★ 실행 뒤 그 query 는 저장하지 말고 지워 주세요 (SQL Editor 기록에 토큰이 남습니다).
--     · 이름은 꼭 kvc_tg_token · kvc_tg_chat 그대로 써야 합니다.
--     · 나중에 토큰을 바꾸려면 Vault 화면에서 그 줄을 고치면 됩니다 (이 파일을 다시 돌릴 필요 없음).
--     · 금고에 둘 중 하나라도 없으면 알림 함수는 아무것도 하지 않고 끝납니다 (오류도 안 냅니다).
--
--  4) Supabase → SQL Editor → New query → 이 파일 내용을 통째로 붙여넣고 [Run]
--     · 여러 번 돌려도 안전합니다 (있으면 건너뛰고, 함수·예약은 바꿔 끼웁니다).
--     · "extension pg_cron ... permission" 같은 오류가 나면 대시보드 → Database → Extensions 에서
--       pg_cron 과 pg_net 을 켜고(Enable) 다시 [Run] 하세요.
--
--  5) 맨 아래 "확인" 결과를 봅니다. 몇 분 안에 텔레그램에 시험 알림이 한 번 옵니다
--     (맨 아래 kvc_tg_send('✅ …') 줄). 안 오면 3)의 이름·값을 다시 확인하세요.
--
--  ★ 끄는 법 (문제가 생겼을 때)
--     select cron.unschedule('kvc-alerts');   -- 텔레그램 알림만 끄기
--     select cron.unschedule('kvc-sweep');    -- 만료 정리 자동 실행 끄기 (관리자 화면을 열 때는 계속 돕니다)
-- ═══════════════════════════════════════════════════════════════

-- ── 1. 확장 기능 켜기 ─────────────────────────────────────────
-- pg_cron = 정해진 시각마다 SQL 을 돌려 주는 예약 기능 · pg_net = DB 안에서 인터넷 주소를 부르는 기능
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net  with schema extensions;


-- ── 2. 같은 알림을 두 번 보내지 않게 기억하는 표 ───────────────────
--   k = 무엇에 대한 알림인지 (down:Y-001 · paidwait:주문번호 · floor:Y1-4 · daily)
--   v = 그때의 값 (마지막 신호 시각 · 끊긴 PC 목록 · 날짜) — 값이 바뀌면 새 일로 보고 다시 알립니다
create table if not exists public.alert_state (
  k  text primary key,
  v  text,
  at timestamptz not null default now()
);
-- 고객 브라우저(공개키)로는 읽지도 쓰지도 못하게 잠급니다 (허용 규칙을 하나도 안 만듦)
alter table public.alert_state enable row level security;


-- ── 3. 텔레그램으로 한 줄 보내기 ───────────────────────────────────
-- 금고에서 토큰·대화방을 꺼내 보냅니다. 없으면 false (아무것도 안 보냄).
-- 보내는 일은 pg_net 이 뒤에서 따로 하므로, 텔레그램이 느려도 이 함수는 바로 끝납니다.
create or replace function public.kvc_tg_send(p_text text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
  v_chat  text;
begin
  begin
    select decrypted_secret into v_token from vault.decrypted_secrets where name = 'kvc_tg_token' limit 1;
    select decrypted_secret into v_chat  from vault.decrypted_secrets where name = 'kvc_tg_chat'  limit 1;
  exception when others then
    return false;            -- 금고(Vault)를 못 읽으면 조용히 끝냅니다
  end;
  if coalesce(v_token, '') = '' or coalesce(v_chat, '') = '' then
    return false;
  end if;
  perform net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body    := jsonb_build_object('chat_id', v_chat, 'text', left(p_text, 3500),
                                  'disable_web_page_preview', true),
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return true;
end;
$$;


-- ── 4. 5분마다 살펴보는 함수 ───────────────────────────────────────
-- 돌려주는 값 = 이번에 보낸 알림 개수 (금고에 열쇠가 없으면 0)
create or replace function public.kvc_alerts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ready    boolean := false;
  v_sent     int := 0;
  v_n        int;
  v_list     text;
  v_down_sec int;
  v_keys     text[] := '{}';
  v_key      text;
  r          record;
  v_today    text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD');
  v_hour     int  := extract(hour from (now() at time zone 'Asia/Seoul'))::int;
  v_d3       int;
  v_wipe     int;
  v_refund   int;
  v_wait     int;
  v_rentdown int;
begin
  -- 금고에 열쇠 두 개가 다 있어야 시작합니다
  begin
    select count(*) = 2 into v_ready
      from vault.decrypted_secrets
     where name in ('kvc_tg_token', 'kvc_tg_chat') and coalesce(decrypted_secret, '') <> '';
  exception when others then
    v_ready := false;
  end;
  if not coalesce(v_ready, false) then
    return 0;
  end if;

  -- ① 임대중 PC 가 10분 넘게 신호 없음 — 같은 끊김(같은 마지막 신호 시각)은 한 번만
  select count(*), string_agg(p.pn, ', ' order by p.pn)
    into v_n, v_list
    from pcs p
   where p.status = 'rent'
     and (p.last_beat is null or p.last_beat < now() - interval '10 minutes')
     and not exists (select 1 from alert_state a
                      where a.k = 'down:' || p.pn and a.v = coalesce(p.last_beat::text, 'none'));
  if v_n > 0 then
    if public.kvc_tg_send('🔴 임대중 PC 신호 끊김 (10분 넘음) ' || v_n || '대' || chr(10) || v_list
                          || chr(10) || '관리자 [오늘 할 일] 에서 확인해 주세요') then
      v_sent := v_sent + 1;
    end if;
    insert into alert_state (k, v, at)
      select 'down:' || p.pn, coalesce(p.last_beat::text, 'none'), now()
        from pcs p
       where p.status = 'rent'
         and (p.last_beat is null or p.last_beat < now() - interval '10 minutes')
    on conflict (k) do update set v = excluded.v, at = excluded.at;
  end if;

  -- ② 결제 완료인데 PC 배정이 10분 넘게 안 된 주문 — 주문마다 한 번만 (알림에는 건수만)
  select count(*) into v_n
    from orders o
   where o.status = 'paid' and o.pn is null
     and coalesce(o.paid_at, o.created_at) < now() - interval '10 minutes'
     and not exists (select 1 from alert_state a where a.k = 'paidwait:' || o.order_id);
  if v_n > 0 then
    if public.kvc_tg_send('💳 결제 완료 · PC 배정 대기 10분 넘음 — 새로 ' || v_n || '건'
                          || chr(10) || '관리자 [오늘 할 일] 맨 위에서 [PC 배정] 해 주세요') then
      v_sent := v_sent + 1;
    end if;
    insert into alert_state (k, v, at)
      select 'paidwait:' || o.order_id, 'sent', now()
        from orders o
       where o.status = 'paid' and o.pn is null
         and coalesce(o.paid_at, o.created_at) < now() - interval '10 minutes'
    on conflict (k) do nothing;
  end if;

  -- ③ 같은 랙 같은 층에서 2대 이상 동시에 신호 끊김 (전원 멀티탭 · 공유기 의심)
  --    점검중(fix)·미등록(new)·자리 미지정(0) PC 는 셈에서 뺍니다. 다운 판정 시간은 관리자 설정값(최소 300초).
  select case when v ~ '^\d{1,6}$' then v::int end into v_down_sec from settings where k = 'down_sec';
  v_down_sec := greatest(300, coalesce(v_down_sec, 300));
  for r in
    select p.room, p.rack, p.fl, count(*) as n, string_agg(p.pn, ', ' order by p.pn) as pns
      from pcs p
     where p.status not in ('new', 'fix')
       and p.rack > 0 and p.fl > 0
       and (p.last_beat is null or p.last_beat < now() - make_interval(secs => v_down_sec))
     group by p.room, p.rack, p.fl
    having count(*) >= 2
  loop
    v_key := 'floor:' || r.room || r.rack || '-' || r.fl;
    v_keys := v_keys || v_key;
    if not exists (select 1 from alert_state a where a.k = v_key and a.v = r.pns) then
      -- 서버실은 알파벳(K·Y·D)만 씁니다 — 실제 이름은 넣지 않습니다
      if public.kvc_tg_send('⚡ 같은 층 여러 대 신호 끊김 — ' || r.room || ' ' || r.rack || '번 랙 ' || r.fl || '층 '
                            || r.n || '대' || chr(10) || r.pns || chr(10) || '전원 멀티탭 · 공유기를 확인해 주세요') then
        v_sent := v_sent + 1;
      end if;
      insert into alert_state (k, v, at) values (v_key, r.pns, now())
      on conflict (k) do update set v = excluded.v, at = excluded.at;
    end if;
  end loop;
  -- 다 살아난 층은 기억에서 지웁니다 — 다음에 또 끊기면 다시 알립니다
  delete from alert_state where k like 'floor:%' and not (k = any (v_keys));

  -- ④ 매일 아침 9시(한국 시각) 요약 — 9시 이후 첫 번째 실행에서 하루 한 번
  if v_hour >= 9 and not exists (select 1 from alert_state where k = 'daily' and v = v_today) then
    select count(*) into v_d3 from orders
     where status = 'assigned' and ends_at >= now() and ends_at < now() + interval '3 days';
    select count(*) into v_wipe from pcs where status = 'wipe';
    select count(*) into v_wait from orders where status = 'paid' and pn is null;
    select count(*) into v_rentdown from pcs
     where status = 'rent' and (last_beat is null or last_beat < now() - interval '10 minutes');
    -- refund_state 칸은 db/08 이 만듭니다. 08 을 안 돌렸으면 이 줄만 "확인 필요" 로 둡니다
    begin
      select count(*) into v_refund from orders where refund_state = 'manual_pending';
    exception when undefined_column then
      v_refund := null;
    end;
    if public.kvc_tg_send('☀️ 한국 가상컴 아침 요약 (' || to_char(now() at time zone 'Asia/Seoul', 'MM-DD') || ')' || chr(10)
         || '· 3일 안에 만료: ' || v_d3 || '건' || chr(10)
         || '· 반납 초기화 대기: ' || v_wipe || '대' || chr(10)
         || '· 직접 송금할 환불: ' || coalesce(v_refund::text || '건', '확인 필요 (db/08 실행 전)') || chr(10)
         || '· PC 배정 대기: ' || v_wait || '건' || chr(10)
         || '· 신호 끊긴 임대중 PC: ' || v_rentdown || '대') then
      v_sent := v_sent + 1;
    end if;
    insert into alert_state (k, v, at) values ('daily', v_today, now())
    on conflict (k) do update set v = excluded.v, at = excluded.at;
  end if;

  -- 오래된 기억은 정리합니다 (30일)
  delete from alert_state where k <> 'daily' and at < now() - interval '30 days';

  return v_sent;
end;
$$;

-- 서버 안에서만 씁니다. 고객 브라우저(anon)·로그인 고객(authenticated)은 부를 수 없게 막습니다.
-- (Supabase 는 public 스키마 함수에 anon 실행 권한을 따로 주기 때문에 둘 다 직접 막아야 합니다)
revoke all on function public.kvc_tg_send(text) from public, anon, authenticated;
revoke all on function public.kvc_alerts()      from public, anon, authenticated;
-- 만료 정리도 같은 이유로 막아 둡니다 (Vercel 은 service_role 로 부르므로 영향 없음)
revoke all on function public.sweep_expired()   from public, anon, authenticated;


-- ── 5. 예약 (같은 이름이면 바꿔 끼웁니다) ─────────────────────────
-- 만료 정리: 1분마다 (db/08 의 sweep_expired 그대로. 함수 안에 "1분에 한 번만" 장치가 있어
--            가끔 한 번 건너뛸 수 있습니다 — 그래도 2분 안에는 정리됩니다)
select cron.schedule('kvc-sweep',  '* * * * *',   $$select public.sweep_expired()$$);
-- 텔레그램 알림: 5분마다
select cron.schedule('kvc-alerts', '*/5 * * * *', $$select public.kvc_alerts()$$);


-- ── 확인 ──────────────────────────────────────────────────────
-- ① 예약 두 줄 (kvc-sweep · kvc-alerts) 이 active = true 로 나오면 성공
select jobname, schedule, active from cron.job where jobname in ('kvc-sweep', 'kvc-alerts') order by jobname;
-- ② 금고에 열쇠 두 개가 있는지 (값은 안 보여 주고 이름만)
select name from vault.secrets where name in ('kvc_tg_token', 'kvc_tg_chat') order by name;
-- ③ 시험 알림 한 번 — true 가 나오고 몇 초 안에 텔레그램에 오면 끝입니다 (false = 금고에 열쇠 없음)
select public.kvc_tg_send('✅ 한국 가상컴 알림 연결 시험입니다') as "시험 알림 보냄";
-- ④ (몇 분 뒤) 예약이 실제로 돌았는지 — status 가 succeeded 면 정상
-- select j.jobname, d.status, d.start_time, d.return_message
--   from cron.job_run_details d join cron.job j on j.jobid = d.jobid
--  where j.jobname in ('kvc-sweep', 'kvc-alerts') order by d.start_time desc limit 10;
