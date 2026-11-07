"""Q&A 썸네일 8장을 ChatGPT(codex exec, 구독 계정 — 추가 과금 없음)로 만든다.
홈페이지 색(짙은 남색·파랑·빨강)에 맞춘 카드 디자인. 제목 글자는 크게 넣는다(대표 지시 2026-11-08).
결과: _보고서/qa_new/qa1.png ~ qa8.png. 확인 뒤 img/qa*.jpg 로 바꾼다.
실행: py tools/gpt_qa_images.py   (이미 있는 파일은 건너뜀)"""
import subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
CODEX = r"C:\Users\honghong\AppData\Roaming\npm\codex.cmd"
OUT = Path(__file__).resolve().parent.parent / "_보고서" / "qa_new"
RULE = ("정사각형 1:1 썸네일 카드 디자인. 지정한 한글 제목 두 줄을 크고 굵게, 아주 잘 보이게 넣는다. "
        "글자는 지정한 문구만 정확히, 오탈자·추가 글자·영어·숫자 금지. 첫 줄은 흰색, 둘째 줄은 강조색 배경 띠 위 흰 글씨. "
        "디자인 느낌: 깔끔하고 고급스러운 IT 서비스 카드뉴스. 짙은 남색(#0E1630) 바탕에 파랑(#0B2FE8)과 빨강(#E2233C) 포인트, "
        "주제를 보여주는 사물 하나를 매끈한 3D 아이콘처럼 크게. 사람·캐릭터·얼굴·로고·워터마크 금지. 네온·형광·보라 금지. "
        "image_gen 도구로 생성해 지정 경로에 PNG 로 저장하고 경로만 답한다.")
JOBS = [
    ("qa1.png", "제목 첫 줄 '가상컴' / 둘째 줄 '활용방법'(파랑 띠). 사물: 모니터 세 대에 게임·그래프·문서 화면."),
    ("qa2.png", "제목 첫 줄 '가상컴' / 둘째 줄 '접속방법'(파랑 띠). 사물: 노트북 화면에 연결 아이콘과 원격 PC 화면."),
    ("qa3.png", "제목 첫 줄 '멀티가상컴' / 둘째 줄 '활용방법'(파랑 띠). 사물: 여러 대의 모니터가 겹쳐 펼쳐진 모습."),
    ("qa4.png", "제목 첫 줄 '원격접속' / 둘째 줄 '사용방법'(빨강 띠). 사물: 키보드·마우스와 화면 속 원격 데스크톱."),
    ("qa5.png", "제목 첫 줄 '이벤트' / 둘째 줄 '프로모션'(빨강 띠). 사물: 리본 달린 선물 상자와 반짝이는 쿠폰."),
    ("qa6.png", "제목 첫 줄 '요금제' / 둘째 줄 '이용안내'(파랑 띠). 사물: 계산기와 동전 더미, 요금표 카드(글자 없음)."),
    ("qa7.png", "제목 첫 줄 '대량구매' / 둘째 줄 '할인안내'(파랑 띠). 사물: 나란히 쌓인 소형 PC 여러 대와 할인 태그(글자 없음)."),
    ("qa8.png", "제목 첫 줄 '불편사항' / 둘째 줄 '발생 시'(빨강 띠). 사물: 응급 구급상자와 렌치 공구."),
]


def run(name, prompt):
    if (OUT / name).exists():
        return f"있음 {name}"
    cmd = [CODEX, "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", str(OUT), "-"]
    for _ in range(2):
        try:
            subprocess.run(cmd, input=f"{prompt}\n{RULE}\n저장 경로: {name}", text=True,
                           encoding="utf-8", capture_output=True, timeout=600)
        except subprocess.TimeoutExpired:
            pass
        if (OUT / name).exists():
            return f"완료 {name}"
    return f"실패 {name}"


OUT.mkdir(parents=True, exist_ok=True)
with ThreadPoolExecutor(3) as ex:
    for r in ex.map(lambda j: run(*j), JOBS):
        print(r)
print("끝")
