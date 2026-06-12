# 재작성 계획 — 현행 Next.js 13 ↔ 신규 Vite + React + FastAPI

> **범위:** 현행 cert-management(Next.js 13 / App Router) 구현과 [docs/plan.md](../plan.md)·[docs/spec.md](../spec.md)가 정의한 신규 스택(Vite + React + FastAPI) 사이의 관계 — 무엇을 차용·손보고차용·폐기·추가하는지, 왜 갈아엎는지의 배경 설명.
> **대상:** 마이그레이션 의사결정을 검토하는 메인테이너, 신규 리포 스캐폴딩을 맡을 개발자.
> **상태:** 구현 반영 — 기준일 2026-06-11.

이 문서는 **배경/근거(explanation)** 문서다. 현행 `src/`(Next.js 13)는 **as-is 참조용**이며 그 동작 자체는 reference/how-to 문서에서 기술한다. 신규 스택은 **설계 단계(미구현, 목표)** 로만 존재하며, 그 단일 진실 공급원(SSOT)은 다음 두 문서다.

- [docs/plan.md](../plan.md) — 재작성의 결정 사항·동기·Phase 일정·미해결 항목.
- [docs/spec.md](../spec.md) — 신규 구현의 개발자 명세(약 2089줄). 데이터 모델·API 시그니처·PDF 합성·보안·배포까지 포함.

> **상태 표기**: 본 문서에서 신규 스택을 가리키는 모든 서술은 **미구현(목표)** 이다. 현행 동작은 `src/`의 코드를 정본으로 삼는다. plan.md/spec.md의 서술이 코드와 다를 경우, "현행"은 코드가 정본이고 "신규"는 설계 의도다.

## 1. 현행 ↔ 신규 관계

| 구분 | 위치 | 성격 |
| --- | --- | --- |
| 현행 (as-is) | `src/`, [prisma/schema.prisma](../../prisma/schema.prisma), [install.sh](../../install.sh) | 운영 중인 Next.js 13 구현. reference/how-to 문서의 정본. |
| 신규 (설계, 미구현) | [docs/plan.md](../plan.md), [docs/spec.md](../spec.md) | 재작성 SSOT. 코드는 아직 없음. |

[README.md](../../README.md)도 동일하게 명시한다: `docs/` 아래 파일은 현행 Next.js 런타임의 as-is 설명이 아니라 **교체 대상 아키텍처와 현행에서 이월할 수정 사항**을 문서화한 것이다.

## 2. 스택 매핑

[plan.md §1](../plan.md#1-결정-사항-요약)의 결정 표를 요약한다. 신규는 현행의 **도메인 로직만 차용**하고 스택 전체를 재구성한다.

| 레이어 | 현행 | 신규 (설계) |
| --- | --- | --- |
| Frontend | Next.js 13 (App Router, RSC) | Vite + React 18 + TypeScript (SPA, React Router v6) |
| Backend | Next.js Route Handlers | FastAPI (Python 3.11+, ASGI/Uvicorn) |
| ORM | Prisma 5 | SQLAlchemy 2.x + Alembic (직렬화는 Pydantic v2) |
| DB | CockroachDB | PostgreSQL 15+ |
| 인증 | NextAuth (Google) | Authlib (Google OAuth 2.0) + JWT 세션 쿠키 |
| 캔버스 디자이너 | Fabric.js 6.0.0-beta7 | 동일 Fabric.js (Vite 환경) |
| PDF 합성 | PDFKit (Node) | reportlab (Python) — `data/ChosunGs.ttf` 유지 |
| QR | `qrcode` (Node) | `qrcode` (Python, Pillow 백엔드) |
| 객체 스토리지 | AWS S3 (`@aws-sdk/client-s3`) | boto3 (S3 + presigned URL) |
| 스타일 | Tailwind CSS 3 | Tailwind CSS 4 (`@tailwindcss/vite`) |
| 패키지 매니저 | pnpm | FE: pnpm / BE: uv (권장) |

스택 변경의 핵심 비용은 응답 계약 교체다. 현행은 `{result, data, error: {title, message}}` envelope을 쓰고 FE는 `data.result` 분기로 성공/실패를 판정한다. 신규는 FastAPI 표준 `{"detail"}` + Pydantic 모델 직접 반환으로 바꾸므로, **FE의 모든 fetch 핸들러를 HTTP status 기반으로 교체**해야 한다(매핑은 [spec.md §4.0.1](../spec.md#401-에러-응답)).

## 3. 왜 갈아엎는가

[plan.md §2](../plan.md#2-왜-갈아엎는가)에서 현행 코드를 읽고 확인한 다섯 가지 동기다.

| # | 동기 | 현행 근거 | 신규 처리 (설계) |
| --- | --- | --- | --- |
| 1 | Next.js 이점이 거의 없음 | RSC가 단순 CRUD 페이지에서 Prisma를 직접 호출 → GET 계열 API가 없어 SPA화·외부 통합·테스트가 모두 어려움. | `GET /certs` 등 GET API 정식화 + OpenAPI/Swagger. |
| 2 | PDF 합성이 서버 헤비 | [install.sh](../../install.sh)가 폰트를 `.next/server/chunks/`로 복사해야 동작. PDFKit·Canvas·sharp 등 네이티브 모듈 의존. [issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 폰트 복사 워크어라운드. | FastAPI + reportlab으로 단순화, `registerFont` 1회. |
| 3 | 권한 검사 중복 | 모든 관리자 API가 12줄짜리 세션·그룹 검사 코드를 복붙. | FastAPI `Depends(require_admin)` 한 줄. |
| 4 | 운영 중 버그 | 보안 critical 4건 + 데이터/UX 다수 ([§4](#4-차용--손보고차용--폐기--추가)에서 요약). | [spec.md §11](../spec.md#11-원본-대비-변경수정-사항) 전 항목에서 수정. |
| 5 | 테스트 코드 없음 | 단위/통합 테스트 0건. | pytest + Vitest + Playwright + Coverage 게이트([spec.md §10.3](../spec.md#103-coverage-게이트)). |

### 3.1 동기 4 — 보안 critical 4건

[plan.md §2](../plan.md#2-왜-갈아엎는가)가 현행 코드에서 직접 확인한 치명 결함이다. 모두 신규에서 수정 대상(설계)이다.

| 마커 | 현행 위치 (심볼) | 결함 | 신규 처리 (설계) |
| --- | --- | --- | --- |
| 🔴 | [dataURItoUint8Array](../../src/lib/dataURI.ts) + [certs/route.ts](../../src/app/api/certs/route.ts) 의 `POST()` + [images/[id]/route.ts](../../src/app/api/images/[id]/route.ts) 의 `GET()` | 클라이언트 data URI MIME을 신뢰해 저장 → GET 시 echo. `data:text/html;base64,...`/SVG로 first-party stored XSS → 세션 쿠키 탈취. | MIME 화이트리스트 + Pillow 매직 바이트 검증 + 신뢰된 MIME echo ([spec.md §4.5](../spec.md#45-images)). |
| 🔴 | [auth.ts](../../src/lib/auth.ts) 의 `signIn` 콜백 | Google `email_verified` 미검증 + `googleId` 무조건 덮어쓰기 → 미인증 Google 계정이 사전등록 이메일로 계정 탈취. | `email_verified === true` 강제 401 거부 + `google_id` 조건부 덮어쓰기 + default admin 예외 ([spec.md §3.1](../spec.md#31-흐름)). |
| 🔴 | [users/route.ts](../../src/app/api/users/route.ts) 의 `POST()` | `groups` payload를 untrusted로 Prisma `connect`에 직접 전달 → admin 자기 박탈/마지막 admin 잠금. | `UserCreate`/`UserUpdate` Pydantic + 마지막 Admin 가드 ([spec.md §4.3.1](../spec.md#431-입력-검증--권한-가드)). |
| 🔴 | 모든 변경 라우트 | CSRF 미보호(쿠키 인증만). | `CsrfMiddleware` — Origin/Referer allowlist + `X-Requested-With: fetch` ([spec.md §8.1](../spec.md#81-csrf-미들웨어--구체)). |

## 4. 차용 / 손보고차용 / 폐기 / 추가

[plan.md §3](../plan.md#3-차용--폐기--재설계)의 분류를 요약한다.

### 4.1 그대로 차용

| 자산 | 비고 |
| --- | --- |
| 데이터 모델 3개(`User`, `Group`, `Certificate`) | 컬럼/관계 동일. `CertificateLog`는 [§4.2](#42-손보고차용) 참조. |
| `CertContent` JSON 스키마 | [content.ts](../../src/types/content.ts) 와 동일. 단 DB 컬럼은 `String` → `JSONB`, 입출력은 `CertContentIn`/`CertContentOut`으로 분리. |
| 한국어 폰트 `data/ChosunGs.ttf` | 그대로. |
| S3 키 규칙 | `certs/images/<uuid>.<ext>`, `certs/issued/<log_id>.pdf`. |
| 검증 URL 형식 | `${BASE_URL}/validate/{certLog.id}`. |
| 텍스트 치환자 | `{{Name}}`/`{{IssueDate}}`/`{{PrintDate}}` (KST 기준). |

### 4.2 손보고차용

| 자산 | 손보는 지점 (설계) |
| --- | --- |
| `CertificateLog` | FK `ON DELETE RESTRICT` → `SET NULL` + 발급 시점 스냅샷 6컬럼(`user_name`, `user_email`, `certificate_name`, `certificate_issued_at`, `certificate_expires_at`, `pdf_key`). 사용자/cert 삭제 후에도 검증·다운로드 영구 보존 ([spec.md §2.2](../spec.md#22-테이블)). |
| NextAuth 인증 | Authlib + JWT(httpOnly cookie). `email_verified` 강제 + `email.lower()` 정규화 + `google_id` 조건부 덮어쓰기 ([spec.md §3.1](../spec.md#31-흐름)). |
| CSV 일괄 추가 | 헤더 필수(현행 헤더-감지 모드 폐기), UTF-8 only(BOM strip), RFC 4180 quote, `그룹` 열은 `\|` 구분 UUID, 사전 검증 후 단일 트랜잭션, 5MiB/1000행 limit ([spec.md §4.3.3](../spec.md#433-csv-일괄-추가-post-apiusersfile)). |
| Admin 권한 | `Group(name="Admin")` 멤버십 검사 유지, 단 `Depends(require_admin)`. 자기 자신 demote/delete 금지 + 마지막 Admin 가드 추가. |
| Admin 그룹 보호 | DELETE 거부 + 현재 이름이 Admin인 PUT 거부 + 새 이름이 Admin인 PUT 거부 ([spec.md §4.4](../spec.md#44-groups)). |
| Pagination 컴포넌트 | `totalpages <= 1` 시 미렌더 + `page > totalpages` 클램프 + Rules of Hooks 준수. |
| `Certificate.user_ids` | ARRAY 유지 + GIN 인덱스 추가 + 사용자 삭제 시 `array_remove`로 dangling UUID 정리. |

### 4.3 폐기

| 폐기 대상 | 대체 (설계) |
| --- | --- |
| [install.sh](../../install.sh) 폰트 복사 워크어라운드 | reportlab `registerFont` 1회 + 도커 이미지에 `data/` COPY. |
| Next.js webpack svgr 설정 | Vite `vite-plugin-svgr`. |
| `(center)` / `(full)` 레이아웃 그룹 | React Router nested routes. |
| `dotenv -c $NODE_ENV -- prisma ...` | Pydantic Settings + `.env`. |
| 응답 envelope `{result, data, error}` | FastAPI 표준 `{"detail"}` + Pydantic 직접 반환. FE 전 fetch 핸들러 교체 ([spec.md §4.0.1](../spec.md#401-에러-응답)). |
| 현행 [`toDocCoordinates`](../../src/app/api/certs/[id]/issue/route.ts) 단일 좌표 변환 | [spec.md §5.3](../spec.md#53-좌표-변환)의 4종 헬퍼(`scale_size`/`scale_point_top_left`/`top_left_rect_to_reportlab`/`top_left_baseline_to_reportlab`). |

### 4.4 새로 추가

| 추가 (설계) | 비고 |
| --- | --- |
| GET 계열 API 정식화 | `GET /certs`, `GET /certs/{id}`, `GET /users`, `GET /groups` 등. |
| OpenAPI 자동 생성 + Swagger UI | `/docs`. |
| CSRF 미들웨어 | Origin/Referer allowlist + `X-Requested-With: fetch`. |
| CSP / 보안 헤더 미들웨어 | `nosniff`, `frame-ancestors none`, S3 public 호스트 허용. |
| `AWS_S3_PUBLIC_ENDPOINT` 분리 | MinIO 호환 시 boto3 client 2개(내부 PUT/GET vs presigned 전용). SigV4 host 서명 때문에 사후 string-replace 불가 ([spec.md §7.1](../spec.md#71-backend-appsapienv)). |
| 헬스체크 | `/api/healthz` + `/api/readyz`, Dockerfile `HEALTHCHECK`, compose `condition: service_healthy`. |
| 마이그레이션 잡 분리 | `api-migrate` 서비스 또는 release_command. 워커가 직접 `alembic upgrade` 안 함. |
| 관찰성 | structlog JSON + RequestIDMiddleware + Prometheus `/metrics` + Sentry(선택) + `audit_logs` 테이블. |
| Cleanup queue | `pending_s3_cleanups` 테이블 + 주기 sweep worker (orphan S3 PDF 회수). |
| 테스트 | 단위 + 통합 + E2E (Coverage 게이트 [spec.md §10.3](../spec.md#103-coverage-게이트)). |

## 5. 미해결 결정 사항

신규 스택 착수 전 확정이 필요한 항목은 [plan.md §6](../plan.md#6-미해결-결정-사항-user-확인-필요)에 **16개**로 정리되어 있다(각 항목은 기본값으로 진행하되 다른 결정이 있으면 우선). 데이터 모델에 가장 큰 영향을 주는 항목은 #12 `CertificateLog` 보존 정책(기본값: SET NULL + 스냅샷 6컬럼 영구 보존)이다. 전체 목록·기본값·대안은 plan.md §6 표를 직접 참조한다.

> 참고: [plan.md §6](../plan.md#6-미해결-결정-사항-user-확인-필요)의 미해결 항목 16개는 [spec.md §11](../spec.md#11-원본-대비-변경수정-사항)의 "원본 대비 변경/수정 사항"(버그 수정 매핑, 별도 번호 체계)과 다른 목록이다. 둘을 혼동하지 말 것.

## 6. 참조

- 재작성 결정·동기·Phase 일정·미해결 항목: [docs/plan.md](../plan.md).
- 신규 구현 명세(SSOT): [docs/spec.md](../spec.md).
- 현행 데이터 모델 레퍼런스: [reference/data-model.md](../reference/data-model.md).
- 차용 대상 현행 코드: [issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts), [auth.ts](../../src/lib/auth.ts), [schema.prisma](../../prisma/schema.prisma), [content.ts](../../src/types/content.ts).
