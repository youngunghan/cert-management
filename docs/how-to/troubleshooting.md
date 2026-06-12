# 트러블슈팅

> **범위:** 증명서 발급(PDF 생성·S3 업로드)·검증·삭제·관리자 대시보드의 현행 결함과 운영 중 흔히 마주치는 증상.
> **대상:** 배포·운영 담당자 및 유지보수 개발자.
> **상태:** 구현 반영 — 기준일 2026-06-11.

본 문서는 현행(as-is) Next.js 13 구현을 기준으로 증상별 원인·조치·코드 위치를 정리한다. 재작성 계획([plan.md](../plan.md)/[spec.md](../spec.md))의 설계는 '미구현(목표)'로만 언급한다. 보안 성격이 짙은 항목은 [explanation/security-and-known-issues.md](../explanation/security-and-known-issues.md)에 별도 정리되어 있다.

상태 마커: 🔴 치명 · 🟠 조건부 결함 · 🟢 의도된 제한 · ✅ 해결.

## 1. 증상별 진단

### 1.1 PDF의 한글이 깨지거나 폰트를 찾지 못함 🔴

발급된 PDF에서 한글이 공백·깨짐으로 표시되거나, 서버 로그에 `ChosunGs.ttf`를 찾을 수 없다는 폰트 로드 에러가 출력된다.

| 항목 | 내용 |
| --- | --- |
| 원인 1 | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`가 폰트를 복사할 때 `fontList.forEach(async ...)` 패턴을 사용한다. `forEach`는 내부 async 콜백의 Promise를 await하지 않으므로, 폰트 `writeFile`이 끝나기 전에 텍스트 렌더링(`doc.font("data/ChosunGs.ttf", h)`)이 실행되는 race가 발생한다. |
| 원인 2 | [install.sh](../../install.sh)가 `data` 디렉터리를 `./.next/server/chunks`로 복사한다. 이 스크립트가 빌드 후 실행되지 않으면 런타임 작업 디렉터리에 `ChosunGs.ttf`가 존재하지 않는다. |
| 조치 1 | `forEach(async ...)`를 `for...of` + `await` 또는 `await Promise.all(fontList.map(...))`로 교체하여 폰트 복사 완료 후 렌더링이 시작되도록 한다(설계(미구현)). |
| 조치 2 | 배포 파이프라인에서 빌드 직후 [install.sh](../../install.sh)가 반드시 실행되도록 보장하고, 복사 대상 경로에 폰트 파일이 존재하는지 확인한다. |
| 위치 | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()` 폰트 복사 블록 / [install.sh](../../install.sh) |

폰트 복사 race 흐름은 아래와 같다.

```text
POST()
  ├─ fontList.forEach(async font => { ... await writeFile })   ← await 되지 않음
  │      (writeFile 진행 중)
  └─ content.texts.forEach(text => doc.font("data/ChosunGs.ttf", h) ...)
                                  ▼
              폰트 파일 미완성 상태에서 렌더링 → 한글 깨짐
```

### 1.2 관리자 대시보드에 NaN% 또는 Infinity% 표시 🟠

관리자 대시보드의 '가입률' 또는 '발급률' 카드에 `NaN%`(또는 `Infinity%`)가 출력된다.

| 항목 | 내용 |
| --- | --- |
| 원인 | [page.tsx](../../src/app/(full)/admin/page.tsx) 의 `AdminPage()`가 비율을 분모 검사 없이 계산한다. 가입률은 `Math.round((registeredUsers.length / users.length) * 100)`, 발급률은 `Math.round((issuedCerts.length / certs.length) * 100)`. 사용자가 0명이면 `0/0 → NaN`, 증명서가 0개이면 `0/0 → NaN`이 된다. |
| 조치 | 분모가 0일 때 `0%`로 대체하도록 가드를 추가한다(설계(미구현)). 예: 분모가 `0`이면 비율을 `0`으로 처리. |
| 위치 | [page.tsx](../../src/app/(full)/admin/page.tsx) 의 `AdminPage()` 가입률·발급률 `Math.round` 식 |

| 카드 | 분자 | 분모 | 0 분모일 때 결과 |
| --- | --- | --- | --- |
| 가입률 | `registeredUsers.length` | `users.length` | `NaN%` |
| 발급률 | `issuedCerts.length` | `certs.length` | `NaN%` |

### 1.3 증명서를 삭제해도 S3 이미지가 남음(스토리지 leak) 🔴

관리자가 증명서를 삭제하면 DB 레코드는 제거되지만 `certs/images/`의 원본 이미지가 S3에 그대로 남아 누적된다. 서버 로그에 이미지 삭제 실패 메시지가 출력될 수 있다.

| 항목 | 내용 |
| --- | --- |
| 원인 | [route.ts](../../src/app/api/certs/[id]/route.ts) 의 `DELETE()`가 `DeleteObjectCommand`의 `Bucket`에 잘못된 env 키 `AWS_S3_BUCKET`을 사용한다. 코드베이스의 나머지 S3 호출은 모두 `AWS_S3_BUCKET_NAME`을 사용한다([route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `GetObjectCommand`/`PutObjectCommand` 참조). `AWS_S3_BUCKET`이 미설정이면 `Bucket`이 undefined가 되어 삭제가 실패한다. |
| 부가 | `DELETE()`는 `certificateLog.deleteMany` → `certificate.delete`를 먼저 수행한 뒤 이미지 삭제를 시도한다. 이미지 삭제가 실패해 500을 반환하더라도 DB 레코드는 이미 제거된 상태이므로, 이미지는 영구히 고아(orphan) 객체로 남는다. |
| 조치 | `DELETE()`의 `Bucket`을 `AWS_S3_BUCKET_NAME`으로 정정하고, 두 env 키 중 하나로 통일한다(설계(미구현)). 운영 키 이름만 사용하고 시크릿 평문은 노출하지 않는다. |
| 위치 | [route.ts](../../src/app/api/certs/[id]/route.ts) 의 `DELETE()` `DeleteObjectCommand` |

| env 키 | 사용 위치 | 비고 |
| --- | --- | --- |
| `AWS_S3_BUCKET_NAME` | issue `POST()`, certs `route.ts`, images `route.ts` | 정본으로 쓰이는 키 |
| `AWS_S3_BUCKET` | `DELETE()` 한 곳 | 오타로 추정되는 키, undefined 시 삭제 실패 |

보안·데이터 보존 관점의 추가 논의는 [explanation/security-and-known-issues.md](../explanation/security-and-known-issues.md) 참고.

### 1.4 발급은 성공했는데 PDF가 없음(orphan 로그) 🟠

발급률·발급 통계에는 집계되지만 다운로드 가능한 PDF가 존재하지 않는 `CertificateLog`가 생긴다.

| 항목 | 내용 |
| --- | --- |
| 원인 | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`가 `prisma.certificateLog.create`로 로그를 먼저 생성한 뒤, 그 이후 단계에서 S3 이미지 fetch, PDF 렌더링, `PutObjectCommand` 업로드를 수행한다. 이미지 fetch 실패(500), 업로드 실패(500) 등 후속 단계가 실패해도 이미 생성된 `CertificateLog`는 롤백되지 않는다. 결과적으로 로그는 존재하지만 `certs/issued/{certLog.id}.pdf`는 없는 orphan 상태가 된다. |
| 영향 | [page.tsx](../../src/app/(full)/admin/page.tsx) 의 발급 통계(`logs.length`, `issuedCerts`)가 실제 PDF가 없는 로그까지 포함해 부풀려진다. |
| 조치 | PDF 업로드 성공 이후에 `CertificateLog`를 생성하거나, 트랜잭션/보상 로직으로 실패 시 로그를 정리한다(설계(미구현)). |
| 위치 | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()` `certificateLog.create` 및 그 이후 S3 단계 |

발급 단계 순서는 다음과 같다.

```text
POST()
  ├─ certificateLog.create()         ← 로그 먼저 생성(커밋됨)
  ├─ s3.send(GetObjectCommand)        ← 이미지 fetch (실패 시 500)
  ├─ doc.pipe / doc.end               ← PDF 렌더링
  └─ s3.send(PutObjectCommand)        ← PDF 업로드 (실패 시 500)
         ▼
   업로드 실패해도 로그는 남음 → orphan 로그
```

### 1.5 만료된 증명서가 발급되고 유효로 표시됨 🟠

`Certificate.expiresAt`이 과거인 증명서도 정상 발급되며, 검증 페이지에서 '유효한 증명서입니다.'로 표시된다.

| 항목 | 내용 |
| --- | --- |
| 원인(발급) | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`가 소유자(`cert.userIds.includes`)만 확인하고 `cert.expiresAt`을 전혀 검사하지 않는다. 만료 여부와 무관하게 PDF가 발급된다. |
| 원인(검증) | [page.tsx](../../src/app/(full)/validate/[id]/page.tsx) 의 `ValidatePage()`가 `certificateLog`를 조회해 존재하면 무조건 유효 화면을 렌더링한다. `certificate.expiresAt` 비교가 없다. |
| 스키마 | `Certificate.expiresAt`은 schema에 `DateTime?`(nullable)로 정의되어 있으나 `src/` 어디에서도 읽지 않는다([reference/data-model.md](../reference/data-model.md) 참조). |
| 조치 | 발급 시 `expiresAt < now`이면 거부하고, 검증 시 만료된 경우 무효 화면(`InvalidPage`)으로 분기한다(설계(미구현)). |
| 위치 | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()` / [page.tsx](../../src/app/(full)/validate/[id]/page.tsx) 의 `ValidatePage()` |

| 단계 | `expiresAt` 검사 | 현행 동작 |
| --- | --- | --- |
| 발급 `POST()` | 없음 | 만료 증명서도 발급 |
| 검증 `ValidatePage()` | 없음 | 로그 존재 시 항상 유효 표시 |

## 2. 빠른 점검 체크리스트

| 증상 | 우선 확인 | 참조 |
| --- | --- | --- |
| PDF 한글 깨짐 | 폰트 복사 await 누락, install.sh 실행 여부 | [§1.1 PDF의 한글이 깨지거나 폰트를 찾지 못함](#11-pdf의-한글이-깨지거나-폰트를-찾지-못함-) |
| 대시보드 NaN% | 사용자·증명서 수가 0인지 | [§1.2 관리자 대시보드에 NaN% 또는 Infinity% 표시](#12-관리자-대시보드에-nan-또는-infinity-표시-) |
| 삭제 후 이미지 잔존 | `DELETE()`의 Bucket env 키 | [§1.3 증명서를 삭제해도 S3 이미지가 남음(스토리지 leak)](#13-증명서를-삭제해도-s3-이미지가-남음스토리지-leak-) |
| 발급됐는데 PDF 없음 | 로그 생성 순서, S3 업로드 실패 로그 | [§1.4 발급은 성공했는데 PDF가 없음(orphan 로그)](#14-발급은-성공했는데-pdf가-없음orphan-로그-) |
| 만료 증명서 유효 표시 | `expiresAt` 미검사 | [§1.5 만료된 증명서가 발급되고 유효로 표시됨](#15-만료된-증명서가-발급되고-유효로-표시됨-) |
