"""AI 소식 분야 타일 그림 — ChatGPT(codex exec, 구독, 추가 비용 없음). 기사 사진 대신 쓰는 우리 그림 (2026-11-10).
글자·로고·상표 없는 3D 오브제 일러스트, 짙은 남색 배경. 결과: _보고서/hub_cat_img/*.png → 다듬어 img/hc-*.webp"""
import subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
CODEX = r"C:\Users\honghong\AppData\Roaming\npm\codex.cmd"
OUT = Path(__file__).resolve().parent.parent / "_보고서" / "hub_cat_img"
RULE = ("고급 테크 브랜드 일러스트, 가로 4:3, 배경은 짙은 남색(#0B1736)에서 파랑(#1E3FA8)으로 은은한 그라데이션, "
        "가운데에 매끈한 3D 유리·금속 질감 오브제 하나(오른쪽 아래 약간 치우침), 부드러운 파란 림라이트, 미니멀, 여백 넉넉. "
        "글자·숫자·로고·상표·실존 회사 마크·사람 얼굴 절대 금지. image_gen 도구로 생성해 지정 경로에 PNG 로 저장하고 경로만 답한다.")
JOBS_BIZ = [
        ("biz-shop.png", "오브제: 유리 쇼핑백과 작은 상품 상자들, 반투명 장바구니 아이콘 모양 빛"),
        ("biz-mkt.png", "오브제: 유리 확성기와 위로 오르는 막대그래프, 하트·말풍선 모양 빛 입자"),
        ("biz-design.png", "오브제: 유리 팔레트와 붓, 겹쳐진 사진 프레임과 필름 조각"),
        ("biz-dev.png", "오브제: 겹쳐진 유리 터미널 창 두 개와 꺾쇠 괄호 기호, 작은 서버 랙"),
        ("biz-office.png", "오브제: 유리 계산기와 표 문서, 서류철과 빛나는 체크 표시"),
        ("biz-edu.png", "오브제: 유리 졸업모와 펼쳐진 책, 작은 마이크와 재생 버튼")]
JOBS = [("llm.png", "오브제: 반투명 유리로 된 말풍선 두 개가 겹쳐 있고 안쪽에 작은 빛나는 점 세 개"),
        ("img.png", "오브제: 유리 액자 프레임 안에 무지갯빛 붓 자국과 작은 산·해 모양, 옆에 떠 있는 붓"),
        ("vid.png", "오브제: 금속 필름 클래퍼보드와 반투명 재생 버튼 삼각형, 필름 띠가 살짝 휘어 있음"),
        ("dev.png", "오브제: 유리 블록에 새겨진 꺾쇠 괄호 기호 < / > 모양(글자 아님, 기호 형태), 옆에 작은 노트북"),
        ("auto.png", "오브제: 서로 맞물린 금속 톱니바퀴 세 개와 빛나는 연결선, 작은 로봇 팔"),
        ("audio.png", "오브제: 반투명 유리 음파 막대 그래프와 작은 금속 마이크, 음표 모양 빛"),
        ("work.png", "오브제: 유리 돋보기와 겹쳐진 문서 카드 세 장, 위에 빛나는 체크 표시"),
        ("ko.png", "오브제: 반투명 유리 구 안에 빛나는 회로 무늬, 아래에 태극 문양을 연상시키는 빨강·파랑 곡선 받침(국기 아님)"),
        ("news.png", "오브제: 접힌 금속 신문 모양 카드와 위로 퍼지는 신호 파동, 작은 종 모양 알림")]
def run(n, p):
    if (OUT / n).exists(): return "있음 " + n
    for _ in range(2):
        try:
            subprocess.run([CODEX, "exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", str(OUT), "-"],
                           input=f"{p}\n{RULE}\n저장 경로: {n}", text=True, encoding="utf-8", capture_output=True, timeout=600)
        except subprocess.TimeoutExpired: pass
        if (OUT / n).exists(): return "완료 " + n
    return "실패 " + n
OUT.mkdir(parents=True, exist_ok=True)
with ThreadPoolExecutor(3) as ex:
    for r in ex.map(lambda j: run(*j), JOBS + JOBS_BIZ): print(r, flush=True)
