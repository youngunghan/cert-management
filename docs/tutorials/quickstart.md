# Quickstart: 로컬에서 처음 띄우기

> **범위:** 현행(as-is) Next.js 13 구현을 개발자 머신에서 처음 실행해 Google 로그인 → 템플릿 생성 → 본인 증명서 발급 → 검증까지 통과하는 happy path.
> **대상:** 이 repo를 처음 클론한 개발자.
> **상태:** 구현 반영 — 기준일 2026-06-11.

이 문서는 현행 Next.js 13(App Router) 구현을 정본으로 기술한다. `docs/plan.md`·`docs/spec.md`의 Vite + React + FastAPI 재작성은 설계(미구현)이며 여기서는 다루지 않는다. 모든 명령은 [package.json](../../package.json)의 실제 `scripts`를 인용한다.

## 1. 사전 준비

| 항목 | 값 | 출처 / 확인 |
| --- | --- | --- |
| 패키지 매니저 | pnpm 10.11.1 | [package.json](../../package.json) 의 `packageManager` |
| Node 런타임 | `@types/node` 20.x 기준 (Node 20 권장) | [package.json](../../package.json) 의 `devDependencies` (정확한 최소 버전은 확인 필요) |
| 프레임워크 | Next.js 13.4.19 | [package.json](../../package.json) 의 `dependencies.next` |
| 데이터베이스 | CockroachDB | [schema.prisma](../../prisma/schema.prisma) 의 `datasource db { provider = "cockroachdb" }` |
| 인증 | Google OAuth (next-auth) | [auth.ts](../../src/lib/auth.ts) 의 `GoogleProvider` |
| 오브젝트 스토리지 | AWS S3 또는 S3 호환 | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `S3Client` |

> 🟢 증명서 **템플릿 생성과 발급**은 모두 S3(호환) 버킷이 필요하다. 템플릿 생성([route.ts](../../src/app/api/certs/route.ts) 의 `POST()`)은 배경 이미지를 `certs/images/<key>`로 업로드하고, 발급([route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`)은 PDF를 `certs/issued/<logId>.pdf`로 업로드한 뒤 서명 URL을 발급한다. 로그인·사용자/그룹 등록은 S3 없이도 동작한다.

## 2. 의존성 설치

```bash
pnpm install
```

[package.json](../../package.json)에 `packageManager`가 `pnpm@10.11.1`로 고정되어 있으므로 pnpm을 사용한다. 네이티브 모듈(`canvas`, `bufferutil`, `utf-8-validate` 등)이 빌드되므로 OS 빌드 툴체인이 필요할 수 있다(상세는 확인 필요).

## 3. 환경 변수 설정

루트에 `.env`(또는 `.env.<NODE_ENV>`)를 만든다. `prisma` 계열 스크립트는 `dotenv -c $NODE_ENV -- prisma` 형태로 환경 파일을 로드한다([package.json](../../package.json) 의 `scripts.prisma`/`prisma:generate`/`prisma:deploy`).

아래는 실행 흐름에 직접 관여하는 변수다. **키 이름만** 적는다(시크릿 평문 금지). 전체 목록·설명은 [reference/configuration.md](../reference/configuration.md)를 참조한다.

| 변수 | 사용처 | 확인 |
| --- | --- | --- |
| `DATABASE_URL` | Prisma datasource | [schema.prisma](../../prisma/schema.prisma) 의 `env("DATABASE_URL")` |
| `GOOGLE_CLIENT_ID` | Google OAuth | [auth.ts](../../src/lib/auth.ts) 의 `GoogleProvider` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth | [auth.ts](../../src/lib/auth.ts) 의 `GoogleProvider` |
| `DEFAULT_ADMIN_EMAIL` | Admin 부트스트랩 | [auth.ts](../../src/lib/auth.ts) 의 `signIn()` |
| `NEXTAUTH_URL` | next-auth 베이스 URL | [README.md](../../README.md) Environment Variables |
| `NEXTAUTH_SECRET` | next-auth 세션 서명 | [README.md](../../README.md) Environment Variables |
| `BASE_URL` | 리다이렉트·QR 검증 URL | [auth.ts](../../src/lib/auth.ts) 의 `withAuth()`, [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()` |
| `AWS_REGION` | S3 클라이언트 | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `S3Client` |
| `AWS_ACCESS_KEY_ID` | S3 클라이언트 | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `S3Client` |
| `AWS_SECRET_ACCESS_KEY` | S3 클라이언트 | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `S3Client` |
| `AWS_S3_BUCKET_NAME` | 이미지/PDF Key | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `GetObjectCommand`/`PutObjectCommand` |
| `AWS_S3_ENDPOINT` | S3 호환 엔드포인트(선택) | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `S3Client` |

- `BASE_URL`은 발급 시 QR 코드 검증 링크 `${BASE_URL}/validate/<logId>` 생성에 쓰이므로 로컬 호스트와 일치시켜야 검증 화면([§9](#9-validatelogid-검증))이 열린다.
- `NEXTAUTH_SECRET`은 `openssl rand -hex 32`로 생성한다([README.md](../../README.md)).

## 4. CockroachDB 연결과 Prisma

`DATABASE_URL`이 가동 중인 CockroachDB를 가리키도록 한 뒤, Prisma 클라이언트 생성과 스키마 마이그레이션을 수행한다.

### 4.1 명령

| 단계 | 명령 | 정의 / 동작 |
| --- | --- | --- |
| 클라이언트 생성 | `pnpm prisma:generate` | [package.json](../../package.json) 의 `scripts.prisma:generate` = `dotenv -c $NODE_ENV -- prisma generate` |
| 스키마 적용(개발) | `pnpm prisma migrate dev` | `scripts.prisma`(`dotenv -c $NODE_ENV -- prisma`)에 `migrate dev` 인자 전달 |
| 스키마 적용(배포용) | `pnpm prisma:deploy` | [package.json](../../package.json) 의 `scripts.prisma:deploy` = `dotenv -c $NODE_ENV -- prisma migrate deploy` |

로컬 첫 셋업은 `pnpm prisma:generate` 후 `pnpm prisma migrate dev`를 권장한다. `prisma:deploy`(=`migrate deploy`)는 이미 작성된 마이그레이션을 적용하는 배포 경로다.

### 4.2 생성되는 모델

[schema.prisma](../../prisma/schema.prisma) 기준 4개 모델이 만들어진다.

| 모델 | 핵심 필드 | 비고 |
| --- | --- | --- |
| `Group` | `id`(uuid), `name`(unique) | `Admin` 그룹이 로그인 시 부트스트랩됨([§7](#7-google-로그인과-admin-부트스트랩)) |
| `User` | `id`, `googleId`(unique, nullable), `email`(unique), `name`, `memo`, `groups` | `googleId`·`email`에 인덱스 |
| `Certificate` | `id`, `name`, `content`, `issuedAt`, `expiresAt?`, `userIds`(uuid[]) | `content`는 JSON 문자열(템플릿) |
| `CertificateLog` | `id`, `certificateId`, `userId`, `createdAt` | 발급 1건 = log 1건. `id`가 검증 URL의 `<logId>` |

## 5. 폰트 데이터 준비

증명서 PDF의 한글 텍스트는 `data/ChosunGs.ttf`를 사용한다([route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `doc.font("data/ChosunGs.ttf", h)`). 즉 PDF 렌더링 경로가 `data/` 디렉터리의 폰트 파일에 의존하므로, 이 데이터가 실행 위치에서 보여야 한다.

```bash
./install.sh
```

[install.sh](../../install.sh)는 `cp -r data ./.next/server/chunks` 한 줄로, repo 루트의 `data/`(`ChosunGs.ttf`, `Helvetica.afm`)를 빌드 산출물 디렉터리로 복사한다.

> 🟠 [install.sh](../../install.sh)는 [package.json](../../package.json)의 `scripts.build`(`next build && ./install.sh`)에서 자동 실행된다 — **프로덕션 빌드(`.next/server/chunks`)를 전제**한다. `pnpm dev`(개발 서버, [§5.1 미적용](#51-dev-모드-주의))에서는 산출물 경로가 달라 이 복사가 그대로 적용되지 않는다. 배포·번들 경로 상세는 [how-to/deploy.md](../how-to/deploy.md)를 참조한다.

### 5.1 dev 모드 주의

- [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`는 런타임에 `node_modules/pdfkit/js/data`의 폰트를 읽어 `path.resolve(__dirname, "data", font)`로 다시 써넣는 폴백을 수행한다(`fs.readdir`/`fs.writeFile`). 따라서 dev에서도 폰트 데이터가 자체 복구될 수 있다.
- 다만 이 폴백은 `__dirname` 기준 상대 경로이므로 환경에 따라 실패할 수 있다(실패 시 [route.ts](../../src/app/api/certs/[id]/issue/route.ts)의 `catch`가 `console.log`만 남김). 발급에서 폰트 오류가 보이면 [§5](#5-폰트-데이터-준비)의 `data/` 배치와 [how-to/deploy.md](../how-to/deploy.md)를 확인한다(상세 동작은 확인 필요).

## 6. 개발 서버 실행

```bash
pnpm dev
```

[package.json](../../package.json)의 `scripts.dev` = `next dev`. 기본적으로 `http://localhost:3000`에서 동작한다. `BASE_URL`/`NEXTAUTH_URL`을 이 주소와 일치시킨다([§3](#3-환경-변수-설정)).

## 7. Google 로그인과 Admin 부트스트랩

브라우저에서 앱에 접속해 Google로 로그인한다. 로그인 분기는 전적으로 [auth.ts](../../src/lib/auth.ts) 의 `signIn()` 콜백이 결정한다.

### 7.1 분기 로직

| 조건 | 동작 | 반환 |
| --- | --- | --- |
| `DEFAULT_ADMIN_EMAIL`이 설정됐고 로그인 이메일과 일치 | `Admin` 그룹이 없으면 생성, 해당 이메일 `User`가 없으면 `memo: "Default admin user"`로 생성하고 `Admin` 그룹에 연결 | `true` |
| 등록된 `User`가 있음(이메일 일치) | `googleId`를 갱신 | `true` |
| 등록된 `User`가 없음 | — | `"/unregistered"` 로 리다이렉트 |
| provider가 google이 아님 | — | `false` |

> ✅ 첫 실행 시에는 **본인 Google 계정을 `DEFAULT_ADMIN_EMAIL`로 지정**해야 한다. 그래야 `signIn()`이 `Admin` 그룹과 관리자 `User`를 부트스트랩하고, 이후 [§7.2](#72-admin-콘솔)에서 다른 사용자를 등록할 수 있다. 등록되지 않은 계정은 `/unregistered`로 보내진다.

### 7.2 admin 콘솔

관리자로 로그인하면 `/admin`에서 관리 화면에 접근한다. 현행 admin 페이지는 다음과 같다.

| 경로 | 파일 | 용도 |
| --- | --- | --- |
| `/admin` | [page.tsx](../../src/app/(full)/admin/page.tsx) | admin 진입 |
| `/admin/users` | [page.tsx](../../src/app/(full)/admin/users/page.tsx) | 사용자(화이트리스트) 등록·관리 |
| `/admin/groups` | [page.tsx](../../src/app/(full)/admin/groups/page.tsx) | 그룹 관리 |
| `/admin/certs` | [page.tsx](../../src/app/(full)/admin/certs/page.tsx) | 템플릿 목록 |
| `/admin/certs/new` | [page.tsx](../../src/app/(full)/admin/certs/new/page.tsx) | 캔버스 기반 템플릿 생성 |

- **사용자 등록:** `/admin/users`에서 발급 대상자를 미리 등록한다. 미등록 이메일은 로그인 시 `/unregistered`로 막힌다([§7.1](#71-분기-로직)).
- **템플릿 생성:** `/admin/certs/new`의 캔버스([CanvasForm.tsx](../../src/app/(full)/admin/certs/new/(forms)/CanvasForm.tsx) 의 `CanvasData`)에서 배경 이미지 위에 텍스트(`type: "text"`)와 QR 박스(`type: "qr"`)를 배치한다. 텍스트에는 `{{Name}}`/`{{IssueDate}}`/`{{PrintDate}}` 치환 토큰을 쓸 수 있다([route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `replaceText()`).

## 8. 본인 증명서 발급

발급 대상에 본인(`User`)이 포함된 `Certificate`에 대해, 본인이 로그인한 상태에서 발급을 실행한다. 발급은 [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`가 처리한다.

### 8.1 발급 시 수행 순서

```
요청(POST /api/certs/<certId>/issue)
   │
   ▼  세션 확인 → 401 if 미인증
   │  certId UUID 검증 → 400 if 비정상
   │  User 조회 → 403 if 없음
   │  Certificate 조회 → 404 if 없음
   │  cert.userIds.includes(user.id) → 403 if 미포함
   ▼
CertificateLog 생성 (createdAt 기록)  ← 이 log.id 가 검증 ID
   │
   ▼  S3에서 배경 이미지 GetObject → PDFDocument 생성(A4, orientation)
   │  texts: replaceText() + toDocCoordinates()로 좌표 변환 후 ChosunGs.ttf로 렌더
   │  rects: ${BASE_URL}/validate/<logId> QR 코드 배치
   ▼
PDF → S3 PutObject(certs/issued/<logId>.pdf)
   │
   ▼
1분 만료 presigned URL 반환 (data.url)
```

| 단계 | 심볼 |
| --- | --- |
| 권한 검사 | `POST()` 내부 `cert.userIds.includes(user.id)` |
| 좌표 변환 | `toDocCoordinates()` (1024×720 / 720×1024 → A4 pt) |
| 텍스트 치환 | `replaceText()` (`{{Name}}`/`{{IssueDate}}`/`{{PrintDate}}`) |
| QR 생성 | `QRcode.toDataURL(\`${BASE_URL}/validate/${certLog.id}\`)` |
| 다운로드 | 1분 만료 presigned URL (`getSignedUrl`, `expiresIn: 1 * 60`) |

> 🟢 발급에는 S3(호환) 버킷과 템플릿 `content.image.data`가 가리키는 배경 이미지(`certs/images/<key>`)가 필요하다. 이미지 조회 실패 시 `POST()`는 500을 반환한다.

## 9. /validate/<logId> 검증

발급 PDF의 QR을 스캔하거나, 브라우저에서 `${BASE_URL}/validate/<logId>`로 직접 접속해 검증한다. `<logId>`는 [§8](#8-본인-증명서-발급)에서 만들어진 `CertificateLog.id`다.

| 입력 | 동작 | 출처 |
| --- | --- | --- |
| `id`가 UUID가 아님 | 무효 화면(`InvalidPage`) | [page.tsx](../../src/app/(full)/validate/[id]/page.tsx) 의 `ValidatePage()` (`validator.isUUID`) |
| 해당 `CertificateLog` 없음 | 무효 화면(`InvalidPage`) | 동일 |
| log 존재 | "유효한 증명서입니다." + 대상자 이름·발급 일시·템플릿 이름 표시 | [page.tsx](../../src/app/(full)/validate/[id]/page.tsx) 의 `ValidatePage()` (`certificate`·`user` include) |

검증 화면은 `CertificateLog`에서 연결된 `certificate.name`, `user.name`, `createdAt`을 그대로 노출한다([page.tsx](../../src/app/(full)/validate/[id]/page.tsx)). 여기까지 통과하면 로컬 happy path 완료다.

## 10. 다음 단계

| 주제 | 문서 |
| --- | --- |
| 전체 환경 변수 레퍼런스 | [reference/configuration.md](../reference/configuration.md) |
| 데이터 모델 상세 | [reference/data-model.md](../reference/data-model.md) |
| 배포·폰트 번들 경로 | [how-to/deploy.md](../how-to/deploy.md) |
