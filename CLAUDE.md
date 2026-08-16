# 한국 가상컴 — 작업 지침

이 파일은 **클로드코드가 이 폴더를 열 때마다 자동으로 읽습니다.**
집 PC에서 하던 작업을 회사 PC에서 그대로 이어가기 위한 인수인계서입니다.

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

api/
  _supa.js         Supabase 연결 (환경변수 없으면 자동 비활성)
  _price.js        ★ 서버가 가진 진짜 가격표
  admin-login.js   관리자 로그인 (httpOnly 쿠키)
  pcs.js           관리자용 PC 조회
  heartbeat.js     서버실 중계기 → 서버
  order-create.js  결제창 열기 전 주문·금액 확정
  toss-confirm.js  금액 대조 → 승인 → PC 자동 배정
  toss-webhook.js  가상계좌 입금 자동 감지

agent/
  kvc-agent.ps1    랙PC용 (2분마다 DB로 직접 전송)
  설치안내.md       현장 세팅하는 분이 보는 문서

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
| 관리자 PC 목록 · 랙맵 | Supabase 연결 전까지 **목업 1,136대**로 자동 폴백 |
| 주문 · 회원 | 목업 |
| 알림톡 | 미연동 (솔라피 예정) |

> **Supabase 프로젝트 하나가 모든 것의 병목입니다.** URL + service_role 키를
> Vercel 환경변수에 넣고 `db/schema.sql` 을 실행하면 관리자가 실데이터로 바뀝니다.

---

## Vercel 환경변수 (대표님이 직접 등록)

| 이름 | 용도 |
|---|---|
| `SUPABASE_URL` | Supabase 프로젝트 주소 |
| `SUPABASE_SERVICE_KEY` | `sb_secret_…` (절대 공개 금지) |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (랙PC 에 배포되는 공개키) |
| `KVC_SETUP_KEY` | 현장에서 랙PC 등록할 때 칠 암호 |
| `KVC_ADMIN_PW` | 관리자 로그인 비밀번호 |
| `KVC_ADMIN_SECRET` | 관리자 쿠키 서명용 (아무 문자열이나 길게) |
| `TOSS_SECRET_KEY` | 토스 시크릿 키 (심사 통과 후) |

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

1. Supabase 연결 → 관리자 실데이터 전환
2. `api/refund.js` 환불 처리 (7일 이내 일할 계산, 셋팅비 5,000원 차감)
3. 이용약관 · 개인정보처리방침 페이지 (사업자정보 받는 대로)
4. 솔라피 알림톡 (접속정보 발송 · 만료 D-5 안내)
5. 자동 연장 (토스 빌링키 정기결제)
