# 로컬 PC Docker 운영 배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자 macOS PC에서 `leader-wiki-bot`을 Docker로 상시 가동하기 위한 운영용 compose 파일·LaunchAgent·운영 가이드를 추가한다.

**Architecture:** 기존 `docker/Dockerfile`의 `prod` 타겟을 사용하는 별도 `docker-compose.prod.yml` + `../leader-wiki`를 호스트에서 매일 07:00 `git pull`하는 macOS launchd LaunchAgent + 운영자용 `docs/operations.md` runbook을 추가한다. 봇 컨테이너는 위키를 read-only로 마운트해 소비만 하고, 위키 동기화 책임은 호스트 launchd에 둔다.

**Tech Stack:** Docker Compose v2, macOS launchd (LaunchAgent), Bash 셸 스크립트, 기존 Node.js 22 + pnpm + tsc 빌드.

**참고:** 설계 정본 [docs/superpowers/specs/2026-05-20-local-docker-deployment-design.md](../specs/2026-05-20-local-docker-deployment-design.md)

---

## 사전 사항

- 모든 경로는 본 리포 루트 기준 상대경로 또는 명시된 절대경로.
- 작업 환경에 `shellcheck`가 없으므로 셸 스크립트는 `bash -n` 구문 체크와 실제 실행으로 검증한다.
- `plutil`은 macOS 기본 제공 → plist 검증에 사용.
- `docker compose config`로 compose 파일 검증.
- 커밋은 각 컴포넌트 단위로 frequent commit (작업별 1회).

---

## File Structure

추가:

| 파일 | 책임 |
|---|---|
| `docker-compose.prod.yml` | 운영용 compose 정의. `prod` 타겟, `restart: unless-stopped`, 위키 RO 마운트만, 로그 회전. |
| `scripts/sync-wiki.sh` | 호스트의 위키 디렉토리에서 `git pull --ff-only` 1회 실행 + 로그 append. |
| `scripts/com.amass.leader-wiki-sync.plist` | 매일 07:00 `sync-wiki.sh`를 실행하는 launchd LaunchAgent. 사용자별 경로는 템플릿 토큰으로 둠. |
| `scripts/install-launch-agent.sh` | plist 템플릿의 토큰을 사용자 환경으로 치환하고 `~/Library/LaunchAgents/`에 설치하는 1회용 헬퍼. |
| `docs/operations.md` | 운영자용 runbook (셋업·시작/중지·로그·트러블슈팅). |
| `tests/scripts/sync-wiki.test.sh` | `sync-wiki.sh` 동작 검증용 셸 테스트. 임시 git 리포에 대해 실행. |

변경 없음: `docker-compose.yml`, `docker/Dockerfile`, 애플리케이션 코드.

---

## Task 1: 운영용 compose 파일 추가

**Files:**
- Create: `docker-compose.prod.yml`

- [ ] **Step 1: `docker-compose.prod.yml` 작성**

```yaml
services:
  bot:
    build:
      context: .
      dockerfile: docker/Dockerfile
      target: prod
    image: leader-wiki-bot:prod
    env_file: .env
    environment:
      WIKI_LOCAL_PATH: /workspace/leader-wiki
      WIKI_SYNC_INTERVAL_CRON: ""
    volumes:
      - ../leader-wiki:/workspace/leader-wiki:ro
    ports:
      - "127.0.0.1:3000:3000"
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
```

설계 정본 §4.3과 일치하는지 확인:
- `target: prod` ✔
- `restart: unless-stopped` ✔
- 위키만 read-only 마운트, src/tests 마운트 없음 ✔
- 포트 `127.0.0.1` 한정 ✔
- `WIKI_SYNC_INTERVAL_CRON=""` (컨테이너 내부 동기화 비활성화) ✔
- 로그 회전 10m × 5 ✔

- [ ] **Step 2: compose 파일 구문 검증**

Run:
```bash
# .env가 없어도 변수 치환만 비활성화하면 config 검증 가능
docker compose -f docker-compose.prod.yml --env-file /dev/null config --quiet
```

Expected: 종료 코드 0, 출력 없음. 만약 `.env` 부재로 경고가 나오면 임시로 빈 `.env`를 만들어 재시도.

- [ ] **Step 3: dev compose가 망가지지 않았는지 확인**

Run:
```bash
docker compose -f docker-compose.yml --env-file /dev/null config --quiet
```

Expected: 종료 코드 0.

- [ ] **Step 4: 커밋**

```bash
git add docker-compose.prod.yml
git commit -m "feat(ops): add docker-compose.prod.yml for local PC operation"
```

---

## Task 2: 위키 동기화 셸 스크립트

**Files:**
- Create: `scripts/sync-wiki.sh`

- [ ] **Step 1: 테스트 디렉토리 생성**

Run:
```bash
mkdir -p tests/scripts
```

- [ ] **Step 2: 테스트 작성 (실패 상태로)**

Create `tests/scripts/sync-wiki.test.sh`:

```bash
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
```

권한:
```bash
chmod +x tests/scripts/sync-wiki.test.sh
```

- [ ] **Step 3: 테스트 실행해서 실패 확인**

Run:
```bash
bash tests/scripts/sync-wiki.test.sh
```

Expected: `FAIL: .../scripts/sync-wiki.sh가 존재하지 않거나 실행 권한이 없음` 으로 비0 종료.

- [ ] **Step 4: `scripts/sync-wiki.sh` 작성**

Create `scripts/sync-wiki.sh`:

```bash
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
```

권한:
```bash
chmod +x scripts/sync-wiki.sh
```

- [ ] **Step 5: bash 구문 체크**

Run:
```bash
bash -n scripts/sync-wiki.sh
```

Expected: 종료 코드 0, 출력 없음.

- [ ] **Step 6: 테스트 다시 실행해서 통과 확인**

Run:
```bash
bash tests/scripts/sync-wiki.test.sh
```

Expected: 마지막 줄에 `OK`, 종료 코드 0.

- [ ] **Step 7: 커밋**

```bash
git add scripts/sync-wiki.sh tests/scripts/sync-wiki.test.sh
git commit -m "feat(ops): add sync-wiki.sh host script with smoke test"
```

---

## Task 3: LaunchAgent plist 템플릿

**Files:**
- Create: `scripts/com.amass.leader-wiki-sync.plist`

- [ ] **Step 1: plist 템플릿 작성**

Create `scripts/com.amass.leader-wiki-sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.amass.leader-wiki-sync</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>__REPO_ROOT__/scripts/sync-wiki.sh</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>WIKI_LOCAL_PATH_HOST</key>
        <string>__WIKI_LOCAL_PATH_HOST__</string>
        <key>SYNC_LOG_FILE</key>
        <string>__HOME__/Library/Logs/leader-wiki-sync.log</string>
    </dict>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>7</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>__HOME__/Library/Logs/leader-wiki-sync.log</string>

    <key>StandardErrorPath</key>
    <string>__HOME__/Library/Logs/leader-wiki-sync.log</string>
</dict>
</plist>
```

토큰 `__REPO_ROOT__`, `__WIKI_LOCAL_PATH_HOST__`, `__HOME__`은 설치 시 `install-launch-agent.sh`가 치환한다.

- [ ] **Step 2: plist 문법 검증**

`plutil`은 XML이 valid plist인지 검사한다. 미치환 토큰이 있어도 XML 자체는 valid해야 한다.

Run:
```bash
plutil -lint scripts/com.amass.leader-wiki-sync.plist
```

Expected: `scripts/com.amass.leader-wiki-sync.plist: OK`

- [ ] **Step 3: 커밋**

```bash
git add scripts/com.amass.leader-wiki-sync.plist
git commit -m "feat(ops): add launchd plist template for daily wiki sync"
```

---

## Task 4: LaunchAgent 설치 헬퍼

**Files:**
- Create: `scripts/install-launch-agent.sh`

- [ ] **Step 1: 설치 스크립트 작성**

Create `scripts/install-launch-agent.sh`:

```bash
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
```

권한:
```bash
chmod +x scripts/install-launch-agent.sh
```

- [ ] **Step 2: bash 구문 체크**

Run:
```bash
bash -n scripts/install-launch-agent.sh
```

Expected: 종료 코드 0, 출력 없음.

- [ ] **Step 3: 인자 검증 동작 확인 (실제 설치는 하지 않음)**

Run:
```bash
./scripts/install-launch-agent.sh
```

Expected: `사용법: ...` 출력 후 비0 종료.

Run:
```bash
./scripts/install-launch-agent.sh /tmp/no-such-dir
```

Expected: `오류: /tmp/no-such-dir 는 git 워킹 트리가 아닙니다.` 출력 후 비0 종료.

- [ ] **Step 4: 커밋**

```bash
git add scripts/install-launch-agent.sh
git commit -m "feat(ops): add LaunchAgent install helper that substitutes paths"
```

---

## Task 5: 운영 가이드 문서

**Files:**
- Create: `docs/operations.md`

- [ ] **Step 1: `docs/operations.md` 작성**

Create `docs/operations.md`:

````markdown
# 운영 가이드 — 로컬 PC Docker 배포

설계 정본: [docs/superpowers/specs/2026-05-20-local-docker-deployment-design.md](superpowers/specs/2026-05-20-local-docker-deployment-design.md)

본 문서는 사용자 macOS PC를 작은 서버로 사용해 `leader-wiki-bot`을 상시 가동하는 운영자용 runbook이다.

---

## 1. 최초 1회 셋업

### 1.1 Docker Desktop

1. [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/) 설치.
2. Docker Desktop → Settings → General → **"Start Docker Desktop when you sign in to your computer"** 토글 ON.
3. Docker가 정상 기동했는지 확인:
   ```bash
   docker version
   ```

### 1.2 위키 리포 클론

본 리포(`leader-wiki-bot`)의 **sibling 디렉토리**에 `leader-wiki`를 클론한다.

```
~/your-workspace/
├── leader-wiki/        ← 새로 클론
└── leader-wiki-bot/    ← 본 리포
```

```bash
cd ~/your-workspace
git clone git@github.com:amass/leader-wiki.git
```

### 1.3 `.env` 작성

```bash
cd ~/your-workspace/leader-wiki-bot
cp .env.example .env
```

`.env`를 열어 다음을 채운다:
- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (또는 `SLACK_SIGNING_SECRET`)
- `ANTHROPIC_API_KEY` 또는 `CLAUDE_CODE_OAUTH_TOKEN`
- **중요**: `WIKI_SYNC_INTERVAL_CRON=` (값을 비워둘 것 — 컨테이너 내부 동기화 비활성화)

### 1.4 운영 컨테이너 기동

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

기동 확인:
```bash
docker compose -f docker-compose.prod.yml logs -f bot
```

Slack Socket Mode 연결 로그가 보이면 정상. 로그 화면은 `Ctrl-C`로 빠져나온다 (컨테이너는 계속 실행됨).

### 1.5 LaunchAgent 설치 (매일 07:00 위키 pull)

```bash
./scripts/install-launch-agent.sh /Users/<나>/your-workspace/leader-wiki
```

즉시 1회 테스트 실행:
```bash
launchctl start com.amass.leader-wiki-sync
tail ~/Library/Logs/leader-wiki-sync.log
```

마지막 라인이 `END sync (exit=0)`이면 성공.

### 1.6 End-to-end 확인

슬랙에서 봇을 멘션하여 응답을 받는다.

---

## 2. 일상 운영

### 2.1 컨테이너

| 동작 | 명령 |
|---|---|
| 시작 | `docker compose -f docker-compose.prod.yml start` |
| 중지 | `docker compose -f docker-compose.prod.yml stop` |
| 재시작 | `docker compose -f docker-compose.prod.yml restart` |
| 로그 보기 | `docker compose -f docker-compose.prod.yml logs -f bot` |
| 업데이트 | `git pull && docker compose -f docker-compose.prod.yml up -d --build` |
| 완전 제거 | `docker compose -f docker-compose.prod.yml down` |
| 상태 확인 | `docker compose -f docker-compose.prod.yml ps` |

### 2.2 LaunchAgent

| 동작 | 명령 |
|---|---|
| 로드 (활성화) | `launchctl load ~/Library/LaunchAgents/com.amass.leader-wiki-sync.plist` |
| 언로드 (비활성화) | `launchctl unload ~/Library/LaunchAgents/com.amass.leader-wiki-sync.plist` |
| 즉시 1회 실행 | `launchctl start com.amass.leader-wiki-sync` |
| 등록 여부 확인 | `launchctl list \| grep leader-wiki` |
| 로그 보기 | `tail -f ~/Library/Logs/leader-wiki-sync.log` |

### 2.3 로그 위치 요약

| 로그 | 위치 |
|---|---|
| 봇 stdout | `docker compose -f docker-compose.prod.yml logs bot` |
| 위키 sync | `~/Library/Logs/leader-wiki-sync.log` |

봇 로그는 Docker json-file 드라이버가 자동 회전 (10MB × 5개). sync 로그는 단순 append이므로 커지면 수동 정리.

---

## 3. 트러블슈팅

### 3.1 봇이 슬랙 멘션에 응답 안 함

1. Docker Desktop이 켜져 있나? → 메뉴 바 아이콘 확인.
2. 컨테이너가 살아있나? → `docker compose -f docker-compose.prod.yml ps`
3. 봇 로그 확인 → `docker compose -f docker-compose.prod.yml logs --tail=200 bot`
4. Socket Mode 토큰(`SLACK_APP_TOKEN`)이 올바른가? → `.env` 확인 후 `restart`.

### 3.2 위키 내용이 갱신 안 됨

1. sync 로그 확인:
   ```bash
   tail -50 ~/Library/Logs/leader-wiki-sync.log
   ```
2. `END sync (exit=0)`이 아니면 → git pull이 실패한 것. 가장 흔한 원인:
   - **호스트의 위키 폴더에 로컬 변경이 있다** → 위키 폴더에서 `git status`로 확인 후 정리(stash/reset). 위키 폴더에는 손대지 않는다.
   - git PATH 문제 → 로그에 `git: command not found`가 있으면 `sync-wiki.sh`의 PATH 라인 확인.
3. 마지막으로 LaunchAgent가 로드되어 있는지 → `launchctl list | grep leader-wiki`.

### 3.3 07:00에 안 돌았다

- 그 시각에 PC가 슬립이었을 가능성. macOS launchd는 슬립 중 누락된 정시 트리거를 wake 직후 1회 실행한다.
- 강제로 즉시 1회 실행하고 싶으면:
  ```bash
  launchctl start com.amass.leader-wiki-sync
  ```

### 3.4 컨테이너가 계속 재시작 루프

- 로그를 본다: `docker compose -f docker-compose.prod.yml logs --tail=200 bot`
- 가장 흔한 원인: `.env`의 토큰 누락/오타.
- 일시 중지: `docker compose -f docker-compose.prod.yml stop`

---

## 4. 알아둘 한계

1. **PC 종료/슬립 중에는 봇이 응답하지 않는다**. PC가 깨어나면 컨테이너가 자동 부활한다.
2. **위키 pull은 하루 1회 (07:00)뿐이다**. 그 시점 이전에 푸시된 변경만 당일 응답에 반영된다.
3. **`git pull --ff-only`는 충돌 시 실패한다**. 위키 폴더는 직접 편집하지 않는다.
````

- [ ] **Step 2: 링크와 명령 sanity check**

Run:
```bash
ls docs/superpowers/specs/2026-05-20-local-docker-deployment-design.md
ls docs/operations.md
```

Expected: 두 파일 모두 존재.

- [ ] **Step 3: README에서 운영 문서로 연결되도록 안내 라인 추가**

Run:
```bash
grep -n "operations.md" README.md || echo "no link yet"
```

기존 README에 운영 가이드 링크가 없으면 추가. README 첫 부분의 설계 정본 링크 바로 아래에 한 줄 추가:

`README.md`에서 다음을 찾는다:
```
설계 정본: [docs/design.md](docs/design.md)
```

뒤에 추가:
```
운영 가이드 (로컬 PC Docker): [docs/operations.md](docs/operations.md)
```

- [ ] **Step 4: 커밋**

```bash
git add docs/operations.md README.md
git commit -m "docs(ops): add operations runbook for local PC Docker deployment"
```

---

## Task 6: 통합 스모크 검증 (Optional - 사용자 환경에서)

이 단계는 사용자 본인의 Mac에서 실제 슬랙 토큰과 위키 리포가 준비되어야 가능하므로, 구현 에이전트는 명령만 기록하고 사용자에게 실행을 위임한다.

**Files:** (없음 — 검증 단계)

- [ ] **Step 1: dev compose가 여전히 동작하는지 (회귀 방지)**

Run (사용자 환경에서, optional):
```bash
docker compose up -d bot
docker compose logs --tail=50 bot
docker compose down
```

Expected: 기존 dev 동작에 영향 없음.

- [ ] **Step 2: prod compose 빌드 및 기동**

Run (사용자 환경에서):
```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs --tail=100 bot
```

Expected: Socket Mode 연결 로그. 컨테이너 상태 `Up`.

- [ ] **Step 3: 자동 재시작 검증**

Run (사용자 환경에서):
```bash
docker compose -f docker-compose.prod.yml ps -q bot | xargs docker kill
sleep 3
docker compose -f docker-compose.prod.yml ps
```

Expected: 컨테이너가 다시 `Up` 상태. `unless-stopped` 정책 동작 확인.

- [ ] **Step 4: LaunchAgent end-to-end**

Run (사용자 환경에서):
```bash
./scripts/install-launch-agent.sh /Users/<나>/your-workspace/leader-wiki
launchctl start com.amass.leader-wiki-sync
sleep 5
tail -20 ~/Library/Logs/leader-wiki-sync.log
```

Expected: 로그에 `BEGIN sync ... END sync (exit=0)`.

- [ ] **Step 5: 슬랙 멘션 응답 확인**

사용자가 슬랙에서 봇을 멘션하여 정상 응답을 받는다.

- [ ] **Step 6: 통합 검증 통과 보고**

검증 결과를 PR 본문 또는 운영자 메모에 기록.

---

## Done Criteria (스펙 §7과 매핑)

| 스펙 요구사항 | 충족 Task |
|---|---|
| `docker compose -f docker-compose.prod.yml up -d --build`로 운영 컨테이너 기동·슬랙 응답 | Task 1 + Task 6.2/6.5 |
| 컨테이너 강제 종료 시 1분 이내 자동 부활 | Task 1 (`restart: unless-stopped`) + Task 6.3 |
| Mac 재부팅 후 별도 조작 없이 봇 응답 가능 | Task 1 + Docker Desktop 자동시작 (Task 5 §1.1) |
| LaunchAgent가 매일 07:00에 sync-wiki.sh 실행, 로그 기록 | Task 2 + Task 3 + Task 4 |
| 호스트 위키에 새 커밋 pull 후 슬랙 응답에 신규 내용 반영 (재시작 불필요) | Task 1 (bind mount RO) + Task 2 |
| 컨테이너 안에서 `WIKI_SYNC_INTERVAL_CRON` 비어 있음 | Task 1 (environment 명시) |
| 컨테이너 로그 50MB 초과 안 함 | Task 1 (logging max-size 10m × 5) |
| `docs/operations.md`만 보고 초기 셋업 가능 | Task 5 |
