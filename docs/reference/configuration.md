# Configuration Reference

> **범위:** 현행 Next.js 13 구현이 실행에 요구하는 환경변수(environment variables) 일체.
> **대상:** 배포·운영 담당자, 신규 개발자.
> **상태:** 구현 반영 — 기준일 2026-06-11.

이 문서는 현행(as-is) Next.js 13 구현이 소비하는 환경변수를 코드 사용처 기준으로 정리한다. 재작성 계획([../plan.md](../plan.md)) / 스펙([../spec.md](../spec.md))의 Vite + React + FastAPI 아키텍처는 설계(미구현)이며 본 문서의 정본이 아니다.

> **시크릿 평문 금지.** 본 문서는 키 이름과 생성 방법만 기술한다. 실제 시크릿 값은 어떤 경우에도 문서/저장소에 기재하지 않는다.

## 1. 환경변수 목록

`필수` 열은 현행 코드가 해당 키 없이 정상 동작하는지를 기준으로 한다.

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `BASE_URL` | 예 | 애플리케이션 base URL. [auth.ts](../../src/lib/auth.ts) 의 `withAuth()` 가 미인증/미등록 사용자를 `${BASE_URL}/login`·`${BASE_URL}/unregistered` 로 redirect 할 때 사용. |
| `DEFAULT_ADMIN_EMAIL` | 예 | 기본 관리자 Google 계정 email. [auth.ts](../../src/lib/auth.ts) 의 `signIn` 콜백이 이 값과 일치하는 로그인 시 `Admin` group·user 를 부트스트랩한다. 미설정 시 부트스트랩 분기를 건너뛴다. |
| `NEXTAUTH_URL` | 예 | NextAuth 의 canonical base URL. NextAuth 가 내부적으로 소비하며 `src/` 코드에서 직접 참조하지 않는다. |
| `NEXTAUTH_SECRET` | 예 | JWT·세션 서명용 시크릿. `openssl rand -hex 32` 로 생성. NextAuth 가 내부적으로 소비. |
| `DATABASE_URL` | 예 | CockroachDB 연결 URL. [schema.prisma](../../prisma/schema.prisma) 의 `datasource db` (`provider = "cockroachdb"`)가 `env("DATABASE_URL")` 로 참조. |
| `GOOGLE_CLIENT_ID` | 예 | Google OAuth Client ID. [auth.ts](../../src/lib/auth.ts) 의 `GoogleProvider({ clientId })` 에 주입. |
| `GOOGLE_CLIENT_SECRET` | 예 | Google OAuth Client Secret. [auth.ts](../../src/lib/auth.ts) 의 `GoogleProvider({ clientSecret })` 에 주입. |
| `AWS_REGION` | 예 | S3 `S3Client({ region })` region. [route.ts](../../src/app/api/certs/route.ts)·[images/[id]/route.ts](../../src/app/api/images/[id]/route.ts) 등에서 client 생성 시 사용. |
| `AWS_ACCESS_KEY_ID` | 예 | S3 자격증명 access key. `S3Client({ credentials })` 에 주입. |
| `AWS_SECRET_ACCESS_KEY` | 예 | S3 자격증명 secret key. `S3Client({ credentials })` 에 주입. |
| `AWS_S3_BUCKET_NAME` | 예 | 인증서 이미지 bucket 이름. `PutObjectCommand`/`GetObjectCommand` 의 `Bucket` 에 사용. 단, DELETE 경로는 오타 키를 참조 — [§2.2 DELETE /certs 의 bucket 키 오타](#22-delete-certs-의-bucket-키-오타). |
| `AWS_S3_ENDPOINT` | 아니오 | S3 호환 스토리지(예: MinIO) 사용 시 endpoint. `S3Client({ endpoint })` 에 전달. 미설정 시 기본 AWS S3 endpoint 사용. |

## 2. 결함 및 주의

### 2.1 env.d.ts 타입 선언 불완전 🟠

[env.d.ts](../../src/types/env.d.ts) 의 `ProcessEnv` 는 일부 키만 선언한다. 누락된 키도 런타임에서 `process.env.<KEY>` 로 사용되나, TypeScript 타입 보강(보장된 `string`) 혜택을 받지 못한다(`string | undefined`).

| 변수 | env.d.ts 선언 | 비고 |
| --- | --- | --- |
| `BASE_URL` | 선언됨 | — |
| `AWS_REGION` | 선언됨 | — |
| `AWS_ACCESS_KEY_ID` | 선언됨 | — |
| `AWS_SECRET_ACCESS_KEY` | 선언됨 | — |
| `GOOGLE_CLIENT_ID` | 선언됨 | — |
| `GOOGLE_CLIENT_SECRET` | 선언됨 | — |
| `DEFAULT_ADMIN_EMAIL` | 미선언 | [auth.ts](../../src/lib/auth.ts) 에서 사용. |
| `NEXTAUTH_URL` | 미선언 | NextAuth 내부 사용. |
| `NEXTAUTH_SECRET` | 미선언 | NextAuth 내부 사용. |
| `DATABASE_URL` | 미선언 | Prisma 가 사용. |
| `AWS_S3_BUCKET_NAME` | 미선언 | S3 command 의 `Bucket` 에 사용. |
| `AWS_S3_ENDPOINT` | 미선언 | `S3Client({ endpoint })` 에 사용(선택). |

영향: 누락 키는 컴파일 타임 누락 검출이 되지 않으며, 미설정 시 런타임에서 `undefined` 가 그대로 전달된다. 상세는 [security-and-known-issues.md](../explanation/security-and-known-issues.md) 참조.

### 2.2 DELETE /certs 의 bucket 키 오타 🟠

[certs/[id]/route.ts](../../src/app/api/certs/[id]/route.ts) 의 DELETE 핸들러는 인증서 이미지 삭제 시 `DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, ... })` 로 잘못된 키 `AWS_S3_BUCKET` 을 참조한다. 다른 경로는 모두 정상 키 `AWS_S3_BUCKET_NAME` 을 사용한다.

| 경로 / 심볼 | 사용 키 | 상태 |
| --- | --- | --- |
| [route.ts](../../src/app/api/certs/route.ts) `POST()` `PutObjectCommand` | `AWS_S3_BUCKET_NAME` | 정상 |
| [images/[id]/route.ts](../../src/app/api/images/[id]/route.ts) `GET()` `GetObjectCommand` | `AWS_S3_BUCKET_NAME` | 정상 |
| [certs/[id]/issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts) | `AWS_S3_BUCKET_NAME` | 정상 |
| [certs/[id]/route.ts](../../src/app/api/certs/[id]/route.ts) DELETE `DeleteObjectCommand` | `AWS_S3_BUCKET` | 🟠 오타 |

영향: `AWS_S3_BUCKET` 을 별도로 설정하지 않는 한 DELETE 시 `Bucket` 이 `undefined` 가 되어 이미지 삭제가 실패하고 `500` 으로 응답할 수 있다(DB 레코드 삭제는 S3 호출 이전에 수행됨). 상세·재현은 [security-and-known-issues.md](../explanation/security-and-known-issues.md) §2.4 참조.

## 3. 카테고리별 그룹

[README.md](../../README.md) 의 분류와 사용처를 함께 정리한다.

| 카테고리 | 변수 |
| --- | --- |
| General | `BASE_URL`, `DEFAULT_ADMIN_EMAIL` |
| NextAuth | `NEXTAUTH_URL`, `NEXTAUTH_SECRET` |
| Database | `DATABASE_URL` |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| AWS S3 / S3 호환 | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET_NAME`, `AWS_S3_ENDPOINT` |

## 4. 시크릿 생성

| 변수 | 생성 방법 |
| --- | --- |
| `NEXTAUTH_SECRET` | `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console 의 OAuth 2.0 Client 발급 값. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS IAM(또는 S3 호환 스토리지) 자격증명 발급 값. |

생성된 시크릿 값은 배포 환경의 secret store 에만 보관하며 저장소·문서에 평문으로 두지 않는다.
