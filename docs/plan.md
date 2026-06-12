# OUTTA 증명서 발급센터 — 재작성 계획 (Vite + React + FastAPI)

## 1. 결정 사항 요약

기존 Next.js 13(App Router) 기반 [cert-management](..) 프로젝트의 **도메인 로직만 차용**하고, 스택을 다음과 같이 재구성한다.

| 레이어 | 이전 | 신규 | 비고 |
|--------|------|------|------|
| Frontend | Next.js 13 (App Router, RSC) | **Vite + React 18 + TypeScript** | SPA. 라우팅은 React Router v6. 상태는 React Query + 가벼운 Zustand 정도. |
| Backend | Next.js Route Handlers | **FastAPI (Python 3.11+)** | ASGI(Uvicorn). |
| ORM | Prisma 5 | **SQLAlchemy 2.x + Alembic** | Pydantic v2 모델로 직렬화. |
| DB | CockroachDB | **PostgreSQL 15+** | CockroachDB 호환 SQL만 쓰면 후에 다시 옮겨도 무방. |
| 인증 | NextAuth (Google) | **Authlib (Google OAuth 2.0)** + JWT 세션 쿠키 | FastAPI 측에서 직접 OAuth flow. Authlib 단독으로 충분(httpx-oauth 등 추가 라이브러리 불필요). |
| 캔버스 디자이너 | Fabric.js 6.0.0-beta7 | **동일하게 Fabric.js** (Vite 환경) | 클라이언트 동작은 그대로 옮길 수 있음. |
| PDF 합성 | PDFKit (Node) | **reportlab** (Python) | 한국어 TTF 임베딩이 안정적. `data/ChosunGs.ttf` 그대로 사용. |
| QR | `qrcode` (Node) | **`qrcode` (Python, Pillow 백엔드)** | API 동일 수준. |
| 객체 스토리지 | AWS S3 (`@aws-sdk/client-s3`) | **boto3 (S3 + presigned URL)** | 동일 IAM 정책. |
| 스타일 | Tailwind CSS 3 | **Tailwind CSS 4** (`@tailwindcss/vite`, CSS-first config) | v3 → v4. PostCSS 단계가 사라지고 `index.css`에서 `@import "tailwindcss";` + `@theme`로 커스터마이즈. |
| 패키지 매니저 | pnpm | FE: pnpm, BE: **uv** 또는 poetry (uv 권장) | 둘 다 lockfile 유지. |

> **차용하는 도메인 자산**: ① Fabric.js 캔버스 설계 UI, ② 텍스트 치환자 `{{Name}}/{{IssueDate}}/{{PrintDate}}` (KST 기준), ③ `Certificate.user_ids[]`로 발급 대상 한정 (원본 `userIds` → snake_case로 통일), ④ `CertificateLog.id` 단위로 QR 검증 — **단, 신규는 SET NULL FK + 스냅샷 컬럼으로 사용자/cert 삭제 후에도 검증 영구 보존**, ⑤ S3 키 규칙(`certs/images/<uuid>.<ext>`, `certs/issued/<certLogId>.pdf`), ⑥ `DEFAULT_ADMIN_EMAIL` 로그인 시 Admin 그룹 멤버십 **idempotent 보장** (원본 "첫 로그인만" 처리하던 버그 수정 포함, 매 로그인마다 보장 + admin 락아웃 복구 경로).

## 2. 왜 갈아엎는가

기존 코드를 직접 읽으며 확인한 동기:

1. **Next.js로 얻는 이점이 거의 없음** — RSC가 단순 CRUD 페이지에서 Prisma 쿼리를 직접 호출하는 구조라 GET 계열 API가 아예 없다(이 때문에 SPA화·외부 통합·테스트가 모두 어려움).
2. **PDF 합성이 서버 헤비** — PDFKit·Canvas·iconv-lite·sharp·utf-8-validate 등 네이티브 모듈을 쓰면서 빌드/배포 단계에서 `install.sh`로 폰트를 `.next/server/chunks/`에 복사해야만 하는 워크어라운드가 있다([install.sh](../install.sh), [src/app/api/certs/[id]/issue/route.ts:124-135](../src/app/api/certs/[id]/issue/route.ts#L124-L135)). FastAPI + reportlab으로 옮기면 단순화된다.
3. **권한 검사 중복** — 모든 관리자 API가 12줄짜리 세션·그룹 검사 코드를 복사한다. FastAPI Depends로 한 줄에 끝낼 수 있다.
4. **운영 중 버그** (신규에서 모두 수정 — 자세한 행은 spec.md §11):
   - 🔴 **보안 critical**:
     - [src/lib/dataURI.ts:9](../src/lib/dataURI.ts#L9) + [api/certs/route.ts:78](../src/app/api/certs/route.ts#L78) + [api/images/[id]/route.ts:52](../src/app/api/images/[id]/route.ts#L52) — 클라이언트 data URI MIME을 신뢰해 저장 → GET 시 echo. `data:text/html;base64,...` 또는 SVG로 **first-party stored XSS → 세션 쿠키 탈취** 가능. 신규는 §4.5 MIME 화이트리스트 + Pillow 매직 바이트 검증 + 신뢰된 MIME echo.
     - [src/lib/auth.ts:15](../src/lib/auth.ts#L15) — Google `email_verified` 미검증 + `google_id` 무조건 덮어쓰기 → 미인증 Google 계정이 사전등록 이메일로 **계정 탈취** 가능. 신규는 §3.1 step 4에서 401 거부, step 7에서 `google_id` 조건부 덮어쓰기 + default admin 예외.
     - [api/users/route.ts:40-61](../src/app/api/users/route.ts#L40) — `groups` payload를 untrusted로 Prisma `connect`/`set`에 직접 전달 → admin이 자기 박탈/마지막 admin 잠금 가능. 신규는 `UserCreate`/`UserUpdate` Pydantic + 마지막 Admin 가드 (§4.3.1).
     - 모든 변경 라우트 CSRF 미보호. 신규는 `CsrfMiddleware` (§8.1).
   - 🟠 **데이터/UX**:
     - [api/certs/[id]/route.ts:97](../src/app/api/certs/[id]/route.ts#L97) — `AWS_S3_BUCKET` 잘못된 env 키 → S3 이미지 leak.
     - [(full)/admin/page.tsx](<../src/app/(full)/admin/page.tsx>) / [admin/certs/page.tsx](<../src/app/(full)/admin/certs/page.tsx>) — `NaN%` (분모 0).
     - [admin/certs/new/Form.tsx:146](<../src/app/(full)/admin/certs/new/Form.tsx#L146>) — "증명서 발급일자" 라벨 중복.
     - [admin/certs/new/Form.tsx:92-109](<../src/app/(full)/admin/certs/new/Form.tsx#L92>) — `res.ok` 미검사 + `window.location.href` → 실패도 성공처럼.
     - [admin/groups/page.tsx:32](<../src/app/(full)/admin/groups/page.tsx#L32>) — 잉여 `'` 문자.
     - [src/lib/auth.ts:36](../src/lib/auth.ts#L36) — default admin이 이미 존재하면 `googleId`/Admin 연결 보장 안 됨.
     - [api/certs/[id]/issue/route.ts:137](../src/app/api/certs/[id]/issue/route.ts#L137) — `CertificateLog` 먼저 생성 후 PDF/S3 실패 시 "검증은 유효한데 PDF 없음" 상태.
     - [api/groups/[id]/route.ts:68](../src/app/api/groups/[id]/route.ts#L68) — Admin 그룹 삭제 보호 서버 부재 (PUT/이름 변경도 미차단).
     - [issue/route.ts:120-135](../src/app/api/certs/[id]/issue/route.ts#L120) — `forEach(async)` 폰트 복사 race + Lambda 등 read-only FS에서 폰트 없이 렌더(Hangul 깨짐).
     - 응답 envelope `{result, data, error}` → FastAPI 표준 `{detail}` + Pydantic. FE의 모든 fetch 핸들러를 HTTP status 기반으로 교체.
5. **테스트 코드 없음** — 단위/통합 테스트 0건. 새로 짤 때 pytest + Vitest + Playwright로 처음부터 (Coverage 게이트 §10.3).

## 3. 차용 / 폐기 / 재설계

### 그대로 차용
- 데이터 모델 3개(`User`, `Group`, `Certificate`) — 컬럼/관계 동일. `CertificateLog`는 아래 "손보고 차용" 참조.
- `CertContent` JSON 스키마 — 단, DB 컬럼은 `String` → `JSONB`로 변경 + Pydantic `CertContentIn`/`CertContentOut`으로 입출력 분리.
- 한국어 폰트 `data/ChosunGs.ttf`.
- S3 키 규칙 (`certs/images/<uuid>.<ext>`, `certs/issued/<log_id>.pdf`).
- 검증 URL 형식 `${BASE_URL}/validate/{certLog.id}`.

### 손보고 차용
- **`CertificateLog`** — FK `ON DELETE RESTRICT` → **`SET NULL`** + 발급 시점 스냅샷 6컬럼 추가(`user_name`, `user_email`, `certificate_name`, `certificate_issued_at`, `certificate_expires_at`, `pdf_key`). 사용자/cert 삭제 후에도 검증·다운로드 영구 보존. spec.md §2.2 참조.
- **NextAuth 인증** → FastAPI **Authlib** + JWT(httpOnly cookie). 사용자 사전 등록 → DB에 없으면 `/unregistered` 정책 동일. 신규로 `email_verified` 강제 + `email.lower()` 정규화 + `google_id` 조건부 덮어쓰기(spec.md §3.1).
- **CSV 일괄 추가** — 헤더 필수(원본 헤더-감지 모드 폐기), UTF-8 only(BOM strip), RFC 4180 quote, `그룹` 열은 `|` 구분 UUID, 사전 검증 후 단일 트랜잭션 INSERT, 5MiB/1000행 limit. 상세 spec.md §4.3.3.
- **Admin 권한** — `Group(name="Admin")` 멤버십 검사 그대로. 단 FastAPI `Depends(require_admin)`. 자기 자신 demote/delete 금지 + 마지막 Admin 가드 추가.
- **Admin 그룹 보호** — DELETE 거부 + PUT(이름 변경) 거부 + 새 이름이 Admin인 PUT 거부 (3가지 모두 spec.md §4.4).
- **Pagination 컴포넌트** — `totalpages <= 1` 시 렌더 안 함 + `page > totalpages` 클램프 + Rules of Hooks 준수.
- **`Certificate.user_ids`** — ARRAY 유지하되 GIN 인덱스 추가 + 사용자 삭제 시 `array_remove`로 dangling UUID 정리.

### 폐기
- `install.sh` 폰트 복사 워크어라운드 — reportlab `registerFont` 한 번 + 도커 이미지에 `data/` COPY.
- Next.js webpack svgr 설정 — Vite의 `vite-plugin-svgr`로 대체.
- `(center)` / `(full)` 레이아웃 그룹 — React Router nested routes.
- `dotenv -c $NODE_ENV -- prisma ...` — Pydantic Settings + `.env`.
- **응답 envelope `{result, data, error: {title, message}}`** → FastAPI 표준 `{"detail"}` + Pydantic 모델 직접 반환. **FE의 모든 fetch 핸들러를 HTTP status + `detail` 기반으로 교체** (spec.md §4.0.1 매핑 표). 이 작업이 FE 마이그레이션 비용의 큰 부분.
- 원본 `to_pdf_xy` 단일 좌표 변환 함수 → spec.md §5.3의 4종 헬퍼 (`scale_size`/`scale_point_top_left`/`top_left_rect_to_reportlab`/`top_left_baseline_to_reportlab`).

### 새로 추가
- `GET` 계열 API 정식화 (`GET /certs`, `GET /certs/{id}`, `GET /users`, `GET /groups` 등).
- OpenAPI 자동 생성 + Swagger UI(`/docs`).
- **CSRF 미들웨어** (Origin/Referer allowlist + `X-Requested-With: fetch` 헤더).
- **CSP / 보안 헤더 미들웨어** (`nosniff`, `frame-ancestors none`, S3 PUBLIC 호스트 허용).
- **`AWS_S3_PUBLIC_ENDPOINT` 분리** — MinIO/MinIO 호환 시 boto3 client 2개(내부 PUT/GET vs presigned 발급 전용). SigV4 host 서명 때문에 사후 string-replace 불가. spec.md §7.1.
- **헬스체크** `/api/healthz` + `/api/readyz`, Dockerfile `HEALTHCHECK`, docker-compose `condition: service_healthy`.
- **마이그레이션 잡 분리** (`api-migrate` 서비스 또는 release_command). 워커가 직접 `alembic upgrade` 안 함.
- **관찰성** — structlog JSON + RequestIDMiddleware + Prometheus `/metrics` + Sentry(선택) + audit_logs 테이블(best-effort 별도 세션).
- **Cleanup queue** — `pending_s3_cleanups` 테이블 + 주기 sweep worker (orphan S3 PDF 회수).
- **단위 + 통합 + E2E 테스트** (Coverage 게이트 spec.md §10.3).

## 4. 작업 단계 (Phase)

각 Phase 끝에 동작 가능한 상태(데모 가능)를 만든다.

### Phase 0 — 환경/리포 셋업 *(반나절)*
- 새 모노레포 레이아웃 결정. 권장: `apps/web/`(Vite) + `apps/api/`(FastAPI) + `packages/shared-types/`(선택). 또는 둘로 나눠 별 리포.
- pre-commit(black + ruff + isort), eslint + prettier, GitHub Actions(lint + test).
- Docker Compose: `postgres`, `minio`(로컬 S3), `api`, `web`.

### Phase 1 — Backend 기본 골격 *(3~4일)*
- FastAPI 앱, SQLAlchemy 모델 5개(`User`, `Group`, `Certificate`, `CertificateLog`+스냅샷, `AuditLog`, `PendingS3Cleanup`), Alembic 첫 마이그레이션.
- Authlib Google OAuth + JWT 쿠키 (`httpOnly`/`Path=/`/`SameSite=Lax`/`Secure`(prod)/`Domain`(env)).
- `current_user` / `require_admin` Depends.
- **OAuth 정책 전부 구현** (spec.md §3.1):
  - `email_verified === true` 강제 → 미충족 401.
  - 모든 이메일 비교/저장에 `.lower()` 정규화.
  - `google_id` 조건부 set: NULL이면 신규, 같으면 no-op, 다르면 401 `account_linked_to_different_google_identity`.
  - `IntegrityError` → 401 `duplicate_google_id` (race 처리).
  - default admin 예외: step 6에서 admin 그룹 idempotent 보장 + step 7의 "다르면 거부" 우회(복구 경로).
- `CsrfMiddleware`, `SecurityHeadersMiddleware`, `RequestIDMiddleware` 등록.
- `/api/healthz`, `/api/readyz`, `/api/auth/*` 라우트.
- 구조화 로깅(structlog) + audit_log 헬퍼(ContextVar + 별도 세션).

### Phase 2 — Backend CRUD + S3 + 보안 *(3~4일)*
- `/users`, `/groups`, `/certs` 풀 CRUD (`UserCreate`/`UserUpdate`/`CertCreate`/`CertUpdate`/`GroupCreate`/`GroupUpdate`).
- `/users/file` (CSV 계약 spec.md §4.3.3 전부: multipart `file`, UTF-8 BOM strip, CP949 거부, 헤더 필수, RFC 4180, 단일 트랜잭션, 5MiB/1000행).
- 자기 자신 demote/delete 금지 + 마지막 Admin 가드.
- **Admin 그룹 보호 3가지**: DELETE 거부 + 현재 이름 Admin인 PUT 거부 + 새 이름 Admin인 PUT 거부.
- boto3 client 2개(내부/public). presigned URL.
- `/api/images/{key}` — 키 정규식 검증, S3 metadata에서 신뢰된 MIME echo, `nosniff` + CSP, slowapi 60/min.
- `POST /certs`: data URI → MIME 화이트리스트 + Pillow 검증 + 재인코딩 + S3 metadata 박기.
- 증명서 삭제 시 logs는 SET NULL 후 스냅샷 보존, 이미 발급된 PDF는 보존, 배경 이미지는 best-effort + cleanup queue.
- pytest + httpx `AsyncClient(transport=ASGITransport(app=app), ...)`로 통합 테스트.

### Phase 3 — Backend 발급 파이프라인 *(2~3일)*
- `/certs/{id}/issue` 사전 가드: 인증, `user_ids` 포함, `expires_at > now()` (만료면 `410 certificate_expired`).
- 발급 트랜잭션 (spec.md §5.5):
  - `log_id = uuid4()` 선생성.
  - `s3_get(image_key, return_metadata=...)` → 신뢰된 MIME 회수.
  - `issue_pdf(log_id, cert, user, bg_bytes, bg_mime)` — `(pdf_bytes, warnings)` 반환(순수 함수, audit log 미접근).
  - S3 PUT → 실패 시 raise (DB 무손상).
  - DB INSERT (스냅샷 6컬럼 채움) → 실패 시 S3 보상 삭제 + cleanup queue.
  - presign → 실패 시 log 보상 + S3 보상 → `503 presign_failed`.
- 좌표 변환(헬퍼 4종) 단위 테스트 — landscape/portrait 양쪽.
- QR ECC=Q + `MIN_QR_PT=60` clamp + `pdf_warning` audit.

### Phase 4 — Frontend 기본 *(2~3일)*
- Vite + React + Tailwind 4 셋업.
- React Router: `/login`, `/unregistered`, `/`, `/certs/:id`, `/admin/*`, `/admin/certs/:id`, `/admin/certs/new`, `/validate/:logId`.
- **Auth 정책 정정**: `AuthProvider`가 공개 라우트(`/login`/`/unregistered`/`/validate*`)에서 `/auth/me` 호출 자체를 건너뜀. 401은 상태로만 해석. **어떤 fetch 콜백에서도 `/login`으로 직접 navigate 금지** — redirect는 `RequireAuth`만. (spec.md §6.5)
- API 클라이언트(`X-Requested-With: fetch` 자동 부착, `credentials: include`).
- React Query 키 컨벤션 + invalidate 매트릭스(spec.md §6.6).

### Phase 5 — Frontend 관리자 화면 *(3~4일)*
- `/admin` 통계 (분모 0 가드 공용 헬퍼 + `[\"dashboard\"]` invalidate keys).
- `/admin/users` (목록·상세·수정·CSV 업로드 — 에러 응답 표 매핑).
- `/admin/groups` (목록·생성·삭제 + Admin 보호 분기).
- `/admin/certs` (목록·삭제) + `/admin/certs/:id` **신규 — 메타데이터 + `expires_at` + `expires_at_clear` 편집**.
- `/admin/certs/new` (Fabric.js 캔버스) — `useMediaQuery`로 모바일 가드(컴포넌트 미마운트), `useMutation` + 인라인 에러, `navigate` 사용.
- `IssueButton`: 클릭 동기 컨텍스트에서 `window.open("about:blank", ...)` 먼저 → mutation 성공 후 `location.href` 채움 (popup blocker 회피).

### Phase 6 — 검증 페이지 + 배포 *(2일)*
- `/validate/:logId` 3분기: 정상 / 만료(`expired=true`) / 없음. 데이터는 스냅샷 컬럼에서.
- 배포:
  - BE 도커 + `HEALTHCHECK` + `tini` PID 1 + `--timeout-graceful-shutdown 30`.
  - 마이그레이션 잡 분리(release_command / `api-migrate`).
  - FE 정적 호스팅(Cloudflare Pages 등).
  - prod 환경 변수에 `AWS_S3_PUBLIC_ENDPOINT` 분리 검토.

### Phase 7 — 마무리 *(1~2일)*
- 시드 스크립트(개발용 Admin + 샘플 증명서).
- README/spec 갱신, OpenAPI export.
- 부하 테스트(특히 `/issue` PDF 합성).

> **총 예상**: 풀타임 1인 기준 약 **2~3주**. 둘이서 FE/BE 분담하면 1주 단축.

## 5. 데이터 마이그레이션

기존 cert-management가 운영 중이 아니라면 신규 DB로 시작. 운영 중이라면:

1. PostgreSQL 빈 DB 구성 → `alembic upgrade head` (모든 테이블 + 인덱스 + CHECK 생성).
2. CockroachDB → 신규 PG 스크립트 마이그레이션:
   - **`Certificate.content`(text) → JSONB**: JSON 파싱 후 INSERT. 파싱 실패 행은 별도 로그 + 수동 검수.
   - **`Certificate.user_ids` (UUID[])**: 그대로 옮기되, INSERT 후 한 번 cleanup — `UPDATE certificates SET user_ids = ARRAY(SELECT u FROM unnest(user_ids) u WHERE u IN (SELECT id FROM users))`로 이미 죽은 dangling UUID 제거.
   - **시간 컬럼 `TIMESTAMP(3)` → `timestamptz`**: 반드시 `USING ... AT TIME ZONE 'UTC'` 명시. USING 없으면 서버 timezone에 종속되어 +9h(KST 서버) 시프트가 발생함. 예:
     ```sql
     ALTER TABLE certificates    ALTER COLUMN issued_at    TYPE timestamptz USING (issued_at    AT TIME ZONE 'UTC');
     ALTER TABLE certificates    ALTER COLUMN expires_at   TYPE timestamptz USING (expires_at   AT TIME ZONE 'UTC');
     ALTER TABLE certificate_logs ALTER COLUMN created_at   TYPE timestamptz USING (created_at   AT TIME ZONE 'UTC');
     ```
   - **`CertificateLog` 스냅샷 backfill**: 신규 스키마는 6개 NOT NULL 스냅샷 컬럼(`user_name`, `user_email`, `certificate_name`, `certificate_issued_at`, `certificate_expires_at`, `pdf_key`). 마이그레이션 시 `users`와 `certificates`를 JOIN해 현재 값으로 backfill. **이상적으로는 발급 시점 값이지만 원본에 이력이 없으므로 현재 값으로 fallback**(수료자 명단 자체가 변하지 않는 도메인이라 실용적 문제는 적음). `pdf_key`는 `'certs/issued/' || id || '.pdf'` 패턴으로 유도. user/cert이 이미 삭제된 로그(원본은 RESTRICT라 발생 불가하지만 데이터 손상 대비)는 별도 audit + 수동 처리.
     ```sql
     INSERT INTO certificate_logs (id, certificate_id, user_id, user_name, user_email,
       certificate_name, certificate_issued_at, certificate_expires_at, pdf_key, created_at)
     SELECT cl.id, cl.certificate_id, cl.user_id,
            u.name, lower(u.email), c.name, c.issued_at, c.expires_at,
            'certs/issued/' || cl.id || '.pdf', cl.created_at
     FROM old_certificate_logs cl
     JOIN users u        ON u.id = cl.user_id
     JOIN certificates c ON c.id = cl.certificate_id;
     ```
   - **이메일 lowercase backfill**: `UPDATE users SET email = lower(email)`. `CHECK (email = lower(email))` 추가 전에 실행.
3. S3 버킷은 그대로 재사용. 다만 §4.2.1 신규 정책에 따라 모든 신규 업로드는 신뢰된 MIME을 `x-amz-meta-content-type` metadata로 저장. **컷오버 전 필수**: `scripts/backfill-mime-metadata.py` 실행 — 기존 `certs/images/<key>` 객체를 모두 GET → Pillow로 매직 바이트 검증 → 신뢰된 MIME을 metadata에 `copy_object`로 박는다 (S3 객체에 metadata만 추가하려면 같은 키로 copy 필요). spec.md §5.4.1은 metadata 부재 시 fallback 없이 500을 던지므로 backfill을 빼먹으면 기존 발급 PDF 합성이 모두 실패한다.
4. **이미 발급된 PDF의 QR은 발급 당시의 `BASE_URL`이 baking된 상태**다. S3 객체는 그대로 살아 있어도, 기존 도메인이 죽으면 QR 자체가 죽는다. 두 가지 옵션 중 하나로 보존:
   - **(권장)** 구 도메인을 신규 시스템으로 reverse proxy. 최소한 `/validate/*`만 신규 BE의 동일 경로로 라우팅하면 기존 QR 전부 살아남음.
   - 도메인을 비활성화해야 한다면 기존 QR은 더 이상 검증 불가. 신규 발급분만 새 `BASE_URL`로 동작. 기존 수료자에게 PDF 재발급 안내 필요.

## 6. 미해결 결정 사항 (User 확인 필요)

기본값으로 진행하되, 다르면 알려주세요.

| # | 항목 | 기본값 | 대안 |
|---|------|-------|------|
| 1 | 모노레포 vs 멀티레포 | 모노레포(`apps/web`, `apps/api`) | 별 리포 2개 |
| 2 | DB | PostgreSQL 15 | 그대로 CockroachDB / SQLite(개발만) |
| 3 | 백엔드 패키지 매니저 | **uv** (rye/poetry 대안) | poetry, pip-tools |
| 4 | OAuth 라이브러리 | Authlib (단독) | python-social-auth, fastapi-users |
| 5 | PDF 라이브러리 | reportlab | fpdf2, weasyprint(HTML→PDF) |
| 6 | 세션 방식 | JWT httpOnly 쿠키 + SameSite=Lax | 서버 세션 + Redis |
| 7 | 배포 (FE) | Cloudflare Pages | S3+CloudFront, Vercel |
| 8 | 배포 (BE) | Docker on Fly.io (release_command로 마이그) | AWS ECS, Render |
| 9 | 한국어 폰트 | `ChosunGs.ttf` 유지 | Pretendard, NanumGothic |
| 10 | E2E 테스트 | Playwright | Cypress |
| 11 | **S3 endpoint 분리 (dev MinIO)** | `AWS_S3_ENDPOINT`(내부) + `AWS_S3_PUBLIC_ENDPOINT`(presigned 발급용) | prod 단일 endpoint (둘 다 비움) |
| 12 | **CertificateLog 보존 정책** | SET NULL + 스냅샷 6컬럼 영구 보존 | CASCADE + 검증 페이지 404 (수료자 PDF가 깨지는 트레이드오프) |
| 13 | **CSV 헤더 정책** | 헤더 필수 강제 | 원본의 헤더-감지 모드 복원 (비권장) |
| 14 | **audit log 트랜잭션 정책** | best-effort 별도 세션 (비즈니스 롤백과 독립) | 비즈니스 트랜잭션에 같이 묶기 |
| 15 | **CSRF 헤더** | `X-Requested-With: fetch` + Origin allowlist | CSRF 토큰 명시(설정 더 무거움) |
| 16 | **cleanup queue 구현** | DB 테이블 + 주기 worker | S3 lifecycle policy로 위임 |

## 7. 작업 순서 (당장 다음에 할 일)

1. 위 미해결 항목 16개 중 다른 결정이 있으면 알려주기 (특히 #12 CertificateLog 보존 정책은 데이터 모델에 큰 영향).
2. 본 `plan.md` 확정되면 [spec.md](spec.md) 검토 → 데이터 모델/API 시그니처 합의.
3. 신규 리포 스캐폴딩(`apps/api`, `apps/web`).
4. Phase 0 (환경/리포 셋업) → Phase 1 (Backend 골격 + 보안 미들웨어) 착수.

## 8. 참고

- 상세 명세: [spec.md](spec.md)
- 차용 대상 코드:
  - 캔버스 디자이너: [src/app/(full)/admin/certs/new/(forms)/CanvasForm.tsx](<../src/app/(full)/admin/certs/new/(forms)/CanvasForm.tsx>)
  - 발급 파이프라인 로직: [src/app/api/certs/[id]/issue/route.ts](../src/app/api/certs/[id]/issue/route.ts)
  - 인증 콜백: [src/lib/auth.ts](../src/lib/auth.ts)
  - 데이터 모델: [prisma/schema.prisma](../prisma/schema.prisma)
  - CertContent 타입: [src/types/content.ts](../src/types/content.ts)
