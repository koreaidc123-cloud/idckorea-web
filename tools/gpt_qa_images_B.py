import subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
CODEX = r"C:\Users\honghong\AppData\Roaming\npm\codex.cmd"
OUT = Path(r"C:\Users\honghong\Desktop\한국가상컴_사이트\_보고서\qa_B")
REF = OUT / "qa1.png"
BASE = ("첨부 이미지와 완전히 같은 디자인 시스템으로 만든다: 같은 밝은 회백색 바탕, 같은 크기·위치의 반투명 유리 카드, 같은 굵기의 파랑 선 아이콘, "
        "같은 위치·크기·굵기의 남색 한글 제목 한 줄. 바뀌는 것은 아이콘과 제목 글자뿐. 정사각형 1:1. "
        "제목은 지정 문구만 정확히, 오탈자·영어·숫자·추가 글자 금지. 사람·로고 금지. "
        "image_gen 도구로 생성해 지정 경로에 PNG 로 저장하고 경로만 답한다.")
JOBS = [
 ("qa2.png","제목 '가상컴 접속방법'. 아이콘: 노트북과 연결 고리(링크) 선 아이콘."),
 ("qa3.png","제목 '멀티가상컴 활용방법'. 아이콘: 겹쳐진 창 네 개 선 아이콘."),
 ("qa4.png","제목 '원격접속 사용방법'. 아이콘: 모니터와 커서 화살표, 신호 곡선 선 아이콘."),
 ("qa5.png","제목 '이벤트 프로모션'. 아이콘: 리본 달린 선물 상자 선 아이콘."),
 ("qa6.png","제목 '요금제 이용안내'. 아이콘: 계산기 선 아이콘."),
 ("qa7.png","제목 '대량구매 할인안내'. 아이콘: 쌓인 상자 세 개와 작은 퍼센트 기호 대신 태그 모양 선 아이콘(글자 없음)."),
 ("qa8.png","제목 '불편사항 발생 시'. 아이콘: 렌치와 말풍선 선 아이콘."),
]
def run(n,p):
    if (OUT/n).exists(): return n
    for _ in range(2):
        try: subprocess.run([CODEX,"exec","--skip-git-repo-check","-s","workspace-write","-C",str(OUT),"-i",str(REF),"-"],input=f"{p}\n{BASE}\n저장 경로: {n}",text=True,encoding="utf-8",capture_output=True,timeout=600)
        except subprocess.TimeoutExpired: pass
        if (OUT/n).exists(): return "ok "+n
    return "fail "+n
with ThreadPoolExecutor(3) as ex:
    for r in ex.map(lambda j: run(*j), JOBS): print(r)
