# 데이터 모델 (Prisma / CockroachDB)

> **범위:** Prisma 스키마([schema.prisma](../../prisma/schema.prisma))에 정의된 4개 모델(`Group`, `User`, `Certificate`, `CertificateLog`)과 암묵 M:N 조인 테이블 `_GroupToUser`, 그 제약·관계·인덱스의 조회용 레퍼런스.
> **대상:** 백엔드/DB를 다루는 개발자, 마이그레이션·쿼리 작성자.
> **상태:** 구현 반영 — 기준일 2026-06-11.

## 1. 개요

- datasource provider: `cockroachdb`. URL은 환경변수 `DATABASE_URL`로 주입(값은 시크릿, 키 이름만 표기).
- generator: `prisma-client-js`.
- 모든 모델 PK는 `id String @id @default(uuid()) @db.Uuid` — CockroachDB `UUID` 타입.
- 모델 수: 4개. 추가로 M:N 관계를 위한 Prisma 암묵 조인 테이블 `_GroupToUser` 1개(스키마에 명시되지 않고 마이그레이션 SQL에만 존재).

```
Group ──< _GroupToUser >── User ──< CertificateLog >── Certificate
 (M:N, CASCADE)                       (1:N, RESTRICT)     (1:N, RESTRICT)
```

DB 타입 표기는 마이그레이션 SQL([migration.sql](../../prisma/migrations/00000000000000_squashed_migrations/migration.sql)) 기준 CockroachDB 타입(`STRING`, `UUID`, `TIMESTAMP(3)`)이며, 괄호 안은 Prisma 스칼라 타입이다.

## 2. 모델

### 2.1 Group

| 이름 | 타입 | 제약 | 설명 |
| --- | --- | --- | --- |
| `id` | `UUID` (`String`) | PK, `@default(uuid())` | 그룹 식별자. |
| `name` | `STRING` (`String`) | `@unique` (`Group_name_key`) | 그룹명. 중복 불가. |
| `User` | — (`User[]`) | 관계 필드 | `User`와의 M:N(조인 테이블 `_GroupToUser`). DB 컬럼 아님. |

### 2.2 User

| 이름 | 타입 | 제약 | 설명 |
| --- | --- | --- | --- |
| `id` | `UUID` (`String`) | PK, `@default(uuid())` | 사용자 식별자. |
| `googleId` | `STRING` (`String?`) | nullable, `@unique` (`User_googleId_key`), `@@index` (`User_googleId_idx`) | Google 계정 식별자. 선택값(미연동 시 NULL). |
| `email` | `STRING` (`String`) | required, `@unique` (`User_email_key`), `@@index` (`User_email_idx`) | 이메일. 중복 불가. |
| `name` | `STRING` (`String`) | required | 표시명. |
| `memo` | `STRING` (`String`) | required, `@default("")` | 자유 메모. 기본값 빈 문자열. |
| `groups` | — (`Group[]`) | 관계 필드 | `Group`과의 M:N(조인 테이블 `_GroupToUser`). DB 컬럼 아님. |
| `logs` | — (`CertificateLog[]`) | 관계 필드 | 이 사용자를 참조하는 `CertificateLog` 역방향. DB 컬럼 아님. |

- 🟢 `googleId`가 nullable이면서 `@unique`: CockroachDB에서 NULL은 unique 제약상 서로 충돌하지 않으므로 미연동 사용자 다수 허용. 의도된 제한.
- `googleId`/`email` 모두 단일 `@@index`를 별도로 보유(`@unique`가 만드는 인덱스와 중복 — [§4](#4-인덱스)에서 정리).

### 2.3 Certificate

| 이름 | 타입 | 제약 | 설명 |
| --- | --- | --- | --- |
| `id` | `UUID` (`String`) | PK, `@default(uuid())` | 인증서 식별자. |
| `name` | `STRING` (`String`) | required | 인증서명. |
| `description` | `STRING` (`String`) | required, `@default("")` | 설명. [§5](#5-마이그레이션-출처)의 2차 마이그레이션에서 추가. |
| `content` | `STRING` (`String`) | required | 인증서 본문. JSON 문자열을 담는 필드이나 DB 타입은 `STRING`(JSONB 아님). [§3.3](#33-content--string-json--jsonb) 참조. |
| `issuedAt` | `TIMESTAMP(3)` (`DateTime`) | required | 발급 시각. |
| `expiresAt` | `TIMESTAMP(3)` (`DateTime?`) | nullable | 만료 시각. 없으면 무기한. |
| `userIds` | `UUID[]` (`String[]` `@db.Uuid`) | required(배열) | 연결된 사용자 ID 배열. FK 아님. [§3.4](#34-userids--배열-fk-아님) 참조. |
| `logs` | — (`CertificateLog[]`) | 관계 필드 | 이 인증서를 참조하는 `CertificateLog` 역방향. DB 컬럼 아님. |

### 2.4 CertificateLog

| 이름 | 타입 | 제약 | 설명 |
| --- | --- | --- | --- |
| `id` | `UUID` (`String`) | PK, `@default(uuid())` | 로그 식별자. |
| `certificateId` | `UUID` (`String` `@db.Uuid`) | required, FK → `Certificate.id` (`CertificateLog_certificateId_fkey`) | 대상 인증서. |
| `certificate` | — (`Certificate`) | 관계 필드 | `@relation(fields: [certificateId], references: [id])`. DB 컬럼 아님. |
| `userId` | `UUID` (`String` `@db.Uuid`) | required, FK → `User.id` (`CertificateLog_userId_fkey`) | 대상 사용자. |
| `user` | — (`User`) | 관계 필드 | `@relation(fields: [userId], references: [id])`. DB 컬럼 아님. |
| `createdAt` | `TIMESTAMP(3)` (`DateTime`) | required, `@default(now())` (DB `DEFAULT CURRENT_TIMESTAMP`) | 생성 시각. |

## 3. 관계 및 설계 특이점

### 3.1 Group ↔ User (M:N, CASCADE)

- `Group.User` ↔ `User.groups`로 양방향 명시. Prisma 암묵 M:N → 조인 테이블 `_GroupToUser` 자동 생성.
- 조인 테이블 컬럼: `A` (`UUID`, → `Group.id`), `B` (`UUID`, → `User.id`).
- FK 동작: 양쪽 모두 `ON DELETE CASCADE ON UPDATE CASCADE` (`_GroupToUser_A_fkey`, `_GroupToUser_B_fkey`). 즉 `Group` 또는 `User` 삭제 시 해당 멤버십 행이 함께 삭제된다(상대 엔티티 자체는 삭제되지 않음).

### 3.2 Certificate ↔ CertificateLog / User ↔ CertificateLog (1:N, RESTRICT)

- `CertificateLog.certificateId`, `CertificateLog.userId` 모두 required(non-null) FK.
- FK 동작: 둘 다 `ON DELETE RESTRICT ON UPDATE CASCADE`.
- 🟠 RESTRICT 결과: 해당 `Certificate` 또는 `User`를 참조하는 `CertificateLog`가 하나라도 있으면 그 부모 행을 **직접 삭제할 수 없다**. 삭제하려면 종속 로그를 먼저 제거해야 한다. (Prisma에서 관계 필드에 `onDelete`를 지정하지 않은 결과의 기본 동작.)

### 3.3 content = String (JSON ≠ JSONB)

- 🟢 `Certificate.content`는 DB상 `STRING`이며, JSON 직렬화 문자열을 저장하는 용도다. CockroachDB의 `JSONB`/`JSON` 타입을 사용하지 않는다.
- 영향: DB 레벨 JSON 경로 쿼리/인덱싱 불가. 파싱·검증은 애플리케이션 책임. 무결성은 DB가 보장하지 않음. 설계 특이점으로 표기.

### 3.4 userIds = 배열, FK 아님

- 🟠 `Certificate.userIds`는 `UUID[]` 배열이며 **외래 키 제약이 없다**. `User.id`를 가리키는 값이지만 DB가 참조 무결성을 강제하지 않는다.
- `User ↔ Certificate`의 실제 관계 추적은 `CertificateLog`(FK 보유)를 통해 이뤄지고, `userIds`는 비정규화된 사용자 ID 목록으로 병존한다.
- 영향: 존재하지 않는/삭제된 `User.id`가 배열에 남을 수 있음(dangling reference 가능). 정합성은 애플리케이션 책임. 설계 특이점으로 표기.

## 4. 인덱스

| 인덱스 | 테이블 | 컬럼 | 종류 | 출처 |
| --- | --- | --- | --- | --- |
| `Group_name_key` | `Group` | `name` | UNIQUE | `@unique` |
| `User_googleId_key` | `User` | `googleId` | UNIQUE | `@unique` |
| `User_email_key` | `User` | `email` | UNIQUE | `@unique` |
| `User_googleId_idx` | `User` | `googleId` | INDEX | `@@index(googleId)` |
| `User_email_idx` | `User` | `email` | INDEX | `@@index(email)` |
| `_GroupToUser_AB_unique` | `_GroupToUser` | (`A`, `B`) | UNIQUE | Prisma 암묵 M:N |
| `_GroupToUser_B_index` | `_GroupToUser` | `B` | INDEX | Prisma 암묵 M:N |

- 🟢 `User`의 `googleId`/`email`은 `@unique`(고유 인덱스 자동 생성)에 더해 명시적 `@@index`도 존재 → 동일 컬럼에 인덱스 2개가 중복 생성된다. 의도된 제한으로 표기(unique 인덱스만으로 조회 가능하므로 비고유 인덱스는 잉여).
- PK는 별도 인덱스 행으로 표기하지 않음(각 테이블 `*_pkey` 제약으로 생성).

## 5. 마이그레이션 출처

| 마이그레이션 | 파일 | 변경 |
| --- | --- | --- |
| `00000000000000_squashed_migrations` | [migration.sql](../../prisma/migrations/00000000000000_squashed_migrations/migration.sql) | 4개 테이블 + `_GroupToUser` 생성, 전체 인덱스, FK 제약(CASCADE / RESTRICT) 정의. |
| `20230820090728_add_certificate_description` | [migration.sql](../../prisma/migrations/20230820090728_add_certificate_description/migration.sql) | `Certificate`에 `description STRING NOT NULL DEFAULT ''` 컬럼 추가. |

- 위 두 마이그레이션을 합치면 [schema.prisma](../../prisma/schema.prisma)의 현행 상태와 일치한다(스쿼시 + description 추가).
