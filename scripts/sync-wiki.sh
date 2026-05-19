#!/usr/bin/env bash
# leader-wiki 호스트 디렉토리에서 fast-forward git pull을 실행하고 결과를 로그에 남긴다.
# launchd LaunchAgent에서 매일 호출된다.
#
# 환경변수:
#   WIKI_LOCAL_PATH_HOST  pull할 위키 디렉토리의 호스트 절대경로 (필수)
#   SYNC_LOG_FILE         로그 파일 경로 (기본: ~/Library/Logs/leader-wiki-sync.log)
#
# launchd 환경 주의사항:
#   - LaunchAgent는 SSH_AUTH_SOCK을 상속받지 않는다. 위키가 SSH 원격을 쓰면
#     git pull이 인증 단계에서 멈춘다. 해결책: (1) 원격을 HTTPS + credential
#     helper 로 바꾸거나, (2) GIT_SSH_COMMAND 로 keyfile 직접 지정하거나,
#     (3) ~/.gitconfig 의 credential helper 설정 사용.
#   - LANG/LC_ALL은 사용자 세션을 따른다. 한국어 로케일이면 git 메시지가
#     한국어로 로깅된다.

set -uo pipefail

WIKI_DIR="${WIKI_LOCAL_PATH_HOST:-}"
LOG_FILE="${SYNC_LOG_FILE:-$HOME/Library/Logs/leader-wiki-sync.log}"

if ! mkdir -p "$(dirname "$LOG_FILE")"; then
  echo "ERROR cannot create log directory: $(dirname "$LOG_FILE")" >&2
  exit 4
fi

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
