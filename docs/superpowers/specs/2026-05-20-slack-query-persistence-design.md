# 슬랙 질의 영속화 설계

> 작성일: 2026-05-20
> 대상 레포: `leader-wiki-bot`
> 목적: 슬랙에서 사용자가 봇에게 한 질의·응답을 DB에 영속 저장하여 (1) 운영 분석/통계, (2) 감사·추적 로그 용도로 활용.

---

## 1. Context

### 현행 상태
조사 결과 봇은 슬랙 질의/응답을 **영속 저장하고 있지 않음**:

- `package.json` 의존성에 DB 드라이버 부재 (현 의존성: `@anthropic-ai/claude-agent-sdk`, `@slack/bolt`, `node-cron`, `p-queue`, `pino`, `simple-git`, `slackify-markdown`, `zod`)
- `src/` 하위에 persistence/repository/database 모듈 없음
- `src/worker.ts`는 질문 수신 → 답변 생성 → `chat.postMessage` 후 메모리에서 휘발됨
- pino 구조화 로그가 stdout으로 출력될 뿐, 컨테이너 재시작·로그 회수 시점 이후 추적 불가
- `docs/design.md`의 관찰성/운영 섹션도 v1 비범위로 명시되어 있음

### 동기
운영 시점에 "어떤 질문이 자주 들어오는지", "어느 위키 페이지가 자주 인용되는지", "실패율은 어떤지", "특정 시점의 특정 질의를 재현해야 하는지" 를 SQL로 답할 수 있어야 함. 로그 grep만으로는 한계 명확.

---

## 2. Goals / Non-Goals

### Goals
- 모든 멘션 처리 결과(성공/실패 모두)를 단일 테이블에 영속 저장
- 운영자가 SQL로 자주 묻는 질문, 인용 페이지 빈도, 사용량 추이, 실패 케이스를 분석 가능
- 감사 목적 — 누가/언제/무엇을 물었고 어떤 답변을 받았는지 추적 가능
- 저장 실패가 봇 응답 critical path에 영향 없음
- 운영 모델(단일 컨테이너 + 영구 볼륨)과 정합

### Non-Goals
- 외부 BI 도구·대시보드 연동 (요구 없음)
- 다중 인스턴스/HA 데이터베이스
- 토큰 사용량 저장 (v1 비범위 — Claude Agent SDK에서 안정적으로 추출 방법 검증 필요. 분석에는 latency·횟수가 더 직접적)
- 사용자에게 "내 질문 히스토리" 같은 기능 노출 (서비스 기능이 아니라 운영 데이터)
- 자동 보관 만료/삭제 (v1은 무기한 보관, 필요해지면 별도 스크립트로)

---

## 3. 아키텍처

```
[worker.ts] ──answer 생성 완료/실패──▶ [query-store.ts] ──INSERT──▶ SQLite (queries.db)
                                                │
                                                └─ pino 로그도 그대로 유지(stdout)
```

- 새 모듈 `src/query-store.ts` — better-sqlite3 래퍼, `recordQuery(entry)` 함수 export. worker에 DI로 주입.
- 새 모듈 `src/db.ts` — DB 연결 초기화 + 마이그레이션 러너 (`PRAGMA user_version` 추적).
- `src/server.ts` 부팅 시 DB 초기화 → worker DI에 `recordQuery` 클로저 전달.
- DB 저장 실패는 사용자 응답에 영향 주지 않음. log.error만 남기고 진행 (감사·분석 목적이지 critical path 아님).

### 저장소 선택 — SQLite + better-sqlite3

| Option | 선택 여부 | 이유 |
|---|---|---|
| **SQLite (better-sqlite3)** | ✅ | 파일 기반 영구 볼륨 하나만 추가하면 됨. 단일 컨테이너 운영 모델과 정합. 동기 API로 단순. SQL·인덱스 그대로 활용. 백업 = 파일 복사. |
| PostgreSQL | ✗ | 일 20~수십 건 트래픽에는 명백한 오버엔지니어링. 별도 DB 컨테이너/네트워크/시크릿/백업 정책 추가 비용. 외부 BI 연동 요구 생기면 그때 이관(스키마는 그대로). |
| JSON Lines append | ✗ | 분석 시 매번 grep/jq 필요, 인덱스 없음. 운영 분석 목적과 충돌. |

---

## 4. 데이터 스키마

```sql
-- src/migrations/0001_init.sql
CREATE TABLE queries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,         -- Slack event_id (중복 enqueue 방어)
  received_at     TEXT NOT NULL,                -- ISO8601 UTC, 멘션 수신 시각
  completed_at    TEXT,                         -- 응답/실패 완료 시각
  channel         TEXT NOT NULL,                -- Slack channel id
  thread_ts       TEXT NOT NULL,                -- Slack thread timestamp
  slack_user      TEXT NOT NULL,                -- U... 형식 Slack user id
  question        TEXT NOT NULL,                -- 봇 멘션 제거 후의 본문
  question_raw    TEXT NOT NULL,                -- 원본 text (멘션 포함)
  prior_turns     INTEGER NOT NULL DEFAULT 0,   -- 스레드 컨텍스트 턴 수
  answer          TEXT,                         -- 최종 Slack mrkdwn 답변, 실패 시 NULL
  citations_json  TEXT,                         -- JSON array: ["wiki/페이지A.md", ...]
  model           TEXT NOT NULL,                -- 사용한 모델 식별자
  latency_ms      INTEGER,                      -- received_at → completed_at (계산 후 저장)
  status          TEXT NOT NULL,                -- 'success' | 'empty' | 'timeout' | 'error'
  error_message   TEXT                          -- status != success일 때 에러 요약
);

CREATE INDEX idx_queries_received_at ON queries (received_at);
CREATE INDEX idx_queries_user        ON queries (slack_user);
CREATE INDEX idx_queries_channel     ON queries (channel);
CREATE INDEX idx_queries_status      ON queries (status);
```

### 설계 메모
- **단일 테이블**로 시작. 인용 페이지는 JSON 컬럼 → 분석 시 `json_each()`로 풀어 씀. 사용 패턴 보고 v2에서 별도 `query_citations` 테이블로 정규화.
- `event_id` UNIQUE → Slack retry로 인한 중복 INSERT 방지. 충돌 시 UNIQUE constraint 에러 catch 후 warn 로그만 남기고 정상 종료.
- `status` 값 4가지:
  - `success` — 정상 답변 게시
  - `empty` — 질문이 비었거나 모델이 빈 답변을 반환
  - `timeout` — `AbortError` (모델 응답 타임아웃)
  - `error` — 기타 예외
- 모든 timestamp는 UTC ISO8601 문자열. SQLite `datetime()` 함수로 비교·집계 가능.
- PII 관점 — 위키가 전사 공개이고 채널 메시지 자체가 워크스페이스 자산이므로 question/answer 평문 저장은 허용된다고 판단. 보관 기간은 §7 참고.

---

## 5. 통합 지점

### 5.1 `src/worker.ts` — finalize 패턴 도입

- `WorkerDeps`에 `recordQuery: (entry: QueryRecord) => void` 추가 (better-sqlite3가 동기이므로 sync 시그니처).
- 핸들러 진입 시 `receivedAt`을 캡처.
- 모든 종료 경로(빈 질문, 정상 응답, 빈 응답, 타임아웃, 일반 에러)에서 공통 `finalize(status, opts)` 호출.
- `recordQuery` 호출은 try/catch로 감싸서 DB 실패가 사용자 응답에 전파되지 않도록.

```ts
// 의사 코드 — 구조 변경 골자
return async (event) => {
  const receivedAt = new Date().toISOString();
  const log = deps.logger.child({ eventId: event.eventId, user: event.user });
  const question = event.text.replace(MENTION_RE, '').trim();

  const finalize = (status, opts) => {
    try {
      deps.recordQuery({
        eventId: event.eventId,
        receivedAt,
        completedAt: new Date().toISOString(),
        channel: event.channel,
        threadTs: event.thread_ts,
        slackUser: event.user,
        question,
        questionRaw: event.text,
        priorTurns: opts.priorTurns ?? 0,
        answer: opts.answer ?? null,
        citations: opts.citations ?? null,
        model: deps.model,
        status,
        errorMessage: opts.errorMessage ?? null,
      });
    } catch (err) {
      log.error({ err }, 'failed to persist query record');
    }
  };

  if (!question) { /* post empty msg */ finalize('empty', {}); return; }

  try {
    const priorTurns = await deps.fetchPriorTurns(...);
    const { answer, citations } = await deps.withReadLock(async () => { /* ... */ });
    if (!answer.trim()) { /* post empty msg */ finalize('empty', { priorTurns: priorTurns.length }); return; }
    // post chunks ...
    finalize('success', { priorTurns: priorTurns.length, answer, citations });
  } catch (err) {
    const status = err?.name === 'AbortError' ? 'timeout' : 'error';
    finalize(status, { errorMessage: String(err?.message ?? err) });
    // 기존 사용자 에러 메시지 post는 그대로 유지
  }
};
```

### 5.2 `src/citations.ts` — 인용 페이지 목록 반환

현재 `replaceCitations`는 치환된 문자열만 반환. `{ text: string, citations: string[] }` 형태로 시그니처 변경하여 worker가 인용된 페이지 경로를 그대로 DB에 저장할 수 있게 함. 기존 호출자는 `.text`로 접근하도록 수정.

### 5.3 `src/server.ts`

부팅 시:
1. `openDb(config.QUERY_LOG_DB_PATH)` 호출
2. 마이그레이션 러너 실행
3. `recordQuery` 클로저를 worker DI에 주입

`QUERY_LOG_ENABLED=false`이면 no-op 함수를 주입하여 동일한 코드 경로를 유지.

### 5.4 `src/config.ts` — 환경 변수 추가

| 변수 | 기본값 | 설명 |
|---|---|---|
| `QUERY_LOG_ENABLED` | `true` | 비활성화 시 no-op |
| `QUERY_LOG_DB_PATH` | `/workspace/data/queries.db` | 컨테이너 내부 경로. 호스트의 `<repo>/data/`가 이 위치에 bind mount됨 |

호스트 측에서는 운영자가 `sqlite3 <repo>/data/queries.db` 명령으로 직접 열어 분석·백업 가능.

---

## 6. 마이그레이션

- `src/migrations/` 디렉토리에 SQL 파일을 순번 부여: `0001_init.sql`, `0002_*.sql` …
- 부팅 시 `db.ts`가 `PRAGMA user_version` 확인 → 미적용 파일을 순서대로 트랜잭션 안에서 실행 → 성공 시 `user_version` 증가.
- 별도 마이그레이션 도구(예: drizzle, knex) 도입 없음. 변경 빈도가 낮고 단일 컨테이너 운영이라 자체 러너로 충분.

---

## 7. 운영

### 7.1 저장 위치 — 호스트 로컬 디렉토리 bind mount

운영 모델이 macOS 로컬 PC Docker이므로, DB는 **호스트의 repo 내부 `./data/` 디렉토리**에 직접 저장한다. Docker named volume이 아니라 bind mount로 매핑하여 운영자가 호스트에서 즉시 sqlite 파일을 열 수 있게 한다.

```
<repo>/
├── data/
│   └── queries.db          ← 호스트 측 실제 파일 (gitignored)
├── docker-compose.yml      ← 마운트: ./data:/workspace/data
└── docker-compose.prod.yml ← 마운트: ./data:/workspace/data
```

컨테이너 내부 경로 `/workspace/data`는 read-write로 마운트 (`WIKI_LOCAL_PATH`는 read-only인 것과 대조).

dev/prod 동일 경로 사용 — 별도 분기 없이 단순.

### 7.2 일상 분석·백업

호스트에서 직접:

```bash
# 분석
sqlite3 ./data/queries.db 'SELECT status, COUNT(*) FROM queries GROUP BY status;'

# 백업 (수동)
cp ./data/queries.db ./data/queries.db.bak.$(date +%F)
```

자동 백업 cron 등은 v1 범위 외. 필요 시 LaunchAgent 추가(`docs/operations.md`에 가이드).

### 7.3 보관 정책
v1은 무기한 보관. 일 수십 건 트래픽으로 수년치 누적해도 메가바이트 수준. 필요해지면 `DELETE FROM queries WHERE received_at < ?` 스크립트 추가(별도 PR).

### 7.4 DB 손상 영향
DB 손상/락 시에도 봇은 정지하지 않음. `recordQuery` 실패 시 log.error만 남기고 사용자 응답은 계속 제공.

---

## 8. 에러 처리

| 상황 | 처리 |
|---|---|
| DB 파일 열기 실패 (부팅 시) | log.error 후 봇은 정상 부팅. `recordQuery`는 no-op으로 대체. 헬스체크 통과. |
| 마이그레이션 실패 | 부팅 fail-fast (운영자가 인지해서 수동 조치 필요한 케이스) |
| INSERT UNIQUE constraint 충돌 | warn 로그만 남기고 정상 종료(Slack retry 중복 케이스) |
| 기타 INSERT 실패 | error 로그만 남기고 사용자 응답 흐름 계속 |
| `QUERY_LOG_ENABLED=false` | no-op 함수 주입 → 코드 경로 동일, 저장만 생략 |

---

## 9. 테스트

### 단위
- `tests/query-store.test.ts` (신규) — 임시 파일 DB로 INSERT 성공, UNIQUE constraint 동작, 마이그레이션이 빈 DB에 정상 적용되는지 검증.
- `tests/citations.test.ts` (수정) — 기존 어서션 + 반환된 `citations` 배열이 인용된 페이지 경로들을 정확히 포함하는지 검증.
- `tests/worker.test.ts` (신규 또는 기존 확장) — mocked `recordQuery`가 각 status(`success`/`empty`/`timeout`/`error`)별로 호출되는지, 그리고 `recordQuery`가 throw해도 사용자 응답 흐름이 영향받지 않는지 검증.

### 통합/E2E
- 수동 — `docs/operations.md`에 "한 번 멘션 후 `sqlite3 queries.db 'SELECT * FROM queries'`로 row 추가 확인" 절차 추가.

---

## 10. 변경 파일 요약

| 파일 | 변경 종류 |
|---|---|
| `src/db.ts` | 신규 — DB 열기, 마이그레이션 러너 |
| `src/query-store.ts` | 신규 — `recordQuery`, `QueryRecord` 타입 |
| `src/migrations/0001_init.sql` | 신규 — 스키마 |
| `src/citations.ts` | 수정 — `{ text, citations: string[] }` 반환 |
| `src/worker.ts` | 수정 — finalize 패턴, `recordQuery` DI |
| `src/server.ts` | 수정 — DB 부팅, worker DI에 store 주입 |
| `src/config.ts` | 수정 — `QUERY_LOG_DB_PATH`, `QUERY_LOG_ENABLED` 추가 |
| `package.json` | 수정 — `better-sqlite3` + `@types/better-sqlite3` 추가 |
| `docker-compose.yml`, `docker-compose.prod.yml` | 수정 — `./data:/workspace/data` bind mount 추가 (호스트 로컬 DB) |
| `.env.example` | 수정 — 새 변수 명시 |
| `.gitignore` | 수정 — `data/` 추가 |
| `docs/design.md` | 수정 — 관찰성 섹션에 query log 추가 |
| `docs/operations.md` | 수정 — 백업/분석 가이드 추가 |
| `tests/query-store.test.ts` | 신규 |
| `tests/worker.test.ts` (또는 기존 확장) | 신규/수정 |
| `tests/citations.test.ts` | 수정 |

---

## 11. 향후 확장 (v2 이후)

- `query_citations` 테이블로 정규화 (페이지 빈도 분석 가속)
- 토큰 사용량 컬럼 추가 (SDK에서 추출 안정화 후)
- 보관 만료 자동화 스크립트
- 외부 BI/대시보드 연동 시 PostgreSQL 이관 — 스키마 그대로 들고 갈 수 있게 설계함
