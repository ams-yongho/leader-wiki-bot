#!/usr/bin/env bash
# sync-wiki.sh 동작 검증
# - 정상 케이스: 빈 변경의 fast-forward를 성공으로 처리하고 로그를 남긴다.
# - 비정상 케이스(경로 미존재)는 비0 종료 코드.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/sync-wiki.sh"

if [[ ! -x "$SCRIPT" ]]; then
  echo "FAIL: $SCRIPT가 존재하지 않거나 실행 권한이 없음" >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# 1) origin이 될 bare 리포 생성
git init --bare "$TMPDIR/origin.git" >/dev/null

# 2) origin에 초기 커밋 푸시 (work_seed 사용)
SEED="$TMPDIR/work_seed"
git clone "$TMPDIR/origin.git" "$SEED" >/dev/null 2>&1
git -C "$SEED" config user.email "test@example.com"
git -C "$SEED" config user.name "test"
echo "hello" > "$SEED/README.md"
git -C "$SEED" add README.md
git -C "$SEED" commit -m "init" >/dev/null
git -C "$SEED" push origin HEAD:main >/dev/null 2>&1
git -C "$TMPDIR/origin.git" symbolic-ref HEAD refs/heads/main

# 3) sync-wiki.sh가 pull할 대상 워킹 트리
WORK="$TMPDIR/work"
git clone "$TMPDIR/origin.git" "$WORK" >/dev/null 2>&1

LOG_FILE="$TMPDIR/sync.log"

# 정상 케이스: ff-only로 변경 없음 → 성공해야 함
WIKI_LOCAL_PATH_HOST="$WORK" SYNC_LOG_FILE="$LOG_FILE" "$SCRIPT"
if [[ ! -s "$LOG_FILE" ]]; then
  echo "FAIL: 로그 파일이 비어있음" >&2
  exit 1
fi
if ! grep -q "BEGIN sync" "$LOG_FILE"; then
  echo "FAIL: 시작 로그 라인 누락" >&2
  exit 1
fi
if ! grep -q "END sync (exit=0)" "$LOG_FILE"; then
  echo "FAIL: 종료 로그 라인 누락 또는 비0 종료" >&2
  exit 1
fi

# 비정상 케이스: 존재하지 않는 경로 → 비0 종료
set +e
WIKI_LOCAL_PATH_HOST="$TMPDIR/no-such-dir" SYNC_LOG_FILE="$LOG_FILE" "$SCRIPT"
rc=$?
set -e
if [[ $rc -eq 0 ]]; then
  echo "FAIL: 잘못된 경로인데 종료 코드가 0" >&2
  exit 1
fi

echo "OK"
