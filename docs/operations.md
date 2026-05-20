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
- **중요**: `WIKI_SYNC_INTERVAL_CRON=` (값을 비워둘 것 — 컨테이너 내부 동기화 cron 비활성화)
- **중요**: `WIKI_REPO_URL=` (값을 비워둘 것 — 컨테이너 내부 동기화 자체를 비활성화)

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

### 2.4 질의 로그 (SQLite)

모든 슬랙 멘션 결과가 `./data/queries.db`에 누적된다. 호스트에서 직접 열어 분석한다.

```bash
# 최근 10건
sqlite3 ./data/queries.db 'SELECT received_at, slack_user, status, substr(question,1,40) FROM queries ORDER BY id DESC LIMIT 10;'

# 상태별 집계
sqlite3 ./data/queries.db 'SELECT status, COUNT(*) FROM queries GROUP BY status;'

# 자주 인용된 페이지 (상위 20)
sqlite3 ./data/queries.db "SELECT je.value, COUNT(*) c FROM queries, json_each(queries.citations_json) je WHERE citations_json IS NOT NULL GROUP BY je.value ORDER BY c DESC LIMIT 20;"
```

수동 백업:

```bash
cp ./data/queries.db ./data/queries.db.bak.$(date +%F)
```

로그 비활성화가 필요하면 `.env`에 `QUERY_LOG_ENABLED=false` 설정 후 `docker compose -f docker-compose.prod.yml restart bot`.

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
   - SSH 인증 실패 → launchd 환경에는 `SSH_AUTH_SOCK`이 상속되지 않는다. 위키 원격을 HTTPS + credential helper로 바꾸거나, `~/.gitconfig`에서 SSH key를 명시.
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
