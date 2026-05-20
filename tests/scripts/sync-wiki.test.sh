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

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

# 1) origin이 될 bare 리포 생성
git init --bare "$TEST_DIR/origin.git" >/dev/null

# 2) origin에 초기 커밋 푸시 (work_seed 사용)
SEED="$TEST_DIR/work_seed"
git clone "$TEST_DIR/origin.git" "$SEED" >/dev/null 2>&1
git -C "$SEED" config user.email "test@example.com"
git -C "$SEED" config user.name "test"
echo "hello" > "$SEED/README.md"
git -C "$SEED" add README.md
git -C "$SEED" commit -m "init" >/dev/null
git -C "$SEED" push origin HEAD:main >/dev/null 2>&1
git -C "$TEST_DIR/origin.git" symbolic-ref HEAD refs/heads/main

# 3) sync-wiki.sh가 pull할 대상 워킹 트리
WORK="$TEST_DIR/work"
git clone "$TEST_DIR/origin.git" "$WORK" >/dev/null 2>&1

# 4) origin에 새 커밋을 푸시해서 WORK가 fast-forward할 거리를 만든다
echo "world" >> "$SEED/README.md"
git -C "$SEED" commit -am "second" >/dev/null
git -C "$SEED" push origin HEAD:main >/dev/null 2>&1
EXPECTED_HEAD=$(git -C "$SEED" rev-parse HEAD)

LOG_FILE="$TEST_DIR/sync.log"

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

# 성공 케이스 후 WORK가 실제로 fast-forward되었는지 확인
ACTUAL_HEAD=$(git -C "$WORK" rev-parse HEAD)
if [[ "$ACTUAL_HEAD" != "$EXPECTED_HEAD" ]]; then
  echo "FAIL: working tree did not advance to origin HEAD ($ACTUAL_HEAD != $EXPECTED_HEAD)" >&2
  exit 1
fi

# 비정상 케이스: 존재하지 않는 경로 → 비0 종료
: > "$LOG_FILE"
set +e
WIKI_LOCAL_PATH_HOST="$TEST_DIR/no-such-dir" SYNC_LOG_FILE="$LOG_FILE" "$SCRIPT"
rc=$?
set -e
if [[ $rc -ne 3 ]]; then
  echo "FAIL: 잘못된 경로일 때 exit 3을 기대했으나 $rc" >&2
  exit 1
fi

echo "OK"
