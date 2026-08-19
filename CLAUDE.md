# 한국 가상컴 — 작업 지침

이 파일은 **클로드코드가 이 폴더를 열 때마다 자동으로 읽습니다.**
집 PC에서 하던 작업을 회사 PC에서 그대로 이어가기 위한 인수인계서입니다.

### 다른 PC 에서 이어서 시작할 때

```powershell
cd $env:USERPROFILE\Desktop\한국가상컴_사이트
git pull
claude
```

그리고 **`CLAUDE.md 읽고 이어서 작업하자`** 라고 치시면 됩니다.
USB 로 복사해 옮길 파일은 없습니다. 코드는 전부 GitHub 로 오갑니다.
(USB 의 `kvc-config.json` 만 예외 — 등록 암호가 들어 있어 저장소에는 빈 값으로 둡니다)

---

## 이 프로젝트가 뭔가

원격PC(가상컴퓨터) 임대 회사 **한국 가상컴**의 홈페이지 + 관리자 시스템입니다.
목표는 **고객이 결제하면 자동으로 PC가 배정되고, 접속 정보를 즉시 받아 바로 쓰는 것**입니다.
경쟁사 컴뷰어스(comviewers.com)를 벤치마킹하되 능가하는 것이 방향입니다.

- 코드: 정적 HTML/CSS/JS + Vercel 서버리스 함수. **빌드 없음, npm 설치 없음.**
- 배포: GitHub `koreaidc123-cloud/idckorea-web` → Vercel 팀 `koreaidc`
- 프리뷰: https://idckorea-dusky.vercel.app
- 실서비스(아직 Sixshop): idckorea1.com

---

## 대화 상대

**정환님** — 제작 담당. 개발은 초보이십니다.

- **존댓말**로, 단계별로 쉽게 설명합니다.
- 전문용어를 쓸 때는 그게 뭔지 한 줄로 풀어서 같이 씁니다.
- **실서비스 보호가 최우선**입니다. 배포에 영향이 가는 단계는 **하기 전에 반드시 다시 여쭙습니다.**
- 이미지 제작은 힉스필드 MCP `gpt_image_2` 로 합니다. (`nano_banana_pro` 금지)

---

## 절대 어기면 안 되는 규칙

1. **서버실 실명(파주·금촌·영태리·등원리)을 고객 화면에 절대 노출하지 않습니다.**
   고객에게는 품번의 알파벳(K / Y / D)만 보입니다. 실명은 관리자 화면에서만 씁니다.
2. **"윈도우 10 Pro 정품" 문구를 쓰지 않습니다.**
3. **애니데스크 비밀번호**는 암호화 저장하고, 관리자 화면에서도 마스킹 + 열람 기록을 남깁니다.
   고객 전달용으로 복사할 때 **위치 정보는 절대 포함하지 않습니다.**
4. **토스 시크릿 키·Supabase service_role 키를 코드에 적지 않습니다.**
   대표님이 Vercel 환경변수에 직접 넣으십니다.
5. 카피는 **기존 홈페이지 워딩 그대로** 씁니다. 창작하지 않습니다. 디자인만 업그레이드합니다.

---

## 디자인 규칙

- 화이트 베이스 + 태극 레드(`#E8412E`) · 블루(`#1B4FD8`). 홍이 왼쪽 위, 청이 오른쪽 아래.
- **전부 한글.** 초대형 영문 타이포 금지.
- **실사 이미지 필수.** IDC센터·서버실 느낌. 일반 사무실 사진 금지.
- CTA 버튼은 전부 빨간색. 파랑은 브랜드·선택 상태에만.

---

## 배포 전에 반드시 하는 일

```powershell
# 1. 모든 인라인 스크립트 문법 검사 (이걸 건너뛰어서 live.html 이 백지가 된 적 있음)
$d=(Get-Location).Path
foreach($f in (Get-ChildItem $d -Filter *.html)){
  $t=[IO.File]::ReadAllText($f.FullName,[Text.Encoding]::UTF8); $i=0
  foreach($m in [regex]::Matches($t,'(?s)<script(?![^>]*\ssrc=)[^>]*>(.*?)</script>')){
    $i++; $p="$env:TEMP\chk_$($f.Name)_$i.js"
    [IO.File]::WriteAllText($p,$m.Groups[1].Value,(New-Object Text.UTF8Encoding($false)))
    node --check $p; if(-not $?){ "!! $($f.Name) #$i 문법 오류" }
  }
}
# 2. api 폴더도 검사
Get-ChildItem .\api -Filter *.js | ForEach-Object { node --check $_.FullName }
```

**푸시 = Vercel 자동배포입니다.** 반드시 정환님 승인을 먼저 받습니다.

---

## 과거에 크게 헤맸던 것 (같은 실수 반복 금지)

| 증상 | 진짜 원인 |
|---|---|
| 스크롤 중 화면 전체가 검게 변함 | 카운트업 끝에 `transform:scale(1.08)` 이 **어두운 오버레이를 가진 섹션 안에서** GPU 합성 레이어를 만들어 오버레이가 화면을 덮음. → `color` 애니메이션으로 교체 + `isolation:isolate` |
| 화면이 잘림 | `contain:paint` 가 페인팅을 박스 안으로 **잘라냄**. → 제거 |
| 섹션이 접힘 | `content-visibility:auto` 가 카운트업 중인 섹션의 렌더링을 건너뜀. → 전면 제거 |
| live.html 백지 | 코드 삭제 후 `+ ;` 연산자 잔재. → 배포 전 `node --check` 필수화 |
| Vercel 검증 오탐 | 프리뷰 URL이 Deployment Protection 로그인 페이지를 200으로 반환. → 공개 alias 로만, **내용 문자열까지** 검사 |

> **어두운 오버레이가 있는 섹션 안에서는 `transform` 애니메이션을 쓰지 않습니다.**
> `contain` · `content-visibility` 도 이 프로젝트에서는 쓰지 않습니다.

### ★★ Vercel 무료 요금제 — 서버 함수 12개 한도

`api/` 안에서 **밑줄로 시작하지 않는 .js 파일 개수가 12를 넘으면 배포가 통째로 실패합니다.**
하나만 넘쳐도 전부 안 올라가고, 사이트는 예전 버전을 계속 서빙합니다.
"올렸는데 반영이 안 된다" 싶으면 **가장 먼저 이걸 의심하세요.**

```powershell
ls api\*.js | Where-Object { $_.Name -notlike "_*" } | Measure-Object   # 12 이하여야 함
vercel ls --yes                                                        # Status 가 Error 인지
```

기능을 더 붙일 때는 새 파일을 만들지 말고 **`api/admin.js` 의 `do` 목록에 추가**하고
실제 코드는 `_admin-이름.js` 로 두세요. 밑줄 파일은 함수로 세지 않습니다.

### 현장 등록 프로그램에서 겪은 것들

| 증상 | 원인 |
|---|---|
| bat 실행하면 깨진 글자와 오류가 쏟아짐 | .bat 에 한글이 있으면 cmd 가 CP949 로 읽어 깨짐. **PC등록.bat 은 순수 ASCII 로만** |
| 작업 XML 범위 초과 오류 | `New-ScheduledTaskTrigger -RepetitionDuration ([TimeSpan]::MaxValue)` 가 일부 윈도우10에서 거부됨. `schtasks /SC MINUTE /MO 2` 로 |
| 서버실 버튼 색은 바뀌는데 선택이 안 됨 | 이벤트에 `.GetNewClosure()` 를 붙이면 별도 영역이 생겨 `$script:` 값이 밖으로 안 나감 |
| 쓰고 있는데 사용중=아니오 | 예약 작업은 SYSTEM(세션 0)으로 돌아 `GetLastInputInfo` 가 사용자 입력을 못 봄. `quser` 로 판단 |
| **엉뚱한 서버실·랙에 등록됨** | 서버가 랙 구조를 몰라 `rack 1~999` 면 다 통과시켰음. → `api/_rooms.js` 를 만들어 서버도 같은 구조를 보게 함 (2026-08-17) |

> **랙을 늘리시면 `api/_rooms.js` 의 `racks` 와 `admin.html` 의 `ROOMS` 를 같이 고치셔야 합니다.**
> 한 곳만 고치면 화면에는 보이는데 저장이 거부됩니다.

---

## 지금 구조

```
index.html      메인
live.html       실시간 PC임대 (컴뷰어스형 필터·페이지네이션)
product.html    상품 상세 + 토스 결제
about.html      회사소개
qa.html         Q&A안내
login.html      로그인·회원가입 (카카오·구글 실제 SDK)
mypage.html     내 가상컴
admin.html      관리자 10화면
success/fail    결제 결과
auth-config.js  ★ 카카오·구글 앱 키를 넣는 곳 (지금 비어 있음)

api/                      ★ 라우트는 12개까지만! (아래 주의사항 참고)
  _supa.js         Supabase 연결 (환경변수 없으면 자동 비활성)
  _price.js        ★ 서버가 가진 진짜 가격표
  _spec.js         CPU 이름 → 판매 상품 번호 알아맞히기
  _crypto.js       애니데스크 비밀번호 잠금 + 쿠키 서명
  _admin-*.js      관리자 기능들 (밑줄로 시작 = 라우트로 안 셈)
  admin.js         ★ 관리자 창구 하나 — do 값으로 위 파일에 넘김
  admin-login.js   관리자 로그인 (httpOnly 쿠키 + 자동대입 잠금)
  customer.js      고객 로그인·내 가상컴 (카카오·구글을 서버가 직접 검증)
  auth-config.js   카카오·구글 공개키를 환경변수에서 내려줌
  live-pcs.js      고객용 공개 PC 목록 (민감정보 미포함)
  health.js        연결 진단
  pc-register.js   현장 PC 등록 + 토큰 발급
  order-create.js  결제창 열기 전 주문·금액 확정
  toss-confirm.js  금액 대조 → 승인 → PC 자동 배정
  toss-webhook.js  가상계좌 입금 자동 감지

agent/
  PC등록.bat        ★ 현장에서 두 번 눌러 실행 (USB에 담아 나감)
  kvc-setup.ps1     큰 글씨 등록 화면 (WinForms)
  kvc-agent.ps1     랙PC용 하트비트 (2분마다 DB로 직접 전송)
  kvc-config.json   서버주소·등록암호 (대표님이 채워 USB에 넣음)
  현장-작업순서.md   세팅하시는 분께 인쇄해 드리는 3단계 안내
  설치안내.md       대표님용 (USB 준비 + 기술 설명)

db/schema.sql       Supabase 에 붙여넣고 실행할 설계
db/02-heartbeat.sql 하트비트 직접 전송용 (토큰 칼럼 + beat 함수)
결제-정산-준비.md    통신판매업 신고부터 정산까지
```

### 하트비트가 흐르는 길

```
랙PC(kvc-agent) ──2분마다 직접──▶ Supabase rpc/beat ──▶ /api/pcs ──▶ 관리자 랙맵
                                                          30초마다 화면 갱신
```

**중계기는 없습니다 (2026-08-16 결정).** 처음엔 서버실마다 중계기 PC 를 두는 설계였으나,
정환님이 "PC 를 계속 켜둘 수 없다"고 지적하셔서 없앴습니다. 제가 중계기를 넣은 이유
중 하나("랙PC 를 인터넷에 열어야 해서 위험")는 **틀린 판단**이었습니다 —
랙PC 는 애니데스크 때문에 이미 인터넷에 나가 있습니다.

- 2분 간격 × 1,200대 = 월 약 2.6GB → Supabase 무료 한도(5GB) 안
- Vercel 함수는 **PC 등록할 때 딱 한 번**만 씁니다 (`/api/pc-register`)
- 보안: PC 마다 전용 토큰. `beat` 함수(security definer)로 **자기 한 줄만** 갱신 가능.
  표 자체는 RLS 로 잠겨 있어 공개키로는 아무것도 못 읽습니다.

### 가격을 바꿀 때 반드시 같이 고칠 3곳

1. `api/_price.js` — 서버가 승인 때 대조하는 진짜 가격
2. `product.html` 의 `BASE` · `TM` — 화면에 보이는 가격
3. `product.html` 의 구조화 데이터(`ld+json`) 안 `price`

**하나라도 어긋나면 결제가 "금액이 다릅니다" 로 거절됩니다.**

---

## 아직 목업인 것 / 진짜인 것

| 부분 | 상태 |
|---|---|
| 화면 · 디자인 · 문구 | **진짜** |
| 카카오·구글 로그인 | **코드는 진짜**, `auth-config.js` 에 키만 넣으면 동작 |
| 토스 결제 | **코드는 진짜**, 테스트 키 상태 (실결제 불가) |
| 관리자 PC 목록 · 랙맵 | **진짜** (등록된 PC 가 없으면 목업으로 폴백) |
| 관리자 주문 · 회원 | **진짜** (`/api/admin?do=orders`) |
| 고객 실시간 PC임대 | **진짜** (`/api/live-pcs`, 20초마다 갱신) |
| 내 가상컴 | **진짜** (서버가 카카오·구글을 직접 검증) |
| 연장 · 해지환불 · PC이전 · 세금계산서 | **진짜** (`/api/admin?do=order-action`) |
| 수동 주문 등록 (스마트스토어·전화) | **진짜** (`/api/admin?do=order-manual`) |
| 잘못 등록한 PC 빼기 | **진짜** (`/api/admin?do=pc-delete`) · 임대중이거나 지난 주문이 있으면 거부 |
| 랙 위치 검증 | **진짜** (`api/_rooms.js`) · 현장 등록과 관리자 수정 양쪽에 걸림 |
| 알림톡 · 문자 | 미연동 (**알리고** LMS + 알림톡 예정) |
| 원격 재부팅 | **코드는 완성** · Supabase `06-B` 실행 + 랙PC 프로그램 갱신을 해야 실제로 돕니다 (맨 위 0순위 참고) |
| 랙PC 프로그램 자동 갱신 | **진짜** — 하루 한 번 스스로 최신 확인 (2026-08-19 추가) |
| 한 PC 를 두 주문이 가져가는 것 | **막힘** — 수동배정·카드결제·가상계좌·PC이전·연장 다섯 곳 전부 (2026-08-19) |
| 이력 조회 (이전 사용자) | 미개발 — 데이터는 쌓이는데 화면이 진행중 주문만 불러옵니다 |
| 만료 자동 처리 | 미개발 — 만료돼도 계속 `임대중` 으로 남습니다 |
| 관리자 메뉴 재편 | 계획 완료 (`관리자-기획.md`) · 아직 적용 안 함 |

> Supabase 는 2026-08-16 연결 완료. `/api/health` 로 상태를 확인합니다.

---

## Vercel 환경변수 (대표님이 직접 등록)

| 이름 | 용도 |
|---|---|
| `SUPABASE_URL` | Supabase 프로젝트 주소 |
| `SUPABASE_SERVICE_KEY` | `sb_secret_…` (절대 공개 금지) |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (랙PC 에 배포되는 공개키) |
| `KVC_SETUP_KEY` | 현장 USB 의 kvc-config.json 에 넣는 등록 암호 |
| `KVC_ADMIN_PW` | 관리자 로그인 비밀번호 |
| `KVC_SECRET` | 관리자 쿠키 서명 + 애니데스크 비밀번호 암호화 (하나로 둘 다) |
| `KAKAO_JS_KEY` | 카카오 JavaScript 키 (넣으면 로그인이 바로 켜집니다) |
| `GOOGLE_CLIENT_ID` | 구글 OAuth 클라이언트 ID |
| `TOSS_SECRET_KEY` | 토스 시크릿 키 (심사 통과 후) |

> 카카오·구글 키는 **코드에 넣지 않습니다.** `/api/auth-config` 가 환경변수에서
> 읽어 내려주므로, 대표님이 Vercel 에 넣으시면 배포 없이 바로 켜집니다.
> `KVC_ADMIN_SECRET` 이라는 옛 이름으로 넣으셨어도 그대로 동작합니다.

> Supabase 키는 2026년부터 형식이 바뀌었습니다 (`service_role` JWT → `sb_secret_`).
> 새 키는 JWT 가 아니라서 `Authorization: Bearer` 로 보내면 실패합니다.
> `api/_supa.js` 가 키 앞글자로 판별해 알아서 나눠 보냅니다.

**설정이 제대로 됐는지는 `/api/health` 를 브라우저로 열어 확인합니다.**
환경변수·표·하트비트 창구가 각각 되는지 한글로 알려줍니다.

---

## 실도메인(idckorea1.com)을 붙일 때 바꿀 곳

`idckorea-dusky.vercel.app` 을 전부 찾아 바꿉니다.

- `robots.txt` 의 Sitemap 주소
- `sitemap.xml` 의 모든 `<loc>`
- 각 페이지 `<link rel="canonical">` · `og:url` · `og:image`
- `index.html` · `product.html` 의 구조화 데이터 안 URL
- 카카오 개발자센터 Redirect URI · 구글 승인된 JavaScript 원본
- 토스 웹훅 URL

---

## 다음에 할 일

### ★★★ 0순위 — 랙PC 프로그램 갱신 (2026-08-19 현장 확인)

**지금 랙에 설치된 14대는 전부 2026-08-16 자 옛날 프로그램입니다.**
원격 재부팅 기능이 그 안에 없어서, 관리자에서 눌러도 영영 반응하지 않습니다.

원인이 두 겹이었습니다.

1. **Supabase 의 beat 함수가 옛날 것** — 이건 GitHub 에 push 해도 안 바뀝니다.
   Supabase SQL Editor 에서 `db/06-B-사라진PC-잡기.sql` 을 직접 실행해야 합니다.
   (`db/03-command.sql` 은 옛 beat 가 들어 있어 실행 금지)
2. **랙PC 안의 프로그램이 옛날 것** — 명령을 받아 실행하는 코드가 아예 없습니다.
   예전 버전은 서버가 뭘 답하든 로그만 남기고 끝냅니다. 원격으로 닿을 길이 없습니다.

**해야 할 일**
  · Supabase 에서 06-B 실행 (아직 안 하셨으면)
  · 14대 각각에서 프로그램갱신.bat 실행 — 또는 그 PC 의 PowerShell(관리자)에서 두 줄
  · 갱신 필요 여부 확인 — Select-String -Path C:KVCkvc-agent.ps1 -Pattern "CMD:" -Quiet
    False 면 갱신 필요 · True 면 이미 최신

**앞으로 이 일은 다시 없습니다.**
kvc-agent.ps1 에 자동 갱신을 넣었습니다. 하루 한 번 사이트의 최신본과 비교해
다르면 스스로 바꿉니다. 잘못된 파일로 랙PC 전체가 죽지 않도록 길이·표식·문법
세 가지를 확인하고, 하나라도 어긋나면 바꾸지 않습니다.
바꾸기 전 파일은 C:KVCkvc-agent.bak 로 남습니다.

**USB 는 바탕화면 ★PC등록_USB_최신 폴더가 정본입니다.**
PC등록 · PC등록_새버전 두 폴더는 8/16 자라 쓰면 안 됩니다.
(저장소 agent/ 와 같되 kvc-config.json 에 등록 암호가 채워져 있습니다)

---

**★ 그다음 진행 순서와 이유는 `관리자-기획.md` 에 자세히 적어 두었습니다.**

| 순서 | 할 일 | 상태 |
|---|---|---|
| 1 | 토스 가맹 심사 (회원가입만 되어 있음) | **대표님 몫 · 최우선** |
| 2 | 원격 재부팅 — 하트비트 응답에 명령을 실어 보냄 | 미착수 |
| 3 | 대시보드를 "오늘 할 일" 로 전환 (이상 PC만 모아 보기) | 미착수 |
| 4 | 이력 조회 — 지난 주문·이전 사용자 (데이터는 이미 쌓이는데 화면이 진행중 주문만 불러옴) | 미착수 |
| 5 | 회원·주문 달력 검색 · 입금자≠사용자 통합 검색 | 미착수 |
| 6 | 알리고 LMS · 알림톡 (만료 D-5 선별 발송 · 접속정보 발송) | 미착수 |
| 7 | 만료 자동 처리 (지금은 만료돼도 계속 임대중으로 남음) | 미착수 |
| 8 | 이용약관 · 개인정보처리방침 (사업자정보 받는 대로) | 미착수 |
| 9 | 자동 연장 (토스 빌링키 정기결제) | 미착수 |

### 2026-08-17 영태리 현장에서 확인한 것

- 랙PC 3대 등록 성공 (`Y-001` 1700 · `Y-002` 3700X · `Y-003` 5600G).
  상품번호 자동매칭·하트비트·고객 화면 노출까지 전부 정상. PC 를 꺼 보니 신호없음도 정상 판정.
- **작업실에서 포맷 → 랙에 꽂으면 IP 가 바뀌지만 문제 없습니다.** 하트비트가 2분마다
  현재 IP 를 다시 올려 덮어씁니다. 기준은 메인보드 일련번호(`hw_id`)라 IP 가 바뀌어도 같은 PC 로 봅니다.
- 사양 정정: **라이젠 1700 = SSD 240GB**, 3700X = 480GB. (`live.html` · `admin.html` · `index.html` · `qa.html` 네 곳)
- 실제 디스크는 232GB 처럼 딱 안 떨어져서, 표시·필터에서 표준 용량으로 맞춰 줍니다.
- 셋팅비는 **표시가격에 포함**입니다. 결제 때 따로 더하지 않고, 환불 때만 5,000원을 뺍니다.
  환불은 **7일 이내에만**, 잔여일 기준입니다.
