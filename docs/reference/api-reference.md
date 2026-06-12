# API Reference

> **범위:** `src/app/api/**` 의 현행(as-is) HTTP Route Handler 전체. NextAuth 핸들러 포함.
> **대상:** API 클라이언트 작성자, 백엔드 유지보수 담당자.
> **상태:** 구현 반영 — 기준일 2026-06-11.

이 문서는 **현행 Next.js 13 App Router 구현**을 정본으로 기술한다. `docs/plan.md`·`docs/spec.md` 의 재작성 계획은 '설계(미구현)'로만 언급한다. 모든 라우트는 `src/app/api/<경로>/route.ts` 의 `route.ts` 에 export 된 HTTP 메서드 함수다.

## 1. 공통 규약

### 1.1 응답 Envelope

전 라우트는 [response.ts](../../src/lib/response.ts) 의 `ResponseDTO` 로 응답을 만든다. 정상·오류 모두 아래 envelope 을 JSON 본문으로 반환한다(이미지 GET 등 바이너리 응답은 예외 — [§5](#5-images)).

| 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `result` | `boolean` | 예 | 성공 여부. 성공 `true`, 실패 `false`. |
| `data` | `object` \| `array` | 아니오 | 성공 시 payload. 라우트별로 형태가 다름. |
| `error` | `object` | 아니오 | 실패 시에만 존재. 아래 하위 필드를 가짐. |
| `error.title` | `string` | 아니오 | 오류 분류 제목(예: `Unauthorized`, `Forbidden`). |
| `error.message` | `string` | 아니오 | 사람이 읽는 오류 설명. |

`ResponseDTO` 는 `Content-Type` 헤더를 자동으로 설정하지 않는다. `ResponseDTO.json()` 은 `JSON.stringify` 한 문자열을 `Response` 본문으로 넘기지만 헤더는 빈 객체(또는 명시 설정한 것)만 사용한다. 🟠 따라서 클라이언트는 `Content-Type: application/json` 을 가정하지 말고 본문을 직접 파싱해야 한다.

### 1.2 인증·권한 모델

대부분의 변경 계열 라우트는 동일한 2단 검사를 거친다. 검사 코드는 각 `route.ts` 에 인라인으로 복제되어 있다([§7](#7-알려진-제약-및-상태)).

| 단계 | 검사 | 실패 시 상태 | 실패 시 `error.title` |
| --- | --- | --- | --- |
| 세션 | [auth.ts](../../src/lib/auth.ts) 의 `getServerSession(authOptions)` 결과가 존재 | `401` | `Unauthorized` |
| 권한 | `prisma.user.findUnique({ include: { groups: true } })` 후 `groups` 에 `name === "Admin"` 그룹 존재 | `403` | `Forbidden` |

세션 사용자는 NextAuth JWT 의 `session.user.id` 로 식별한다([§6](#6-auth)). `Admin` 그룹은 `name` 문자열로 판정하며, 그룹 부트스트랩 로직은 [auth.ts](../../src/lib/auth.ts) 의 `signIn` 콜백(`DEFAULT_ADMIN_EMAIL`)에 있다.

예외:
- `POST /api/certs/:id/issue` 는 Admin 검사 대신 **본인 발급 대상 검사**를 한다([§2.3](#23-post-apicertsidissue)).
- `GET /api/images/:id` 는 **세션·권한 검사 없음**(공개) ([§5](#5-images)).
- `/api/auth/[...nextauth]` 는 NextAuth 가 직접 처리([§6](#6-auth)).

### 1.3 HTTP 상태코드

| 상태 | 의미 | 발생 조건(요약) |
| --- | --- | --- |
| `200` | 성공 | 삭제·발급 등 데이터 미반환 또는 단순 payload 성공. |
| `201` | 생성 성공 | 일부 생성 라우트. **단 라우트별로 일관되지 않음** ([§7](#7-알려진-제약-및-상태)). |
| `400` | 잘못된 요청 | 필수 필드 누락, UUID 형식 오류, 본문 형식 오류. |
| `401` | 미인증 | 세션 없음. |
| `403` | 권한 없음 | 세션은 있으나 `Admin` 아님(또는 발급 대상 아님). |
| `404` | 미존재 | 대상 리소스(cert/user/group/image) 없음. |
| `500` | 서버 오류 | S3 작업 실패, 생성 결과 없음, 미분류 예외. |

### 1.4 경로 파라미터 파싱

동적 세그먼트 `[id]` 라우트는 Next.js 의 `params` 인자를 쓰지 않고 **요청 URL 을 직접 분해**한다. 이 차이 때문에 검증 강도가 라우트마다 다르다.

| 라우트 | 파싱 방식(심볼) | UUID 검증 |
| --- | --- | --- |
| `DELETE /api/certs/:id` | `new URL(req.url).pathname.split("/").pop()` | 있음 (`validator.isUUID`) |
| `POST /api/certs/:id/issue` | `pathname.split("/")` 에서 `issue` pop 후 다시 pop | 있음 (`validator.isUUID`) |
| `POST /api/users/:id` | `req.url.split("/").pop()` | 없음 |
| `DELETE /api/users/:id` | `req.url.split("/").pop()` | 없음 |
| `DELETE /api/groups/:id` | `new URL(req.url).pathname.split("/").pop()` | 있음 (`validator.isUUID`) |
| `GET /api/images/:id` | `new URL(req.url).pathname.split("/").pop()` | 없음 (`/` 포함 여부만 검사) |

## 2. Certs

소스: [route.ts](../../src/app/api/certs/route.ts), [route.ts](../../src/app/api/certs/[id]/route.ts), [route.ts](../../src/app/api/certs/[id]/issue/route.ts).

| 메서드 | 경로 | 권한 | 요청 본문 | 응답 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/certs` | 세션 + Admin | JSON (아래 [§2.1](#21-post-apicerts)) | `201` `{result, data:Certificate}` / 4xx·5xx envelope |
| `DELETE` | `/api/certs/:id` | 세션 + Admin | 없음 | `200` `{result:true}` / 4xx·5xx envelope |
| `POST` | `/api/certs/:id/issue` | 세션 + 발급 대상 본인 | 없음 | `200` `{result, data:{url}}` / 4xx·5xx envelope |

### 2.1 POST /api/certs

인증서 정의를 생성한다. 본문의 `content.image.data` 는 data URI 이며, 디코드 후 S3 `certs/images/<uuid>.<ext>` 로 업로드한다. 업로드 성공 시 `content.image.data` 를 파일명으로 치환해 `content` 를 문자열로 저장한다. 좌표/텍스트 구조는 [content.ts](../../src/types/content.ts) 의 `CertContent` 를 따른다.

요청 본문(`POST()` 의 `req.json()` 구조분해):

| 이름 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `name` | `string` | 예 | 인증서 이름. 누락 시 `400`. |
| `description` | `string` | 아니오 | 설명. 미검증, `null` 허용. |
| `content` | `CertContent` | 예 | 이미지·텍스트·도형·방향 정의. `content.image.data` 는 data URI. 누락 시 `400`. |
| `issuedAt` | `string` | 예 | 발급일(날짜 문자열). `` `${issuedAt}T00:00:00Z` `` 로 `Date` 변환. 누락 시 `400`. |
| `users` | `string[]` | 예 | 대상 사용자 id 배열. 배열이 아니거나 원소가 문자열이 아니면 `400`. |

응답:

| 상태 | 조건 | 본문 |
| --- | --- | --- |
| `201` | 생성 성공 | `{result:true, data:<Certificate>}` |
| `400` | 필수 필드 누락 또는 `users` 형식 오류 | `{result:false, error:{title:"Bad Request", message:"Invalid request body"}}` |
| `401` | 세션 없음 | `Unauthorized` envelope |
| `403` | Admin 아님 | `Forbidden` envelope |
| `500` | S3 업로드 실패 또는 생성 결과 없음 | `Internal Server Error` envelope |

🟠 `content.image.data` 가 유효한 data URI 가 아니면 `dataURItoUint8Array` 단계에서 처리되며, S3 단계 외의 디코드 실패는 try 블록 밖이라 미분류 예외로 이어질 수 있다(확인 필요 — `dataURI` 구현 범위 밖).

### 2.2 DELETE /api/certs/:id

인증서와 관련 발급 로그를 삭제하고 S3 이미지를 제거한다. `DELETE()` 는 `prisma.certificateLog.deleteMany` → `prisma.certificate.delete` 후 S3 `DeleteObjectCommand` 를 보낸다.

| 상태 | 조건 | 본문 |
| --- | --- | --- |
| `200` | 삭제 성공 | `{result:true}` |
| `400` | `id` 없음 또는 비-UUID | `Bad Request` envelope |
| `401` | 세션 없음 | `Unauthorized` envelope |
| `403` | Admin 아님 | `Forbidden` envelope |
| `404` | 인증서 없음 | `{result:false, error:{title:"Not Found", message:"Certificate not found"}}` |
| `500` | S3 이미지 삭제 실패 | `Internal Server Error` envelope |

🟠 S3 삭제에 쓰는 버킷이 `process.env.AWS_S3_BUCKET` 으로, 다른 라우트의 `AWS_S3_BUCKET_NAME` 과 키 이름이 다르다([§7](#7-알려진-제약-및-상태)). 또한 DB 삭제가 S3 삭제보다 먼저 일어나므로 S3 단계에서 `500` 이 나도 DB row 는 이미 삭제된 상태다.

### 2.3 POST /api/certs/:id/issue

대상 사용자에게 PDF 를 발급한다. `POST()` 는 세션 사용자가 해당 인증서의 `userIds` 에 포함되는지 검사하므로 **Admin 이 아니어도 본인 발급은 가능**하다. PDF 는 [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `toDocCoordinates()`·`replaceText()` 로 좌표 변환·치환을 거쳐 `pdfkit` 으로 생성하고, S3 `certs/issued/<certLogId>.pdf` 로 업로드한 뒤 1분 만료 presigned URL 을 반환한다. QR 코드는 `${BASE_URL}/validate/<certLogId>` 를 인코딩한다.

| 상태 | 조건 | 본문 |
| --- | --- | --- |
| `200` | 발급 성공 | `{result:true, data:{url:"<presigned URL, 60s>"}}` |
| `400` | `id` 없음 또는 비-UUID | `{result:false, error:{title:"Bad Request", message:"Invalid request URL"}}` |
| `401` | 세션 없음 | `Unauthorized` envelope |
| `403` | 세션 사용자 미존재 또는 `cert.userIds` 에 없음 | `Forbidden` envelope |
| `404` | 인증서 없음 | `Not Found` envelope |
| `500` | S3 이미지 조회 실패 / `Body` 없음 / PDF 업로드 실패 | `Internal Server Error` envelope |

🟠 발급 로그(`certificateLog`)는 PDF 생성·S3 업로드보다 먼저 `create` 된다. 따라서 이후 단계에서 `500` 이 나도 로그 row 는 남는다. 또한 PDF 생성에 `data/ChosunGs.ttf` 폰트와 `node_modules/pdfkit/js/data` 복사에 의존한다([route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`).

## 3. Users

소스: [route.ts](../../src/app/api/users/route.ts), [route.ts](../../src/app/api/users/[id]/route.ts), [route.ts](../../src/app/api/users/file/route.ts).

| 메서드 | 경로 | 권한 | 요청 본문 | 응답 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/users` | 세션 + Admin | JSON (아래 [§3.1](#31-post-apiusers)) | `201` `{result, data:User}` / 4xx envelope |
| `POST` | `/api/users/:id` | 세션 + Admin | JSON `{memo, groups}` | `201` `{result:true}` / 4xx envelope |
| `DELETE` | `/api/users/:id` | 세션 + Admin | 없음 | `200` `{result:true}` / 4xx envelope |
| `POST` | `/api/users/file` | 세션 + Admin | CSV 텍스트 | `200` `{result, data:[]}` / 4xx·5xx envelope |

### 3.1 POST /api/users

단일 사용자를 생성한다. `POST()` 검증은 `name` 존재와 `email` 형식(`validator.isEmail`)만 본다.

| 이름 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `name` | `string` | 예 | 사용자 이름. 누락 시 `400`. |
| `email` | `string` | 예 | 이메일. `validator.isEmail` 통과 필요. |
| `googleId` | `string` \| `null` | 아니오 | Google 식별자. 미검증, 그대로 저장. |
| `groups` | `connect` 입력 | 아니오 | Prisma `groups.connect` 로 전달. 형식은 Prisma `connect` 인자(`{id}` 배열 등)를 그대로 받음 — **클라이언트가 connect 형태를 맞춰야 함**. |

| 상태 | 조건 | 본문 |
| --- | --- | --- |
| `201` | 생성 성공 | `{result:true, data:<User>}` |
| `400` | `name` 누락 또는 `email` 형식 오류 | `Bad Request` envelope |
| `401` | 세션 없음 | `Unauthorized` envelope |
| `403` | Admin 아님 | `Forbidden` envelope |

🟠 `groups` 가 검증 없이 `connect` 로 전달되어 형식 오류 시 Prisma 예외가 그대로 노출될 수 있다(확인 필요 — try/catch 없음).

### 3.2 POST /api/users/:id

기존 사용자의 `memo` 와 `groups` 를 갱신한다. `POST()` 는 `memo` 갱신과 `groups` `set` 갱신을 **두 번의 `prisma.user.update`** 로 나누어 수행한다. `groups` 는 `g.id` 만 추출해 `set` 한다(전체 교체).

| 이름 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `memo` | `string` | 아니오 | 메모. 그대로 갱신. |
| `groups` | `Group[]` | 예 | 교체할 그룹 배열. 각 원소의 `id` 만 사용. 누락 시 `groups.map` 에서 예외. |

| 상태 | 조건 | 본문 |
| --- | --- | --- |
| `201` | 갱신 성공 | `{result:true}` |
| `401` | 세션 없음 | `Unauthorized` envelope |
| `403` | Admin 아님 | `Forbidden` envelope |
| `404` | 대상 사용자 없음 | `{result:false, error:{title:"Not Found", message:"User not found"}}` |

🟠 갱신인데 성공 상태가 `201` 이다([§7](#7-알려진-제약-및-상태)). `id` 에 UUID 검증이 없고, `groups` 누락 시 `400` 대신 미분류 예외가 난다(확인 필요).

### 3.3 DELETE /api/users/:id

사용자를 삭제한다. `DELETE()` 는 대상 존재 확인 후 `prisma.user.delete` 만 호출한다.

| 상태 | 조건 | 본문 |
| --- | --- | --- |
| `200` | 삭제 성공 | `{result:true}` |
| `401` | 세션 없음 | `Unauthorized` envelope |
| `403` | Admin 아님 | `Forbidden` envelope |
| `404` | 대상 사용자 없음 | `Not Found` envelope |

### 3.4 POST /api/users/file

CSV 본문(`req.text()`)으로 사용자를 일괄 생성한다. `POST()` 는 `\r\n` 을 `\n` 으로 정규화 후 줄 단위로 파싱한다. 헤더는 선택적이며, 헤더가 있으면 `이름`·`이메일`·`그룹` 이 모두 포함되어야 한다.

| 헤더 컬럼 | 매핑 필드 | 설명 |
| --- | --- | --- |
| `이름` | `name` | trim 적용. |
| `이메일` | `email` | trim 적용. |
| `그룹` | `groups` | `|` 로 분할한 각 토큰을 group `id` 로 보고 `prisma.group.findUnique` 조회. 미존재 시 `400`. |
| `Google ID` | `googleId` | 공백이면 `null`. |
| `메모` | `memo` | trim 적용. |

| 상태 | 조건 | 본문 |
| --- | --- | --- |
| `200` | 생성 성공(상태코드 미지정 → 기본 `200`) | `{result:true, data:[<생성된 User + result>]}` |
| `400` | 필수 헤더 누락, 또는 존재하지 않는 그룹 id | `Bad Request` envelope (`message` 한글) |
| `401` | 세션 없음 | `Unauthorized` envelope |
| `403` | Admin 아님 | `Forbidden` envelope |
| `500` | `Error` 가 아닌 미분류 예외 | `Internal Server Error` envelope (`message` 한글) |

🟠 헤더 판정은 `headers.some((h) => header.includes(h))` 로 한 컬럼이라도 알려진 헤더명과 겹치면 헤더 행으로 간주한다. 헤더가 없는 CSV 는 컬럼 매핑 기준(`headers`)이 첫 데이터 줄이 되어 매핑이 어긋날 수 있다(확인 필요). 성공 응답이 `ResponseDTO.json` 으로 상태코드를 지정하지 않아 `200` 인 점도 다른 생성 라우트(`201`)와 불일치한다.

## 4. Groups

소스: [route.ts](../../src/app/api/groups/route.ts), [route.ts](../../src/app/api/groups/[id]/route.ts).

| 메서드 | 경로 | 권한 | 요청 본문 | 응답 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/groups` | 세션 + Admin | JSON `{name}` | `200` `{result, data:Group}` / 4xx envelope |
| `DELETE` | `/api/groups/:id` | 세션 + Admin | 없음 | `200` `{result:true}` / 4xx envelope |

### 4.1 POST /api/groups

그룹을 생성한다. `POST()` 는 `name` 존재만 검증한다.

| 이름 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `name` | `string` | 예 | 그룹 이름. 누락 시 `400`. |

| 상태 | 조건 | 본문 |
| --- | --- | --- |
| `200` | 생성 성공(상태코드 미지정 → 기본 `200`) | `{result:true, data:<Group>}` |
| `400` | `name` 누락 | `Bad Request` envelope |
| `401` | 세션 없음 | `Unauthorized` envelope |
| `403` | Admin 아님 | `Forbidden` envelope |

🟠 생성인데 `ResponseDTO.json` 으로 상태코드 미지정이라 `200` 이다([§7](#7-알려진-제약-및-상태)).

### 4.2 DELETE /api/groups/:id

그룹을 삭제한다. `DELETE()` 는 UUID 검증 후 존재 확인, `prisma.group.delete` 호출.

| 상태 | 조건 | 본문 |
| --- | --- | --- |
| `200` | 삭제 성공 | `{result:true}` |
| `400` | `id` 없음 또는 비-UUID | `Bad Request` envelope |
| `401` | 세션 없음 | `Unauthorized` envelope |
| `403` | Admin 아님 | `Forbidden` envelope |
| `404` | 그룹 없음 | `Not Found` envelope |

## 5. Images

소스: [route.ts](../../src/app/api/images/[id]/route.ts).

| 메서드 | 경로 | 권한 | 요청 본문 | 응답 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/images/:id` | **없음 (공개)** | 없음 | `200` 바이너리 이미지 / `400`·`404` envelope |

`GET()` 은 세션·권한 검사 없이 S3 `certs/images/<id>` 객체를 그대로 스트리밍한다. 정상 응답은 envelope 이 아니라 **원본 바이너리**이며, `Content-Type` 은 `mime.contentType(id)` 또는 `application/octet-stream` 이다.

| 상태 | 조건 | 본문 |
| --- | --- | --- |
| `200` | 객체 조회 성공 | 이미지 바이너리(`Content-Type` 헤더 설정) |
| `400` | `id` 없음 또는 `id` 에 `/` 포함 | `Bad Request` envelope |
| `404` | S3 `Body` 없음 또는 조회 예외 | `{result:false, error:{title:"Not Found", message:"Image not found"}}` |

🟢 이미지 조회는 의도적으로 공개다. 단 파일명(`<uuid>.<ext>`)을 알면 누구나 접근 가능하므로 비밀 자료를 이미지로 두면 안 된다. `id` 검증은 `/` 포함 여부만 보므로 UUID 검증은 없다.

## 6. Auth

소스: [route.ts](../../src/app/api/auth/[...nextauth]/route.ts), 설정은 [auth.ts](../../src/lib/auth.ts) 의 `authOptions`.

| 메서드 | 경로 | 권한 | 요청 본문 | 응답 |
| --- | --- | --- | --- | --- |
| `GET` / `POST` | `/api/auth/[...nextauth]` | NextAuth 내부 처리 | NextAuth 규약 | NextAuth 규약(envelope 아님) |

`route.ts` 는 `NextAuth(authOptions)` 가 만든 `handler` 를 `GET`·`POST` 로 그대로 export 한다. 응답 형식은 `ResponseDTO` envelope 이 아니라 NextAuth 의 표준 응답을 따른다. 주요 설정([auth.ts](../../src/lib/auth.ts)):

| 항목 | 값(심볼/키 이름) | 설명 |
| --- | --- | --- |
| Provider | `GoogleProvider` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 사용(키 이름만). |
| `signIn` 콜백 | `DEFAULT_ADMIN_EMAIL` 일치 시 `Admin` 그룹·사용자 부트스트랩 | 미등록 사용자는 `/unregistered` 로 리다이렉트, DB 사용자는 `googleId` 갱신. |
| `session` 콜백 | `session.user = {id, name, googleId}` | 다른 라우트의 `session.user.id` 출처. |
| `pages` | `signIn: "/login"`, `error: "/login"` | 커스텀 인증 페이지. |

세션 기반 라우트 보호 헬퍼 `withAuth()` 도 같은 파일에 있으나 이는 RSC 페이지용이며 API 라우트는 `getServerSession` 을 직접 호출한다([§1.2](#12-인증권한-모델)).

## 7. 알려진 제약 및 상태

### 7.1 목록·단건 조회 GET API 부재 🟢

`src/app/api/**` 에는 **인증서·사용자·그룹의 목록 또는 단건을 조회하는 GET 엔드포인트가 없다**. 화면에 필요한 조회는 RSC(Server Component) 페이지가 `prisma` 를 직접 호출해 수행한다(예: `src/app/(full)/admin/users/page.tsx`, `src/app/(full)/certs/[id]/page.tsx`, `src/app/(full)/validate/[id]/page.tsx`). 즉 읽기는 API 계층이 아니라 페이지 계층에 있다. 외부 클라이언트가 조회 API 를 기대하면 안 된다. 공개 바이너리 조회인 `GET /api/images/:id` 만 예외다([§5](#5-images)).

### 7.2 성공 상태코드 불일치 🟠

생성·갱신 성공 상태코드가 라우트마다 다르다.

| 라우트 | 성공 상태 | 비고 |
| --- | --- | --- |
| `POST /api/certs` | `201` | 명시적 `status(201)`. |
| `POST /api/users` | `201` | 명시적 `status(201)`. |
| `POST /api/users/:id` | `201` | 갱신인데 `201`. |
| `POST /api/users/file` | `200` | `ResponseDTO.json` 으로 상태 미지정 → 기본 `200`. |
| `POST /api/groups` | `200` | `ResponseDTO.json` 으로 상태 미지정 → 기본 `200`. |

### 7.3 환경 변수 키 이름 불일치 🟠

S3 버킷 환경 변수 키가 라우트별로 다르다. 대다수 라우트는 `AWS_S3_BUCKET_NAME` 을 쓰지만, `DELETE /api/certs/:id` ([route.ts](../../src/app/api/certs/[id]/route.ts))의 `DeleteObjectCommand` 만 `AWS_S3_BUCKET` 을 쓴다. 두 키가 동일 값으로 설정되지 않으면 이미지 삭제가 실패해 `500` 이 발생한다(시크릿 값은 표기하지 않음 — 키 이름만).

### 7.4 인증·권한 검사 코드 중복 🟠

세션 + Admin 검사 블록이 각 `route.ts` 에 동일하게 복제되어 있다(공유 미들웨어 없음). [auth.ts](../../src/lib/auth.ts) 의 `withAuth()` 는 RSC 전용이고 API 라우트는 이를 쓰지 않는다. 검사 로직 변경 시 전 라우트를 함께 수정해야 한다.

### 7.5 동적 세그먼트 검증 강도 차이 🟠

`[id]` 라우트가 `params` 대신 URL 문자열을 직접 분해하며, UUID 검증 유무가 라우트마다 다르다([§1.4](#14-경로-파라미터-파싱)). `users/:id` 계열은 UUID 검증이 없어 잘못된 `id` 가 DB 조회 단계까지 전달된다.

### 7.6 부분 실패 시 정합성 🟠

`DELETE /api/certs/:id` 와 `POST /api/certs/:id/issue` 는 DB 변경(삭제·로그 생성)을 S3 작업보다 먼저 수행한다. S3 단계 실패로 `500` 이 반환돼도 선행 DB 변경은 롤백되지 않아 상태가 어긋날 수 있다([§2.2](#22-delete-apicertsid), [§2.3](#23-post-apicertsidissue)).

### 7.7 재작성 설계(미구현)

`docs/plan.md`·`docs/spec.md` 는 위 제약을 정리하는 재작성을 다루나, 본 문서 기준일에는 **미구현(목표)**이다. 현행 동작은 이 문서를 정본으로 한다.
