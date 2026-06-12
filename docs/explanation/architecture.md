# 아키텍처와 설계 결정 (as-is)

> **범위:** 현행 Next.js 13 App Router 구현의 런타임 아키텍처와 그 설계 결정(왜)을 기술한다. 보안·결함 상세는 [security-and-known-issues.md](./security-and-known-issues.md), 재작성 설계(미구현)는 [rewrite-plan.md](./rewrite-plan.md)에 위임한다.
> **대상:** 코드베이스를 처음 읽는 개발자, 재작성 계획을 검토하는 메인테이너.
> **상태:** 구현 반영 — 기준일 2026-06-11.

이 문서는 **현행(as-is) 구현**만을 정본으로 다룬다. 재작성 계획([plan.md](../plan.md) / [spec.md](../spec.md))의 산출물은 본문에서 '미구현(목표)'로만 언급한다.

## 1. 시스템 개요

OUTTA 증명서 발급센터는 단일 Next.js 13 애플리케이션이다. 화면(RSC 페이지)과 mutation API(route handler)가 같은 프로세스에 공존하며, 외부 의존은 인증·데이터·오브젝트 스토리지로 한정된다.

| 영역 | 채택 기술 | 근거 / 비고 |
| --- | --- | --- |
| 프레임워크 | Next.js `13.4.19` (App Router) | RSC + route handler 단일 배포 |
| 인증 | NextAuth `^4.23.1` (Google Provider) | [auth.ts](../../src/lib/auth.ts) 의 `authOptions` |
| ORM | Prisma `5.1.1` (`@prisma/client`) | [prisma.ts](../../src/lib/prisma.ts) 의 `prisma` 싱글턴 |
| 데이터베이스 | CockroachDB | `datasource db { provider = "cockroachdb" }` (prisma/schema.prisma) |
| 오브젝트 스토리지 | AWS S3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) | 인증서 이미지·발급 PDF 저장 |
| PDF 합성 | PDFKit (`pdfkit ^0.13.0`) | **서버측** 합성 — [issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts) |
| 인증서 디자이너 | Fabric.js (`fabric 6.0.0-beta7`) | **클라이언트측(CSR)** — `CanvasForm.tsx`, `CertPreview.tsx` |
| QR 코드 | `qrcode ^1.5.3` | 발급 시 검증 URL 인코딩 |
| 스타일 | Tailwind CSS `3.3.2` | `tailwind.config.js` |
| 린터 / 포매터 | Next lint 스크립트 + Rome 설정 | `package.json`의 `lint`는 `next lint`, `rome.json`은 Rome 규칙 설정. 별도 ESLint 설정 파일은 없음. |
| 패키지 매니저 | pnpm `10.11.1` | `package.json`의 `packageManager` |

근거 파일: [package.json](../../package.json), [next.config.js](../../next.config.js).

## 2. 라우트 그룹 구조

App Router의 라우트 그룹(괄호 폴더)으로 레이아웃을 둘로 가른다. 그룹 이름은 URL에 포함되지 않으며, 오직 어떤 `layout.tsx`로 감쌀지를 결정한다.

| 라우트 그룹 | 레이아웃 심볼 | `<body>` 처리 | 용도 |
| --- | --- | --- | --- |
| `(full)` | [layout.tsx](../../src/app/(full)/layout.tsx) 의 `RootLayout` | `<body>{children}</body>` (전체폭) | 메인·증명서·검증·관리자 화면 |
| `(center)` | [layout.tsx](../../src/app/(center)/layout.tsx) 의 `CenterLayout` | `flex justify-center items-center` (중앙 정렬) | `login`, `unregistered` 화면 |

🟠 **두 그룹 모두 자체 `<html>`/`<head>`/`<body>`를 선언한다.** 두 `layout.tsx`는 동일한 `metadata`(타이틀)와 동일한 Pretendard 웹폰트 `<link>`를 각자 중복 정의한다. 공통 루트 레이아웃이 없으므로 head 자산 변경 시 두 파일을 함께 고쳐야 한다.

### 2.1 페이지 분포

- `(full)` 도메인 페이지: `page.tsx`(루트), `certs/`, `certs/[id]/`, `validate/[id]/`, `admin/`, `admin/users/`, `admin/groups/`, `admin/certs/`, `admin/certs/new/`.
- `(center)` 페이지: `login/`, `unregistered/`.
- 클라이언트 컴포넌트(`"use client"`)는 인터랙션이 필요한 하위 컴포넌트(예: `admin/Header.tsx`, `login/Login.tsx`, `admin/groups/Table.tsx`)로 한정되고, 페이지 셸 자체는 RSC다.

## 3. 데이터 흐름: RSC 직접 쿼리 vs mutation API

이 아키텍처의 가장 큰 특이점은 **읽기와 쓰기의 경로가 분리**되어 있다는 점이다.

| 작업 종류 | 처리 위치 | 데이터 접근 | 예시 |
| --- | --- | --- | --- |
| 도메인 데이터 **읽기(read)** | RSC 페이지 (서버 컴포넌트) | `withAuth()` + `prisma` **직접 호출** | [admin/page.tsx](../../src/app/(full)/admin/page.tsx) 의 `AdminPage()` |
| 도메인 데이터 **쓰기(mutation)** | route handler | `POST` / `DELETE` 핸들러 | [issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()` |

### 3.1 RSC가 Prisma를 직접 호출한다

[admin/page.tsx](../../src/app/(full)/admin/page.tsx) 의 `AdminPage()`는 서버에서 다음을 순차 실행한다.

1. [auth.ts](../../src/lib/auth.ts) 의 `withAuth()` 로 세션·사용자 조회.
2. `user.groups` 에서 `name === "Admin"` 여부 확인, 아니면 `redirect(process.env.BASE_URL)`.
3. `prisma.user.findMany()`, `prisma.group.findMany()`, `prisma.certificate.findMany({ include: { logs: true } })`, `prisma.certificateLog.findMany()` 를 직접 호출해 집계 표시.

즉 **도메인 데이터 조회용 GET API가 존재하지 않는다.** 화면이 곧 쿼리다. 이 결정의 결과:

| 영향 | 설명 |
| --- | --- |
| SPA 전환 곤란 | 클라이언트가 호출할 read 엔드포인트가 없어, 페이지 전체 RSC 렌더 없이는 데이터를 얻을 수 없다. |
| 외부 통합 곤란 | 다른 시스템이 사용자·그룹·증명서를 조회할 공개 read 계약(JSON API)이 없다. |
| 테스트 곤란 | read 로직이 페이지 컴포넌트에 인라인되어 있어, HTTP 단위로 read를 검증할 수 없고 RSC 렌더 전체를 띄워야 한다. |

🟢 의도된 단순화로 볼 수 있으나, 위 한계는 구조적 제약이다.

### 3.2 GET route handler는 데이터 API가 아니다

route handler 중 GET을 export하는 것은 두 개뿐이며, 둘 다 도메인 데이터 read가 아니다.

| 경로 | 메서드 | 성격 |
| --- | --- | --- |
| `api/auth/[...nextauth]/route.ts` | `GET`, `POST` | NextAuth 핸들러(`handler`) — 인증 콜백 전용 |
| [images/[id]/route.ts](../../src/app/api/images/[id]/route.ts) | `GET` | S3 오브젝트 바이트 프록시(`GET()`) — 이미지 바이너리 전달 |

나머지 도메인 route handler는 전부 **mutation**이다: `api/certs/route.ts`·`api/groups/route.ts`·`api/users/route.ts`·`api/users/file/route.ts`(`POST`), `api/users/[id]/route.ts`(`POST`+`DELETE`), `api/certs/[id]/route.ts`·`api/groups/[id]/route.ts`(`DELETE`), 그리고 [issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts)(`POST`).

## 4. 인증과 인가

### 4.1 인증 (NextAuth + Google)

[auth.ts](../../src/lib/auth.ts) 의 `authOptions`:

| 콜백 | 동작 |
| --- | --- |
| `signIn()` | Google 프로필의 `sub`를 `googleId`로 사용. `DEFAULT_ADMIN_EMAIL`과 일치하면 `Admin` 그룹·사용자를 없을 때 생성. DB에 없는 이메일이면 `"/unregistered"` 반환. |
| `jwt()` | `googleId`로 DB 사용자 조회해 토큰에 `id`/`name`/`googleId` 주입. |
| `session()` | 토큰의 `id`/`name`/`googleId`를 `session.user`로 노출. |

시크릿은 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 환경 변수로 주입한다(키 이름만 기술).

### 4.2 인가가 두 경로에 중복된다

같은 권한 판단이 read 경로와 mutation 경로에서 **별도로** 구현된다.

| 경로 | 게이트 | 위치 |
| --- | --- | --- |
| RSC read | `withAuth()` → 세션·등록 확인, 페이지별 그룹 체크 후 `redirect()` | [auth.ts](../../src/lib/auth.ts) 의 `withAuth()`, [admin/page.tsx](../../src/app/(full)/admin/page.tsx) |
| mutation | `getServerSession(authOptions)` 직접 호출 후 핸들러 내부에서 소유권 검사 | [issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()` |

`POST()`는 자체적으로 ① 세션 검사(401), ② URL의 `id`를 `validator.isUUID()`로 검증(400), ③ `prisma.user`로 사용자 재조회(403), ④ `cert.userIds.includes(user.id)` 소유권 검사(403)를 수행한다. `withAuth()`와는 코드를 공유하지 않는다.

🟠 **인가 중복**: read는 `withAuth()`, mutation은 핸들러별 인라인 로직이라 규칙이 한 곳에 모이지 않는다. 누락·불일치 위험은 [security-and-known-issues.md](./security-and-known-issues.md)에서 상세히 다룬다.

## 5. 요청 흐름 다이어그램

```text
                        ┌─────────────────────────────────────────────┐
                        │                Browser                       │
                        │  Fabric.js designer (CSR) · RSC 렌더 결과     │
                        └───────────┬──────────────────┬──────────────┘
                                    │ (a) 페이지 요청    │ (b) mutation (fetch)
                                    ▼                   ▼
        ┌───────────────────────────────────┐  ┌──────────────────────────────┐
        │ RSC Page  (full)/(center)         │  │ Route Handler  api/.../route  │
        │  withAuth() + prisma.* 직접 호출   │  │  getServerSession + 인라인 인가│
        └───────────┬───────────────────────┘  └──────┬───────────────┬───────┘
                    │                                  │               │
                    │ Prisma                           │ Prisma        │ AWS SDK
                    ▼                                  ▼               ▼
        ┌───────────────────────┐          ┌───────────────┐  ┌───────────────┐
        │   CockroachDB         │◀─────────│  CockroachDB  │  │    AWS S3     │
        │ (user/group/cert/log) │          └───────────────┘  │ images/issued │
        └───────────────────────┘                             └───────────────┘

        인증: Browser ─OAuth─▶ api/auth/[...nextauth] ─▶ Google ─▶ signIn/jwt/session 콜백
```

- (a) 페이지 요청은 RSC가 서버에서 Prisma를 직접 질의해 HTML로 응답.
- (b) mutation은 route handler가 Prisma·S3·QR 합성을 수행하고 JSON(`ResponseDTO`)으로 응답.

## 6. PDF 발급 파이프라인 (서버 헤비)

증명서 발급은 [issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()` 한 핸들러가 동기적으로 수행한다.

| 단계 | 동작 | 보조 심볼 |
| --- | --- | --- |
| 1 | 세션·UUID·사용자·소유권 검사 | `validator.isUUID()` |
| 2 | `fs.mkdir(__dirname/data)` 후 `node_modules/pdfkit/js/data`의 폰트를 런타임에 디스크로 복사 | `fs/promises` |
| 3 | `certificateLog` 레코드 생성(발급 로그) | `prisma.certificateLog.create()` |
| 4 | S3에서 배경 이미지 GET → base64 data URI로 PDFKit에 임베드 | `GetObjectCommand`, `mime.contentType()` |
| 5 | 검증 URL(`${BASE_URL}/validate/${certLog.id}`)을 QR data URL로 생성 | `QRcode.toDataURL()` |
| 6 | `content.texts`/`content.rects`를 캔버스 좌표→PDF 포인트로 변환해 배치 | `toDocCoordinates()`, `replaceText()` |
| 7 | `PassThrough` 스트림으로 PDF 버퍼링 후 S3에 PUT, 1분 만료 presigned URL 반환 | `PutObjectCommand`, `getSignedUrl()` |

### 6.1 좌표 변환

[issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `toDocCoordinates(x, y, orientation)`는 Fabric.js 캔버스 픽셀을 A4 포인트로 환산한다.

| orientation | 캔버스(px) | A4(pt) |
| --- | --- | --- |
| `landscape` | 1024 × 720 | 841.89 × 595.28 |
| (그 외 = portrait) | 720 × 1024 | 595.28 × 841.89 |

### 6.2 텍스트 치환 토큰

`replaceText()`가 인식하는 토큰:

| 토큰 | 치환 값 |
| --- | --- |
| `{{Name}}` | `user.name` |
| `{{IssueDate}}` | `cert.issuedAt` (ko-KR 로캘) |
| `{{PrintDate}}` | 발급 시점 현재 날짜 (ko-KR 로캘) |

🟠 **서버 헤비**: 합성·폰트 복사·S3 왕복·QR 생성이 단일 요청 안에서 직렬로 일어나 응답 지연과 콜드 스타트 비용이 크다. PDF 폰트는 고정 `data/ChosunGs.ttf`(2단계에서 복사한 폰트 디렉터리 기준)를 사용한다. 디자이너(Fabric.js)는 CSR이고 합성은 서버이므로, 미리보기와 산출물의 렌더링 주체가 분리된다.

## 7. 인프라 어댑터

### 7.1 Prisma 싱글턴

[prisma.ts](../../src/lib/prisma.ts) 의 `prisma`는 서버에서만 인스턴스화된다.

| 분기 | 동작 |
| --- | --- |
| `typeof window === "undefined"` | `globalForPrisma.prisma ?? new PrismaClient()` (HMR 시 재사용) |
| 클라이언트 번들 | `undefined as unknown as PrismaClient` (브라우저로 누출 방지) |
| `NODE_ENV !== "production"` | 인스턴스를 `globalForPrisma.prisma`에 캐시 |

### 7.2 S3 클라이언트와 webpack 외부화

S3 클라이언트는 mutation/이미지 핸들러에서 각각 `S3Client`로 생성하며, `AWS_REGION`·`AWS_S3_ENDPOINT`·`AWS_S3_BUCKET_NAME`·`AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY` 환경 변수를 사용한다(키 이름만 기술).

[next.config.js](../../next.config.js) 의 `webpack()`은 네이티브 의존을 번들에서 제외한다.

| 설정 | 값 / 효과 |
| --- | --- |
| `config.externals` | `sharp`, `canvas`를 `commonjs`로 외부화(서버 네이티브 모듈) |
| `exprContextCritical` | `false` — 동적 require 경고 억제(PDFKit 등) |
| SVG 처리 | `*.svg?url`은 file loader, 그 외 `*.svg`는 `@svgr/webpack`로 React 컴포넌트화 |

## 8. 핵심 설계 특이점 요약

| 특이점 | 상태 | 근거 | 상세 |
| --- | --- | --- | --- |
| RSC 페이지가 Prisma를 직접 쿼리(도메인 read API 부재) | 🟠 | [admin/page.tsx](../../src/app/(full)/admin/page.tsx), [§3.1](#31-rsc가-prisma를-직접-호출한다) | SPA/외부통합/테스트 제약 |
| 서버측 PDF 합성(단일 요청 직렬) | 🟠 | [issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts), [§6](#6-pdf-발급-파이프라인-서버-헤비) | 지연·콜드스타트 비용 |
| 인가 로직 중복(read=`withAuth()`, mutation=인라인) | 🟠 | [auth.ts](../../src/lib/auth.ts), [§4.2](#42-인가가-두-경로에-중복된다) | 규칙 분산 |
| 그룹별 `<html>`/`<head>` 중복 선언 | 🟠 | [(full)/layout.tsx](../../src/app/(full)/layout.tsx), [(center)/layout.tsx](../../src/app/(center)/layout.tsx) | head 자산 이중 관리 |

치명적 결함과 보안 이슈의 상세 분석은 [security-and-known-issues.md](./security-and-known-issues.md)를, 위 제약을 해소하는 재작성 설계(미구현)는 [rewrite-plan.md](./rewrite-plan.md)를 참조한다. 데이터 모델은 [reference/data-model.md](../reference/data-model.md)에서 다룬다.
