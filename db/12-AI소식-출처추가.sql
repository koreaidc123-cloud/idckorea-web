-- ═══════════════════════════════════════════════════════════════
--  AI 소식 출처 21곳 추가   (2026-11-09)
--
--  ★ db/11-AI허브.sql 을 11-09 이전에 이미 돌리셨을 때만 실행합니다.
--    (11-09 이후의 db/11 에는 이 출처가 이미 들어 있습니다. 다시 돌려도 겹치지 않습니다)
--  · 국내 IT 언론(지디넷·전자신문·블로터 등)은 topic 이 news_ko_f 라서 AI 기사만 골라 담습니다.
--  · 공식 발표(OpenAI·구글·딥마인드·엔비디아·허깅페이스·깃허브), 해외 AI 매체, 신규 AI 도구(Product Hunt), 개발자 커뮤니티(긱뉴스)
--  · 2026-11-09 에 주소마다 한 번씩 받아 RSS 가 오는 것을 확인했습니다.
--  필요 없는 곳은 관리자 화면 [AI 허브 관리 → 출처] 에서 끄시면 됩니다.
-- ═══════════════════════════════════════════════════════════════
insert into hub_sources (kind, name, url_or_channel_id, topic) values
  ('rss', 'AI포스트', 'https://www.aipostkorea.com/rss/allArticle.xml', 'news_ko'),
  ('rss', '구글 뉴스 · 생성형 AI', 'https://news.google.com/rss/search?q=%EC%83%9D%EC%84%B1%ED%98%95%20AI&hl=ko&gl=KR&ceid=KR:ko', 'news_ko'),
  ('rss', '구글 뉴스 · AI 에이전트', 'https://news.google.com/rss/search?q=AI%20%EC%97%90%EC%9D%B4%EC%A0%84%ED%8A%B8&hl=ko&gl=KR&ceid=KR:ko', 'news_ko'),
  ('rss', '지디넷코리아', 'https://feeds.feedburner.com/zdkorea', 'news_ko_f'),
  ('rss', '전자신문', 'https://rss.etnews.com/Section902.xml', 'news_ko_f'),
  ('rss', '블로터', 'https://www.bloter.net/rss/allArticle.xml', 'news_ko_f'),
  ('rss', '디지털투데이', 'https://www.digitaltoday.co.kr/rss/allArticle.xml', 'news_ko_f'),
  ('rss', '테크M', 'https://www.techm.kr/rss/allArticle.xml', 'news_ko_f'),
  ('rss', 'IT조선', 'https://it.chosun.com/rss/allArticle.xml', 'news_ko_f'),
  ('rss', '바이라인네트워크', 'https://byline.network/feed/', 'news_ko_f'),
  ('rss', 'Wired · AI', 'https://www.wired.com/feed/tag/ai/latest/rss', 'news_en'),
  ('rss', 'MIT Technology Review · AI', 'https://www.technologyreview.com/topic/artificial-intelligence/feed', 'news_en'),
  ('rss', 'Ars Technica · AI', 'https://arstechnica.com/ai/feed/', 'news_en'),
  ('rss', 'OpenAI 뉴스', 'https://openai.com/news/rss.xml', 'official'),
  ('rss', 'Google AI 블로그', 'https://blog.google/technology/ai/rss/', 'official'),
  ('rss', 'Google DeepMind', 'https://deepmind.google/blog/rss.xml', 'official'),
  ('rss', 'NVIDIA 블로그', 'https://blogs.nvidia.com/feed/', 'official'),
  ('rss', 'Hugging Face 블로그', 'https://huggingface.co/blog/feed.xml', 'official'),
  ('rss', 'GitHub 블로그 · AI', 'https://github.blog/ai-and-ml/feed/', 'official'),
  ('rss', 'Product Hunt · AI', 'https://www.producthunt.com/feed?category=artificial-intelligence', 'tools'),
  ('rss', '긱뉴스', 'https://news.hada.io/rss/news', 'dev_f')
on conflict (url_or_channel_id) do nothing;

select count(*) as "출처 개수" from hub_sources;
