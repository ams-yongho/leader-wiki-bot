# 로컬 PC Docker 운영 배포 설계

작성일: 2026-05-20
대상: `leader-wiki-bot`을 사용자 1인의 macOS PC에서 Docker로 상시 가동

---

## 1. 목적과 범위

사용자 PC를 "작은 서버"처럼 사용하여 `leader-wiki-bot`을 상시 가동한다. PC가 켜져 있는 동안에는 슬랙에서 봇이 항상 응답하고, 위키 내용은 매일 정해진 시각에 자동 갱신된다.

### 비목표 (의도적으로 다루지 않음)

- 클라우드 배포 (24/7 가동 보장이 필요하면 별도 설계).
- 다중 PC·고가용성 구성.
- 외부 시크릿 매니저(Vault, 1Password CLI 등) 통합.
- 외부 로그 집계(Loki, ELK 등) 통합.
- 슬랙 외부 노출(HTTP 모드) — Socket Mode를 유지하므로 포워딩·도메인 불필요.

---

## 2. 컨텍스트와 결정 사항

### 2.1 위키 데이터 동기화 방식: 호스트 bind mount (B)

세 후보 중 **B 방식(호스트의 `../leader-wiki`를 bind mount하고 git pull도 호스트에서 수행)**을 채택한다.

이유: 경영지원팀이 위키를 부정기적으로 정리·푸시하므로 사용자가 호스트의 위키 폴더를 직접 들여다보거나 상태를 확인할 일이 있다. 컨테이너 내부 동기화(A)는 자기완결적이지만 호스트에서 보이지 않고, 컨테이너가 pull(C)은 권한 이슈가 생긴다. B는 컨테이너의 책임을 "read-only 마운트 소비자"로 축소시켜 가장 깔끔하다.

### 2.2 위키 pull 주기: 매일 07:00

5분마다 pull하지 않고 **하루 1회 오전 7시**에만 pull한다. 경영지원의 푸시 시점이 불규칙해서 잦은 pull이 의미 없고, 출근 시각 직전 1회 갱신으로 충분하다.

### 2.3 자동화 범위: 풀 자동화

- Docker Desktop: macOS 로그인 시 자동 실행 (앱 설정 토글).
- 봇 컨테이너: `restart: unless-stopped` — 크래시·재부팅에서 자동 부활.
- 호스트 위키 pull: macOS `launchd` LaunchAgent로 매일 07:00 자동 실행.

### 2.4 dev/prod 환경 분리: 별도 compose 파일

기존 `docker-compose.yml`(dev 핫리로드)은 변경하지 않고, 운영용은 `docker-compose.prod.yml`로 별도 파일을 만든다. 실수로 dev 환경에서 prod를 띄우는 사고를 막기 위해 `override.yml` 자동 적용 방식이 아니라 명시적인 별도 파일을 쓴다.

---

## 3. 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│ 사용자 Mac (호스트)                                              │
│                                                                  │
│   ┌────────────────────────────────────┐                         │
│   │ Docker Desktop  (로그인 시 자동시작)│                         │
│   │  ┌──────────────────────────────┐  │                         │
│   │  │ leader-wiki-bot (prod 컨테이너)│  │   restart:             │
│   │  │   node dist/server.js        │  │   unless-stopped        │
│   │  │   Slack Socket Mode 연결      │  │                         │
│   │  │   /workspace/leader-wiki ← ──┼──┼──┐                      │
│   │  └──────────────────────────────┘  │  │  bind mount (ro)     │
│   └────────────────────────────────────┘  │                      │
│                                            │                      │
│   ~/.../leader-wiki  ←─────────────────────┘                      │
│        ▲                                                          │
│        │ git pull --ff-only                                       │
│        │                                                          │
│   launchd LaunchAgent                                             │
│     com.amass.leader-wiki-sync                                    │
│     StartCalendarInterval: 07:00 매일                             │
│     실행: scripts/sync-wiki.sh                                    │
│     로그: ~/Library/Logs/leader-wiki-sync.log                     │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 컴포넌트 책임

| 컴포넌트 | 책임 | 책임 아닌 것 |
|---|---|---|
| 봇 컨테이너 | 슬랙 이벤트 수신·답변, 위키 파일 **읽기 전용 소비** | 위키 git pull, 시간 스케줄링 |
| LaunchAgent | 매일 07:00 위키 `git pull` 실행 | 봇 프로세스 관리 |
| Docker Desktop | 컨테이너 런타임 제공, 자동 재시작 | 위키 동기화 |
| 사용자(운영자) | 최초 셋업, `.env` 토큰 관리, 트러블슈팅 | 정기 운영 (자동화에 일임) |

---

## 4. 파일 구조

### 4.1 새로 추가

```
docker-compose.prod.yml
scripts/
  sync-wiki.sh
  com.amass.leader-wiki-sync.plist
docs/
  operations.md
```

### 4.2 변경 없음

- `docker-compose.yml` (dev용 그대로)
- `docker/Dockerfile` (`prod` 타겟 그대로 사용)
- 봇 애플리케이션 코드

### 4.3 각 파일의 정의

#### `docker-compose.prod.yml`

dev compose와의 차이만 명시:

- `services.bot.build.target: prod`
- `services.bot.restart: unless-stopped`
- `services.bot.command` 없음 (Dockerfile의 CMD `node dist/server.js` 사용)
- `services.bot.volumes`:
  - `../leader-wiki:/workspace/leader-wiki:ro` — **유지**
  - `./src`, `./tests`, `./package.json`, `./tsconfig.json` 마운트 — **제거**
- `services.bot.ports: ["127.0.0.1:3000:3000"]` (외부 노출 금지, 로컬 헬스체크 한정)
- `services.bot.environment.WIKI_SYNC_INTERVAL_CRON: ""` (컨테이너 내부 동기화 비활성화)
- `services.bot.logging`:
  - `driver: json-file`
  - `options.max-size: "10m"`, `options.max-file: "5"`

기동:
```bash
docker compose -f docker-compose.prod.yml up -d --build
```

#### `scripts/sync-wiki.sh`

책임: 호스트의 위키 디렉토리에서 `git pull --ff-only`를 실행하고 결과를 로그에 append.

요구 동작:
- 위키 경로는 환경변수 `WIKI_LOCAL_PATH_HOST` 또는 plist에서 주입받음.
- `git pull --ff-only`만 수행 (충돌 시 실패 — 의도된 동작).
- 시작·종료 시각과 git 출력을 `~/Library/Logs/leader-wiki-sync.log`에 ISO 타임스탬프와 함께 append.
- 실패 시 비0 종료 코드 (launchd 로그에도 기록되도록).

#### `scripts/com.amass.leader-wiki-sync.plist`

LaunchAgent 정의:

- `Label`: `com.amass.leader-wiki-sync`
- `ProgramArguments`: `/bin/bash`, `<repo 절대경로>/scripts/sync-wiki.sh`
- `EnvironmentVariables`: `WIKI_LOCAL_PATH_HOST=<위키 절대경로>`
- `StartCalendarInterval`: `Hour=7, Minute=0`
- `StandardOutPath`: `~/Library/Logs/leader-wiki-sync.log`
- `StandardErrorPath`: `~/Library/Logs/leader-wiki-sync.log`
- `RunAtLoad`: `false` (로그인 시 자동 1회 실행 안 함 — 매일 정시만)

#### `docs/operations.md`

운영자용 실행 가이드. 다음 항목을 포함한다:

1. 최초 셋업 체크리스트 (§5)
2. 일상 운영 명령 (start/stop/restart/update/logs)
3. LaunchAgent 관리 (load/unload/start/list)
4. 트러블슈팅 (§6)

---

## 5. 최초 1회 셋업 절차

1. **Docker Desktop**: 설치 후 설정에서 `Start Docker Desktop when you sign in to your computer` 토글 ON.
2. **위키 리포 클론**: 본 리포의 sibling 디렉토리에 `leader-wiki`를 git clone.
   ```
   ~/your-workspace/
   ├── leader-wiki/
   └── leader-wiki-bot/
   ```
3. **`.env` 작성**: `.env.example`을 `.env`로 복사하고 슬랙·Anthropic 토큰 채우기. **`WIKI_SYNC_INTERVAL_CRON=`을 비워두기**.
4. **운영 컨테이너 기동**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   docker compose -f docker-compose.prod.yml logs -f bot
   ```
   슬랙 Socket Mode 연결 로그를 확인.
5. **LaunchAgent 설치**:
   ```bash
   # plist의 위키 경로를 사용자 환경에 맞게 수정 후
   cp scripts/com.amass.leader-wiki-sync.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.amass.leader-wiki-sync.plist
   # 즉시 1회 테스트 실행
   launchctl start com.amass.leader-wiki-sync
   tail ~/Library/Logs/leader-wiki-sync.log
   ```
6. **슬랙에서 봇 멘션**으로 end-to-end 동작 확인.

---

## 6. 운영 시 알아야 할 한계

1. **PC를 끄면 봇도 죽는다**. 슬랙 멘션이 와도 응답하지 못한다. PC가 깨어나면 자동으로 부활한다.
2. **`git pull --ff-only`는 충돌 시 실패한다**. 사용자가 호스트의 위키 폴더에서 로컬 변경을 만들면 pull이 거부된다. 위키 폴더에는 손대지 않는다. 손댄 흔적이 있으면 sync 로그에서 확인 가능.
3. **07:00에 PC가 슬립이면 정확히 7시가 아니라 wake 직후에 1회 실행된다** (launchd 기본 동작). 출근해서 PC를 깨우면 그때 pull된다.
4. **봇 컨테이너는 위키 파일 변경을 즉시 보지만, 진행 중인 슬랙 응답에는 반영되지 않는다**. 다음 멘션부터 새 내용으로 답변한다 (Claude Agent SDK가 매 요청마다 파일을 새로 읽음).

---

## 7. 수용 기준 (Acceptance Criteria)

- [ ] `docker compose -f docker-compose.prod.yml up -d --build`로 운영 컨테이너가 기동되고 슬랙에서 멘션에 응답한다.
- [ ] 컨테이너를 강제 종료해도 `unless-stopped` 정책으로 1분 이내 자동 부활한다.
- [ ] Mac 재부팅 후 별도 조작 없이 봇이 슬랙 응답 가능 상태가 된다.
- [ ] LaunchAgent가 매일 07:00 (또는 wake 직후)에 `sync-wiki.sh`를 실행하고 `~/Library/Logs/leader-wiki-sync.log`에 결과가 남는다.
- [ ] 호스트의 `../leader-wiki`에 새 커밋이 pull된 후 슬랙 멘션에 신규 내용 기반 답변이 가능하다 (컨테이너 재시작 불필요).
- [ ] 봇 컨테이너 안에서 `WIKI_SYNC_INTERVAL_CRON`이 비어 있어 내부 동기화 cron이 동작하지 않는다.
- [ ] 컨테이너 로그 파일 크기가 50MB(10m × 5)를 초과하지 않는다.
- [ ] `docs/operations.md`만 보고 다른 사람(또는 미래의 본인)이 최초 셋업을 완료할 수 있다.
