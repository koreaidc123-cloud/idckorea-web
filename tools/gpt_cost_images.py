"""비용 비교 구간 제품 사진 — ChatGPT(codex exec, 구독, 추가 비용 없음). 흰 배경으로 만든 뒤 배경을 지워 투명 PNG로 씁니다."""
import subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
CODEX = r"C:\Users\honghong\AppData\Roaming\npm\codex.cmd"
OUT = Path(__file__).resolve().parent.parent / "_보고서" / "cc_img"
RULE = ("고급 제품 광고 사진, 정사각형 1:1, 완전한 순백색(#FFFFFF) 단색 배경, 그림자·바닥 반사 없이 피사체만, 피사체는 가운데 크게(가로 70%). "
        "글자·숫자·로고·상표·사과 마크 절대 금지. image_gen 도구로 생성해 지정 경로에 PNG 로 저장하고 경로만 답한다.")
JOBS = [("minipc.png","피사체: 은색 알루미늄 정사각형 소형 데스크톱 컴퓨터(높이가 낮은 납작한 상자, 모서리 둥금), 앞면 아래 작은 상태등 하나, 3/4 각도."),
        ("serverpc.png","피사체: 검은 미들타워 데스크톱 PC 본체, 옆면 강화유리 안에 파란 LED 팬과 그래픽카드가 보임, 3/4 각도, 고급 촬영."),
        ("power.png","피사체: 흰 멀티탭에 꽂힌 검은 전원 플러그와 작은 디지털 전력량 측정기(화면은 빈칸), 3/4 각도.")]
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
