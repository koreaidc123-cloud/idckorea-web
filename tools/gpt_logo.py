import subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
CODEX = r"C:\Users\honghong\AppData\Roaming\npm\codex.cmd"
OUT = Path(r"C:\Users\honghong\Desktop\한국가상컴_사이트\_보고서\로고시안\gpt")
BASE = ("회사 로고 심볼(엠블럼)만, 글자·숫자·영문 절대 없음. 정사각형 1:1, 완전한 흰 배경, 심볼은 가운데에 크게. "
        "주제: 한국 태극(빨강 위·파랑 아래의 S자 곡선 원)과 서버 랙(가로로 쌓인 서버 칸, 작은 상태 불빛)을 하나로 합친 원형 심볼. "
        "색: 빨강 #E2233C 그라데이션, 파랑 #0B2FE8 그라데이션, 남색 #0E1630. 고급 기업 로고 수준으로 단순하면서도 질감과 입체감. "
        "작게 줄여도 알아볼 수 있게. 클립아트·만화·과한 반사·네온 금지. image_gen 도구로 생성해 지정 경로에 PNG 로 저장하고 경로만 답한다.")
JOBS = [("L1_metal.png","표현: 매끈한 금속 테두리와 유리 같은 광택의 3D 엠블럼, 서버 칸은 얇게 파인 홈."),
        ("L2_flat_gradient.png","표현: 평면 그라데이션 로고(애플·토스 스타일), 그림자 거의 없이 부드러운 색 전환과 정교한 여백."),
        ("L3_glass_tile.png","표현: 둥근 사각 남색 유리 타일 앱 아이콘 안에 빛나는 태극 서버 원, 은은한 안쪽 빛.")]
def run(n,p):
    if (OUT/n).exists(): return n
    for _ in range(2):
        try: subprocess.run([CODEX,"exec","--skip-git-repo-check","-s","workspace-write","-C",str(OUT),"-"],input=f"{p}\n{BASE}\n저장 경로: {n}",text=True,encoding="utf-8",capture_output=True,timeout=600)
        except subprocess.TimeoutExpired: pass
        if (OUT/n).exists(): return "ok "+n
    return "fail "+n
with ThreadPoolExecutor(3) as ex:
    for r in ex.map(lambda j: run(*j), JOBS): print(r)
