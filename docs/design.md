# leader-wiki-bot 설계 명세

> 이 문서는 신규 레포 `leader-wiki-bot`의 정본 설계 문서입니다.
> `leader-wiki` 레포의 위키 내용을 슬랙에서 자연어로 질의·응답하는 봇을 정의합니다.
> 작성일: 2026-05-16

---

## 1. Context

[`leader-wiki`](https://github.com/amass/leader-wiki) (이하 "위키 레포")는 Karpathy 패턴의 LLM-curated 위키로, 리더회의 회의록을 누적해 회사 진행 상태를 마크다운으로 관리합니다. 사람은 `raw/`에 회의록을 넣고, LLM(주로 Claude Code)이 `wiki/` 페이지를 작성·갱신합니다. 운영 스키마는 위키 레포의 `AGENTS.md`에 정의되어 있습니다.

현재 위키 질의는 로컬에서 Claude Code를 띄워야만 가능합니다. 이 봇은 **슬랙에서 `@leader-wiki-bot` 멘션 하나로 동일한 질의 경험을 제공**합니다. 위키의 `AGENTS.md §4.2 (Query)` 워크플로우를 그대로 슬랙 위로 옮긴 것입니다.

회의록이 전사 공개이므로 봇 응답 권한은 워크스페이스 전체로 개방합니다.

---

## 2. Goals / Non-Goals

### Goals
- 슬랙 어느 채널에서든 `@leader-wiki-bot <질문>` 멘션 → 위키 내용 기반 답변
- 답변에 `wiki/` 페이지를 GitHub 링크로 인용 (출처 추적 가능)
- 한 스레드 내에서 follow-up 질문 가능 (이전 Q&A 컨텍스트 유지)
- 로컬 docker-compose 개발 → 동일 Docker 이미지로 프로덕션 배포
- 위키 운영 철학(`AGENTS.md`)과 정합: 매 질의마다 재구성되는 RAG가 아니라, 에이전트가 `wiki/index.md`부터 탐색해서 관련 페이지를 *읽고* 답함

### Non-Goals
- 위키 페이지 *작성·갱신*은 봇이 하지 않음 (그건 Claude Code로 수동 ingest)
- RAG/임베딩 인덱싱 없음
- 다국어 자동 번역 없음 (한국어 위키 → 한국어 답변)
- 별도 인증 레이어 없음 (Slack 워크스페이스 멤버십이 곧 권한)
- 실시간 슬랙 reaction·메시지 편집 기능 없음 (v1 범위 밖)

---

## 3. 아키텍처

### 데이터 흐름

```
사용자 슬랙 메시지 (@leader-wiki-bot 질문)
   │
   ▼
[1] Slack Events API → POST /slack/events
   │   - Signing Secret 검증
   │   - 즉시 200 OK 반환 (Slack 3s ACK 제한)
   ▼
[2] In-memory 큐에 작업 enqueue
   │   { event, thread_ts, user, text }
   ▼
[3] 워커가 비동기로 처리
   │
   ├─ 3a. 스레드 컨텍스트 수집
   │      conversations.replies API로 동일 thread_ts 메시지 history 조회
   │      (봇 자신과 사용자 메시지만 user/assistant turn으로 정리)
   │
   ├─ 3b. Claude Agent SDK 세션 시작
   │      - cwd: /workspace/leader-wiki
   │      - 허용 도구: Read, Glob, Grep (파일 시스템 read-only)
   │      - system prompt: AGENTS.md §4.2 임베드 + 슬랙 응답 가이드
   │      - messages: [...thread_history, { role: 'user', content: question }]
   │      - 모델: claude-sonnet-4-6 (기본)
   │
   ├─ 3c. 에이전트 루프 진행
   │      LLM이 wiki/index.md 먼저 읽고 관련 페이지 탐색·읽기
   │      → 합성된 답변 생성 (Markdown + [[wikilink]] 인용)
   │
   ├─ 3d. 후처리
   │      - [[페이지명]] → GitHub blob URL로 치환
   │      - Markdown → Slack mrkdwn 변환
   │
   └─ 3e. chat.postMessage
          채널 + thread_ts에 답변 (원본 스레드에 reply)
```

### 컴포넌트

| 모듈 | 책임 |
|---|---|
| `src/server.ts` | Slack Bolt 앱 부팅, Events 리스너 등록, 헬스체크 엔드포인트 |
| `src/queue.ts` | In-memory FIFO 큐 (`p-queue`) + concurrency 1~2 |
| `src/worker.ts` | 큐 소비자, 단일 이벤트 처리 오케스트레이션 |
| `src/agent.ts` | Claude Agent SDK 세션 빌더, 시스템 프롬프트 조립 |
| `src/wiki-sync.ts` | git clone/pull, cron 스케줄, 락 처리 |
| `src/thread-context.ts` | Slack `conversations.replies` 호출, message history → SDK messages 변환 |
| `src/citations.ts` | `[[페이지명]]` → GitHub URL 변환 |
| `src/slack-format.ts` | Claude 응답(Markdown) → Slack mrkdwn 변환 |
| `src/config.ts` | env var 로딩·검증 (zod) |
| `src/logger.ts` | 구조화 로그 (pino) |

---

## 4. 기술 스택

| 분야 | 선택 |
|---|---|
| Runtime | Node.js 20+ |
| 언어 | TypeScript 5+ (strict) |
| 패키지 매니저 | pnpm |
| Slack | `@slack/bolt` (Socket Mode 우선, HTTP fallback) |
| Claude | `@anthropic-ai/claude-agent-sdk` |
| Git | `simple-git` |
| 큐 | `p-queue` |
| 스케줄 | `node-cron` |
| 설정 검증 | `zod` |
| 로그 | `pino` |
| 테스트 | `vitest` |
| 빌드 | `tsx`(dev), `tsc`(prod) |
| 컨테이너 | Docker (Node 20-alpine, 멀티 스테이지) |
| 로컬 dev | docker-compose |

**Socket Mode 권장 이유**: 공개 endpoint 노출 불필요. 로컬·사내망 모두에서 동일하게 동작. 프로덕션 전환도 환경 변수 토글로 가능.

---

## 5. 레포 구조

```
leader-wiki-bot/
├── src/
│   ├── server.ts
│   ├── queue.ts
│   ├── worker.ts
│   ├── agent.ts
│   ├── wiki-sync.ts
│   ├── thread-context.ts
│   ├── citations.ts
│   ├── slack-format.ts
│   ├── config.ts
│   ├── logger.ts
│   └── prompts/
│       └── system.md       # AGENTS.md §4.2 베이스 시스템 프롬프트
├── tests/
│   ├── citations.test.ts
│   ├── slack-format.test.ts
│   └── thread-context.test.ts
├── docker/
│   ├── Dockerfile
│   └── entrypoint.sh
├── docker-compose.yml      # 로컬 개발용
├── .env.example
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── README.md
└── docs/
    └── design.md           # 이 문서 (또는 본 md를 그대로)
```

---

## 6. 설정 / 환경 변수

`.env.example`:

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...           # Socket Mode 사용 시
SLACK_SIGNING_SECRET=...           # HTTP 모드 사용 시
SLACK_MODE=socket                  # socket | http

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6

# Wiki repo
WIKI_REPO_URL=git@github.com:amass/leader-wiki.git
WIKI_REPO_BRANCH=main
WIKI_LOCAL_PATH=/workspace/leader-wiki
WIKI_SYNC_INTERVAL_CRON=*/5 * * * *    # 5분마다 git pull (프로덕션)
WIKI_REPO_GITHUB_URL=https://github.com/amass/leader-wiki  # 인용 링크 베이스

# 동작
LOG_LEVEL=info
MAX_CONCURRENT_AGENTS=2
QUEUE_MAX_SIZE=20
AGENT_TIMEOUT_MS=120000
```

---

## 7. 핵심 구현 디테일

### 7.1 위키 동기화

- **로컬 dev**: docker-compose에서 호스트의 sibling 디렉토리 `../leader-wiki`를 `/workspace/leader-wiki`에 **bind mount (read-only)**. git pull 불필요. 위키 편집 즉시 반영.
- **프로덕션**:
  1. 컨테이너 첫 부팅 시 `WIKI_REPO_URL`을 `WIKI_LOCAL_PATH`로 clone.
  2. `node-cron`이 `WIKI_SYNC_INTERVAL_CRON` 간격으로 `git pull --ff-only` 실행.
  3. pull 중에는 mutex로 새 에이전트 세션 시작 차단 (in-progress 세션은 진행).
- private 레포면 deploy key를 SSH로 또는 GitHub App 토큰을 HTTPS로 주입. v1은 SSH deploy key 권장(가장 단순).

### 7.2 Claude Agent SDK 세션

```ts
// 의사 코드 (정확한 SDK API는 구현 시 확인)
import { query } from '@anthropic-ai/claude-agent-sdk';

const systemPrompt = await loadSystemPrompt(); // src/prompts/system.md + 위키의 AGENTS.md §4.2 inline

const result = query({
  prompt: question,
  options: {
    cwd: config.WIKI_LOCAL_PATH,
    model: config.ANTHROPIC_MODEL,
    systemPrompt,
    allowedTools: ['Read', 'Glob', 'Grep'],   // 쓰기·실행 도구 모두 차단
    permissionMode: 'bypassPermissions',       // read-only tool만 허용했으므로 안전
    messages: priorTurns,                      // 스레드 컨텍스트
    abortSignal: AbortSignal.timeout(config.AGENT_TIMEOUT_MS),
  },
});

for await (const message of result) {
  // assistant 텍스트 누적
}
```

**시스템 프롬프트 골자** (`src/prompts/system.md`):
- 너는 리더회의 위키의 질의 응답 에이전트.
- 위키 운영 규칙은 `AGENTS.md`(작업 디렉토리 루트)를 따른다. 모르면 먼저 그것을 읽어라.
- 질의가 들어오면: ① `wiki/index.md` 먼저 읽어 후보 페이지 식별 → ② 후보 페이지들 읽기 → ③ 답변 합성, 출처는 `[[페이지명]]` wikilink로 인용.
- `raw/`는 읽기 전용. 인용 우선순위는 `wiki/` > `raw/`.
- 답변 언어는 질문 언어를 따른다 (기본 한국어).
- 답변 길이는 슬랙 메시지에 적합하게 (긴 표·코드블록 지양, 필요 시 핵심만 + 페이지 링크).
- 위키에 정보 없으면 "위키에 해당 내용이 없습니다"로 정직하게 답변.

### 7.3 인용 변환 (`[[페이지명]]` → GitHub URL)

- 에이전트 응답 텍스트에서 `[[...]]` 패턴 매칭.
- `wiki/` 디렉토리 인덱스(파일명 → 상대경로 맵)와 비교해서 일치하면 GitHub blob URL로 치환.
- 예: `[[프로젝트-알파]]` → `<https://github.com/amass/leader-wiki/blob/main/wiki/프로젝트-알파.md|프로젝트-알파>`
- 일치하는 페이지가 없으면 원본 그대로 두고 경고 로그.

### 7.4 슬랙 mrkdwn 변환

- Claude는 기본 Markdown을 출력. Slack mrkdwn은 부분집합 + 약간의 차이 (`*bold*` vs `**bold**`, 링크 문법 등).
- `slackify-markdown` 등 라이브러리 사용. 코드블록 처리는 라이브러리 동작 확인 후 필요 시 wrapper.
- 한 메시지 4000자 초과 시 자동 분할 (스레드 내 추가 메시지로).

### 7.5 스레드 컨텍스트

- 멘션이 도착했을 때 `event.thread_ts`가 있으면 그 스레드의 이전 메시지 fetch.
- 봇 자신의 메시지는 `assistant`, 다른 사람 메시지는 `user`로 매핑. 가장 최근 멘션이 새 user prompt.
- 토큰 절약을 위해 최근 N(예: 6)턴만 유지. 그 이상은 잘라냄.
- 멘션 텍스트에서 `<@U...>` 봇 user id 제거 후 LLM에 전달.

### 7.6 큐 & ACK

- Slack Events는 3초 내 200 OK 안 주면 retry → 멱등성 깨짐. 무조건 즉시 ACK.
- 큐에 들어간 작업은 `MAX_CONCURRENT_AGENTS`만큼 동시 처리.
- 큐가 `QUEUE_MAX_SIZE` 초과면 즉시 "지금 바빠요, 잠시 후 다시 멘션해주세요" 답변.
- Slack retry 헤더(`X-Slack-Retry-Num`) 감지 시 중복 처리 skip.

---

## 8. 슬랙 앱 셋업 체크리스트

수동 작업(api.slack.com → Your Apps):

1. **Create New App** → "From scratch" → 이름 `leader-wiki-bot`, 워크스페이스 선택.
2. **Socket Mode** → Enable. App-level token 생성 (`connections:write` 스코프). → `SLACK_APP_TOKEN`.
3. **OAuth & Permissions** → Bot Token Scopes 추가:
   - `app_mentions:read` (멘션 수신)
   - `chat:write` (답변 게시)
   - `channels:history`, `groups:history`, `im:history`, `mpim:history` (스레드 히스토리 조회)
   - `users:read` (사용자명 표시용, 선택)
4. **Event Subscriptions** → Enable Events.
   - Subscribe to bot events: `app_mention`
   - Socket Mode이므로 Request URL 불필요.
5. **App Home** → "Messages Tab" Enable (DM 지원 시).
6. **Install to Workspace** → 봇 토큰 발급 → `SLACK_BOT_TOKEN`.

---

## 9. 로컬 개발 (docker-compose)

`docker-compose.yml` 골자:

```yaml
services:
  bot:
    build:
      context: .
      dockerfile: docker/Dockerfile
      target: dev
    env_file: .env
    volumes:
      - ../leader-wiki:/workspace/leader-wiki:ro   # sibling 디렉토리 가정
      - ./src:/app/src                              # hot reload
    command: pnpm dev
```

전제: `leader-wiki` 레포와 `leader-wiki-bot` 레포가 동일 부모 디렉토리에 클론되어 있다.

`pnpm dev`는 `tsx watch src/server.ts`로 hot reload.

---

## 10. 프로덕션 배포

1. `docker build -f docker/Dockerfile --target prod -t leader-wiki-bot:latest .`
2. 실행 환경에 `.env` 주입 (시크릿 매니저 권장).
3. 첫 부팅 시 wiki clone, 이후 cron pull.
4. 호스팅 옵션은 사용자가 추후 결정 (Fly.io / Render / 사내 서버 / k8s 등). 컨테이너 1개 + 영구 볼륨(wiki clone 저장용) 정도면 충분.

리소스: 메모리 256~512MB, CPU 0.25~0.5 vCPU면 충분 (Anthropic API가 무거운 일 다 함).

---

## 11. 에러 처리

| 상황 | 처리 |
|---|---|
| Slack 서명 검증 실패 | 401 응답, 로그 |
| 큐 가득 참 | 스레드에 "대기열 가득" 메시지 |
| Anthropic rate limit | 1회 exponential backoff 재시도, 실패 시 사용자에게 안내 |
| 에이전트 타임아웃 | 진행 중 도구 결과 무시, 사용자에게 "응답 지연" 메시지 |
| `wiki/` 디렉토리 비어있음 | "위키가 아직 비어있습니다" 답변 |
| `git pull` 실패 | 이전 상태 유지하고 경고 로그, 에이전트는 계속 동작 |
| Anthropic API 키 없음 | 부팅 단계에서 fail-fast |

모든 사용자 노출 에러 메시지는 한국어. 내부 로그는 영문 + 구조화.

---

## 12. 테스트

- **단위**: `citations.ts`, `slack-format.ts`, `thread-context.ts` 변환 로직.
- **통합**: mock된 Slack 이벤트 → 워커 호출 → mock Anthropic 응답 → 최종 `chat.postMessage` 호출 페이로드 검증.
- **E2E (수동)**: 실제 dev 슬랙 워크스페이스 + 로컬 wiki 사본 + 실제 Claude API. 비용 의식.
- CI: lint(`eslint`) + typecheck + vitest 단위/통합.

---

## 13. 운영 관심사

### 비용 추정 (Sonnet 4.6 기준 가정)
- 1회 질의: input ~10K 토큰(시스템 프롬프트 + 위키 일부) + output ~1K 토큰.
- 위키가 커지면 시스템 프롬프트 부분에 prompt caching 적용해 90% 절감 가능.
- 일 20회 사용 가정 시 월 $10~30 예상 (위키 크기에 따라).

### 관찰성
- pino 구조화 로그(JSON). 최소: 이벤트 ID, thread_ts, user, latency, 토큰 사용량, 인용된 페이지.
- 에러는 stderr로 분리.
- v2에서 Sentry/Datadog 등 검토.

### 보안
- Slack 토큰·Anthropic 키는 env로만 주입, 코드·이미지에 절대 포함 X.
- 봇 컨테이너의 `/workspace/leader-wiki` 마운트는 **read-only**.
- 봇은 위키 git push 권한 절대 보유 X.
- Claude Agent SDK 도구는 `Read`/`Glob`/`Grep`로 한정. `Bash`·`Write`·`Edit` 차단.

---

## 14. 단계별 구현 (MVP → v1)

### Phase 0 — 셋업 (반나절)
- 레포 초기화, pnpm·tsconfig·eslint·vitest·pino 셋업
- `.env.example`, `config.ts` (zod 검증)
- `Dockerfile` 멀티 스테이지 + docker-compose.yml

### Phase 1 — Slack 이벤트 수신 echo (반나절)
- Socket Mode 부팅, `app_mention` 수신 → "안녕하세요" 에코 회신
- 큐·워커 골격, 헬스체크 엔드포인트

### Phase 2 — Wiki 동기화 (반나절)
- 로컬 마운트 모드 우선 검증
- 프로덕션용 clone+cron 로직과 락

### Phase 3 — 에이전트 단발 응답 (1일)
- Claude Agent SDK 통합, 시스템 프롬프트 적용
- 단일 질문 → 위키 탐색 → 한국어 답변 반환
- 인용 변환 + slack mrkdwn 변환

### Phase 4 — 스레드 컨텍스트 (반나절)
- `conversations.replies` 통합, prior turn 주입

### Phase 5 — 에러·운영 마감 (반나절)
- 타임아웃·rate limit 처리, 큐 한도, 사용자용 에러 메시지
- README 작성, 슬랙 앱 셋업 체크리스트 문서화

총 약 3.5~4일 작업 (1인 풀타임 기준).

---

## 15. 미해결 / 추후 결정

- **호스팅 위치**: 일단 로컬 dev + Docker 이미지 빌드까지. 프로덕션 호스팅은 운영 시점에 결정.
- **위키 레포 가시성**: public이면 HTTPS clone, private이면 deploy key 또는 GitHub App.
- **DM 지원 범위**: 일단 채널 멘션 우선, DM은 동일 코드로 자동 지원되지만 검증은 v1 이후.
- **prompt caching 활성화 시점**: 위키가 일정 크기(예: 50 페이지) 넘어가면 켜기.
- **응답에 raw 출처도 포함할지**: 일단 wiki 페이지만. 사용자가 "원본 회의록 보여줘"라고 명시할 때만 raw 인용 확장.
- **다중 워크스페이스 지원**: v1에서는 단일 워크스페이스 가정.

---

## 16. 참고

- 위키 레포: `leader-wiki` (`AGENTS.md` §4.2가 본 봇의 핵심 워크플로우)
- Karpathy LLM Wiki: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Claude Agent SDK (TS): `@anthropic-ai/claude-agent-sdk`
- Slack Bolt (TS): `@slack/bolt`