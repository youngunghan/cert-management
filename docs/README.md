# cert-management — 개발자 문서 (현행 Next.js 13 구현)

OUTTA 증명서 발급센터: 관리자가 Fabric.js 캔버스로 증명서 템플릿을 만들고, 수료자가 PDF를 발급받아 QR로 검증하는 Next.js 13 + Prisma(CockroachDB) + S3 시스템. 프로젝트 개요는 [../README.md](../README.md).

> 본 `docs/`는 **현행(as-is) 구현**을 기술한다. 별도의 [plan.md](plan.md)·[spec.md](spec.md)는 **Vite + React + FastAPI 재작성 계획(설계 / 미구현)**이며 — 둘의 관계는 [explanation/rewrite-plan.md](explanation/rewrite-plan.md) 참고.

## 문서 목록 (Diátaxis)

### Tutorials — 처음 따라하기

| 문서 | 설명 |
|---|---|
| [tutorials/quickstart.md](tutorials/quickstart.md) | 로컬 설치 → 마이그레이션 → 폰트 → 실행 → 로그인 → 발급 1회 → 검증 (happy path) |

### How-to — 과업 가이드

| 문서 | 설명 |
|---|---|
| [how-to/design-and-issue-certificate.md](how-to/design-and-issue-certificate.md) | 캔버스 템플릿 설계 → 발급(PDF 합성) → 공개 검증 흐름 |
| [how-to/manage-users-and-groups.md](how-to/manage-users-and-groups.md) | 사용자/그룹 CRUD + CSV 일괄 등록 |
| [how-to/deploy.md](how-to/deploy.md) | 빌드·배포, `install.sh` 폰트 워크어라운드, 환경변수 |
| [how-to/troubleshooting.md](how-to/troubleshooting.md) | 증상별 진단(폰트 깨짐·NaN%·S3 이미지 leak·orphan 로그·만료 미검사) |

### Reference — 조회용 명세

| 문서 | 설명 |
|---|---|
| [reference/api-reference.md](reference/api-reference.md) | 전 라우트 명세(certs/users/groups/images/auth) + 응답 envelope |
| [reference/data-model.md](reference/data-model.md) | Prisma 4 모델(Group/User/Certificate/CertificateLog) 스키마 |
| [reference/cert-content-schema.md](reference/cert-content-schema.md) | `CertContent` 캔버스 레이아웃 JSON 스키마 |
| [reference/configuration.md](reference/configuration.md) | 환경변수 레퍼런스 |

### Explanation — 깊은 설명

| 문서 | 설명 |
|---|---|
| [explanation/architecture.md](explanation/architecture.md) | App Router·RSC 직접 쿼리·route handler·PDFKit·S3·NextAuth 구조와 설계 결정 |
| [explanation/security-and-known-issues.md](explanation/security-and-known-issues.md) | 현행 보안·결함 카탈로그(🔴🟠) + 재작성 수정 매핑 |
| [explanation/rewrite-plan.md](explanation/rewrite-plan.md) | 현행 ↔ FastAPI 재작성 관계(plan.md/spec.md 요약, 설계/미구현) |

### 재작성 계획 (설계 / 미구현 — 별도 SSOT)

| 문서 | 설명 |
|---|---|
| [plan.md](plan.md) | 재작성 동기·차용/폐기/추가·Phase·DB 마이그레이션·미해결 16항목 |
| [spec.md](spec.md) | 재작성 개발자 명세(데이터모델·API·OAuth·PDF·CSV·테스트) — 재작성 SSOT(~2089줄) |

## 읽기 순서

처음이면 [tutorials/quickstart.md](tutorials/quickstart.md) → [how-to/design-and-issue-certificate.md](how-to/design-and-issue-certificate.md). 전체 구조는 [explanation/architecture.md](explanation/architecture.md), 운영 결함·보안은 [explanation/security-and-known-issues.md](explanation/security-and-known-issues.md). 재작성을 검토하려면 [explanation/rewrite-plan.md](explanation/rewrite-plan.md) → [spec.md](spec.md).
