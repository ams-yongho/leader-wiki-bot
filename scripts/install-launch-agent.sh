#!/usr/bin/env bash
# LaunchAgent plist 템플릿의 토큰을 사용자 환경으로 치환하고
# ~/Library/LaunchAgents/ 에 설치한 뒤 launchctl로 로드한다.
#
# 사용법:
#   scripts/install-launch-agent.sh <위키 로컬 경로>
#
# 예:
#   scripts/install-launch-agent.sh /Users/me/code/leader-wiki

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "사용법: $0 <위키 로컬 절대경로>" >&2
  exit 1
fi

WIKI_PATH="$1"

if [[ ! -d "$WIKI_PATH/.git" ]]; then
  echo "오류: $WIKI_PATH 는 git 워킹 트리가 아닙니다." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_ROOT/scripts/com.amass.leader-wiki-sync.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET="$TARGET_DIR/com.amass.leader-wiki-sync.plist"

mkdir -p "$TARGET_DIR"

# 이미 로드되어 있으면 먼저 unload
if launchctl list | grep -q "com.amass.leader-wiki-sync"; then
  echo "기존 LaunchAgent unload..."
  launchctl unload "$TARGET" 2>/dev/null || true
fi

# 토큰 치환. sed 구분자로 '|' 사용 (경로에 '/' 포함되므로).
sed \
  -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
  -e "s|__WIKI_LOCAL_PATH_HOST__|$WIKI_PATH|g" \
  -e "s|__HOME__|$HOME|g" \
  "$TEMPLATE" > "$TARGET"

# 문법 검증
plutil -lint "$TARGET"

# 로드
launchctl load "$TARGET"

echo "설치 완료: $TARGET"
echo "즉시 1회 테스트 실행: launchctl start com.amass.leader-wiki-sync"
echo "로그 확인: tail -f \"$HOME/Library/Logs/leader-wiki-sync.log\""
