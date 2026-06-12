# 증명서 디자인 및 발급

> **범위:** admin이 캔버스로 증명서를 디자인해 등록하는 시점부터, 사용자가 PDF를 발급받고 공개 URL로 검증되기까지의 end-to-end 흐름.
> **대상:** 증명서 발급 기능을 운영·디버깅하는 개발자.
> **상태:** 구현 반영 — 기준일 2026-06-11.

이 문서는 현행 Next.js 13 App Router 구현(as-is)을 기술한다. 재작성 계획([plan.md](../plan.md), [spec.md](../spec.md))의 목표 설계와는 구분하며, 그러한 설계는 본문에서 '미구현(목표)'로만 언급한다.

## 1. 전체 흐름

증명서는 두 단계로 나뉜다. (A) admin이 디자인 후 `Certificate` 레코드를 만드는 **등록** 단계, (B) 사용자가 자신에게 할당된 증명서를 PDF로 뽑는 **발급** 단계. 발급된 PDF의 QR을 스캔하면 (C) 공개 **검증** 페이지가 열린다.

```
[A. 등록]  admin
  └ FileForm: 배경 이미지 선택
  └ CanvasForm: Fabric.js 캔버스에 텍스트/QR rect 배치
  └ Form.createCert(): 캔버스 → CertContent JSON 직렬화
        │  POST /api/certs
        ▼
   route.ts POST()
   ├ 배경 data URI → S3 certs/images/<uuid>.<ext>
   ├ content.image.data 를 S3 키(filename)로 치환
   └ prisma.certificate.create()

[B. 발급]  사용자 (/certs/:id)
  └ IssueButton.issueCert(): POST /api/certs/:id/issue
        │
        ▼
   issue/route.ts POST()
   ├ CertificateLog 생성 (certLog.id)
   ├ S3 certs/images/<key> 배경 이미지 GET
   ├ PDFKit 합성: replaceText() 치환자 + toDocCoordinates() 좌표 변환
   ├ QR = BASE_URL/validate/<certLog.id>
   ├ S3 certs/issued/<certLog.id>.pdf PUT
   └ 60초 presigned URL 반환 → 브라우저가 즉시 다운로드

[C. 검증]  공개 (/validate/:logId)
  └ ValidatePage: CertificateLog 조회 → 유효/무효 표시
```

| 단계 | 코드 | 진입점 |
| --- | --- | --- |
| 디자인 UI | [CanvasForm.tsx](../../src/app/(full)/admin/certs/new/(forms)/CanvasForm.tsx) | `CanvasForm()` |
| 직렬화 | [Form.tsx](../../src/app/(full)/admin/certs/new/Form.tsx) | `createCert()` |
| 등록 API | [route.ts](../../src/app/api/certs/route.ts) | `POST()` |
| 발급 버튼 | [IssueButton.tsx](../../src/app/(full)/certs/[id]/IssueButton.tsx) | `issueCert()` |
| 발급 API | [route.ts](../../src/app/api/certs/[id]/issue/route.ts) | `POST()` |
| 검증 페이지 | [page.tsx](../../src/app/(full)/validate/[id]/page.tsx) | `ValidatePage()` |

## 2. 등록 단계 (디자인 → Certificate)

### 2.1 캔버스 디자인

[CanvasForm.tsx](../../src/app/(full)/admin/certs/new/(forms)/CanvasForm.tsx) 의 `CanvasForm()` 은 Fabric.js `Canvas` 를 생성하고 다음 요소를 다룬다.

| 요소 | 생성 함수 | Fabric 타입 | 특성 |
| --- | --- | --- | --- |
| 배경 이미지 | `useEffect` 내부 `Image.fromURL()` | `Image` | `selectable=false`, 이동·스케일·회전 lock. `width > height` 이면 `scaleToWidth(canvas.width)`, 그 외(세로가 길거나 정사각)이면 `scaleToHeight(canvas.height)` 후 `centerObject`로 중앙 배치. |
| 텍스트 | `addText()` | `Text` | 초기 문구 `"여기에 텍스트 입력"`, `fontFamily: "ChosunGs"`, `textAlign: "center"`. 회전·스케일 lock. |
| QR 자리 | `addQrCode()` | `Rect` | 100×100, `fill: "red"` 의 사각형. 발급 시 실제 QR 이미지로 치환된다(코드 자체를 그리는 것이 아니라 위치·크기만 정의하는 placeholder). |

캔버스 치수는 `orientation` 에 따라 고정된다.

| orientation | width | height |
| --- | --- | --- |
| `landscape` | 1024 | 720 |
| `portrait` | 720 | 1024 |

이 1024×720 / 720×1024 픽셀 공간이 좌표계의 기준이며, 발급 시 A4 포인트 좌표로 변환된다([§3.4](#34-좌표-변환과-치환자)). orientation별 의미는 [reference/cert-content-schema.md](../reference/cert-content-schema.md) 참조.

선택된 요소의 X/Y/W/H 와 텍스트 값은 우측 패널 입력과 양방향 바인딩되며, `debounceFabric`(top/left/width/height/text)으로 Fabric 객체에 반영된다. '가운데 정렬' 버튼은 `left` 를 `canvasWidth / 2 - width / 2` 로 설정한다.

### 2.2 CertContent 직렬화

`CanvasForm` 자체는 `CertContent` 를 만들지 않는다. 직렬화는 부모 [Form.tsx](../../src/app/(full)/admin/certs/new/Form.tsx) 의 `createCert()` 가 수행한다. `canvas._objects` 를 타입별로 분리해 다음과 같이 매핑한다.

| CertContent 필드 | 소스 (Fabric) | 비고 |
| --- | --- | --- |
| `image.data` | `image.toDataURL()` | base64 data URI. POST 후 S3 키로 치환됨([§2.3](#23-post-apicerts)). |
| `image.width` / `height` | `getScaledWidth()` / `getScaledHeight()` | |
| `image.left` / `top` | `image.left` / `image.top` | |
| `texts[].data` | `text.text` | 치환자 문자열 포함 가능. |
| `texts[].scale` | `text.scaleX` | |
| `texts[].left` / `top` | `text.left` / `text.top` | |
| `texts[].width` / `height` | `getScaledWidth()` / `getScaledHeight()` | |
| `rects[].width` / `height` | `getScaledWidth()` / `getScaledHeight()` | QR placeholder 크기. |
| `rects[].left` / `top` | `rect.left` / `rect.top` | QR placeholder 위치(raw 좌표). |
| `orientation` | `orientation` state | `landscape` \| `portrait`. |

`CertContent` 타입은 [content.ts](../../src/types/content.ts) 의 `CertContent` 에 정의되어 있다. 전체 필드 스펙은 [reference/cert-content-schema.md](../reference/cert-content-schema.md) 를 정본으로 한다.

요청 body 는 `{ content, name, description, issuedAt: issueDate, users }` 형태이며 `users` 는 선택된 사용자 id 배열이다.

### 2.3 POST /api/certs

[route.ts](../../src/app/api/certs/route.ts) 의 `POST()` 처리 순서.

1. **인증/인가**: `getServerSession` 으로 세션 확인(없으면 401). `prisma.user.findUnique`(`groups` include)로 사용자를 조회해, 사용자가 없거나(`!user`) `groups` 중 `name === "Admin"` 그룹이 없으면 403.
2. **검증**: `name`, `content`, `issuedAt`, `users` 필수(누락 시 400). `users` 는 문자열 배열이어야 함(아니면 400).
3. **배경 업로드**: `content.image.data`(data URI)를 [dataURI.ts](../../src/lib/dataURI.ts) 의 `dataURItoUint8Array()` 로 디코드해 `{ data, mime }` 를 얻는다. `mime.extension(imageData.mime)` 으로 확장자를 결정하고 `crypto.randomUUID()` 로 `certs/images/<uuid>.<ext>` 키를 만들어 S3 `PutObjectCommand` 로 올린다. 실패 시 500.
4. **키 치환**: 업로드 후 `content.image.data = filename` — data URI를 S3 객체 키(파일명만)로 덮어쓴다. 따라서 DB에 저장되는 `content.image.data` 는 `<uuid>.<ext>` 형태이다.
5. **레코드 생성**: `prisma.certificate.create` 로 저장. `content` 는 `JSON.stringify(content)`, `issuedAt` 은 `new Date(\`${issuedAt}T00:00:00Z\`)`(UTC 자정), `userIds` 는 사용자 id 배열. 성공 시 201, 실패 시 500.

응답·DTO 형태는 [reference/api.md](../reference/api.md) 참조.

## 3. 발급 단계 (Certificate → PDF)

### 3.1 발급 트리거

[IssueButton.tsx](../../src/app/(full)/certs/[id]/IssueButton.tsx) 의 `issueCert()` 가 `POST /api/certs/${certId}/issue` 를 `credentials: "include"` 로 호출한다. 성공 시 응답의 `data.url`(presigned URL)을, `document.createElement("a")`로 만든 detached `<a>` 엘리먼트의 `href` 로 지정하고 `click()` 하여 다운로드를 유발한다. 실패하면 `alert("발급에 실패했습니다.")` 후 `setLoading(false)` 로 버튼을 복구한다. 성공 경로에서는 `setLoading(false)` 가 없어 버튼이 `발급중` 상태로 남는다.

### 3.2 인증·인가·식별자 검증

[route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()`.

| 검사 | 조건 | 실패 응답 |
| --- | --- | --- |
| 세션 | `getServerSession` 결과 없음 | 401 |
| 증명서 id | URL에서 추출한 `id` 가 `validator.isUUID` 통과 못 함 | 400 |
| 사용자 존재 | `prisma.user.findUnique` 결과 없음 | 403 |
| 증명서 존재 | `prisma.certificate.findUnique` 결과 없음 | 404 |
| 할당 여부 | `cert.userIds.includes(user.id)` 가 false | 403 |

`id` 는 라우트 파라미터가 아니라 `req.url` 의 pathname을 `/` 로 분리해 `"issue"` 를 pop한 뒤 다음 세그먼트를 pop하여 얻는다.

### 3.3 폰트 준비

PDFKit이 사용할 폰트를 런타임에 배치한다. `node_modules/pdfkit/js/data` 의 폰트 파일들을 `path.join(__dirname, "data")` 로 복사한다(디렉터리 생성·복사 실패는 `try/catch` 로 무시). 텍스트 렌더링에는 별도로 `data/ChosunGs.ttf` 를 사용한다([§3.4](#34-좌표-변환과-치환자)).

🟠 조건부 결함: 폰트 복사 루프는 `fontList.forEach(async ...)` 로, `await` 가 forEach 콜백 내부에만 적용되어 복사 완료를 기다리지 않는다. 또한 텍스트가 참조하는 `data/ChosunGs.ttf` 가 이 복사 대상(pdfkit afm 폰트)에 포함되는지는 **확인 필요**.

### 3.4 좌표 변환과 치환자

`CertificateLog` 를 먼저 생성해 `certLog.id` 를 확보한 뒤, `cert.content` 를 `JSON.parse` 하여 `CertContent` 로 사용한다.

**배경 이미지**: `certs/images/<content.image.data>` 를 S3에서 GET, base64 data URI로 만들어 `doc.image(imageURL, 0, 0, { align: "center", valign: "center", fit: ... })` 로 배치. `fit` 은 orientation에 따라 `[841.89, 595.28]`(landscape) 또는 `[595.28, 841.89]`(portrait) — A4 포인트 치수.

**좌표 변환** — `toDocCoordinates(x, y, orientation)` 은 캔버스 픽셀을 A4 포인트로 선형 스케일한다.

| orientation | x 변환 | y 변환 |
| --- | --- | --- |
| `landscape` | `x * 841.89 / 1024` | `y * 595.28 / 720` |
| `portrait` | `x * 595.28 / 720` | `y * 841.89 / 1024` |

W·H 도 동일 함수로 변환된다(좌표·치수 모두 같은 스케일).

**텍스트 치환** — `replaceText(text, user, cert)` 는 다음 치환자를 1회 치환한다.

| 치환자 | 치환값 |
| --- | --- |
| `{{Name}}` | `user.name` |
| `{{IssueDate}}` | `cert.issuedAt.toLocaleDateString("ko-KR")` |
| `{{PrintDate}}` | `new Date().toLocaleDateString("ko-KR")` (발급 시각) |

🟢 의도된 제한: `String.replace` 는 각 치환자를 첫 번째 일치만 치환한다. 동일 치환자를 한 텍스트에 두 번 이상 넣으면 두 번째부터는 치환되지 않는다.

각 텍스트는 `doc.font("data/ChosunGs.ttf", h).text(data, x, y, { align: "center", width: w, height: h }).rect(x, y, w, h)` 로 그려진다. 폰트 크기로 변환된 높이 `h` 를 사용하며, 디버그성으로 `rect` 외곽선도 함께 그려진다. 치환자·좌표 규칙의 배경은 [reference/cert-content-schema.md](../reference/cert-content-schema.md) 와 [explanation/rendering-pipeline.md](../explanation/rendering-pipeline.md) 참조.

**QR 코드** — `QRcode.toDataURL(\`${process.env.BASE_URL}/validate/${certLog.id}\`, { width: 512 })` 로 생성한 data URI를 `content.rects` 각 위치에 `doc.image(qrcodeString, x, y, { fit: [w, h] })` 로 배치한다. QR이 인코딩하는 URL은 `BASE_URL/validate/<certLog.id>` 이다.

🟠 조건부 결함: `content.rects.forEach(async (rect) => ...)` 콜백은 비동기로 선언되어 있으나 내부 `doc.image` 호출은 동기이므로 동작한다. 다만 async 콜백은 `doc.end()` 전 완료 보장이 없어 향후 비동기 작업 추가 시 누락 위험이 있다 — 현행에서는 동기 호출이라 영향 없음.

### 3.5 PDF 저장과 presigned URL

| 항목 | 값 |
| --- | --- |
| 스트림 | `doc.pipe(PassThrough())` → `Buffer.concat(chunks)` 로 수집 |
| PDF 크기 | `PDFDocument({ size: "A4", layout: content.orientation })` |
| S3 키 | `certs/issued/<certLog.id>.pdf` |
| ContentType | `application/pdf` |
| presigned URL | `getSignedUrl(...)`, `expiresIn: 1 * 60` (60초) |

업로드 또는 이미지 fetch 실패 시 500. 성공 시 200 `{ result: true, data: { url: preSigned } }`.

🟢 의도된 제한: presigned URL 유효기간이 60초로 짧다. `IssueButton` 이 응답 직후 자동 다운로드하므로 정상 경로에선 충분하나, 사용자가 URL을 보관·재사용하는 용도는 아니다.

## 4. 검증 단계 (공개)

[page.tsx](../../src/app/(full)/validate/[id]/page.tsx) 의 `ValidatePage()` 는 인증 없이 접근 가능한 서버 컴포넌트다.

1. URL의 `id`(= `certLog.id`)가 `validator.isUUID` 를 통과하지 못하면 `InvalidPage` 렌더.
2. `prisma.certificateLog.findUnique({ where: { id }, include: { certificate: true, user: true } })`.
3. 레코드가 없으면 `InvalidPage`, 있으면 "유효한 증명서입니다." 화면에 `user.name`, `cert.createdAt.toLocaleString("ko-KR")`(발급 시각), `certificate.name` 을 표시.

🟢 의도된 제한: 검증은 `CertificateLog` 의 **존재 여부**만 확인한다. PDF 내용·서명·해시 대조는 없으며, 동일 증명서를 여러 번 발급하면 발급 횟수만큼 서로 다른 `certLog.id`(따라서 서로 다른 QR/검증 URL)가 생긴다. 검증 모델의 설계 의도는 [explanation/validation-model.md](../explanation/validation-model.md) 참조.

## 5. 관련 문서

| 문서 | 내용 |
| --- | --- |
| [reference/cert-content-schema.md](../reference/cert-content-schema.md) | `CertContent` 필드·orientation·좌표계 정본 |
| [reference/api.md](../reference/api.md) | `/api/certs`, `/api/certs/:id/issue` 요청·응답 스펙 |
| [explanation/rendering-pipeline.md](../explanation/rendering-pipeline.md) | 캔버스→PDF 좌표·치환자 변환 배경 |
| [explanation/validation-model.md](../explanation/validation-model.md) | 로그 기반 검증 모델 설계 의도 |
