-- ═══════════════════════════════════════════════════════════════
--  AI 소식 출처 14곳 추가   (2026-11-09)
--
--  ★ db/11-AI허브.sql 을 11-09 이전에 이미 돌리셨을 때만 실행합니다.
--    (11-09 이후의 db/11 에는 이 출처가 이미 들어 있습니다. 다시 돌려도 겹치지 않습니다)
--  · 국내 IT 언론(지디넷·전자신문·블로터 등)은 topic 이 news_ko_f 라서 AI 기사만 골라 담습니다.
--  · 기업 공식 뉴스룸(삼성전자·SK텔레콤·SK하이닉스·구글 코리아, AI 글만), 개발자 커뮤니티(긱뉴스). 한국어 출처만.
--  · 예전 db/11 에 있던 영어 출처는 끕니다(아래 update).
--  · 2026-11-09 에 주소마다 한 번씩 받아 RSS 가 오는 것을 확인했습니다.
--  필요 없는 곳은 관리자 화면 [AI 허브 관리 → 출처] 에서 끄시면 됩니다.
-- ═══════════════════════════════════════════════════════════════
insert into hub_sources (kind, name, url_or_channel_id, topic) values
  ('rss', 'AI포스트', 'https://www.aipostkorea.com/rss/allArticle.xml', 'news_ko'),
  ('rss', 'SK텔레콤 뉴스룸', 'https://news.sktelecom.com/feed', 'official_f'),
  ('rss', 'SK하이닉스 뉴스룸', 'https://news.skhynix.co.kr/feed/', 'official_f'),
  ('rss', '구글 코리아 블로그', 'https://blog.google/intl/ko-kr/rss/', 'official_f'),
  ('rss', '긱뉴스', 'https://news.hada.io/rss/news', 'dev_f'),
  ('youtube', '테디노트 TeddyNote', 'UCt2wAAXgm87ACiQnDHQEW6Q', 'ai_tools'),
  ('youtube', '빵형의 개발도상국', 'UC2L1DgDMD5pJ-35G47Objfw', 'ai_tools'),
  ('youtube', '일잘러 장피엠', 'UCSkpTOEl_zW6b4Y7M_Prefg', 'ai_tools'),
  ('youtube', 'GPTers 커뮤니티', 'UCLL4StPwMllEZJ6bYI4Ds3w', 'ai_tools'),
  ('youtube', '엔드플랜 Endplan AI', 'UCUpkgT9Entggw2fMBprWM4w', 'ai_tools'),
  ('youtube', '코딩애플', 'UCSLrpBAzr-ROVGHQ5EmxnUg', 'dev_f'),
  ('youtube', '드림코딩', 'UC_4u-bXaba7yrRz_6x6kb_w', 'dev_f'),
  ('youtube', 'ITSub잇섭', 'UCdUcjkyZtf-1WJyPPiETF1g', 'tech_f'),
  ('youtube', '테크몽 Techmong', 'UCFX6adXoyQKxft933NB3rmA', 'tech_f')
on conflict (url_or_channel_id) do nothing;

update hub_sources set topic = 'dev_f' where url_or_channel_id = 'UCUpJs89fSBXNolQGOYKn0YQ';
update hub_sources set topic = 'office_f' where url_or_channel_id = 'UCZ6UHYBQFBe14WUgxlgmYfg';
update hub_sources set enabled = false where name in ('전자신문', '블로터', '디지털투데이', '테크M', 'IT조선', '구글 뉴스 · AI 인공지능', '구글 뉴스 · 클로드 코드', '구글 뉴스 · 생성형 AI', '구글 뉴스 · AI 에이전트', '지디넷코리아', '바이라인네트워크', '삼성전자 뉴스룸', 'The Verge · AI', 'TechCrunch · AI', 'Wired · AI', 'MIT Technology Review · AI', 'Ars Technica · AI', 'OpenAI 뉴스', 'Google AI 블로그', 'Google DeepMind', 'NVIDIA 블로그', 'Hugging Face 블로그', 'GitHub 블로그 · AI', 'Product Hunt · AI', 'Higgsfield AI', 'Anthropic', 'Google for Developers');

select count(*) filter (where enabled) as "켜진 출처", count(*) as "전체" from hub_sources;
