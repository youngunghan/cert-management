# CertContent 스키마

> **범위:** `Certificate.content` 에 저장되는 `CertContent` JSON의 구조 — 필드 정의, 좌표계, 직렬화 형태.
> **대상:** 증명서 디자인·발급·렌더링 코드를 다루는 개발자.
> **상태:** 구현 반영 — 기준일 2026-06-11.

`CertContent` 는 증명서 한 장의 디자인(배경 이미지 + 텍스트 + QR 자리)을 표현하는 JSON 객체이다. 타입은 [content.ts](../../src/types/content.ts) 의 `CertContent` 에 정의되어 있다. 디자인 단계에서 [CanvasForm.tsx](../../src/app/(full)/admin/certs/new/(forms)/CanvasForm.tsx) 의 Fabric 캔버스로 생성되고, 발급 단계에서 [route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `POST()` 가 읽어 PDF로 합성한다.

이 객체는 DB에 구조화된 JSON 컬럼으로 저장되는 것이 아니라, `JSON.stringify` 된 **String** 으로 `Certificate.content` 컬럼에 저장된다. 저장 형태는 [reference/data-model.md](../reference/data-model.md) 참조. 발급 시 `POST()` 는 `JSON.parse(cert.content) as CertContent` 로 역직렬화한다.

## 1. 최상위 구조

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `image` | `object` | 배경 이미지 1개. 필드는 [§2 image](#2-image) 참조. |
| `texts` | `object[]` | 텍스트 요소 배열. 항목 필드는 [§3 texts](#3-texts) 참조. 빈 배열 가능. |
| `rects` | `object[]` | QR 코드 자리(placeholder) 배열. 항목 필드는 [§4 rects](#4-rects) 참조. 빈 배열 가능. |
| `orientation` | `"landscape" \| "portrait"` | 캔버스 방향. 좌표계 기준을 결정한다([§5 좌표계](#5-좌표계)). |

## 2. image

배경 이미지의 데이터와 캔버스 내 배치를 담는다.

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `data` | `string` | 이미지 본체. 입력·저장 단계에 따라 의미가 다르다([§2.1 data의 이중 의미](#21-data의-이중-의미)). |
| `width` | `number` | 캔버스 좌표계 기준 너비(px). |
| `height` | `number` | 캔버스 좌표계 기준 높이(px). |
| `left` | `number` | 좌상단 기준 X 좌표(px). |
| `top` | `number` | 좌상단 기준 Y 좌표(px). |

### 2.1 data의 이중 의미

`image.data` 는 라이프사이클 단계에 따라 두 가지 형태를 가진다. 같은 필드명이지만 내용이 다르다.

| 단계 | 형태 | 예시 |
| --- | --- | --- |
| 입력(디자인 직후, POST 본문) | data URI(base64) | `data:image/png;base64,iVBORw0KG...` |
| 저장(DB의 `cert.content`) | S3 객체 키 `<uuid>.<ext>` | `3f9a1c2e-....png` |

발급 시 `POST()` 는 저장된 키로 S3 객체를 읽는다. S3 키 조합은 `Key: ` certs/images/${content.image.data}` ` 형태이며(`certs/images/` prefix + `image.data`), MIME 타입은 `mime.contentType(content.image.data)` 로 확장자에서 추론한다. data URI → S3 키로의 치환은 등록 단계에서 일어난다([how-to/design-and-issue-certificate.md](../how-to/design-and-issue-certificate.md) 의 POST 단계 참조).

## 3. texts

텍스트 요소 배열. 각 항목은 캔버스의 `Text` 객체 한 개에 대응한다([CanvasForm.tsx](../../src/app/(full)/admin/certs/new/(forms)/CanvasForm.tsx) 의 `addText()`).

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `data` | `string` | 표시할 문자열. 치환자(`{{Name}}` 등)를 포함할 수 있다([§3.1 치환자](#31-치환자)). |
| `scale` | `number` | 텍스트 스케일. `CanvasTextData.scale` 에 대응. |
| `left` | `number` | 좌상단 기준 X 좌표(px). |
| `top` | `number` | 좌상단 기준 Y 좌표(px). |
| `width` | `number` | 너비(px). 변환 후 PDF 텍스트 박스의 `width` 가 된다. |
| `height` | `number` | 높이(px). 변환 후 폰트 크기(`h`)이자 텍스트 박스 `height` 로 쓰인다. |

### 3.1 치환자

`texts[].data` 에 들어가는 치환자(`{{Name}}`, `{{IssueDate}}`, `{{PrintDate}}`)는 발급 시 `replaceText()` 가 실제 값으로 치환한다. `replaceText()` 는 각 치환자에 대해 `String.prototype.replace(string, ...)` 를 호출하므로 🟡 각 치환자의 **첫 번째 일치만** 치환된다(같은 치환자가 두 번 이상 나오면 두 번째부터는 그대로 남는다). 이 동작이 의도된 제한인지는 확인 필요. 치환자 목록·치환 규칙은 [how-to/design-and-issue-certificate.md](../how-to/design-and-issue-certificate.md#34-좌표-변환과-치환자) 참조.

## 4. rects

QR 코드 자리(placeholder) 배열. 각 항목은 캔버스의 `Rect` 한 개에 대응한다([CanvasForm.tsx](../../src/app/(full)/admin/certs/new/(forms)/CanvasForm.tsx) 의 `addQrCode()`). `rects` 자체는 QR 이미지를 담지 않는다 — 위치·크기만 정의하고, 발급 시 `POST()` 가 해당 영역에 실제 QR 이미지를 그린다.

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `width` | `number` | 너비(px). |
| `height` | `number` | 높이(px). |
| `left` | `number` | 좌상단 기준 X 좌표(px). |
| `top` | `number` | 좌상단 기준 Y 좌표(px). |

발급 시 각 `rect` 영역에는 `${process.env.BASE_URL}/validate/${certLog.id}` 를 인코딩한 QR(`QRcode.toDataURL`, `width: 512`)이 `fit: [w, h]` 로 그려진다.

## 5. 좌표계

모든 `left`/`top`/`width`/`height` 는 캔버스 픽셀 좌표이며, 원점은 **좌상단**이다. 좌표 공간의 크기는 `orientation` 에 따라 결정된다([CanvasForm.tsx](../../src/app/(full)/admin/certs/new/(forms)/CanvasForm.tsx) 의 `canvasWidth`/`canvasHeight`).

| orientation | 캔버스 너비(px) | 캔버스 높이(px) |
| --- | --- | --- |
| `landscape` | 1024 | 720 |
| `portrait` | 720 | 1024 |

```
(0,0) ─────────────► X
  │
  │   left,top
  │     ┌───────────┐
  │     │  요소      │  height
  │     └───────────┘
  │         width
  ▼
  Y
```

발급 시 이 픽셀 좌표는 A4 포인트 좌표로 선형 변환된다([route.ts](../../src/app/api/certs/[id]/issue/route.ts) 의 `toDocCoordinates()`).

| orientation | 픽셀 공간 | A4 포인트 공간 |
| --- | --- | --- |
| `landscape` | 1024 × 720 | 841.89 × 595.28 |
| `portrait` | 720 × 1024 | 595.28 × 841.89 |

변환식(landscape): `[(x * 841.89) / 1024, (y * 595.28) / 720]`. 변환·렌더링 흐름의 배경은 [how-to/design-and-issue-certificate.md](../how-to/design-and-issue-certificate.md#34-좌표-변환과-치환자) 참조.

## 6. 직렬화 예시

DB 저장 시점(`image.data` 가 S3 키인 상태)의 `CertContent` 직렬화 예시이다.

```json
{
  "image": {
    "data": "3f9a1c2e-7b4d-4e8a-9c1f-0a2b3c4d5e6f.png",
    "width": 1024,
    "height": 720,
    "left": 0,
    "top": 0
  },
  "texts": [
    {
      "data": "{{Name}} 님",
      "scale": 1,
      "left": 320,
      "top": 200,
      "width": 384,
      "height": 48
    },
    {
      "data": "발급일: {{IssueDate}}",
      "scale": 1,
      "left": 320,
      "top": 280,
      "width": 384,
      "height": 32
    }
  ],
  "rects": [
    {
      "width": 100,
      "height": 100,
      "left": 820,
      "top": 560
    }
  ],
  "orientation": "landscape"
}
```

> 위 예시는 DB 저장 형태(`image.data` = S3 키)이다. 디자인 직후/POST 본문 단계에서는 `image.data` 가 data URI 이다([§2.1 data의 이중 의미](#21-data의-이중-의미)).

## 7. 관련 문서

| 문서 | 내용 |
| --- | --- |
| [how-to/design-and-issue-certificate.md](../how-to/design-and-issue-certificate.md) | 디자인·등록·발급·검증 전체 흐름 |
| [reference/data-model.md](../reference/data-model.md) | `Certificate.content` 컬럼 저장 형태 |
