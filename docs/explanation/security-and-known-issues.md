# 보안 및 알려진 결함 (현행 구현)

> **범위:** 현행 Next.js 13(App Router) cert-management 구현의 보안 취약점과 알려진 결함을 심볼 기준으로 정리한다. 재작성(Vite + React + FastAPI) 계획은 [plan.md](../plan.md) / [spec.md](../spec.md)에 있으며, 본 문서에서는 '설계(미구현)'로만 참조한다.
> **대상:** 보안 리뷰어, 운영 담당, 재작성 작업자.
> **상태:** 구현 반영 — 기준일 2026-06-11.

본 문서는 **as-is** 동작을 기술한다. 모든 항목은 코드를 직접 읽어 확인했으며, 재작성에서의 수정 매핑은 [§5 추적 표](#5-이슈-추적-표)에 정리한다. 상태 마커: 🔴 치명 · 🟠 조건부 결함 · 🟢 의도된 제한 · ✅ 해결.

---

## 1. 치명적 보안 취약점 (🔴)

### 1.1 클라이언트 data URI MIME 신뢰 → first-party 스토어드 XSS

업로드부터 다운로드까지 클라이언트가 보낸 data URI의 MIME을 **검증 없이 신뢰**한다. 세 지점이 연결되어 first-party 스토어드 XSS가 성립한다.

| 단계 | 위치(심볼) | 동작 |
|------|-----------|------|
| 디코딩 | [dataURI.ts](../../src/lib/dataURI.ts) 의 `dataURItoUint8Array()` | `dataURI`의 첫 토큰에서 `mimeString`을 파싱해 그대로 반환. 매직 바이트 검증 없음 |
| 저장 | [route.ts](../../src/app/api/certs/route.ts) 의 `POST()` | `dataURItoUint8Array(imageContent)`의 `mime`을 `mime.extension()`에 넣어 `${crypto.randomUUID()}.${extension}` 파일명 생성 후 S3 업로드 |
| 다운로드 | [route.ts](../../src/app/api/images/[id]/route.ts) 의 `GET()` | 응답 `Content-Type`을 `mime.contentType(id)`(파일명 확장자 기반)으로 echo |

- **공격 경로**: Admin이 증명서를 만들 때 `POST()`는 본문 검증을 `!name || !content || ...` 수준에서만 한다(매직 바이트·MIME 화이트리스트 없음). `data:text/html;base64,...` 또는 `<script>`를 품은 SVG를 `content.image.data`로 보내면 `mime.extension()`이 `html`/`svg` 확장자를 산출하고, 같은 확장자 키로 S3에 저장된다.
- `GET()`이 그 키를 `mime.contentType(id)`로 다시 `text/html`/`image/svg+xml`로 echo하므로, 이미지 호스트(first-party origin)에서 임의 HTML/스크립트가 실행된다.
- `GET()`은 `X-Content-Type-Options: nosniff`나 CSP를 설정하지 않으며, 키 형식 검증도 `!id || id.includes("/")`에 그친다(확장자 화이트리스트 없음).
- **영향**: 동일 origin 실행 → NextAuth 세션 쿠키 탈취/CSRF·계정 권한 도용.
- **신뢰 경계**: 업로드는 Admin 전용이지만, XSS 피해자는 해당 이미지를 보는 모든 사용자다(stored).

> 디코딩 분기 자체도 취약하다: `dataURItoUint8Array()`는 `byteString.charCodeAt(i)`로 바이트를 채우므로 비-base64/비-Latin1 경로에서 손상 가능성이 있으나, MIME 신뢰가 1차 위협이다.

### 1.2 `signIn` 콜백 — `email_verified` 미검증 + `googleId` 무조건 덮어쓰기

[auth.ts](../../src/lib/auth.ts) 의 `signIn` 콜백.

| 결함 | 코드상 사실 |
|------|------------|
| `email_verified` 미검증 | `googleProfile`에서 `sub`/`email`/`name`만 사용하고 `email_verified`를 전혀 확인하지 않는다 |
| 비관리자 경로 `googleId` 무조건 덮어쓰기 | `DEFAULT_ADMIN_EMAIL` 분기를 벗어난 일반 경로에서, `databaseUser`가 존재하면 조건 없이 `prisma.user.update({ where: { id }, data: { googleId } })` 실행 |

- **공격 경로**: 사전 등록된 이메일(`databaseUser.email`)을 자신의 미인증 Google 계정에 claim한 공격자가 로그인하면, `email_verified` 검사가 없으므로 통과하고, 그 사용자 row의 `googleId`가 공격자의 `sub`로 덮어써진다 → **계정 탈취**.
- `jwt` 콜백이 `googleId`(=`user.id`)로 `databaseUser`를 조회해 세션을 구성하므로, 한번 덮어쓰면 이후 로그인이 공격자 sub로 고정된다.
- **부수 결함(🟠)**: `DEFAULT_ADMIN_EMAIL` 분기는 `adminUser`가 이미 존재하면 `googleId`/Admin 그룹 연결을 보장하지 않는다(신규 생성 시에만 `connect`). default admin이 이미 있으면 멤버십 보장 누락 — [§4.2](#42-default-admin-부트스트랩-멱등성-부재) 참조.

### 1.3 users 라우트 — untrusted `groups` 페이로드 직통 → 자기 demote / 마지막 admin 잠금

| 위치(심볼) | 코드상 사실 |
|-----------|------------|
| [route.ts](../../src/app/api/users/route.ts) 의 `POST()` | 요청 본문 `groups`를 검증 없이 `prisma.user.create({ data: { groups: { connect: groups } } })`에 직통 |
| [route.ts](../../src/app/api/users/[id]/route.ts) 의 `POST()` | 요청 본문 `groups`를 `prisma.user.update({ data: { groups: { set: groups.map((g) => ({ id: g.id })) } } })`에 직통 |

- 두 핸들러 모두 호출자가 Admin인지만 확인하고(`user.groups.find((g) => g.name === "Admin")`), 다음 가드가 **전혀 없다**:
  - 그룹 id의 존재 검증.
  - **자기 자신 demote 금지** — Admin이 자신의 `groups`에서 Admin을 빼는 `set`을 허용.
  - **마지막 Admin 보호** — 마지막 남은 Admin을 demote/삭제하면 시스템 전체가 Admin 잠금(관리 불능) 상태가 된다.
- `[id]/route.ts` 의 `POST()`는 `groups`가 누락/비배열이어도 `groups.map`을 호출하므로 런타임 throw 가능성도 있다(확인 필요: 클라이언트가 항상 배열을 보낸다는 보장 없음).
- 권한 검사는 이름 문자열 `"Admin"` 매칭이 유일한 진실 출처이므로, 마지막 Admin demote는 곧 영구 잠금이다([§1.4](#14-delete-apigroupsid--admin-그룹-삭제-보호-부재)와 동일한 단일 진실 출처 문제).

### 1.4 `DELETE /api/groups/:id` — Admin 그룹 삭제 보호 부재

[route.ts](../../src/app/api/groups/[id]/route.ts) 의 `DELETE()`.

- 호출자 Admin 여부와 `id`의 UUID 형식(`validator.isUUID`)만 검증한 뒤, 대상 그룹 이름과 무관하게 `prisma.group.delete()`를 실행한다.
- **`Admin` 그룹 자체를 삭제할 수 있다.** 권한 검사가 `g.name === "Admin"` 기반이므로 Admin 그룹이 사라지면 어떤 사용자도 관리자 권한을 가질 수 없게 되어 **시스템 영구 잠금**.
- 이 라우트에는 PUT(이름 변경) 핸들러가 없으나, 재작성 설계는 이름 변경 우회까지 차단한다(미구현, [§5](#5-이슈-추적-표) 참조).

### 1.5 변경 라우트 CSRF 미보호

- 모든 변경 라우트(`POST`/`DELETE` 핸들러)는 쿠키 세션(`getServerSession`)만으로 인증하며, **Origin/Referer 검증·CSRF 토큰·커스텀 요청 헤더 요구가 전혀 없다**. 확인된 핸들러: [route.ts](../../src/app/api/certs/route.ts) 의 `POST()`, [route.ts](../../src/app/api/certs/[id]/route.ts) 의 `DELETE()`, [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`, [route.ts](../../src/app/api/users/route.ts) 의 `POST()`, [route.ts](../../src/app/api/users/[id]/route.ts) 의 `POST()`/`DELETE()`, [route.ts](../../src/app/api/groups/[id]/route.ts) 의 `DELETE()`.
- NextAuth 기본 쿠키의 `SameSite` 정책에 의존할 뿐, 애플리케이션 레이어의 CSRF 방어가 없다.
- **영향**: 다른 결함과 결합 시(특히 [§1.1](#11-클라이언트-data-uri-mime-신뢰--first-party-스토어드-xss)의 동일 origin XSS) 변경 요청 위조가 용이해진다.

---

## 2. 조건부 결함 (🟠)

### 2.1 `issue` 라우트 — orphan `CertificateLog` (PDF/S3 성공 전 생성)

[route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`.

- 발급 순서가 잘못되어 있다:
  1. `prisma.certificateLog.create()`로 **로그를 먼저 생성**.
  2. 이후 S3에서 배경 이미지 GET → PDFKit으로 합성 → `pdfStream` → S3 PUT(`certs/issued/${certLog.id}.pdf`) → presigned URL.
- 1번 이후 임의 단계가 실패하면(이미지 GET 실패 → 500, S3 PUT 실패 → 500 반환), 로그 row는 **롤백되지 않는다**. QR 검증 URL은 `${BASE_URL}/validate/${certLog.id}`로 이미 발급 ID를 가리키므로, "검증은 유효한데 PDF는 없는" **orphan 상태**가 생긴다.

### 2.2 `issue` 라우트 — `Certificate.expiresAt` 만료 미검사

- [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`는 인증, `validator.isUUID(id)`, `cert.userIds.includes(user.id)`(수령자 여부)만 검사한다.
- **증명서 만료(`Certificate.expiresAt`)를 전혀 확인하지 않는다.** 만료된 증명서도 발급된다. [schema.prisma](../../prisma/schema.prisma) 의 `Certificate` 모델에는 `expiresAt DateTime?` 컬럼이 **이미 존재**하나, `src/` 코드(발급 라우트 포함)는 이 필드를 한 번도 읽지 않는다. 입력 폼/검사가 없다는 점은 [spec.md §11](../spec.md) 표 8행과 일치한다.

### 2.3 `issue` 라우트 — 폰트 복사 `forEach(async)` race

- [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`가 PDFKit 폰트 데이터를 런타임에 `__dirname/data`로 복사한다:
  - `fontList.forEach(async (font) => { ... await fs.writeFile(...) })` — `forEach`는 async 콜백의 완료를 await하지 않는다. 복사가 끝나기 전에 합성(`doc.font("data/ChosunGs.ttf", ...)`)으로 진행될 수 있는 **race**다.
  - read-only 파일시스템(예: Lambda)에서는 `fs.mkdir`/`fs.writeFile`가 실패하고 `catch`가 삼키므로, 폰트 없이 렌더 → 한글 깨짐 가능.
- 유사 패턴이 본문 합성에도 있다: `content.rects.forEach(async (rect) => { ... })`는 async 콜백을 await하지 않으나, 내부가 동기 `doc.image(...)` 호출이라 실질 영향은 폰트 경로가 더 크다(확인 필요).

### 2.4 `DELETE /certs` — `AWS_S3_BUCKET` env 키 오타

[route.ts](../../src/app/api/certs/[id]/route.ts) 의 `DELETE()`.

| 항목 | 값 |
|------|----|
| 사용된 키 | `process.env.AWS_S3_BUCKET` |
| 다른 모든 라우트가 쓰는 키 | `process.env.AWS_S3_BUCKET_NAME` (`certs/route.ts`, `images/[id]/route.ts`, `issue/route.ts`) |

- `DELETE()`는 DB에서 `certificateLog.deleteMany` + `certificate.delete`를 먼저 수행한 뒤, 배경 이미지 삭제 시 `DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, ... })`를 사용한다.
- `AWS_S3_BUCKET`은 다른 곳에서 설정되지 않는 오타 키이므로 `undefined`가 되어 **S3 삭제가 실패**한다. 그 결과 `catch`가 500을 반환하지만, **DB row는 이미 삭제된 뒤**라 배경 이미지가 S3에 영구 leak된다.

---

## 3. 의도된 제한 / 정정 (🟢)

### 3.1 `Pagination` — Rules of Hooks 위반 아님

[Pagination.tsx](../../src/components/Pagination.tsx) 의 `Pagination()`.

- 이 컴포넌트는 **React 훅(`useState`/`useEffect` 등)을 전혀 사용하지 않는다.** 따라서 "Rules of Hooks 위반"은 **해당 없음**(정정).
- 실제 디자인 이슈는 **조건부 렌더 누락**이다:

| 입력 상황 | 현행 동작 | 바람직한 동작 |
|-----------|----------|--------------|
| `total === 0` | `totalpages = 0`, 빈 `<nav>` 렌더 | 렌더 안 함 |
| `total <= perPage` | `totalpages <= 1`, 단일 페이지 버튼 노출 | 렌더 안 함 |
| `page > totalpages` | 클램프 없음 | clamp 필요 |

- 우측 화살표 disabled 조건은 `endPage === totalpages`인데, `totalpages === 0`인 경우는 별도로 다루지 않는다(`startPage=1`, `endPage=0`이라 버튼 0개 + 빈 nav).
- 재작성 설계([§6.9 Pagination 컨트랙트](../spec.md))는 `totalpages <= 1`일 때 `null` 반환 + `useEffect` clamp를 도입한다. **이때 비로소 훅이 생기므로** Rules of Hooks(early return 이전 훅 배치)가 적용 대상이 된다 — 이는 신규 코드의 제약이지 현행 코드의 결함이 아니다.

### 3.2 좌표 y-flip 누락 — 현행 PDFKit에선 정상

[route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `toDocCoordinates()`.

- `toDocCoordinates(x, y, orientation)`는 디자이너 픽셀(landscape 1024×720 / portrait 720×1024)을 A4 포인트로 **스케일만** 한다. y축 뒤집기(flip)가 없다.
- **PDFKit의 좌표 원점은 좌상단**이고 Fabric.js 디자이너도 좌상단이므로, 현행 구현에서는 y-flip이 **불필요**하다. 결함 아님.
- y-flip은 원점이 **좌하단**인 reportlab 기반 재작성에서만 필요하다([§5.3 좌표 변환](../spec.md), 미구현). 현행 정본 기준 정상.

---

## 4. 인증 콜백 부수 사항

### 4.1 세션/JWT 콜백 구성

[auth.ts](../../src/lib/auth.ts) 의 `session`/`jwt` 콜백.

- `jwt` 콜백은 `user.id`(Google `sub`)를 `googleId`로 보고 DB 사용자를 조회해 토큰에 `id`/`name`/`googleId`를 싣는다.
- `session` 콜백은 토큰의 `id`/`name`/`googleId`만 세션에 노출한다(email/groups 미포함). 권한 검사는 각 라우트가 `session.user.id`로 DB를 재조회해 수행한다.

### 4.2 default admin 부트스트랩 멱등성 부재

- [auth.ts](../../src/lib/auth.ts) 의 `signIn` 콜백의 `DEFAULT_ADMIN_EMAIL` 분기는 `adminUser`가 **존재하지 않을 때만** 사용자 생성 + Admin `connect`를 수행한다.
- 이미 존재하는 default admin의 `googleId` 갱신이나 Admin 그룹 멤버십 **재보장이 없다.** admin 락아웃 복구 경로가 사실상 부재(🟠).

---

## 5. 이슈 추적 표

재작성 수정 매핑은 [plan.md](../plan.md) / [spec.md](../spec.md)의 해당 절을 가리킨다(모두 **미구현(목표)**).

| 이슈 | 심각도 | 위치(심볼) | 재작성 수정(spec.md §) |
|------|--------|-----------|------------------------|
| data URI MIME 신뢰 → 스토어드 XSS | 🔴 | `dataURItoUint8Array()` ([dataURI.ts](../../src/lib/dataURI.ts)) · `POST()` ([certs/route.ts](../../src/app/api/certs/route.ts)) · `GET()` ([images/[id]/route.ts](../../src/app/api/images/[id]/route.ts)) | §4.5 / §4.2.1 (MIME 화이트리스트 + Pillow 매직 바이트 + 신뢰 MIME echo + nosniff/CSP), §8.3 |
| `email_verified` 미검증 + `googleId` 무조건 덮어쓰기 → 계정 탈취 | 🔴 | `signIn` 콜백 ([auth.ts](../../src/lib/auth.ts)) | §3.1 (email_verified 강제, google_id 조건부 set, IntegrityError→duplicate_google_id) |
| untrusted `groups` → 자기 demote / 마지막 admin 잠금 | 🔴 | `POST()` ([users/route.ts](../../src/app/api/users/route.ts)) · `POST()` ([users/[id]/route.ts](../../src/app/api/users/[id]/route.ts)) | §4.3.1 / §4.3.2 (Pydantic UserCreate/UserUpdate + group_ids 존재 검증 + self-demote/마지막 Admin 가드) |
| Admin 그룹 삭제 보호 부재 | 🔴 | `DELETE()` ([groups/[id]/route.ts](../../src/app/api/groups/[id]/route.ts)) | §4.4 (DELETE 거부 + PUT 현재/새 이름 Admin 거부) |
| 변경 라우트 CSRF 미보호 | 🔴 | 모든 변경 핸들러(certs/users/groups/issue `POST`/`DELETE`) | §8.1 (`CsrfMiddleware`: Origin/Referer allowlist + `X-Requested-With: fetch`) |
| orphan `CertificateLog` (PDF/S3 전 생성) | 🟠 | `POST()` ([issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts)) | §5.5 (log_id 선생성 → PDF → S3 PUT → DB INSERT → presign, 단계별 보상) |
| `Certificate.expiresAt` 만료 미검사 | 🟠 | `POST()` ([issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts)) | §4.2.2 (미만료 사전 가드, 만료 시 `410 certificate_expired`) |
| 폰트 복사 `forEach(async)` race | 🟠 | `POST()` ([issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts)) | §5.2 (도커 이미지 폰트 COPY + startup 1회 `registerFont`) |
| `AWS_S3_BUCKET` env 키 오타 → 이미지 leak | 🟠 | `DELETE()` ([certs/[id]/route.ts](../../src/app/api/certs/[id]/route.ts)) | §4.2.3 (`settings.AWS_S3_BUCKET_NAME` 단일 출처 + DB-then-S3 + cleanup queue) |
| default admin 부트스트랩 멱등성 부재 | 🟠 | `signIn` 콜백 ([auth.ts](../../src/lib/auth.ts)) | §3.1 step 6 (idempotent upsert + 항상 Admin 보장 + 복구 경로) |
| Pagination — Rules of Hooks 위반 **아님**, 조건부 렌더 누락 | 🟢 | `Pagination()` ([Pagination.tsx](../../src/components/Pagination.tsx)) | §6.9 (`totalpages <= 1` null 리턴 + useEffect clamp) |
| 좌표 y-flip 누락 — 현행 PDFKit에선 정상 | 🟢 | `toDocCoordinates()` ([issue/route.ts](../../src/app/api/certs/[id]/issue/route.ts)) | §5.3 (reportlab 좌하단 원점용 4종 헬퍼; 재작성에서만 필요) |
| 자동화 테스트 0건 | 🟠 | 리포 전역 | §10 (pytest + Vitest + Playwright + Coverage 게이트) |

---

## 6. 테스트 현황

- **단위/통합/E2E 테스트 0건.** 현행 리포에 자동화 테스트가 존재하지 않는다. 위 결함들은 회귀 방지 장치 없이 운영된다. 재작성 설계는 [§10 테스트](../spec.md)에서 처음부터 테스트 매트릭스를 도입한다(미구현).
