#!/usr/bin/env bash
# leader-wiki 호스트 디렉토리에서 fast-forward git pull을 실행하고 결과를 로그에 남긴다.
# launchd LaunchAgent에서 매일 호출된다.
#
# 환경변수:
#   WIKI_LOCAL_PATH_HOST  pull할 위키 디렉토리의 호스트 절대경로 (필수)
#   SYNC_LOG_FILE         로그 파일 경로 (기본: ~/Library/Logs/leader-wiki-sync.log)

set -uo pipefail

WIKI_DIR="${WIKI_LOCAL_PATH_HOST:-}"
LOG_FILE="${SYNC_LOG_FILE:-$HOME/Library/Logs/leader-wiki-sync.log}"

mkdir -p "$(dirname "$LOG_FILE")"

timestamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

log() {
  printf '%s %s\n' "$(timestamp)" "$*" >> "$LOG_FILE"
}

log "BEGIN sync WIKI_LOCAL_PATH_HOST=${WIKI_DIR:-<unset>}"

if [[ -z "$WIKI_DIR" ]]; then
  log "ERROR WIKI_LOCAL_PATH_HOST is not set"
  log "END sync (exit=2)"
  exit 2
fi

if [[ ! -d "$WIKI_DIR/.git" ]]; then
  log "ERROR not a git working tree: $WIKI_DIR"
  log "END sync (exit=3)"
  exit 3
fi

# git이 PATH에 없을 수 있으므로 (launchd는 최소 환경) 확장된 PATH 사용
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

pull_output=$(git -C "$WIKI_DIR" pull --ff-only 2>&1)
pull_rc=$?

# 출력 각 줄을 timestamp 붙여 로그에 남김
while IFS= read -r line; do
  log "git: $line"
done <<< "$pull_output"

log "END sync (exit=$pull_rc)"
exit "$pull_rc"
