# leader-wiki-bot

`leader-wiki` 레포의 LLM-curated 위키 내용을 슬랙에서 `@leader-wiki-bot <질문>` 멘션으로 질의·응답하는 봇.

설계 정본: [docs/design.md](docs/design.md)
운영 가이드 (로컬 PC Docker): [docs/operations.md](docs/operations.md)

---

## 동작 개요

1. 사용자가 슬랙에서 봇을 멘션
2. Bolt(Socket Mode)가 `app_mention` 이벤트 수신 → in-memory 큐에 enqueue
3. 워커가 Claude Agent SDK 세션을 띄움. 작업 디렉토리는 위키 클론, 허용 도구는 `Read`/`Glob`/`Grep`(read-only)
4. 에이전트가 `AGENTS.md §4.2` 워크플로우대로 `wiki/index.md` → 후보 페이지 탐색 → 답변 합성
5. `[[페이지명]]` 형식 인용을 GitHub blob URL로 치환 후 Slack mrkdwn으로 변환
6. 같은 스레드에 답변 게시 (4000자 초과 시 자동 분할)
7. 같은 스레드 내 follow-up 멘션은 `conversations.replies`로 prior turn을 가져와 컨텍스트 유지

---

## 로컬 개발

### 사전 준비

- Node.js 22+ (현재 toolchain은 22 이상을 요구. `engines.node: ">=22"`)
- pnpm 10+ (corepack으로 자동 활성화됨)
- Docker (선택, docker-compose 개발 시)
- sibling 디렉토리에 `leader-wiki` 레포가 클론되어 있어야 함:
  ```
  ~/your-workspace/
  ├── leader-wiki/       # 위키 레포 (별도 클론)
  └── leader-wiki-bot/   # 본 레포
  ```

### 환경 변수

`.env.example`을 `.env`로 복사하고 채워넣음:

```bash
cp .env.example .env
```

| 변수 | 설명 |
|---|---|
| `SLACK_BOT_TOKEN` | OAuth 설치 후 발급 (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Socket Mode app-level token (`xapp-...`, `connections:write`) |
| `SLACK_SIGNING_SECRET` | HTTP 모드일 때만 필요 |
| `SLACK_MODE` | `socket` (기본) 또는 `http` |
| `ANTHROPIC_API_KEY` | Anthropic API 키 |
| `ANTHROPIC_MODEL` | 기본 `claude-sonnet-4-6` |
| `WIKI_REPO_URL` | 프로덕션 clone용 git URL. 로컬 dev에서는 미설정 → bind mount만 사용 |
| `WIKI_REPO_BRANCH` | 기본 `main` |
| `WIKI_LOCAL_PATH` | 위키 마운트/클론 경로. docker-compose에서는 `/workspace/leader-wiki` |
| `WIKI_SYNC_INTERVAL_CRON` | cron 표현식, 기본 `*/5 * * * *` (5분마다 pull) |
| `WIKI_REPO_GITHUB_URL` | 인용 링크용 GitHub HTTPS URL, 예: `https://github.com/amass/leader-wiki` |
| `LOG_LEVEL` | pino 로그 레벨, 기본 `info` |
| `MAX_CONCURRENT_AGENTS` | 워커 동시성, 기본 `2` (max 10) |
| `QUEUE_MAX_SIZE` | 큐 대기 한도, 기본 `20` |
| `AGENT_TIMEOUT_MS` | 에이전트 호출 타임아웃, 기본 `120000` |
| `PORT` | HTTP 헬스체크 포트, 기본 `3000` (Socket Mode에서는 미사용) |

### Docker로 실행 (권장)

```bash
docker compose up bot
```

`docker-compose.yml`이 `../leader-wiki`를 `/workspace/leader-wiki`에 read-only로 바인드 마운트함. `src/`도 마운트되어 `tsx watch`로 핫 리로드.

### 네이티브로 실행

```bash
pnpm install
pnpm dev
```

`WIKI_LOCAL_PATH`는 호스트 절대경로(예: `/Users/me/code/leader-wiki`)로 설정.

### 빌드·테스트·린트

```bash
pnpm build      # tsc → dist/
pnpm test       # vitest (27개 단위 테스트)
pnpm typecheck  # tsc --noEmit
pnpm lint       # eslint
```

---

## 슬랙 앱 셋업 체크리스트

[api.slack.com/apps](https://api.slack.com/apps) → Your Apps에서:

1. **Create New App** → "From scratch" → 이름 `leader-wiki-bot`, 워크스페이스 선택
2. **Socket Mode** → Enable → App-level token 생성 (`connections:write`) → `SLACK_APP_TOKEN`
3. **OAuth & Permissions** → Bot Token Scopes:
   - `app_mentions:read` (멘션 수신)
   - `chat:write` (답변 게시)
   - `channels:history`, `groups:history`, `im:history`, `mpim:history` (스레드 히스토리)
   - `users:read` (선택)
4. **Event Subscriptions** → Enable → Bot events에 `app_mention` 추가 (Socket Mode이므로 Request URL 불필요)
5. **App Home** → "Messages Tab" Enable (DM 사용 시)
6. **Install to Workspace** → `SLACK_BOT_TOKEN` 발급

---

## 프로덕션 배포

```bash
docker build -f docker/Dockerfile --target prod -t leader-wiki-bot:latest .
docker run --env-file .env -v leader-wiki-data:/workspace/leader-wiki leader-wiki-bot:latest
```

운영 메모:
- 시크릿은 시크릿 매니저로 주입(.env 파일 직접 사용 금지)
- 첫 부팅 시 `WIKI_REPO_URL`이 설정돼있으면 자동 clone, 이후 `WIKI_SYNC_INTERVAL_CRON` 간격으로 `git pull --ff-only`
- private 위키 레포는 SSH deploy key 사용 권장 (`SSH_PRIVATE_KEY` env로 주입하면 `docker/entrypoint.sh`가 셋업)
- 컨테이너 1개 + wiki clone 영구 볼륨 정도면 충분. 메모리 256–512MB, CPU 0.25–0.5 vCPU
- 로그는 stdout으로 pino JSON. `LOG_LEVEL=debug`로 상세 로그

---

## 아키텍처

- `src/server.ts` — Slack Bolt 앱 부팅, app_mention 핸들러, 헬스체크
- `src/queue.ts` — p-queue 기반 in-memory 큐 + backpressure
- `src/wiki-sync.ts` — git clone + cron pull + read/write 락
- `src/worker.ts` — 단일 이벤트 처리 오케스트레이션
- `src/thread-context.ts` — `conversations.replies` → prior turn 변환
- `src/agent.ts` — Claude Agent SDK 세션 빌더 (read-only 도구만, 타임아웃, rate-limit retry)
- `src/citations.ts` — `[[페이지명]]` → GitHub blob URL 치환
- `src/slack-format.ts` — Markdown → Slack mrkdwn + 4000자 분할
- `src/retry.ts` — rate-limit 재시도 wrapper
- `src/config.ts` — zod 환경 변수 검증
- `src/logger.ts` — pino 구조화 로그
- `src/prompts/system.md` — 에이전트 시스템 프롬프트

---

## 테스트

- 단위: `citations`, `slack-format`, `thread-context`, `config`, `queue`, `wiki-sync`, `retry`
- 수동 E2E: 실 슬랙 워크스페이스 + 실제 Claude API로 검증 (비용 의식)
- CI: typecheck + lint + vitest (별도 워크플로우 미정의)
