-- ═══════════════════════════════════════════════════════════════
--  1단계 — 지금 대장이 어떤 상태인지 봅니다   (2026-08-18)
--
--  Supabase → SQL Editor → 통째로 붙여넣고 [Run]
--
--  ★ 이 파일은 읽기만 합니다. 아무것도 바꾸지 않습니다.
--    돌린 결과표를 그대로 캡처해서 주시면, 무엇을 어떻게 고칠지
--    정확히 정해서 알려 드리겠습니다.
--
--  ★ 무엇을 보나
--    ① 품번 앞글자와 서버실이 어긋난 줄
--       Y-001 인데 서버실이 K 라면, 그 줄이 다른 PC 에게 덮어써진 줄입니다.
--       바로 이게 영태리 PC 가 사라진 사고의 흔적입니다.
--    ② 영태리(Y) 로 잡혀 있는 PC 전부
--    ③ 서버실별로 몇 대가 있고, 그중 몇 대가 지금 신호를 보내는지
-- ═══════════════════════════════════════════════════════════════

select "구분", "품번", "서버실", "자리", "애니데스크", "IP", "마지막 신호"
from (

  -- ① 사고 흔적 : 품번 앞글자 ≠ 서버실
  select 1 as ord,
         '① 어긋남(사고 흔적)'                       as "구분",
         pn                                          as "품번",
         room::text                                  as "서버실",
         coalesce(rack::text,'?')||'-'||coalesce(fl::text,'?')||'-'||coalesce(slot::text,'?') as "자리",
         coalesce(anydesk,'—')                       as "애니데스크",
         coalesce(ip,'—')                            as "IP",
         coalesce(to_char(last_beat,'MM-DD HH24:MI'),'신호 없음') as "마지막 신호"
    from pcs
   where room is distinct from substr(pn, 1, 1)

  union all

  -- ② 영태리(Y) 전체
  select 2,
         '② 영태리(Y)',
         pn,
         room::text,
         coalesce(rack::text,'?')||'-'||coalesce(fl::text,'?')||'-'||coalesce(slot::text,'?'),
         coalesce(anydesk,'—'),
         coalesce(ip,'—'),
         coalesce(to_char(last_beat,'MM-DD HH24:MI'),'신호 없음')
    from pcs
   where pn like 'Y-%' or room = 'Y'

  union all

  -- ③ 서버실별 대수
  select 3,
         '③ 서버실별 대수',
         room::text || ' 서버실',
         count(*)::text || ' 대',
         (count(*) filter (where last_beat > now() - interval '10 minutes'))::text || ' 대 신호중',
         '—', '—', '—'
    from pcs
   group by room

  union all

  -- ④ 이미 미등록으로 잡혀 있는 것 (있다면)
  select 4,
         '④ 미등록 PC',
         coalesce(hw_id,'—'),
         coalesce(room::text,'—'),
         '—',
         coalesce(anydesk,'—'),
         coalesce(ip,'—'),
         coalesce(to_char(last_beat,'MM-DD HH24:MI'),'—')
    from pcs_unregistered

) t
order by ord, "품번";
