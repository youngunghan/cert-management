# 사용자와 그룹 관리

> **범위:** 사용자/그룹 CRUD API와 CSV 일괄 등록(현행 Next.js 13 App Router 구현).
> **대상:** Admin 그룹 소속 운영자, 그리고 관리 화면을 다루는 프론트엔드 개발자.
> **상태:** 구현 반영 — 기준일 2026-06-11.

이 문서는 [/api/users/route.ts](../../src/app/api/users/route.ts), [/api/users/[id]/route.ts](../../src/app/api/users/[id]/route.ts), [/api/users/file/route.ts](../../src/app/api/users/file/route.ts), [/api/groups/route.ts](../../src/app/api/groups/route.ts), [/api/groups/[id]/route.ts](../../src/app/api/groups/[id]/route.ts) 의 현행 구현을 정본으로 한다. 데이터 모델은 [schema.prisma](../../prisma/schema.prisma) 의 `User`/`Group` 을 따른다.

## 1. 사전 조건과 권한 모델

모든 사용자/그룹 관리 엔드포인트는 다음 두 단계 가드를 동일하게 적용한다(각 `POST()`/`DELETE()` 함수 상단).

| 단계 | 검사 | 실패 시 응답 |
| --- | --- | --- |
| 인증 | `getServerSession(authOptions)` 결과가 존재 | `401` Unauthorized |
| 인가 | `prisma.user.findUnique` 로 세션 사용자 레코드를 조회하고, `!user || !user.groups.find((g) => g.name === "Admin")` 가 거짓 | `403` Forbidden |

즉, **`Admin` 그룹 소속 사용자만** 모든 관리 동작을 수행할 수 있다. 세션은 있으나 DB에 `User` 레코드가 없는 경우(`!user`)와, 레코드는 있으나 `Admin` 그룹이 없는 경우 모두 인가 단계에서 `403` 으로 차단된다.

### 1.1 Admin 그룹 부트스트랩

`Admin` 그룹과 최초 관리자 계정은 [auth.ts](../../src/lib/auth.ts) 의 `signIn` 콜백에서 자동 생성된다.

- `DEFAULT_ADMIN_EMAIL` 환경 변수와 일치하는 이메일로 Google 로그인하면, `Admin` 그룹이 없을 경우 생성한다. 해당 이메일의 `User`가 없을 때만 새 사용자 생성과 `Admin` 그룹 연결을 함께 수행한다. 이미 존재하는 default admin의 `googleId`/그룹 멤버십 재보장은 현행 코드에서 수행하지 않는다.
- 그 외 이메일은 사전에 `User` 레코드가 존재해야 로그인되며, 없으면 `/unregistered` 로 리다이렉트된다.

> 시크릿 평문은 본 문서에 싣지 않는다. 키 이름(`DEFAULT_ADMIN_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)만 참조한다.

## 2. 사용자 관리

### 2.1 사용자 생성

[/api/users/route.ts](../../src/app/api/users/route.ts) 의 `POST()`.

`POST /api/users`

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `name` | `string` | 예 | 사용자 이름. falsy면 `400`. |
| `email` | `string` | 예 | `validator.isEmail` 통과해야 함. 실패 시 `400`. |
| `googleId` | `string \| null` | 아니오 | Google 계정 sub. 미지정 가능. |
| `groups` | `Prisma connect 입력` | 아니오 | 그대로 `groups.connect` 로 전달되는 식별자 목록(예: `[{ "id": "<UUID>" }]`). |

검증 규칙은 `!name || !validator.isEmail(email)` 단 한 줄이다. `groups` 값은 검증 없이 Prisma `connect` 로 전달된다.

| 응답 | 조건 |
| --- | --- |
| `201` `{ result: true, data: <newUser> }` | 생성 성공 |
| `400` Bad Request | `name` 누락 또는 이메일 형식 오류 |
| `401` / `403` | [§1](#1-사전-조건과-권한-모델) 가드 위반 |

### 2.2 사용자 수정

[/api/users/[id]/route.ts](../../src/app/api/users/[id]/route.ts) 의 `POST()`. 대상 `id` 는 요청 URL 마지막 세그먼트(`req.url.split("/").pop()`)에서 추출한다.

`POST /api/users/:id`

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `memo` | `string` | 아니오 | `User.memo` 를 그대로 덮어쓴다. |
| `groups` | `Group[]` | 예 | `groups.set` 으로 **전량 교체**된다(`groups.map((g) => ({ id: g.id }))`). 부분 추가/삭제가 아니라 set 시맨틱이다. |

동작 순서: `memo` 갱신 → `groups` set 갱신, 두 번의 `prisma.user.update` 로 분리 수행한다. `groups` 가 `undefined` 이면 `.map` 단계에서 실패하므로 호출 시 배열로 전달해야 한다(확인 필요: 빈 배열 `[]` 전달 시 모든 그룹 해제).

| 응답 | 조건 |
| --- | --- |
| `201` `{ result: true }` | 갱신 성공 |
| `404` Not Found | 대상 `id` 의 사용자 없음 |
| `401` / `403` | [§1](#1-사전-조건과-권한-모델) 가드 위반 |

> 성공 시 상태 코드가 `201`(생성)인 점은 수정 동작과 의미가 어긋난다. 🟢 의도된 제한으로 간주하되 클라이언트는 `result` 플래그로 성공을 판정할 것.

### 2.3 사용자 삭제

[/api/users/[id]/route.ts](../../src/app/api/users/[id]/route.ts) 의 `DELETE()`. `id` 추출 방식은 [§2.2](#22-사용자-수정)와 동일하다.

`DELETE /api/users/:id`

| 응답 | 조건 |
| --- | --- |
| `200` `{ result: true }` | 삭제 성공 |
| `404` Not Found | 대상 `id` 의 사용자 없음 |
| `409` Conflict | 대상 사용자를 참조하는 `CertificateLog` 가 있어 DB 제약상 삭제할 수 없음 |
| `401` / `403` | [§1](#1-사전-조건과-권한-모델) 가드 위반 |

삭제 전 `id` 형식 검증은 없으며, 존재 여부만 `findUnique` 로 확인한다. `CertificateLog.userId` 는 DB에서 `ON DELETE RESTRICT` 이므로 발급 이력이 있는 사용자는 삭제할 수 없고 `409` 로 응답한다.

## 3. 그룹 관리

### 3.1 그룹 생성

[/api/groups/route.ts](../../src/app/api/groups/route.ts) 의 `POST()`.

`POST /api/groups`

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `name` | `string` | 예 | 그룹 이름. falsy면 `400`. `Group.name` 은 스키마상 `@unique`. |

| 응답 | 조건 |
| --- | --- |
| `200` `{ result: true, data: <newGroup> }` | 생성 성공(`ResponseDTO.json`, 기본 상태 `200`) |
| `400` Bad Request | `name` 누락 |
| `401` / `403` | [§1](#1-사전-조건과-권한-모델) 가드 위반 |

### 3.2 그룹 삭제

[/api/groups/[id]/route.ts](../../src/app/api/groups/[id]/route.ts) 의 `DELETE()`. `id` 는 `new URL(req.url).pathname.split("/").pop()` 로 추출한다.

`DELETE /api/groups/:id`

| 응답 | 조건 |
| --- | --- |
| `200` `{ result: true }` | 삭제 성공 |
| `400` Bad Request | `id` 누락, `validator.isUUID` 실패, 또는 대상 그룹이 `Admin` 그룹이라 삭제할 수 없음 |
| `404` Not Found | 대상 `id` 의 그룹 없음 |
| `401` / `403` | [§1](#1-사전-조건과-권한-모델) 가드 위반 |

> 그룹 삭제는 사용자 삭제와 달리 `validator.isUUID` 로 식별자 형식을 사전 검증한다.

## 4. CSV 일괄 등록

[/api/users/file/route.ts](../../src/app/api/users/file/route.ts) 의 `POST()`. 요청 본문은 JSON이 아니라 `req.text()` 로 읽는 원시 CSV 텍스트다.

`POST /api/users/file`

### 4.1 입력 형식

- 인코딩: UTF-8 텍스트(`req.text()`).
- 개행: `\r\n` 을 `\n` 으로 정규화한 뒤 줄 단위 분리. 컬럼 구분자는 `,`.
- 빈 줄(`line.trim().length === 0`)은 건너뛴다.
- 예시 파일: [public/examples/users.csv](../../public/examples/users.csv) (헤더 행만 포함).

| 컬럼 헤더 | 대상 필드 | 처리 |
| --- | --- | --- |
| `이름` | `User.name` | `trim()` 후 저장. **필수**. |
| `이메일` | `User.email` | `trim()` 후 저장. **필수**. |
| `그룹` | `User.groups` | `|` 구분 그룹 **UUID** 목록. 각 UUID를 `group.findUnique` 로 조회. **필수**. |
| `Google ID` | `User.googleId` | `trim()` 결과가 비면 `null`, 아니면 원본 값 저장. |
| `메모` | `User.memo` | `trim()` 후 저장. |

### 4.2 헤더 감지 모드

첫 줄을 `,` 로 분리한 `headers` 가 알려진 헤더 집합(`["이름","이메일","그룹","Google ID","메모"]`) 중 하나라도 포함하면 `hasHeader = true`.

| 모드 | 조건 | 동작 |
| --- | --- | --- |
| 헤더 있음 | 첫 줄에 알려진 헤더 포함 | 첫 줄을 헤더로 사용하고 `slice(1)` 부터 데이터로 파싱 |
| 헤더 없음 | 첫 줄에 알려진 헤더 없음 | `slice(0)`, 즉 첫 줄부터 데이터로 파싱하되 컬럼 매핑은 여전히 `headers`(=첫 데이터 줄) 기준 |

> 헤더가 없는 경우에도 컬럼 매핑은 `headers`(파일 첫 줄을 분리한 값)에 의존한다. 따라서 헤더 행 없이 업로드하면 컬럼 매핑이 첫 데이터 줄 내용에 좌우되어 의도대로 동작하지 않을 수 있다. 🟠 조건부 결함 — 헤더 행을 포함해 업로드할 것을 권장한다(상세: [explanation/security-and-known-issues.md](../explanation/security-and-known-issues.md)).

필수 헤더 검증: `hasHeader` 가 참인데 `["이름","이메일","그룹"]` 을 모두 포함하지 않으면 `400`("필수 항목이 누락되었습니다").

### 4.3 파싱과 저장 흐름

```text
req.text()
  │
  ▼
\r\n → \n 정규화, "\n" 으로 줄 분리
  │
  ▼
헤더 감지(hasHeader) ── 필수 헤더 누락? ──► 400
  │
  ▼
각 데이터 줄마다:
  ├─ "," 분리 → 컬럼별 매핑
  ├─ "그룹": "|" 분리한 각 UUID를 group.findUnique
  │     └─ 미존재 그룹 발견 → throw → 400("유저 타입이 올바르지 않습니다.")
  └─ users[] 에 적재
  │
  ▼
users[] 순회하며 user.create(connect groups)  ◄── 행 단위 순차 생성(트랜잭션 아님)
  │
  ▼
200 { result: true, data: result[] }
```

### 4.4 응답

| 응답 | 조건 |
| --- | --- |
| `200` `{ result: true, data: <행별 결과 배열> }` | 전체 처리 성공(`ResponseDTO.json`, 기본 상태 `200`) |
| `400` Bad Request | 필수 헤더 누락, 또는 존재하지 않는 그룹 UUID 발견 시(메시지 `"유저 타입이 올바르지 않습니다."`) |
| `500` Internal Server Error | `Error` 가 아닌 예외 발생 시 |
| `401` / `403` | [§1](#1-사전-조건과-권한-모델) 가드 위반 |

`data` 배열의 각 원소는 생성된 `User` 필드 전체에 `result: !!resultUser.id` 플래그를 더한 형태다.

> 행 단위로 순차 `create` 하며 단일 트랜잭션이 아니다. 중간 행에서 그룹 조회는 전체 파싱 단계(throw)에서 선검증되지만, 생성 단계(이메일 `@unique` 충돌 등)에서 발생하는 Prisma 예외는 `catch` 에서 `400`/`500` 으로 매핑되며 **이미 생성된 앞쪽 행은 롤백되지 않는다**. 부분 적용 가능성에 유의할 것(상세·완화책: [explanation/security-and-known-issues.md](../explanation/security-and-known-issues.md)).

## 5. 알려진 제한과 권한 한계

다음 항목은 본 엔드포인트들의 검증 공백이다(상세 분석·영향도는 [explanation/security-and-known-issues.md](../explanation/security-and-known-issues.md); 아래 표는 본 문서 내 근거 절을 링크한다).

| 항목 | 마커 | 요지 |
| --- | --- | --- |
| 존재하지 않는 그룹 연결(단건 생성/수정) | 🟠 | [§2.1](#21-사용자-생성)·[§2.2](#22-사용자-수정)의 `groups` 는 단건 API에서 형식·존재 검증 없이 Prisma `connect`/`set` 으로 전달된다(CSV는 `findUnique` 로 선검증). |
| 이메일/그룹명 중복 | 🟠 | `User.email`·`Group.name` 의 `@unique` 위반은 애플리케이션 단에서 사전 처리되지 않고 Prisma 예외로 표면화된다. |
| 헤더 없는 CSV 매핑 오류 | 🟠 | [§4.2](#42-헤더-감지-모드) 참조. |
| CSV 부분 적용 | 🟠 | [§4.3](#43-파싱과-저장-흐름)·[§4.4](#44-응답) 참조, 트랜잭션 부재. |
| 수정 성공 시 `201` 코드 | 🟢 | [§2.2](#22-사용자-수정) 참조, 의도된 제한. |
| Admin 단일 권한 모델 | 🟢 | 세분화된 역할 없이 `Admin` 그룹 전부/전무 권한. 세분화는 설계(미구현) 단계로 [plan.md](../plan.md)·[spec.md](../spec.md) 에서 다룬다. |
