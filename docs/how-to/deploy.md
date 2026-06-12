# 배포 (Deployment)

> **범위:** 현행 Next.js 13 구현([package.json](../../package.json) `next@13.4.19`)의 프로덕션 빌드·배포 절차. build 스크립트, 폰트 워크어라운드, 환경변수, 외부 서비스(CockroachDB / NextAuth / S3) 연결.
> **대상:** 운영 배포를 수행하는 엔지니어.
> **상태:** 구현 반영 — 기준일 2026-06-11.

이 문서는 as-is 구현을 기술한다. `docs/plan.md` / `docs/spec.md`의 Vite + React + FastAPI 재작성은 **설계(미구현)** 이며 본 가이드의 범위가 아니다.

## 1. 빌드

[package.json](../../package.json)의 `scripts.build`는 다음을 순차 실행한다.

| 단계 | 명령 | 설명 |
| --- | --- | --- |
| 1 | `next build` | Next.js 13 프로덕션 번들 생성(`.next/`) |
| 2 | `./install.sh` | 빌드 후 폰트 워크어라운드 실행([§2](#2-폰트-워크어라운드-installsh)) |

```bash
pnpm install
pnpm prisma:generate   # Prisma Client 생성 (scripts.prisma:generate)
pnpm build             # next build && ./install.sh
pnpm start             # next start (프로덕션 서버)
```

- 패키지 매니저는 `pnpm@10.11.1`로 고정되어 있다([package.json](../../package.json) `packageManager`).
- DB 마이그레이션은 배포 시 별도 적용한다: `pnpm prisma:deploy`(= `prisma migrate deploy`). `scripts.prisma:*`는 모두 `dotenv -c $NODE_ENV` 래퍼를 거치므로 `NODE_ENV`에 맞는 `.env.<NODE_ENV>` 파일이 있어야 한다.

🟠 [next.config.js](../../next.config.js)의 `webpack()`은 `config.externals`에 `sharp: "commonjs sharp"`와 `canvas: "commonjs canvas"`를 추가한다. 즉 두 모듈은 번들에 포함되지 않고 런타임에 `require`로 해석된다. 그러나 `sharp`는 [package.json](../../package.json) `dependencies`에 **없다**(`canvas`만 `^2.11.2`로 선언됨). `sharp`를 실제로 로드하는 코드 경로에 도달하면 모듈 미설치로 실패한다 — 의존 경로 사용 여부는 **확인 필요**. 외부화된 네이티브 모듈은 배포 이미지에 별도 설치가 필요하다.

## 2. 폰트 워크어라운드 (install.sh)

[install.sh](../../install.sh)는 한 줄이다.

```bash
cp -r data ./.next/server/chunks
```

### 2.1 왜 필요한가

발급 라우트 [route.ts](../../src/app/api/certs/[id]/issue/route.ts)의 `POST()`는 두 종류의 폰트를 **상대경로**로 참조한다.

| 폰트 | 종류 | 참조 방식 | 출처 |
| --- | --- | --- | --- |
| PDFKit 표준 AFM | Helvetica 등 메트릭 | PDFKit 내부가 자체 `data/` 상대경로로 읽음 | `node_modules/pdfkit/js/data` |
| `ChosunGs.ttf` | 한글 임베드 폰트 | `doc.font("data/ChosunGs.ttf", h)` | 리포지토리 루트 `data/` |

- `doc.font("data/ChosunGs.ttf", ...)`는 **현재 작업 디렉터리 기준 상대경로** `data/ChosunGs.ttf`를 연다. PDFKit 자체도 표준 폰트 AFM 메트릭을 자신의 `data/` 디렉터리에서 로드한다.
- `next build` 산출물은 서버 코드를 `.next/server/chunks` 아래로 옮기므로, 런타임 모듈이 폰트를 찾는 위치 기준에 `data/`가 존재해야 한다. `install.sh`는 루트 `data/`(`ChosunGs.ttf`, `Helvetica.afm`)를 `.next/server/chunks/data`로 복사해 이 상대경로를 만족시킨다.
- 이 복사를 누락하면 PDF 생성 시 폰트 파일을 찾지 못해 한글 텍스트가 깨지거나 발급이 실패한다.

### 2.2 런타임 AFM 자가 복사

[route.ts](../../src/app/api/certs/[id]/issue/route.ts)의 `POST()`는 빌드타임 복사와 별개로, 요청 처리 중 PDFKit AFM 파일을 런타임에도 한 번 더 복사한다.

| 동작 | 코드 | 설명 |
| --- | --- | --- |
| 디렉터리 생성 | `fs.mkdir(path.join(__dirname, "data"))` | 모듈 위치 `__dirname` 하위에 `data/` 생성(존재 시 무시) |
| 소스 탐색 | `path.resolve(process.cwd(), "node_modules/pdfkit/js/data")` | PDFKit AFM 디렉터리 나열 |
| 복사 | `fontList.forEach(async (font) => { ... await fs.writeFile(...) })` | 각 AFM을 `__dirname/data`로 기록 |

🟠 **read-only FS / 콜드스타트 race.** 위 복사는 `forEach(async ...)` 안에서 수행되며 `POST()`가 이 비동기 작업들을 **await 하지 않는다**(fire-and-forget). 따라서:

- 쓰기 완료 전에 PDF 렌더링(`doc.font(...)`, `doc.end()`)이 진행되어 폰트 미준비 상태로 출력될 수 있다(한글 깨짐).
- Lambda 등 **read-only 파일시스템**(또는 `/tmp` 외 쓰기 금지) 환경에서는 `fs.mkdir`/`fs.writeFile`가 실패한다. 두 작업의 예외는 각각 다른 catch에 삼켜져 조용히 폰트 없이 진행된다: `fs.mkdir`는 인자 없는 빈 catch(`catch {}`)로 **로그 없이** 무시되고, `fs.writeFile`(및 디렉터리 나열)는 `catch (e) { console.log(e); }`로만 출력된 뒤 무시된다.

→ 증상·우회는 troubleshooting 문서 참조: [how-to/troubleshooting.md](troubleshooting.md). 안정 배포에는 쓰기 가능한 표준 서버(컨테이너/VM)와 [§2.1](#21-왜-필요한가)의 빌드타임 복사 사용을 권장한다.

## 3. 환경변수

전체 목록·형식·시크릿 취급은 [reference/configuration.md](../reference/configuration.md)를 정본으로 한다. 아래는 배포에 직접 필요한 항목이다(값이 아닌 **키 이름만** 기재).

| 변수 | 용도 | 비고 |
| --- | --- | --- |
| `BASE_URL` | QR 검증 URL 생성 베이스 | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) `POST()`가 `${process.env.BASE_URL}/validate/${certLog.id}` 로 사용 |
| `DEFAULT_ADMIN_EMAIL` | 기본 관리자 이메일 | [README.md](../../README.md) 기재 |
| `NEXTAUTH_URL` | NextAuth 콜백 베이스 URL | [§3.1](#31-nextauth--google-oauth) |
| `NEXTAUTH_SECRET` | NextAuth 세션 서명 시크릿 | `openssl rand -hex 32` 등으로 생성 |
| `DATABASE_URL` | CockroachDB 연결 문자열 | [§3.2](#32-cockroachdb) |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID | [§3.1](#31-nextauth--google-oauth) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret | 시크릿 |
| `AWS_REGION` | S3 리전 | [§3.3](#33-s3--s3-호환-스토리지) |
| `AWS_ACCESS_KEY_ID` | S3 액세스 키 ID | 시크릿 |
| `AWS_SECRET_ACCESS_KEY` | S3 시크릿 액세스 키 | 시크릿 |
| `AWS_S3_BUCKET_NAME` | S3 버킷 이름 | 이미지·발급 PDF 저장 |
| `AWS_S3_ENDPOINT` | S3 호환 엔드포인트 | **선택** — S3 호환 스토리지용 |

> 시크릿 값은 문서·로그에 평문으로 남기지 않는다. 위 표는 키 이름만 기재한다.

### 3.1 NextAuth + Google OAuth

- `NEXTAUTH_URL`은 배포 도메인의 외부 접근 URL과 일치해야 한다. 불일치 시 OAuth redirect가 어긋난다.
- Google OAuth Console의 **Authorized redirect URI**에 `${NEXTAUTH_URL}/api/auth/callback/google`을 등록한다(NextAuth Google provider 기본 콜백 경로 — 정확한 등록 경로는 인증 구성과 대조 **확인 필요**).
- `NEXTAUTH_SECRET`은 환경마다 고정 시크릿을 사용한다(재시작 시 세션 무효화 방지).

### 3.2 CockroachDB

- `DATABASE_URL`은 CockroachDB 연결 문자열로, Prisma Client([package.json](../../package.json) `@prisma/client@5.1.1`)가 사용한다.
- 마이그레이션 적용: `pnpm prisma:deploy`. 스키마 변경 반영 전까지 런타임 쿼리가 실패할 수 있다.

### 3.3 S3 / S3 호환 스토리지

[route.ts](../../src/app/api/certs/[id]/issue/route.ts)의 `S3Client`는 다음 환경변수로 구성된다.

| 클라이언트 옵션 | 환경변수 |
| --- | --- |
| `region` | `AWS_REGION` |
| `credentials.accessKeyId` | `AWS_ACCESS_KEY_ID` |
| `credentials.secretAccessKey` | `AWS_SECRET_ACCESS_KEY` |
| `endpoint` | `AWS_S3_ENDPOINT` (선택) |

- `AWS_S3_ENDPOINT`를 설정하면 AWS 외 S3 호환 스토리지(MinIO 등)로 향한다. 미설정 시 AWS 기본 엔드포인트를 사용한다.
- 버킷 키 레이아웃(`POST()` 참조): 원본 이미지 `certs/images/<image.data>`, 발급 PDF `certs/issued/<certLog.id>.pdf`. 발급 응답은 `getSignedUrl(... expiresIn: 60)`로 **1분 만료** presigned URL을 반환한다.

## 4. 배포 체크리스트

```
빌드/배포 흐름
│
├─ pnpm install                  (pnpm 10.11.1 고정)
├─ 환경변수 주입                 (§3 — 시크릿은 평문 노출 금지)
├─ pnpm prisma:generate
├─ pnpm prisma:deploy            (CockroachDB 마이그레이션)
├─ pnpm build                    (next build && ./install.sh → data/ 복사)
│     └─ 확인: .next/server/chunks/data/ChosunGs.ttf 존재 (§2.1)
├─ 네이티브 모듈 확인            (🟠 sharp 미설치 / canvas 미빌드 가능 — §1)
└─ pnpm start
      └─ 주의: read-only FS면 §2.2 폰트 race → how-to/troubleshooting.md
```
