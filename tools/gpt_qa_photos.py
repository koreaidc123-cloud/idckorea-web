"""Q&A 카드 배경 사진 8장 — ChatGPT(codex exec, 구독, 추가 비용 없음).
제목·설명은 그림에 넣지 않고 사이트 글꼴(CSS)로 올린다(대표 지시 2026-11-08: '디자인 같지가 않다').
결과: _보고서/qa_photo/qa1.png ~ qa8.png → img/qa*.jpg"""
import subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
CODEX = r"C:\Users\honghong\AppData\Roaming\npm\codex.cmd"
OUT = Path(__file__).resolve().parent.parent / "_보고서" / "qa_photo"
RULE = ("가로 4:3 고급 광고 사진 같은 실사 이미지. 글자·숫자·로고·워터마크·사람 얼굴 절대 금지. "
        "공통 톤: 짙은 남색과 검정 배경의 어두운 스튜디오, 차가운 파란 조명과 아주 약한 빨강 림라이트, 얕은 심도, 고급 IT 제품 광고 느낌. "
        "피사체는 화면 오른쪽 2/3에 두고 왼쪽 아래는 어둡고 비워 둔다(나중에 글자를 올림). 네온·보라·만화풍 금지. "
        "image_gen 도구로 생성해 지정 경로에 PNG 로 저장하고 경로만 답한다.")
JOBS = [
 ("qa1.png","피사체: 책상 위 와이드 모니터 세 대에 서로 다른 작업 화면이 은은하게 켜진 모습."),
 ("qa2.png","피사체: 반쯤 열린 은색 노트북 화면에 원격 데스크톱 창이 떠 있는 모습(화면 글자는 흐릿하게)."),
 ("qa3.png","피사체: 서버랙에 나란히 꽂힌 똑같은 소형 PC 여러 대, 파란 상태등이 줄지어 켜짐."),
 ("qa4.png","피사체: 키보드 위에 놓인 손 없는 무선 마우스와 화면 속 원격 PC 바탕화면."),
 ("qa5.png","피사체: 검은 상자에 파란 리본이 묶인 선물 상자 하나, 고급 패키지 촬영."),
 ("qa6.png","피사체: 금속 계산기와 고급 만년필, 빈 영수증 용지(글자 없음)."),
 ("qa7.png","피사체: 끝없이 이어지는 서버랙 통로를 낮은 각도에서 본 모습."),
 ("qa8.png","피사체: 서버랙 앞 작업대 위에 놓인 공구 세트와 손전등(사람 없음)."),
]
def run(n,p):
    if (OUT/n).exists(): return "있음 "+n
    for _ in range(2):
        try: subprocess.run([CODEX,"exec","--skip-git-repo-check","-s","workspace-write","-C",str(OUT),"-"],input=f"{p}\n{RULE}\n저장 경로: {n}",text=True,encoding="utf-8",capture_output=True,timeout=600)
        except subprocess.TimeoutExpired: pass
        if (OUT/n).exists(): return "완료 "+n
    return "실패 "+n
OUT.mkdir(parents=True, exist_ok=True)
with ThreadPoolExecutor(3) as ex:
    for r in ex.map(lambda j: run(*j), JOBS): print(r)
