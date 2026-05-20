# 슬랙 질의 영속화 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 슬랙 멘션 처리 결과(성공/실패 포함)를 호스트 로컬 SQLite DB에 영속 저장하여 운영 분석/감사 로그 용도로 사용한다.

**Architecture:** worker가 답변 생성 후/실패 후 공통 `finalize()`로 새 모듈 `query-store.ts`(better-sqlite3 동기 래퍼)에 row 1개를 INSERT한다. DB 파일은 호스트 `<repo>/data/queries.db`에 위치하고 Docker는 `./data:/workspace/data` bind mount로 연결. 부팅 시 `db.ts`의 마이그레이션 러너가 `PRAGMA user_version` 기반으로 `src/migrations/` 하위 SQL을 순차 적용한다. DB 실패는 critical path가 아니므로 사용자 응답에는 영향 없음.

**Tech Stack:** Node.js 22, TypeScript ESM, better-sqlite3, vitest, zod, Docker (bind mount).

**Spec:** [docs/superpowers/specs/2026-05-20-slack-query-persistence-design.md](../specs/2026-05-20-slack-query-persistence-design.md)

---

## File Structure

**Create:**
- `src/db.ts` — DB 연결 + 마이그레이션 러너
- `src/query-store.ts` — `recordQuery()` + `QueryRecord` 타입
- `src/migrations/0001_init.sql` — 초기 스키마
- `tests/db.test.ts` — 마이그레이션 러너 단위 테스트
- `tests/query-store.test.ts` — INSERT/UNIQUE constraint 단위 테스트
- `tests/worker-record.test.ts` — finalize 호출 검증

**Modify:**
- `src/config.ts` — `QUERY_LOG_ENABLED`, `QUERY_LOG_DB_PATH` 추가
- `src/citations.ts` — `replaceCitations` 반환 `{ text, citations }`
- `src/worker.ts` — `recordQuery` DI + finalize 패턴
- `src/server.ts` — DB 부팅, worker DI에 store 주입
- `src/page-index.ts` — 새 citations 시그니처 반영 (영향 미미)
- `tests/citations.test.ts` — 새 반환 시그니처에 맞춰 어서션 조정
- `package.json` — `better-sqlite3`, `@types/better-sqlite3` 의존성
- `docker-compose.yml`, `docker-compose.prod.yml` — `./data:/workspace/data` bind mount
- `docker/Dockerfile` — better-sqlite3 native build를 위한 deps stage 빌드 도구 (필요 시)
- `.env.example` — 새 환경 변수
- `.gitignore` — `data/` 추가
- `docs/design.md` — 관찰성 섹션에 query log 추가
- `docs/operations.md` — DB 분석/백업 가이드 추가

---

## Task 1: 의존성 설치 + Docker 빌드 검증

**Files:**
- Modify: `package.json`
- Modify: `docker/Dockerfile`

- [ ] **Step 1: better-sqlite3 + 타입 추가**

```bash
pnpm add better-sqlite3
pnpm add -D @types/better-sqlite3
```

기대: `package.json` `dependencies`에 `better-sqlite3`(`^11` 또는 그 시점 최신), `devDependencies`에 `@types/better-sqlite3`이 추가됨.

- [ ] **Step 2: 네이티브 설치 확인**

```bash
node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec('CREATE TABLE t (x INTEGER)'); console.log('ok');"
```

기대 출력: `ok`. 실패하면 prebuilt binary가 없는 환경이거나 Node ABI 불일치. 그 경우 Step 3로.

- [ ] **Step 3: (조건부) Dockerfile deps stage에 빌드 도구 추가**

Step 2가 호스트에서 성공했어도, Alpine 컨테이너에서 prebuilt가 다운로드 안 될 수 있음. `docker/Dockerfile`의 `base` stage `apk add` 라인을 다음으로 교체:

```dockerfile
RUN corepack enable && apk add --no-cache git openssh-client tini \
    && apk add --no-cache --virtual .build-deps python3 make g++
```

그리고 `deps` stage 끝에 빌드 도구 제거:

```dockerfile
FROM base AS deps
RUN pnpm install --frozen-lockfile
RUN apk del .build-deps
```

이렇게 하면 prod 이미지에 빌드 도구가 leak되지 않음 (prod는 build stage의 `node_modules`만 복사).

- [ ] **Step 4: Docker 빌드 검증**

```bash
docker compose -f docker-compose.prod.yml build bot
```

기대: 빌드 성공. better-sqlite3가 .node 바이너리를 생성/다운로드함.

- [ ] **Step 5: 커밋**

```bash
git add package.json pnpm-lock.yaml docker/Dockerfile
git commit -m "feat(deps): better-sqlite3 추가 및 Alpine 네이티브 빌드 설정"
```

---

## Task 2: 환경 변수 추가 (config.ts)

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: 실패 테스트 작성**

`tests/config.test.ts`에 다음 케이스를 추가 (파일 끝의 describe 블록 내에):

```ts
it('QUERY_LOG_ENABLED 기본값은 true, QUERY_LOG_DB_PATH 기본값은 /workspace/data/queries.db', () => {
  withEnv(
    {
      SLACK_BOT_TOKEN: 'xoxb-x',
      SLACK_APP_TOKEN: 'xapp-x',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      WIKI_LOCAL_PATH: '/w',
      WIKI_REPO_GITHUB_URL: 'https://github.com/o/r',
    },
    () => {
      const cfg = loadConfig();
      expect(cfg.QUERY_LOG_ENABLED).toBe(true);
      expect(cfg.QUERY_LOG_DB_PATH).toBe('/workspace/data/queries.db');
    },
  );
});

it('QUERY_LOG_ENABLED=false 로 비활성화 가능', () => {
  withEnv(
    {
      SLACK_BOT_TOKEN: 'xoxb-x',
      SLACK_APP_TOKEN: 'xapp-x',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      WIKI_LOCAL_PATH: '/w',
      WIKI_REPO_GITHUB_URL: 'https://github.com/o/r',
      QUERY_LOG_ENABLED: 'false',
      QUERY_LOG_DB_PATH: '/tmp/q.db',
    },
    () => {
      const cfg = loadConfig();
      expect(cfg.QUERY_LOG_ENABLED).toBe(false);
      expect(cfg.QUERY_LOG_DB_PATH).toBe('/tmp/q.db');
    },
  );
});
```

`withEnv`는 기존 `tests/config.test.ts`의 헬퍼를 사용. 없다면 케이스 위에 동일 패턴으로 헬퍼 정의 (직접 `process.env` 백업/복원).

- [ ] **Step 2: 테스트 실패 확인**

```bash
pnpm test tests/config.test.ts
```

기대: 새 테스트 2개 FAIL (필드 미정의).

- [ ] **Step 3: `src/config.ts` 스키마 확장**

`Schema = z.object({...})` 안에 다음을 추가:

```ts
QUERY_LOG_ENABLED: z
  .preprocess((v) => {
    if (v === undefined || v === '') return true;
    if (v === 'false' || v === '0') return false;
    if (v === 'true' || v === '1') return true;
    return v;
  }, z.boolean())
  .default(true),
QUERY_LOG_DB_PATH: z.string().min(1).default('/workspace/data/queries.db'),
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
pnpm test tests/config.test.ts
```

기대: 전체 PASS.

- [ ] **Step 5: `.env.example` 업데이트**

기존 `.env.example` 끝에 다음 섹션 추가:

```
# 질의 로그 (호스트 ./data/ 에 bind mount된 SQLite)
QUERY_LOG_ENABLED=true
QUERY_LOG_DB_PATH=/workspace/data/queries.db
```

- [ ] **Step 6: 커밋**

```bash
git add src/config.ts tests/config.test.ts .env.example
git commit -m "feat(config): QUERY_LOG_ENABLED, QUERY_LOG_DB_PATH 환경 변수 추가"
```

---

## Task 3: 마이그레이션 SQL 작성

**Files:**
- Create: `src/migrations/0001_init.sql`

- [ ] **Step 1: 디렉토리 생성 및 SQL 작성**

`src/migrations/0001_init.sql`:

```sql
-- 슬랙 멘션 질의/응답 1건당 1 row
CREATE TABLE queries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  received_at     TEXT NOT NULL,
  completed_at    TEXT,
  channel         TEXT NOT NULL,
  thread_ts       TEXT NOT NULL,
  slack_user      TEXT NOT NULL,
  question        TEXT NOT NULL,
  question_raw    TEXT NOT NULL,
  prior_turns     INTEGER NOT NULL DEFAULT 0,
  answer          TEXT,
  citations_json  TEXT,
  model           TEXT NOT NULL,
  latency_ms      INTEGER,
  status          TEXT NOT NULL,
  error_message   TEXT
);

CREATE INDEX idx_queries_received_at ON queries (received_at);
CREATE INDEX idx_queries_user        ON queries (slack_user);
CREATE INDEX idx_queries_channel     ON queries (channel);
CREATE INDEX idx_queries_status      ON queries (status);
```

- [ ] **Step 2: tsconfig가 SQL 파일을 빌드 산출물에 포함하는지 확인**

`tsconfig.json` 확인. 별도 `include`로 SQL을 다루지 않으므로 빌드 시 `dist/`에 복사되지 않음. Task 8(server.ts)에서 마이그레이션 로더가 SQL을 어떻게 읽는지에 따라 처리. 본 계획은 **마이그레이션 SQL을 TS 모듈에 인라인 string으로 두지 않고 별도 SQL 파일로 두되, `db.ts`에서 `import.meta.url` 기준 상대경로로 읽는다**. 빌드 시 `dist/src/migrations/`에 SQL이 있어야 하므로 Task 8 step에서 Dockerfile 또는 build script가 SQL을 복사하도록 한다.

다만 더 단순한 길은 **SQL을 TS에 인라인**으로 두는 것. 마이그레이션이 1개이고 향후도 가벼우므로 인라인 채택. 본 step에서 작성한 `0001_init.sql`은 **레퍼런스 보관용**으로 둔다 (사람이 읽기 좋음). 실제 실행은 `db.ts`의 인라인 상수로 한다 — Task 4에서 정의.

(따라서 SQL 파일 자체는 코드 경로에서 사용되지 않지만 마이그레이션 이력 문서로 유지)

- [ ] **Step 3: 커밋**

```bash
git add src/migrations/0001_init.sql
git commit -m "feat(db): 초기 마이그레이션 SQL 추가"
```

---

## Task 4: DB 모듈 작성 (`src/db.ts`)

**Files:**
- Create: `src/db.ts`
- Create: `tests/db.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`tests/db.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runMigrations } from '../src/db.js';

const tmpDirs: string[] = [];
function makeTmp() {
  const d = mkdtempSync(join(tmpdir(), 'qlog-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('db', () => {
  it('빈 DB에 마이그레이션 적용 후 queries 테이블 존재', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'q.db');
    const db = openDb(dbPath);
    runMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='queries'")
      .get();
    expect(row).toBeTruthy();
  });

  it('마이그레이션은 멱등 — 두 번 호출해도 에러 없음', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'q.db');
    const db = openDb(dbPath);
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const v = (db.pragma('user_version', { simple: true }) as number);
    expect(v).toBe(1);
  });

  it('상위 디렉토리가 없어도 자동 생성', () => {
    const dir = makeTmp();
    const dbPath = join(dir, 'nested', 'deep', 'q.db');
    expect(() => openDb(dbPath)).not.toThrow();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
pnpm test tests/db.test.ts
```

기대: FAIL (`src/db.ts` 없음).

- [ ] **Step 3: 구현**

`src/db.ts`:

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE queries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id        TEXT NOT NULL UNIQUE,
        received_at     TEXT NOT NULL,
        completed_at    TEXT,
        channel         TEXT NOT NULL,
        thread_ts       TEXT NOT NULL,
        slack_user      TEXT NOT NULL,
        question        TEXT NOT NULL,
        question_raw    TEXT NOT NULL,
        prior_turns     INTEGER NOT NULL DEFAULT 0,
        answer          TEXT,
        citations_json  TEXT,
        model           TEXT NOT NULL,
        latency_ms      INTEGER,
        status          TEXT NOT NULL,
        error_message   TEXT
      );
      CREATE INDEX idx_queries_received_at ON queries (received_at);
      CREATE INDEX idx_queries_user        ON queries (slack_user);
      CREATE INDEX idx_queries_channel     ON queries (channel);
      CREATE INDEX idx_queries_status      ON queries (status);
    `,
  },
];

export function openDb(filePath: string): Db {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
pnpm test tests/db.test.ts
```

기대: 3 PASS.

- [ ] **Step 5: 타입체크**

```bash
pnpm typecheck
```

기대: 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat(db): SQLite 연결 및 마이그레이션 러너 추가"
```

---

## Task 5: query-store.ts 작성

**Files:**
- Create: `src/query-store.ts`
- Create: `tests/query-store.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`tests/query-store.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runMigrations } from '../src/db.js';
import { createQueryStore, type QueryRecord } from '../src/query-store.js';

const tmpDirs: string[] = [];
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'qstore-'));
  tmpDirs.push(dir);
  const db = openDb(join(dir, 'q.db'));
  runMigrations(db);
  return { db, store: createQueryStore(db) };
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const baseRecord: QueryRecord = {
  eventId: 'evt-1',
  receivedAt: '2026-05-20T00:00:00.000Z',
  completedAt: '2026-05-20T00:00:02.000Z',
  channel: 'C123',
  threadTs: '1716163200.000100',
  slackUser: 'U999',
  question: '프로젝트 알파 진행 상황은?',
  questionRaw: '<@UBOT> 프로젝트 알파 진행 상황은?',
  priorTurns: 0,
  answer: '진행 중입니다.',
  citations: ['wiki/프로젝트-알파.md'],
  model: 'claude-sonnet-4-6',
  status: 'success',
  errorMessage: null,
};

describe('query-store', () => {
  it('성공 row INSERT 후 SELECT로 확인', () => {
    const { db, store } = makeStore();
    store.recordQuery(baseRecord);
    const row = db.prepare('SELECT * FROM queries WHERE event_id=?').get('evt-1') as Record<string, unknown>;
    expect(row.status).toBe('success');
    expect(row.question).toBe('프로젝트 알파 진행 상황은?');
    expect(JSON.parse(row.citations_json as string)).toEqual(['wiki/프로젝트-알파.md']);
    expect(row.latency_ms).toBe(2000);
  });

  it('citations 빈 배열도 정상 저장', () => {
    const { db, store } = makeStore();
    store.recordQuery({ ...baseRecord, citations: [] });
    const row = db.prepare('SELECT citations_json FROM queries WHERE event_id=?').get('evt-1') as { citations_json: string };
    expect(JSON.parse(row.citations_json)).toEqual([]);
  });

  it('citations null이면 citations_json은 NULL', () => {
    const { db, store } = makeStore();
    store.recordQuery({ ...baseRecord, citations: null });
    const row = db.prepare('SELECT citations_json FROM queries WHERE event_id=?').get('evt-1') as { citations_json: string | null };
    expect(row.citations_json).toBeNull();
  });

  it('동일 event_id 두 번 INSERT 시 UNIQUE constraint 에러를 던지지 않고 무시', () => {
    const { db, store } = makeStore();
    store.recordQuery(baseRecord);
    expect(() => store.recordQuery({ ...baseRecord, question: '다른 질문' })).not.toThrow();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM queries').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('error 상태는 answer NULL, error_message 보존', () => {
    const { db, store } = makeStore();
    store.recordQuery({
      ...baseRecord,
      eventId: 'evt-err',
      answer: null,
      citations: null,
      status: 'error',
      errorMessage: 'rate limited',
    });
    const row = db.prepare('SELECT * FROM queries WHERE event_id=?').get('evt-err') as Record<string, unknown>;
    expect(row.answer).toBeNull();
    expect(row.status).toBe('error');
    expect(row.error_message).toBe('rate limited');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
pnpm test tests/query-store.test.ts
```

기대: FAIL (`src/query-store.ts` 없음).

- [ ] **Step 3: 구현**

`src/query-store.ts`:

```ts
import type { Db } from './db.js';

export type QueryStatus = 'success' | 'empty' | 'timeout' | 'error';

export interface QueryRecord {
  eventId: string;
  receivedAt: string;
  completedAt: string;
  channel: string;
  threadTs: string;
  slackUser: string;
  question: string;
  questionRaw: string;
  priorTurns: number;
  answer: string | null;
  citations: string[] | null;
  model: string;
  status: QueryStatus;
  errorMessage: string | null;
}

export interface QueryStore {
  recordQuery: (entry: QueryRecord) => void;
}

const INSERT_SQL = `
  INSERT INTO queries (
    event_id, received_at, completed_at, channel, thread_ts, slack_user,
    question, question_raw, prior_turns, answer, citations_json,
    model, latency_ms, status, error_message
  ) VALUES (
    @eventId, @receivedAt, @completedAt, @channel, @threadTs, @slackUser,
    @question, @questionRaw, @priorTurns, @answer, @citationsJson,
    @model, @latencyMs, @status, @errorMessage
  )
`;

function computeLatency(receivedAt: string, completedAt: string): number | null {
  const start = Date.parse(receivedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

export function createQueryStore(db: Db): QueryStore {
  const stmt = db.prepare(INSERT_SQL);
  return {
    recordQuery: (entry) => {
      const params = {
        eventId: entry.eventId,
        receivedAt: entry.receivedAt,
        completedAt: entry.completedAt,
        channel: entry.channel,
        threadTs: entry.threadTs,
        slackUser: entry.slackUser,
        question: entry.question,
        questionRaw: entry.questionRaw,
        priorTurns: entry.priorTurns,
        answer: entry.answer,
        citationsJson: entry.citations === null ? null : JSON.stringify(entry.citations),
        model: entry.model,
        latencyMs: computeLatency(entry.receivedAt, entry.completedAt),
        status: entry.status,
        errorMessage: entry.errorMessage,
      };
      try {
        stmt.run(params);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
          // Slack retry로 인한 중복 event_id — 정상 무시
          return;
        }
        throw err;
      }
    },
  };
}

export function noopQueryStore(): QueryStore {
  return { recordQuery: () => {} };
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
pnpm test tests/query-store.test.ts
```

기대: 5 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/query-store.ts tests/query-store.test.ts
git commit -m "feat(query-store): SQLite INSERT 래퍼와 UNIQUE 충돌 무시 로직"
```

---

## Task 6: citations.ts 시그니처 변경

**Files:**
- Modify: `src/citations.ts`
- Modify: `tests/citations.test.ts`

기존 `replaceCitations` 호출자는 `src/worker.ts` 한 곳뿐. 시그니처를 `{ text: string, citations: string[] }` 반환으로 바꿔도 영향 작음.

- [ ] **Step 1: 테스트 갱신 (실패 유도)**

`tests/citations.test.ts`의 3개 케이스를 다음과 같이 변경 + 새 케이스 추가:

```ts
it('알려진 페이지명은 slack 링크로 치환', () => {
  const out = replaceCitations('자세한 건 [[프로젝트-알파]] 참고', {
    pages,
    githubBaseUrl: githubBase,
    branch: 'main',
  });
  expect(out.text).toBe(
    '자세한 건 <https://github.com/amass/leader-wiki/blob/main/wiki/%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8-%EC%95%8C%ED%8C%8C.md|프로젝트-알파> 참고',
  );
  expect(out.citations).toEqual(['wiki/프로젝트-알파.md']);
});

it('표시 텍스트가 있는 형식도 처리: [[페이지|텍스트]]', () => {
  const out = replaceCitations('[[김아무개|아무개]] 님', {
    pages,
    githubBaseUrl: githubBase,
    branch: 'main',
  });
  expect(out.text).toContain('|아무개>');
  expect(out.text).toContain('wiki/people/');
  expect(out.citations).toEqual(['wiki/people/김아무개.md']);
});

it('알 수 없는 페이지명은 원본 유지, citations는 빈 배열', () => {
  const out = replaceCitations('[[없는페이지]]', {
    pages,
    githubBaseUrl: githubBase,
    branch: 'main',
  });
  expect(out.text).toBe('[[없는페이지]]');
  expect(out.citations).toEqual([]);
});

it('같은 페이지를 여러 번 인용해도 citations는 중복 제거', () => {
  const out = replaceCitations('[[프로젝트-알파]] 그리고 다시 [[프로젝트-알파]]', {
    pages,
    githubBaseUrl: githubBase,
    branch: 'main',
  });
  expect(out.citations).toEqual(['wiki/프로젝트-알파.md']);
});
```

(`buildPageIndex` 테스트는 변경 없음)

- [ ] **Step 2: 테스트 실패 확인**

```bash
pnpm test tests/citations.test.ts
```

기대: replaceCitations 관련 케이스가 모두 FAIL.

- [ ] **Step 3: `src/citations.ts` 구현 변경**

`replaceCitations` 함수를 다음으로 교체:

```ts
export interface CitationResult {
  text: string;
  citations: string[];
}

export function replaceCitations(text: string, ctx: CitationContext): CitationResult {
  const seen = new Set<string>();
  const replaced = text.replace(WIKILINK_RE, (match, raw: string, display?: string) => {
    const name = raw.trim();
    const path = ctx.pages.get(name);
    if (!path) return match;
    seen.add(path);
    const url = `${ctx.githubBaseUrl}/blob/${ctx.branch}/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const label = (display ?? name).trim();
    return `<${url}|${label}>`;
  });
  return { text: replaced, citations: Array.from(seen) };
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
pnpm test tests/citations.test.ts
```

기대: 5 PASS (기존 buildPageIndex 1 + replaceCitations 4).

- [ ] **Step 5: 호출자 컴파일 에러 확인 (의도된 실패)**

```bash
pnpm typecheck
```

기대: `src/worker.ts`에서 `replaceCitations(...)` 결과를 string처럼 사용하는 곳에서 타입 에러. Task 7에서 수정 예정. 이번 커밋은 typecheck를 일부러 깨진 채 두지 않기 위해 Task 7과 한 PR로 묶지만, 커밋은 분리해서 한다.

- [ ] **Step 6: 커밋 (worker는 다음 task에서 함께 수정될 예정)**

```bash
git add src/citations.ts tests/citations.test.ts
git commit -m "refactor(citations): replaceCitations 반환을 {text,citations}로 확장"
```

(typecheck 실패는 다음 task에서 즉시 해소되므로 무방. 작업자는 곧바로 Task 7로 진행.)

---

## Task 7: worker.ts에 finalize 패턴 도입

**Files:**
- Modify: `src/worker.ts`
- Create: `tests/worker-record.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`tests/worker-record.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { createWorker, type MentionEvent } from '../src/worker.js';
import type { QueryRecord } from '../src/query-store.js';

const silentLogger = pino({ level: 'silent' });

function makeDeps(overrides: Partial<Parameters<typeof createWorker>[0]> = {}) {
  const recorded: QueryRecord[] = [];
  const posted: { text: string }[] = [];
  const deps = {
    logger: silentLogger,
    postMessage: vi.fn(async (m: { channel: string; thread_ts: string; text: string }) => {
      posted.push({ text: m.text });
    }),
    fetchPriorTurns: vi.fn(async () => []),
    withReadLock: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    wikiPath: '/tmp/wiki',
    githubBaseUrl: 'https://github.com/o/r',
    branch: 'main',
    model: 'claude-sonnet-4-6',
    timeoutMs: 30_000,
    recordQuery: (r: QueryRecord) => {
      recorded.push(r);
    },
    runAgent: vi.fn(async () => 'OK'),
    scanWikiPages: vi.fn(async () => new Map<string, string>()),
    ...overrides,
  };
  return { deps, recorded, posted };
}

const baseEvent: MentionEvent = {
  channel: 'C1',
  thread_ts: '111.222',
  user: 'U1',
  text: '<@UBOT> 안녕',
  eventId: 'evt-x',
  botUserId: 'UBOT',
};

describe('worker finalize', () => {
  it('정상 흐름은 status=success로 1건 기록', async () => {
    const { deps, recorded } = makeDeps();
    const worker = createWorker(deps);
    await worker(baseEvent);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].status).toBe('success');
    expect(recorded[0].question).toBe('안녕');
    expect(recorded[0].eventId).toBe('evt-x');
  });

  it('빈 질문은 status=empty', async () => {
    const { deps, recorded } = makeDeps();
    const worker = createWorker(deps);
    await worker({ ...baseEvent, text: '<@UBOT>' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].status).toBe('empty');
  });

  it('AbortError는 status=timeout', async () => {
    const { deps, recorded } = makeDeps({
      runAgent: vi.fn(async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }),
    });
    const worker = createWorker(deps);
    await worker(baseEvent);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].status).toBe('timeout');
  });

  it('기타 예외는 status=error + errorMessage 보존', async () => {
    const { deps, recorded } = makeDeps({
      runAgent: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    });
    const worker = createWorker(deps);
    await worker(baseEvent);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].status).toBe('error');
    expect(recorded[0].errorMessage).toBe('rate limited');
  });

  it('recordQuery 실패해도 사용자 응답 흐름은 정상', async () => {
    const { deps, posted } = makeDeps({
      recordQuery: () => {
        throw new Error('disk full');
      },
    });
    const worker = createWorker(deps);
    await expect(worker(baseEvent)).resolves.toBeUndefined();
    expect(posted.length).toBeGreaterThan(0);
  });
});
```

이 테스트는 `runAgent`와 `scanWikiPages`를 DI로 주입할 수 있다고 가정함. 현재 `worker.ts`는 이들을 직접 import하므로 그 부분도 함께 리팩터링.

- [ ] **Step 2: 테스트 실패 확인**

```bash
pnpm test tests/worker-record.test.ts
```

기대: FAIL (필드 미정의 / 시그니처 불일치).

- [ ] **Step 3: `src/worker.ts` 재작성**

```ts
import type { Logger } from './logger.js';
import { askAgent as defaultAskAgent, type PriorTurn } from './agent.js';
import { replaceCitations } from './citations.js';
import { scanWikiPages as defaultScanWikiPages } from './page-index.js';
import { toSlackMrkdwn, splitForSlack } from './slack-format.js';
import type { QueryRecord, QueryStatus } from './query-store.js';

export interface MentionEvent {
  channel: string;
  thread_ts: string;
  user: string;
  text: string;
  eventId: string;
  botUserId: string;
}

export interface WorkerDeps {
  logger: Logger;
  postMessage: (args: { channel: string; thread_ts: string; text: string }) => Promise<void>;
  fetchPriorTurns: (channel: string, thread_ts: string, botUserId: string) => Promise<PriorTurn[]>;
  withReadLock: <T>(fn: () => Promise<T>) => Promise<T>;
  wikiPath: string;
  githubBaseUrl: string;
  branch: string;
  model: string;
  timeoutMs: number;
  recordQuery: (entry: QueryRecord) => void;
  runAgent?: typeof defaultAskAgent;
  scanWikiPages?: typeof defaultScanWikiPages;
}

const MENTION_RE = /<@[A-Z0-9]+>/g;

export function createWorker(deps: WorkerDeps) {
  const runAgent = deps.runAgent ?? defaultAskAgent;
  const scanWikiPages = deps.scanWikiPages ?? defaultScanWikiPages;

  return async (event: MentionEvent): Promise<void> => {
    const receivedAt = new Date().toISOString();
    const log = deps.logger.child({ eventId: event.eventId, user: event.user });
    const question = event.text.replace(MENTION_RE, '').trim();

    const finalize = (
      status: QueryStatus,
      opts: {
        priorTurns?: number;
        answer?: string | null;
        citations?: string[] | null;
        errorMessage?: string | null;
      },
    ) => {
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

    if (!question) {
      await deps.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: '질문 내용이 비어있습니다. `@leader-wiki-bot <질문>` 형식으로 멘션해주세요.',
      });
      finalize('empty', {});
      return;
    }

    let priorTurnsCount = 0;
    try {
      const priorTurns = await deps.fetchPriorTurns(event.channel, event.thread_ts, event.botUserId);
      priorTurnsCount = priorTurns.length;
      log.info({ priorTurns: priorTurnsCount }, 'gathered thread context');

      const { answer, citations } = await deps.withReadLock(async () => {
        const pages = await scanWikiPages(deps.wikiPath);
        const raw = await runAgent(
          { question, priorTurns },
          { cwd: deps.wikiPath, model: deps.model, timeoutMs: deps.timeoutMs, logger: log },
        );
        const cited = replaceCitations(raw, {
          pages,
          githubBaseUrl: deps.githubBaseUrl,
          branch: deps.branch,
        });
        return { answer: toSlackMrkdwn(cited.text), citations: cited.citations };
      });

      if (!answer.trim()) {
        await deps.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: '답변을 생성할 수 없었습니다. 잠시 후 다시 시도해주세요.',
        });
        finalize('empty', { priorTurns: priorTurnsCount });
        return;
      }

      const chunks = splitForSlack(answer);
      for (const chunk of chunks) {
        await deps.postMessage({ channel: event.channel, thread_ts: event.thread_ts, text: chunk });
      }

      finalize('success', { priorTurns: priorTurnsCount, answer, citations });
    } catch (err) {
      log.error({ err }, 'worker failed');
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = isAbort
        ? '응답이 지연되어 중단되었습니다. 잠시 후 다시 시도해주세요.'
        : '답변 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
      await deps.postMessage({ channel: event.channel, thread_ts: event.thread_ts, text: msg });
      finalize(isAbort ? 'timeout' : 'error', {
        priorTurns: priorTurnsCount,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
pnpm test tests/worker-record.test.ts tests/citations.test.ts
```

기대: 둘 다 PASS.

- [ ] **Step 5: 전체 typecheck**

```bash
pnpm typecheck
```

기대: 에러 없음 (server.ts는 다음 task에서 `recordQuery` DI를 주입해야 컴파일됨 — 이때 missing field 에러가 날 것임. 발생 시 즉시 Task 8로 진행).

- [ ] **Step 6: 커밋**

```bash
git add src/worker.ts tests/worker-record.test.ts
git commit -m "feat(worker): finalize 패턴으로 모든 종료 경로에서 질의 기록"
```

---

## Task 8: server.ts에서 DB 부팅 + DI 연결

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: server.ts 변경**

`src/server.ts` 상단 import 영역에 추가:

```ts
import { openDb, runMigrations } from './db.js';
import { createQueryStore, noopQueryStore, type QueryStore } from './query-store.js';
```

`const wikiSync = createWikiSync({...});` 호출 직전에 다음 블록 삽입:

```ts
let queryStore: QueryStore;
if (config.QUERY_LOG_ENABLED) {
  try {
    const db = openDb(config.QUERY_LOG_DB_PATH);
    runMigrations(db);
    queryStore = createQueryStore(db);
    logger.info({ path: config.QUERY_LOG_DB_PATH }, 'query log enabled');
  } catch (err) {
    logger.error({ err }, 'failed to open query log DB — falling back to noop');
    queryStore = noopQueryStore();
  }
} else {
  queryStore = noopQueryStore();
  logger.info('query log disabled');
}
```

`createWorker({...})` 호출에 다음 필드 추가:

```ts
recordQuery: (entry) => queryStore.recordQuery(entry),
```

(다른 필드는 기존 그대로 유지)

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

기대: 에러 없음.

- [ ] **Step 3: 빌드 검증**

```bash
pnpm build
```

기대: 성공.

- [ ] **Step 4: 전체 테스트**

```bash
pnpm test
```

기대: 모든 테스트 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/server.ts
git commit -m "feat(server): 부팅 시 query log DB 초기화 및 worker에 주입"
```

---

## Task 9: Docker bind mount + .gitignore + .env.example 확인

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`
- Modify: `.gitignore`

- [ ] **Step 1: `docker-compose.yml` 수정**

`bot.volumes` 리스트에 다음 한 줄 추가:

```yaml
      - ./data:/workspace/data
```

전체 volumes 블록 예시:

```yaml
    volumes:
      - ../leader-wiki:/workspace/leader-wiki:ro
      - ./src:/app/src
      - ./tests:/app/tests
      - ./package.json:/app/package.json:ro
      - ./tsconfig.json:/app/tsconfig.json:ro
      - ./data:/workspace/data
```

`bot.environment`에 `QUERY_LOG_DB_PATH: /workspace/data/queries.db` 명시 (이미 default라 생략 가능하지만 명시적 문서화 가치).

- [ ] **Step 2: `docker-compose.prod.yml` 수정**

`bot.volumes`에 동일 한 줄 추가:

```yaml
      - ./data:/workspace/data
```

`bot.environment`에도 `QUERY_LOG_DB_PATH: /workspace/data/queries.db` 추가.

- [ ] **Step 3: `.gitignore`에 `data/` 추가**

`.gitignore` 끝에 다음 라인 추가:

```
# 로컬 query log SQLite
data/
```

- [ ] **Step 4: 호스트 디렉토리 생성**

```bash
mkdir -p data
```

(Docker가 root 소유로 자동 생성하지 않게 미리 사용자 소유로 만들어 둠.)

- [ ] **Step 5: Docker dev 부팅 smoke test**

```bash
docker compose up --build -d bot
sleep 5
docker compose logs --tail=50 bot
```

기대: `query log enabled` 로그가 보임. `./data/queries.db` 파일이 호스트에 생성됨.

확인:

```bash
ls -lah ./data/
sqlite3 ./data/queries.db 'SELECT name FROM sqlite_master WHERE type="table";'
```

기대: `queries` 테이블 존재.

정리:

```bash
docker compose down
```

- [ ] **Step 6: 커밋**

```bash
git add docker-compose.yml docker-compose.prod.yml .gitignore
git commit -m "feat(ops): query log DB를 호스트 ./data 로 bind mount"
```

---

## Task 10: 문서 갱신 + 최종 검증

**Files:**
- Modify: `docs/design.md`
- Modify: `docs/operations.md`
- Modify: `README.md`

- [ ] **Step 1: `docs/design.md` — 관찰성 섹션 보강**

`13. 운영 관심사 > 관찰성` 섹션 끝에 다음 문단 추가:

```markdown
**Query log (v1.1 이후)**: 모든 멘션 처리 결과(성공/empty/timeout/error)를 `<repo>/data/queries.db` (SQLite)에 1건씩 기록한다. 컬럼: `event_id`, `received_at`, `completed_at`, `channel`, `thread_ts`, `slack_user`, `question`, `answer`, `citations_json`, `model`, `latency_ms`, `status`, `error_message`. 운영자는 호스트에서 `sqlite3 ./data/queries.db`로 직접 분석/백업한다. 자세한 설계는 [docs/superpowers/specs/2026-05-20-slack-query-persistence-design.md](superpowers/specs/2026-05-20-slack-query-persistence-design.md).
```

- [ ] **Step 2: `docs/operations.md` — 분석/백업 절차 추가**

`2.3 로그 위치 요약` 표 아래에 다음 절 추가:

````markdown
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
````

- [ ] **Step 3: `README.md` 환경 변수 표에 두 항목 추가**

`| LOG_LEVEL | pino 로그 레벨, 기본 info |` 행 부근에 다음 두 행 추가:

```markdown
| `QUERY_LOG_ENABLED` | 슬랙 질의 로그 저장 여부 (기본 `true`) |
| `QUERY_LOG_DB_PATH` | SQLite 파일 경로 (기본 `/workspace/data/queries.db`, 호스트 `./data/queries.db`) |
```

- [ ] **Step 4: 최종 풀 검증**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

기대: 모두 PASS.

- [ ] **Step 5: 커밋**

```bash
git add docs/design.md docs/operations.md README.md
git commit -m "docs: query log SQLite 운영 가이드와 환경 변수 표 갱신"
```

- [ ] **Step 6: E2E smoke (수동)**

이 step은 사람이 직접 수행:

1. `.env` 채우고 `docker compose -f docker-compose.prod.yml up -d --build`
2. 슬랙에서 봇을 한 번 멘션
3. 응답 받은 뒤 호스트에서:
   ```bash
   sqlite3 ./data/queries.db 'SELECT received_at, status, substr(question,1,40), substr(answer,1,40) FROM queries ORDER BY id DESC LIMIT 1;'
   ```
   기대: 방금 그 질의 1건이 보임.
4. 의도적으로 비어있는 멘션(`@bot`)도 한 번 보내 보고 `status=empty` 1건 추가 확인.

E2E가 정상이면 PR/머지 준비 완료.

---

## 자가 점검 메모

- 스펙 §3 아키텍처 → Task 4,5,8에서 구현
- 스펙 §4 스키마 → Task 3 (SQL 파일), Task 4 (인라인 SQL) — 두 경로 동일 내용 보장
- 스펙 §5.1 worker finalize → Task 7
- 스펙 §5.2 citations 시그니처 변경 → Task 6
- 스펙 §5.3 server 부팅 통합 → Task 8
- 스펙 §5.4 config 변수 → Task 2
- 스펙 §6 마이그레이션 → Task 4
- 스펙 §7.1 호스트 bind mount → Task 9
- 스펙 §7.2 분석/백업 → Task 10
- 스펙 §8 에러 처리 (UNIQUE, DB 실패 graceful) → Task 5 (UNIQUE), Task 7 (graceful), Task 8 (open 실패 시 noop fallback)
- 스펙 §9 테스트 → Task 4 (db), Task 5 (query-store), Task 6 (citations), Task 7 (worker)

placeholder 없음. 모든 step에 실제 코드/명령 포함. 타입 일관성(`QueryRecord`, `QueryStatus`, `replaceCitations` 반환형) 확인 완료.
