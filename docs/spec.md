# OUTTA 증명서 발급센터 — 개발자 명세 (spec.md)

> **대상 스택**: Vite + React 18 + TypeScript (FE) / FastAPI + SQLAlchemy 2 + PostgreSQL (BE) / boto3 + reportlab
> **참고 원본**: [cert-management/](..) (Next.js 13 구현). 본 문서는 신규 구현의 단일 진실 공급원(SSOT).
> 동기·근거·일정은 [plan.md](plan.md) 참조.

---

## 1. 시스템 개요

### 1.1 한 줄 요약
OUTTA 소속 사용자에게 디지털 증명서를 발급하고 QR로 검증하는 SPA + API.

### 1.2 행위자 (Actor)VV
| 행위자 | 능력 |
|--------|------|
| 비로그인 | `/login`, `/validate/:logId`, `/api/images/:id` |
| 일반 사용자 | 본인이 `user_ids`에 포함된 증명서 보기/PDF 발급 |
| 관리자(Admin 그룹) | 사용자·그룹·증명서 CRUD, CSV 일괄 등록 |

### 1.3 핵심 흐름
1. **템플릿 생성**: Admin이 배경 이미지 + 텍스트 + QR rect를 캔버스에서 배치 → POST `/certs`.
2. **발급**: 사용자가 본인용 증명서를 선택 → POST `/certs/{id}/issue` → 서버가 PDF 합성 + S3 업로드 → presigned URL 즉시 다운로드.
3. **검증**: PDF 안의 QR 스캔 → `/validate/{certLogId}` → `CertificateLog` 조회 결과 표시.

### 1.4 아키텍처
```
┌──────────────────┐  HTTPS (cookie auth)  ┌────────────────────┐
│ Browser          │ ────────────────────▶ │ FastAPI (Uvicorn)  │
│  Vite + React    │ ◀──────────────────── │  /auth /certs ...  │
│  Fabric.js (CSR) │   JSON / blob          └─┬───────┬───────┬─┘
└──────────────────┘                          │       │       │
                                              │       │       │
                                       SQLAlchemy boto3   Authlib
                                              │       │       │
                                              ▼       ▼       ▼
                                       ┌──────────┐ ┌────┐ ┌──────────┐
                                       │ Postgres │ │ S3 │ │  Google  │
                                       └──────────┘ └────┘ └──────────┘
```

---

## 2. 도메인 모델 (PostgreSQL / SQLAlchemy 2)

### 2.1 ER
```
Group (1)──(N)── user_groups ──(N)──(1) User
                                      │
                                      │ (1)
                                      ▼ (N)
                              CertificateLog
                                      │ (N)
                                      │
                                      ▼ (1)
                                Certificate
```

### 2.2 테이블

**핵심 정책**:
1. **발급 이력은 영구 보존** — 원본 Prisma는 `CertificateLog` FK가 `ON DELETE RESTRICT`라 사용자/증명서 삭제가 사실상 차단됐다. 신규는 **`SET NULL` + 스냅샷 컬럼**으로 바꿔서 admin이 자유롭게 삭제하면서도 "이미 발급된 증명서는 계속 검증 가능"을 만족시킨다.
2. **`Certificate.user_ids`는 ARRAY 유지 + 애플리케이션 cleanup** — Postgres ARRAY는 FK를 못 가지므로, 사용자 삭제 시 동일 트랜잭션에서 `array_remove`로 dangling UUID를 제거한다(§4.3). GIN 인덱스 필수.
3. **시간 컬럼은 모두 `timestamptz`** — 레거시 `TIMESTAMP(3)` 마이그레이션 시 `USING ... AT TIME ZONE 'UTC'` 명시(plan.md §5).

```python
# apps/api/app/db.py
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass

# apps/api/app/models.py
import uuid
from datetime import datetime, timezone
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy import (
    ForeignKey, String, DateTime, Table, Column, Index, CheckConstraint, func, text,
)
from sqlalchemy.dialects.postgresql import UUID, ARRAY, JSONB

from app.db import Base

# 인덱스 컨벤션: 단일 컬럼 B-Tree는 `index=True` 인라인, 그 외(GIN/복합/CHECK)는 __table_args__.

user_groups = Table(
    "user_groups",
    Base.metadata,
    Column("user_id", UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("group_id", UUID(as_uuid=True), ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True),
)

class Group(Base):
    __tablename__ = "groups"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    users: Mapped[list["User"]] = relationship(secondary=user_groups, back_populates="groups")

class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # unique=True가 이미 unique 인덱스를 만든다 → 별도 index=True 금지(중복 인덱스).
    google_id: Mapped[str | None] = mapped_column(String, unique=True)
    # email: 저장 시 반드시 lower() 적용 (§3.1, §4.0 UserCreate validator). DB-레이어 가드는 CHECK.
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    memo: Mapped[str] = mapped_column(String, default="", server_default="", nullable=False)
    groups: Mapped[list[Group]] = relationship(secondary=user_groups, back_populates="users")
    # passive_deletes=True: DB FK SET NULL이 처리 — ORM이 cert.logs를 사전 로드해 UPDATE 발행하지 않게.
    logs: Mapped[list["CertificateLog"]] = relationship(back_populates="user", passive_deletes=True)
    __table_args__ = (
        # CHECK가 모델 코드에 있어야 metadata.create_all/Alembic autogenerate 둘 다 일관 동작.
        CheckConstraint("email = lower(email)", name="ck_users_email_lowercase"),
    )

class Certificate(Base):
    __tablename__ = "certificates"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(String, default="", server_default="", nullable=False)
    content: Mapped[dict] = mapped_column(JSONB, nullable=False)                   # 원본은 String, 신규는 JSONB
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # ARRAY는 FK 제약 불가 → 사용자 삭제 시 §4.3의 array_remove로 cleanup.
    # NULL 방지: NOT NULL + server_default '{}'. Python default=list와 양쪽 모두 둔다.
    user_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)),
        nullable=False,
        default=list,
        server_default=text("'{}'::uuid[]"),
    )
    logs: Mapped[list["CertificateLog"]] = relationship(
        back_populates="certificate",
        passive_deletes=True,                                # cascade 제거 + DB SET NULL 단독 처리 (스냅샷 보존)
    )
    __table_args__ = (
        Index("ix_certificates_user_ids_gin", "user_ids", postgresql_using="gin"),
    )

class CertificateLog(Base):
    """발급 이력 = 검증 단위. 스냅샷 컬럼으로 영구 보존.

    원본 Prisma는 FK RESTRICT라 사용자/증명서 삭제가 차단됐다.
    신규는 SET NULL + 스냅샷으로 바꿔서, admin 삭제 후에도 이미 발행된 QR이 계속 검증되도록 한다.
    """
    __tablename__ = "certificate_logs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # FK는 nullable + SET NULL — 사용자/증명서 삭제 시 NULL로 끊고, 스냅샷으로 검증 계속.
    certificate_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("certificates.id", ondelete="SET NULL"), nullable=True, index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # 스냅샷: 발급 시점의 정보를 그대로 박아둔다. 검증/만료 판정도 이 컬럼만 사용.
    user_name: Mapped[str] = mapped_column(String, nullable=False)
    user_email: Mapped[str] = mapped_column(String, nullable=False)
    certificate_name: Mapped[str] = mapped_column(String, nullable=False)
    certificate_issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    certificate_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pdf_key: Mapped[str] = mapped_column(String, nullable=False)         # "certs/issued/<log_id>.pdf"

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),                                       # DB가 채움. timezone-aware.
    )                                                                    # (datetime.utcnow는 naive + Py3.12 deprecated이므로 사용 금지)

    certificate: Mapped[Certificate | None] = relationship(back_populates="logs")
    user: Mapped[User | None] = relationship(back_populates="logs")

class AuditLog(Base):
    """audit log = 발급/삭제/Admin 변경 같은 사실의 영구 기록 (§8.2).

    audit_log() 헬퍼(§8.2)가 request context(request_id/actor_id/ip/ua)를
    ContextVar로 자동 수집해 채운다.
    """
    __tablename__ = "audit_logs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    request_id: Mapped[str] = mapped_column(String, nullable=False)
    # actor_id: 사용자 row가 삭제돼도 이력은 유지 → SET NULL.
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    action: Mapped[str] = mapped_column(String, nullable=False)
    target_type: Mapped[str | None] = mapped_column(String)             # 'cert', 'user', 'group', 'log'
    target_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    ip: Mapped[str | None] = mapped_column(String)                       # INET 대신 String — 이식성
    ua: Mapped[str | None] = mapped_column(String)
    success: Mapped[bool] = mapped_column(nullable=False)
    error_code: Mapped[str | None] = mapped_column(String)
    meta: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"), nullable=False, default=dict)
    __table_args__ = (
        Index("ix_audit_logs_action_ts", "action", "ts"),
        Index("ix_audit_logs_target", "target_type", "target_id"),
    )
```

**인덱스/제약 요약** (Alembic 첫 리비전이 위 모델들로부터 autogenerate):
- `users.email`: `CHECK (email = lower(email))` + unique 인덱스 (CHECK는 모델 `__table_args__`로 단일 출처).
- `certificates.user_ids`: GIN 인덱스 (`/api/certs/me`의 `:uid = ANY(user_ids)` 가속).
- `certificate_logs.certificate_id`, `certificate_logs.user_id`: 인라인 `index=True` (B-Tree).
- `certificate_logs` cascade 제거 — Certificate 삭제 시 logs는 살아남아 SET NULL로 끊긴다.
- `audit_logs` 2개 복합 인덱스 — action+ts(시간 기반 조회), target_type+target_id(특정 리소스 이력).

**테스트 fixture 정책**: pytest fixture는 **반드시 `alembic upgrade head`로 스키마 생성**. `Base.metadata.create_all()`은 PostgreSQL 확장(`pgcrypto` 등)이나 추후 추가될 raw DDL을 잡지 못하므로 사용 금지 — 위 모델은 모두 SQLAlchemy 1차 시민이므로 create_all로도 거의 동작하지만, 정책 단일화를 위해 모든 경로를 Alembic으로 통일.

### 2.3 `Certificate.content` 스키마 (JSONB)

```ts
// 프론트엔드와 공유. 원본 src/types/content.ts와 동일.
type CertContent = {
  image: { data: string; width: number; height: number; left: number; top: number };
  // image.data 는 S3 객체 키(예: "<uuid>.png"). GET /api/images/<key>로 다운로드.
  texts: { data: string; scale: number; left: number; top: number; width: number; height: number }[];
  rects: { width: number; height: number; left: number; top: number }[];
  orientation: "landscape" | "portrait";
};
```

캔버스 좌표계: `landscape` 1024×720, `portrait` 720×1024. PDF는 항상 A4(841.89×595.28 또는 595.28×841.89 pt).

### 2.4 텍스트 치환자
PDF 합성 시 다음을 그대로 치환:
- `{{Name}}` → `User.name`
- `{{IssueDate}}` → `cert.issued_at`을 KST(`Asia/Seoul`)로 변환 후 `"YYYY. M. D."` 포맷 (zero-pad 없음, 원본 `toLocaleDateString("ko-KR")`과 동치)
- `{{PrintDate}}` → 발급 시점의 KST 현재 날짜를 동일 포맷

> 두 날짜는 한 곳에서만 처리하도록 [`fmt_kr_date()`](#54-합성-절차) 헬퍼를 둔다. 서버 timezone에 의존하지 않음.

---

## 3. 인증 / 권한

### 3.1 흐름
1. FE가 `GET /api/auth/google/login` 으로 리디렉트 → Authlib가 state/nonce 발급 후 Google 동의 화면.
2. Google → `GET /api/auth/google/callback?code=&state=...` 로 콜백. Authlib가 `state` 일치 + `nonce` 검증을 자동 수행 (FastAPI 라우트에서 명시적으로 보장).
3. BE가 토큰 교환 → Google `userinfo`로 `email`, `email_verified`, `sub`, `name` 획득.
4. **이메일 검증 강제**: `email_verified !== true` 면 즉시 `401`로 거부한다. Google에서 미인증 이메일을 claim한 계정이 사전 등록된 이메일을 가로채는 공격을 차단한다.
5. **이메일 정규화**: 비교/조회/저장은 모두 `email.lower()` 기준. 클라이언트가 보낸 케이싱은 무시한다.
6. **부트스트랩 분기**:
   - `email.lower() == DEFAULT_ADMIN_EMAIL.lower()` 이면:
     - `Admin` 그룹이 없으면 생성.
     - 사용자 row를 `UPSERT (email)` — 없으면 신규, 있으면 그대로.
     - **항상** `Admin` 그룹 멤버십을 보장(이미 연결돼 있으면 no-op).
     - `google_id` 갱신은 아래 step 7 규칙을 따른다 — **단, default admin email은 step 7의 "다르면 거부" 규칙을 우회**하여 항상 신규 sub로 덮어쓴다(복구 경로). 이는 admin 락아웃을 막기 위한 의도된 예외.
   - 그 외엔 DB의 `users.email`이 사전 등록돼 있어야 함. 없으면 FE의 `/unregistered`로 302.
7. **`google_id` 무조건 덮어쓰기 금지** (단 step 6의 default admin 예외 적용 후):
   - 사용자의 `google_id`가 NULL이면 신규 sub로 세팅.
   - 이미 값이 있는데 들어온 sub와 **다르면** 401 거부 + 명시적 메시지 `account_linked_to_different_google_identity`. admin 개입 없이는 재바인딩 불가.
     - **예외**: step 6에서 들어온 email이 `DEFAULT_ADMIN_EMAIL`이면 이 규칙을 우회해 신규 sub로 덮어쓴다(복구 경로). default admin 자체가 admin 락아웃의 회복 메커니즘.
   - 같은 sub면 no-op.
   - 들어온 sub가 *다른* 사용자 row에 이미 매핑돼 있으면 401 `duplicate_google_id`. 구현은 SELECT-then-UPDATE의 race window를 고려해 **`sqlalchemy.exc.IntegrityError`를 catch해 동일 메시지로 재발생** — `google_id` unique constraint violation을 generic 500으로 흘리지 않는다.
8. 통과 시 **JWT를 쿠키로 세팅**:
   - 속성: `httpOnly`, `Path=/`, `SameSite=Lax`, payload `{sub: user_id, name, exp}`, 만료 7일.
   - `Secure`: `settings.ENV == "prod"`에서 `True`, dev에서 `False`.
   - `Domain`: `settings.SESSION_COOKIE_DOMAIN`이 채워진 경우만 설정.
   - **SameSite는 `Lax`로 통일 (prod에서도)**. Strict는 OAuth 콜백(Google → 우리 도메인) 같은 top-level cross-site GET에서 in-flight state 쿠키를 떨궈 로그인 자체가 깨지기 때문. CSRF는 §8.1의 Origin/Referer + `X-Requested-With` 헤더로 보완한다.
   - Authlib state/nonce 임시 쿠키도 동일하게 `Lax`로 세팅 (Strict면 콜백에서 사라짐).

### 3.2 Dependencies
```python
async def current_user(request: Request, db: AsyncSession) -> User: ...
async def require_admin(user: User = Depends(current_user)) -> User:
    if not any(g.name == "Admin" for g in user.groups):
        raise HTTPException(403, "Admin only")
    return user
```

모든 관리자 라우트는 `Depends(require_admin)`만 붙이면 끝. 비관리자 사용자 라우트는 `Depends(current_user)` + 라우트 내에서 소유권 검사.

### 3.3 Authlib + SessionMiddleware 등록

**필수**: Authlib OAuth client는 state·nonce·code_verifier를 starlette의 session storage에 저장한다. `starlette.middleware.sessions.SessionMiddleware`가 등록되지 않으면 `/api/auth/google/login` 첫 호출에서 즉시 `AssertionError: SessionMiddleware must be installed to access request.session`로 실패한다.

```python
# apps/api/app/main.py (발췌)
from authlib.integrations.starlette_client import OAuth
from starlette.middleware.sessions import SessionMiddleware
from fastapi import FastAPI

from app.config import settings

app = FastAPI()

# OAuth state/nonce 저장용. JWT 세션 쿠키와는 별개 (이쪽은 starlette signed-session 쿠키).
# 짧은 수명만 필요하지만 OAuth 콜백이 cross-site GET이라 SameSite=Lax 필수.
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.SESSION_SECRET,            # JWT와 동일 시크릿 재사용 OK
    session_cookie="oauth_state",                  # JWT 쿠키(SESSION_COOKIE_NAME)와 분리
    same_site="lax",
    https_only=(settings.ENV == "prod"),
    max_age=600,                                   # 10분 — OAuth 콜백 시간 여유
)

oauth = OAuth()
oauth.register(
    name="google",
    client_id=settings.GOOGLE_CLIENT_ID,
    client_secret=settings.GOOGLE_CLIENT_SECRET,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)
```

### 3.4 OAuth 라우트 (`apps/api/app/routes/auth.py`)

```python
from fastapi import APIRouter, Request
from starlette.responses import RedirectResponse
from app.main import oauth
from app.config import settings

router = APIRouter(prefix="/api/auth", tags=["auth"])

@router.get("/google/login")
async def google_login(request: Request):
    # Authlib가 state/nonce 생성 후 request.session에 저장 → SessionMiddleware 필수.
    return await oauth.google.authorize_redirect(
        request, settings.GOOGLE_REDIRECT_URI,
    )

@router.get("/google/callback")
async def google_callback(request: Request):
    # state/nonce 검증은 Authlib가 자동.
    token = await oauth.google.authorize_access_token(request)
    profile = token.get("userinfo")
    # → §3.1 step 4 부터 진행.
    ...
```

---

## 4. REST API (FastAPI)

> Base prefix: `/api`. 응답은 모두 Pydantic 모델. 에러는 `{"detail": "..."}` (FastAPI 표준).
>
> **명명 규칙**: 모든 JSON 필드는 **snake_case**로 통일한다(`user_ids`, `issued_at`, `expires_at`, `google_id`, `group_ids`, `is_admin` 등). FE 타입도 동일하게 정렬한다 — 원본 Next.js의 camelCase(`userIds` 등)는 신규에서 사용하지 않는다. Pydantic alias로 응답을 camelCase로 바꾸지 않는다(디버깅 비용만 늘어남).

### 4.0 응답 스키마 (Pydantic)

모든 엔드포인트가 참조하는 공유 응답 모델. 별도 `apps/api/app/schemas.py`에 둔다. FE [`types/`](#61-디렉토리)는 이 정의와 1:1로 정렬.

```python
# apps/api/app/schemas.py
from datetime import datetime, date, time, timezone
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import (
    BaseModel, EmailStr, ConfigDict, Field, BeforeValidator, AfterValidator,
)

KST = ZoneInfo("Asia/Seoul")

# ── 재사용 타입 ───────────────────────────────────────────────────────────

# 이메일은 RFC 검증 + 무조건 lower(). UserCreate / UserOut / 어디서든 동일.
LowerEmail = Annotated[EmailStr, AfterValidator(lambda s: s.lower())]

def _kst_midnight_or_passthrough(v):
    """입력 정규화 규칙:
    - None → None (Optional 필드용; Annotated | None 결합 시).
    - date-only 문자열 'YYYY-MM-DD' → KST 자정으로 해석 후 UTC datetime.
    - date 객체(not datetime) → KST 자정으로 해석 후 UTC datetime.
    - datetime 객체 (tz-aware) → 그대로 통과 (이후 Pydantic이 UTC로 강제하려면 별도 ConfigDict 사용).
    - datetime 객체 (naive) → **거부** (`ValueError("naive_datetime_not_allowed")` → Pydantic 422로 전파).
    - ISO 8601 문자열 (datetime) → Pydantic 표준 파서가 그대로 처리 (passthrough).
    """
    if v is None:
        return None
    if isinstance(v, str) and len(v) == 10 and v.count("-") == 2:
        d = date.fromisoformat(v)
        return datetime.combine(d, time(0, 0), tzinfo=KST).astimezone(timezone.utc)
    if isinstance(v, date) and not isinstance(v, datetime):
        return datetime.combine(v, time(0, 0), tzinfo=KST).astimezone(timezone.utc)
    if isinstance(v, datetime) and v.tzinfo is None:
        raise ValueError("naive_datetime_not_allowed")
    return v

# datetime 필드용. 입력 시 date-only를 KST 자정→UTC로 변환. tz-aware datetime은 통과, naive datetime은 422.
KstDateOrDatetime = Annotated[datetime, BeforeValidator(_kst_midnight_or_passthrough)]

# ── 출력 ──────────────────────────────────────────────────────────────────

class GroupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    member_count: int | None = None     # GET /groups 목록에서만 채움

class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    email: LowerEmail
    name: str
    memo: str = ""
    google_id: str | None = None
    groups: list[GroupOut] = []

class MeOut(UserOut):
    """`is_admin = any(g.name == "Admin" for g in user.groups)` — §3.2 require_admin과 동일 술어 단일 출처.
    SQLAlchemy hybrid_property로 User에 노출하거나 라우트 핸들러에서 계산해 채운다."""
    is_admin: bool

class CertContentIn(BaseModel):
    """클라이언트 → 서버. image.data는 Data URI."""
    class _Image(BaseModel):
        data: str                         # data:image/...;base64,...
        width: float; height: float; left: float; top: float
    class _Text(BaseModel):
        data: str; scale: float
        width: float; height: float; left: float; top: float
    class _Rect(BaseModel):
        width: float; height: float; left: float; top: float
    image: _Image
    texts: list[_Text] = []
    rects: list[_Rect] = []
    orientation: Literal["landscape", "portrait"]

class CertContentOut(BaseModel):
    """DB/응답에 저장된 형태. image.data는 S3 키."""
    class _Image(BaseModel):
        data: str                         # "<uuid>.<ext>"
        width: float; height: float; left: float; top: float
    class _Text(BaseModel):
        data: str; scale: float
        width: float; height: float; left: float; top: float
    class _Rect(BaseModel):
        width: float; height: float; left: float; top: float
    image: _Image
    texts: list[_Text] = []
    rects: list[_Rect] = []
    orientation: Literal["landscape", "portrait"]

class CertSummaryOut(BaseModel):
    """GET /certs 목록용. content 제외(payload 절감)."""
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    description: str = ""
    issued_at: datetime
    expires_at: datetime | None = None
    user_ids: list[UUID] = []
    log_count: int = 0

class CertOut(BaseModel):
    """GET /certs/{id} 단건. content 포함."""
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    description: str = ""
    content: CertContentOut
    issued_at: datetime
    expires_at: datetime | None = None
    user_ids: list[UUID] = []
    log_count: int | None = None

class CertLogOut(BaseModel):
    """발급 이력. user/cert 삭제 후에도 스냅샷으로 살아남음."""
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    certificate_id: UUID | None = None   # 원본 삭제 시 SET NULL
    user_id: UUID | None = None
    user_name: str
    user_email: LowerEmail
    certificate_name: str
    certificate_issued_at: datetime
    certificate_expires_at: datetime | None = None
    pdf_key: str
    created_at: datetime

class IssueOut(BaseModel):
    url: str                              # presigned S3 URL, TTL = settings.AWS_S3_PRESIGN_EXPIRES

class ValidateOut(BaseModel):
    """공개 검증 결과. 데이터는 모두 CertificateLog의 스냅샷에서 가져온다.

    UX (§4.6): FE는 **issued_at**(템플릿의 발급 기준일, 스냅샷)을 메인으로 보여주고
    log_created_at(실제 PDF 발급 시각)은 보조 메타로 노출한다.
    """
    valid: bool                           # log_id가 DB에 존재하면 true
    expired: bool = False                 # certificate_expires_at < now()
    certificate_name: str | None = None
    user_name: str | None = None
    issued_at: datetime | None = None     # log.certificate_issued_at (스냅샷)
    expires_at: datetime | None = None    # log.certificate_expires_at
    log_created_at: datetime | None = None  # 이 사용자의 PDF 발급 시각

# ── 요청 본문 (입력) ─────────────────────────────────────────────────────

class UserCreate(BaseModel):
    name: str = Field(min_length=1)
    email: LowerEmail                     # AfterValidator로 자동 .lower()
    google_id: str | None = None
    group_ids: list[UUID] = []

class UserUpdate(BaseModel):
    memo: str | None = None
    group_ids: list[UUID] | None = None   # None = 변경 안 함, [] = 모두 제거

class GroupCreate(BaseModel):
    name: str = Field(min_length=1)

class GroupUpdate(BaseModel):
    name: str = Field(min_length=1)

class CertCreate(BaseModel):
    name: str = Field(min_length=1)
    description: str = ""
    content: CertContentIn                # Data URI 포함 CertContent
    issued_at: KstDateOrDatetime          # date면 KST 자정→UTC 자동 변환
    expires_at: KstDateOrDatetime | None = None
    user_ids: list[UUID] = []

class CertUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    issued_at: KstDateOrDatetime | None = None
    # None = 변경 안 함. 만료 해제는 expires_at_clear=True로 명시.
    expires_at: KstDateOrDatetime | None = None
    expires_at_clear: bool = False        # True면 expires_at 무시하고 NULL로 set (§4.2.0)
    user_ids: list[UUID] | None = None
```

#### 4.0.1 에러 응답

FastAPI 표준만 사용. 원본의 `{result, data, error: {title, message}}` envelope은 폐기.

```jsonc
// 4xx/5xx — string detail
{ "detail": "Admin only" }

// 422 (Pydantic 검증 실패) — list detail
{ "detail": [
    { "loc": ["body", "email"], "msg": "value is not a valid email", "type": "value_error.email" }
]}
```

원본 → 신규 매핑:

| 원본 (`error.title`) | HTTP | 신규 `detail` |
|---------------------|------|--------------|
| Unauthorized | 401 | `"unauthenticated"` |
| Forbidden | 403 | `"forbidden"` 또는 구체 사유 (`"admin_only"`, `"not_a_recipient"`) |
| Not Found | 404 | `"<resource>_not_found"` |
| Bad Request | 400 / 422 | 422 = Pydantic 자동, 400 = 수동 비즈니스 검증 |
| Internal Server Error | 500 | `"internal_error"` (상세는 audit log에만) |

FE는 `if (!res.ok) { toast(res.detail) }` 한 줄로 처리. 원본의 `if (!data.result) ...` 분기는 전부 HTTP status 기반으로 교체.

### 4.1 Auth

| 메서드 | 경로 | 인증 | 설명 |
|--------|------|------|------|
| GET | `/api/auth/google/login` | - | OAuth 시작 |
| GET | `/api/auth/google/callback` | - | OAuth 콜백 |
| POST | `/api/auth/logout` | login | 쿠키 삭제 |
| GET | `/api/auth/me` | login | 현재 사용자(`UserOut` + `is_admin`) |

### 4.2 Certificates

| 메서드 | 경로 | 권한 | 설명 |
|--------|------|------|------|
| GET | `/api/certs` | Admin | 전체 목록 (`CertSummaryOut[]` — content 제외, payload 절감) |
| GET | `/api/certs/me` | login | 본인 발급 가능 목록 (`CertSummaryOut[]`; GIN 인덱스로 `:uid = ANY(user_ids)` 가속) |
| GET | `/api/certs/{id}` | login (Admin or `user_ids`에 포함) | 단건 조회 (`CertOut`) |
| POST | `/api/certs` | Admin | 생성 (`CertCreate` → `CertOut`). 배경 이미지 Data URI → S3 |
| PUT | `/api/certs/{id}` | Admin | 메타데이터 수정 (`CertUpdate` → `CertOut`). content 자체 수정은 새로 만들기 권장 |
| DELETE | `/api/certs/{id}` | Admin | 삭제 (logs는 SET NULL로 보존; S3 배경 객체는 best-effort) |
| POST | `/api/certs/{id}/issue` | login + `user_ids` 포함 + 미만료 | PDF 합성 → S3 → `IssueOut` (presigned URL) |
| GET | `/api/certs/{id}/logs` | Admin | 발급 이력 (`CertLogOut[]`) |

#### 4.2.0 PUT 의미

- 모든 필드가 optional. `null` 또는 누락은 "변경 안 함".
- `expires_at` 해제(무기한으로 되돌리기)는 별도 `"expires_at_clear": true` 플래그(`CertUpdate.expires_at_clear`, §4.0). True면 `expires_at` 필드는 무시하고 NULL로 set.
- 우선순위: `expires_at_clear=True` > `expires_at` 값 > 변경 안 함.
- `user_ids`의 모든 UUID는 사전 검증 — 존재하지 않는 UUID가 하나라도 있으면 `400 invalid_user_ids`.

#### 4.2.1 `POST /api/certs` 요청 / `issued_at`·`expires_at` 의미

```json
{
  "name": "OUTTA 부트캠프 수료증",
  "description": "2026 봄 기수",
  "content": { "image": { "data": "data:image/png;base64,...", "...": "..." }, "texts": [], "rects": [], "orientation": "landscape" },
  "issued_at": "2026-05-01",
  "expires_at": null,
  "user_ids": ["<uuid>"]
}
```

- `issued_at`/`expires_at`는 **ISO 8601 date 또는 datetime**. **date-only(`YYYY-MM-DD`)는 KST 자정으로 해석한 뒤 UTC로 저장** (서버 timezone 비의존). 예: `"2026-05-01"` → `2026-04-30T15:00:00Z`.
- `expires_at: null` = 무기한.
- 서버는 `content.image.data`를 다음 순으로 처리:
  1. `dataURItoBytes()`로 디코딩 → MIME 추출.
  2. **MIME 화이트리스트**(§4.5): `{image/png, image/jpeg, image/webp}` 외엔 415 거부.
  3. Pillow로 매직 바이트 검증 + RGB로 재인코딩(EXIF/메타데이터 제거).
  4. `s3://<bucket>/certs/images/<uuid>.<ext>`에 업로드, **신뢰된 MIME을 S3 object metadata(`x-amz-meta-content-type`)에 저장**.
  5. `content.image.data`를 키만으로 치환(`"<uuid>.<ext>"`) 후 `Certificate` 레코드 생성.

#### 4.2.2 `POST /api/certs/{id}/issue` (발급)

**사전 조건** (전부 충족해야 함; 하나라도 실패 시 발급 트랜잭션 시작 전 차단):
1. 인증됨 (`Depends(current_user)`)
2. `user.id IN cert.user_ids` — 아니면 `403 not_a_recipient`
3. `cert.expires_at IS NULL` 또는 `cert.expires_at > now()` — 만료면 `410 certificate_expired`

응답 (`IssueOut`):
```json
{ "url": "https://s3.../certs/issued/<log_id>.pdf?X-Amz-..." }
```

- presigned URL TTL = `settings.AWS_S3_PRESIGN_EXPIRES` (기본 300초, 상한 7일 by S3 SigV4).
- 원본 1분 → 신규 5분으로 상향했으나 값은 환경 변수로 변경 가능.

#### 4.2.3 `DELETE /api/certs/{id}` (구현 순서)

부분 실패 상태를 만들지 않는 단일 정책:

```python
# apps/api/app/routes/certs.py — DELETE 핸들러
from app.services.s3 import s3_delete
from app.services.audit import audit_log
from app.services.cleanup import enqueue_cleanup

async with db.begin():
    # FK SET NULL은 DB가 자동 처리 (passive_deletes=True § 2.2). 명시적 UPDATE는 안전망.
    await db.execute(
        update(CertificateLog)
        .where(CertificateLog.certificate_id == cert_id)
        .values(certificate_id=None)
    )
    await db.execute(delete(Certificate).where(Certificate.id == cert_id))
# 위 COMMIT 직후, S3 best-effort:
try:
    await s3_delete(f"certs/images/{img_key}")
except Exception as e:
    await audit_log(
        "s3_cleanup_failed", success=False, target_type="cert", target_id=cert_id,
        error_code=type(e).__name__, key=img_key,
    )
    await enqueue_cleanup(key=f"certs/images/{img_key}")
return {"deleted": cert_id, "logs_preserved": count}
```

- 버킷 식별자는 **반드시 `settings.AWS_S3_BUCKET_NAME`** — 문자열 리터럴/다른 env 키 금지.
- S3 삭제 실패가 사용자 응답을 5xx로 만들면 안 됨. cleanup queue/audit log에 적재 후 200.
- **이미 발급된 PDF(`certs/issued/<log_id>.pdf`)는 삭제하지 않는다** — 스냅샷 로그가 살아 있으므로 검증 시 다운로드 가능해야 함.

### 4.3 Users

| 메서드 | 경로 | 권한 | 설명 |
|--------|------|------|------|
| GET | `/api/users` | Admin | 목록 (`UserOut[]`, groups join). `?q=` 검색(name/email/group) |
| GET | `/api/users/{id}` | Admin | 단건 (`UserOut`) |
| POST | `/api/users` | Admin | 생성 (`UserCreate` → `UserOut`). `email`은 `.lower()` 정규화, `group_ids` 모두 존재 검증 |
| PUT | `/api/users/{id}` | Admin | 갱신 (`UserUpdate` → `UserOut`). `group_ids=None` = no-op, `[]` = 모두 제거 |
| DELETE | `/api/users/{id}` | Admin | 삭제 (스냅샷 로그는 보존, `Certificate.user_ids`에서 cleanup) |
| POST | `/api/users/file` | Admin | CSV multipart 업로드 |

#### 4.3.1 입력 검증 / 권한 가드

모든 변경 엔드포인트에서 강제:

1. **payload는 Pydantic 모델로만 받는다** — 원본의 `groups: { connect: req.body.groups }` 패턴 금지.
2. **`group_ids` 사전 검증** — `SELECT id FROM groups WHERE id = ANY(:group_ids)`로 전부 존재 확인. 누락 시 `400 invalid_group_ids`.
3. **자기 자신 보호** — `current_user.id == path_id` 인 경우:
   - DELETE → `409 cannot_delete_self`
   - PUT → group_ids에서 `Admin` 제외 시 `409 cannot_demote_self`
4. **마지막 Admin 보호** — DELETE 또는 group 변경으로 Admin 그룹의 잔여 멤버가 0이 되는지 사전 확인:
   ```sql
   SELECT count(*) FROM user_groups ug JOIN groups g ON g.id = ug.group_id
   WHERE g.name = 'Admin' AND ug.user_id != :target_id
   ```
   결과가 0이면 `409 last_admin`.

#### 4.3.2 `DELETE /api/users/{id}` 트랜잭션

```
BEGIN
  -- 1. 마지막 Admin 가드 (위 4번)
  -- 2. self-delete 가드 (위 3번)
  -- 3. Certificate.user_ids에서 dangling UUID 제거
  UPDATE certificates SET user_ids = array_remove(user_ids, :user_id)
    WHERE :user_id = ANY(user_ids);
  -- 4. user_groups는 FK CASCADE로 자동
  -- 5. certificate_logs는 FK SET NULL — 스냅샷 컬럼으로 검증 계속 가능
  DELETE FROM users WHERE id = :user_id;
COMMIT
```

#### 4.3.3 CSV 일괄 추가 (`POST /api/users/file`)

**요청 계약**:
1. `Content-Type: multipart/form-data`. 파일 필드명은 정확히 **`file`** (다른 이름은 422).
2. 인코딩: **UTF-8 필수**. UTF-8 BOM 허용 후 strip(`utf-8-sig`). CP949/EUC-KR 검출 시 `400 invalid_encoding` ("UTF-8로 저장해 주세요").
3. 첫 줄은 **헤더 필수**(원본의 헤더-감지 모드는 폐기). `이름`, `이메일`, `그룹`이 모두 포함돼야 함. 순서 무관. `Google ID`, `메모`는 선택. 미지정 컬럼은 무시.
4. 파싱: 표준 `csv.reader(io.TextIOWrapper(file.file, encoding="utf-8-sig", newline=""))` — RFC 4180 따옴표/이스케이프 지원.
5. `그룹` 열: 그룹 UUID `|` 구분. 빈 값 허용(= 그룹 없음).
6. 모든 이메일은 `.lower()` 정규화.
7. **사전 검증** 단계에서 모든 행을 파싱·검증. 단 한 줄이라도 실패 시 INSERT 실행 안 함.
8. INSERT는 **단일 `async with db.begin():` 트랜잭션** — 한 줄 실패 시 전체 롤백. 부분 성공 응답 만들지 않음.
9. **한계**: 최대 파일 크기 5 MiB, 최대 1000행. 초과 시 413/400.
10. **중복 정책**: 파일 내 중복 이메일은 `400 duplicate_in_file` (행 번호 표기). DB에 이미 존재하는 이메일은 `409 email_exists`.

**예시 CSV**:
```csv
이름,이메일,그룹,Google ID,메모
홍길동,user1@example.com,<group-uuid>|<group-uuid>,,수료자
```

**응답**:

성공 200:
```json
{ "created": 12, "user_ids": ["<uuid>", "..."] }
```

검증 실패 400/422:
```json
{
  "detail": "csv_validation_failed",
  "errors": [
    { "row": 3, "column": "이메일", "message": "value is not a valid email" },
    { "row": 7, "column": "그룹",   "message": "group not found: <uuid>" }
  ]
}
```

- 행 번호는 헤더 제외 1-based. 컬럼명은 한국어 헤더 그대로.

### 4.4 Groups

| 메서드 | 경로 | 권한 | 설명 |
|--------|------|------|------|
| GET | `/api/groups` | Admin | 목록 (`GroupOut[]` + `member_count`) |
| GET | `/api/groups/{id}` | Admin | 단건 (`GroupOut`) |
| POST | `/api/groups` | Admin | 생성 (`GroupCreate` → `GroupOut`) |
| PUT | `/api/groups/{id}` | Admin | 이름 변경 (`GroupUpdate` → `GroupOut`) |
| DELETE | `/api/groups/{id}` | Admin | 삭제 (`Admin` 그룹은 보호) |

#### Admin 그룹 보호 (서버 강제, UI 비활성화는 보조)

다음을 **서버에서** 모두 거부:

1. **DELETE** 시 대상 `group.name == "Admin"` → `409 admin_group_protected`.
2. **PUT** 시 *현재 이름이* `Admin` → `409 admin_group_protected` (변경 금지).
3. **PUT** 시 *새 이름이* `Admin` → `409 admin_group_protected` (기존 그룹을 Admin으로 승격하는 우회 차단).

→ 이름 기반 권한 검사(`g.name == "Admin"`)가 유일한 진실 출처이므로, Admin 그룹 자체의 이름 변경/삭제는 시스템 잠금을 초래한다.

### 4.5 Images

| 메서드 | 경로 | 권한 | 설명 |
|--------|------|------|------|
| GET | `/api/images/{key}` | - (공개, rate-limited) | `s3://<bucket>/certs/images/<key>` 프록시 |

#### 보안 정책 (스토어드 XSS 방지)

원본은 클라이언트가 보낸 data URI mime을 그대로 받아 확장자로 저장하고, GET 시 같은 확장자로 `Content-Type`을 재추정해 echo했다. 이는 `data:text/html;base64,...` 또는 script-bearing SVG로 first-party XSS → NextAuth 쿠키 탈취까지 가능한 경로다. 신규는 다음 정책으로 차단:

1. **업로드(`POST /api/certs`)**: MIME 화이트리스트 `{image/png, image/jpeg, image/webp}`만 허용. data URI에서 디코딩한 바이트의 매직 바이트도 Pillow로 검증(헤더-바디 일치). EXIF 제거 + RGB 재인코딩.
2. **저장**: S3 객체 metadata `x-amz-meta-content-type`에 신뢰된 MIME 박아둠. 키는 `<uuid>.<ext>` (uuid4 + Pillow 결정 ext).
3. **다운로드(`GET /api/images/{key}`)**:
   - 키 형식 검증: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$` 정규식만 허용 (정확한 UUID 형식 + 화이트리스트 확장자). `/`, `..`, dotfile, 쿼리스트링 모두 차단.
   - S3에서 `Content-Type`은 **저장된 metadata에서** 읽음 (filename mime 추정 금지).
   - 응답 헤더 강제: `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="<key>"`, `Cache-Control: private, max-age=3600`.
   - 앱 전역에 CSP(`default-src 'self'; img-src 'self' data:; script-src 'self'`).
   - slowapi rate limit: 60 req/min/IP.

### 4.6 Validate

| 메서드 | 경로 | 권한 | 설명 |
|--------|------|------|------|
| GET | `/api/validate/{log_id}` | - (공개, rate-limited) | `ValidateOut` (§4.0). 데이터는 **`CertificateLog`의 스냅샷 컬럼에서만** 가져옴 |

**규칙** (공개 query 엔드포인트 — 모든 응답은 **200 + `ValidateOut`**, 404 안 씀):
- `CertificateLog` row가 없으면 `ValidateOut(valid=False, expired=False)` + **200**. 다른 필드는 모두 `None`.
- 있으면:
  - `certificate_expires_at` 검사 → `expired = (expires_at IS NOT NULL AND expires_at < now())`
  - `valid = True` (스냅샷은 영구 유효; 원본 cert/user가 삭제되어도 OK)
- `certificate_id`/`user_id` FK가 NULL이어도(원본 삭제됨) 응답에는 스냅샷 `*_name`이 채워져 정상 동작.

> **404 안 쓰는 이유**: §4.0.1는 4xx → `{detail}` 단언. ValidateOut을 404로 반환하면 envelope 충돌. 공개 query라 존재/부재 enumeration도 보호 가치가 낮으므로 200 통일이 단순하다.

**FE UX 분기** (Validate 페이지):
- `valid && !expired` → 녹색 체크 + "유효한 증명서입니다"
- `valid && expired` → 노란 경고 + "만료된 증명서입니다 (만료일: <fmt_kr_date>)"
- `!valid` → 빨간 X + "유효하지 않은 증명서입니다"

slowapi rate limit: 30 req/min/IP (열거 공격 차단).

---

## 5. PDF 합성 (reportlab)

### 5.1 의존성

uv는 PEP 621(`[project] dependencies`)을 그대로 읽는다. Poetry 스타일(`reportlab = "^4.2"`)은 사용하지 않는다.

```toml
# apps/api/pyproject.toml
[project]
name = "cert-api"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.30",
  "sqlalchemy[asyncio]>=2.0",
  "asyncpg>=0.29",
  "alembic>=1.13",
  "pydantic[email]>=2.7",                # EmailStr → email-validator 자동 포함
  "pydantic-settings>=2.3",
  "authlib>=1.3",
  "httpx>=0.27",
  "python-multipart>=0.0.9",
  "slowapi>=0.1.9",
  "boto3>=1.34",
  "reportlab>=4.2",
  "qrcode[pil]>=7.4",
]

[dependency-groups]
dev = [
  "pytest>=8.0",
  "pytest-asyncio>=0.23",
  "moto>=5.0",
]
```

### 5.2 폰트
```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont("ChosunGs", str(BASE_DIR / "data" / "ChosunGs.ttf")))
```
`data/ChosunGs.ttf`(원본 그대로)는 BE 리포의 `data/`에 둔다. 도커 이미지에 같이 빌드.

### 5.3 좌표 변환

reportlab의 좌표 원점은 **좌하단**. Fabric.js 디자이너는 **좌상단** + 1024×720 픽셀. 두 좌표계 차이는 두 종류로 흡수해야 한다: (1) 디자이너 → PDF **스케일**(점·크기 동일), (2) 좌상단 → 좌하단 **y 플립**(점 좌표에만 적용, 크기는 그대로).

단일 `to_pdf_xy`로 점과 크기를 같이 처리하면 미래 컨트리뷰터가 새 도형(line/ellipse/Frame)을 추가할 때 y 플립을 또 손으로 인라이닝하다 누락하기 쉽다. 헬퍼를 **점 / 크기 / 좌상단 rect / 좌상단 텍스트 baseline** 4종으로 분리:

```python
from typing import Literal

LANDSCAPE = (841.89, 595.28)
PORTRAIT  = (595.28, 841.89)
DESIGNER_W, DESIGNER_H = 1024, 720
Orientation = Literal["landscape", "portrait"]

def page_size(orientation: Orientation) -> tuple[float, float]:
    return LANDSCAPE if orientation == "landscape" else PORTRAIT

def scale_size(w: float, h: float, orientation: Orientation) -> tuple[float, float]:
    """디자이너(1024×720) → PDF points. 크기 전용. y 플립 없음."""
    pw, ph = page_size(orientation)
    return w * pw / DESIGNER_W, h * ph / DESIGNER_H

def scale_point_top_left(x: float, y_top: float, orientation: Orientation) -> tuple[float, float]:
    """디자이너 좌상단 점 → PDF 좌상단 점 (아직 y-down, reportlab 좌표 아님)."""
    return scale_size(x, y_top, orientation)

def top_left_rect_to_reportlab(
    x: float, y_top: float, w: float, h: float, orientation: Orientation,
) -> tuple[float, float, float, float]:
    """디자이너 좌상단 rect → reportlab 좌하단 rect (x, y_bottom, w, h).
    drawImage / 사각형에 사용."""
    pw, ph = page_size(orientation)
    sx, sy_top = scale_point_top_left(x, y_top, orientation)
    sw, sh = scale_size(w, h, orientation)
    return sx, ph - sy_top - sh, sw, sh

def top_left_baseline_to_reportlab(
    x: float, y_top: float, font_size: float, orientation: Orientation,
) -> tuple[float, float]:
    """디자이너 좌상단 텍스트박스 → reportlab (x, baseline_y).
    drawString / drawCentredString에 사용. cap-height ≈ font_size 가정."""
    pw, ph = page_size(orientation)
    sx, sy_top = scale_point_top_left(x, y_top, orientation)
    return sx, ph - sy_top - font_size
```

기존 `to_pdf_xy`는 폐기. 모든 §5.4 호출 사이트는 위 4종 중 하나를 사용.

### 5.4 합성 절차

reportlab의 `drawString`/`drawCentredString`은 **글자 baseline**을 y로 받는다. 영역 높이 `h`를 그대로 폰트 크기로 쓰면 baseline이 영역 상단에 닿아 글자가 위로 튀어 오르고, 폰트 메트릭상 영역을 가로로도 넘칠 수 있다. **헤드룸 폰트 크기**(`fit_font_size`) + **baseline 끌어내림**(`top_left_baseline_to_reportlab`) 두 헬퍼로 해결.

```python
# apps/api/app/services/pdf.py
import io
from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo

import qrcode
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas
from PIL import Image

from app.config import settings        # Settings() 인스턴스
from app.models import Certificate, User
# §5.3에서 정의된 헬퍼
from app.services.pdf_coords import (
    Orientation, page_size, scale_size,
    top_left_rect_to_reportlab, top_left_baseline_to_reportlab,
)

FONT_NAME = "ChosunGs"
TEXT_HEADROOM = 0.8        # 영역 높이의 80%까지만 폰트로 사용 (디센더·매트릭 여유)
KST = ZoneInfo("Asia/Seoul")

ALLOWED_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}

def fmt_kr_date(d: datetime) -> str:
    """KST 기준 날짜를 zero-pad 없는 한국식 표기로. 원본 toLocaleDateString('ko-KR')과 동치.
    f-string으로 직접 포맷해 strftime의 %-m / %#m 같은 플랫폼 차이를 피한다."""
    kd = d.astimezone(KST)
    return f"{kd.year}. {kd.month}. {kd.day}."

def fit_font_size(text: str, max_w: float, max_h: float) -> float:
    """영역 (max_w, max_h)에 들어가는 가장 큰 폰트 크기.
    수직은 cap-height 근사로 max_h * TEXT_HEADROOM, 수평은 stringWidth로 측정."""
    size = max_h * TEXT_HEADROOM
    if size <= 1:
        return 1.0
    width = pdfmetrics.stringWidth(text, FONT_NAME, size)
    if width > max_w:
        size = size * max_w / width
    return max(1.0, size)

def _load_bg_image(bg_bytes: bytes, mime: str) -> ImageReader:
    """배경 이미지를 신뢰된 MIME과 함께 검증·정규화한 뒤 ImageReader로 변환.
    Pillow 통과로 EXIF/메타데이터 제거 + RGB 변환."""
    if mime not in ALLOWED_IMAGE_MIMES:
        raise ValueError(f"unsupported_image_mime:{mime}")
    img = Image.open(io.BytesIO(bg_bytes))
    img.load()                          # 매직 바이트 검증 (잘못된 파일은 여기서 raise)
    if img.mode != "RGB":
        img = img.convert("RGB")
    return ImageReader(img)

def issue_pdf(
    log_id: UUID, cert: Certificate, user: User, bg_bytes: bytes, bg_mime: str,
) -> tuple[bytes, list[dict]]:
    """발급 트랜잭션의 PDF 합성 단계 (§5.5의 step). 순수 함수."""
    content: dict = cert.content        # JSONB → dict
    orientation: Orientation = content["orientation"]
    page_w, page_h = page_size(orientation)

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(page_w, page_h))

    # 배경 이미지: 비율 유지하며 페이지에 맞춤(원본 PDFKit의 fit과 동치).
    c.drawImage(
        _load_bg_image(bg_bytes, bg_mime),
        0, 0, width=page_w, height=page_h,
        preserveAspectRatio=True, anchor="c", mask="auto",
    )

    # 텍스트: {{Name}} / {{IssueDate}} / {{PrintDate}} 치환 + 좌상단 → baseline 변환.
    print_date = fmt_kr_date(datetime.now(tz=KST))
    issue_date = fmt_kr_date(cert.issued_at)
    for t in content["texts"]:
        text = (t["data"]
                .replace("{{Name}}", user.name)
                .replace("{{IssueDate}}", issue_date)
                .replace("{{PrintDate}}", print_date))
        # 헬퍼: 크기는 scale_size, baseline은 top_left_baseline_to_reportlab — y 플립 누락 불가능.
        w_px, h_px = scale_size(t["width"], t["height"], orientation)
        font_size = fit_font_size(text, w_px, h_px)
        x, baseline_y = top_left_baseline_to_reportlab(
            t["left"], t["top"], font_size, orientation,
        )
        c.setFont(FONT_NAME, font_size)
        c.drawCentredString(x + w_px / 2, baseline_y, text)

    # QR: ECC=Q + 명시적 box_size로 작은 rect에서도 스캔 가능 보장.
    qr_url = f"{settings.BASE_URL}/validate/{log_id}"
    qr = qrcode.QRCode(
        version=None,                                       # 자동 결정
        error_correction=qrcode.constants.ERROR_CORRECT_Q,  # ~25% — 인쇄 손상에 강함
        box_size=10, border=2,
    )
    qr.add_data(qr_url)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    qr_reader = ImageReader(qr_img)

    MIN_QR_PT = 60.0    # 36자 URL × ECC=Q × ~25mm @ 600dpi 기준 스캔 가능 최저
    warnings: list[dict] = []
    for r in content["rects"]:
        x, y_bl, w, h = top_left_rect_to_reportlab(
            r["left"], r["top"], r["width"], r["height"], orientation,
        )
        if min(w, h) < MIN_QR_PT:
            # 너무 작아도 차단하지 않고 MIN_QR_PT로 강제 확대(스캔 가능성 보장).
            # 호출자(§5.5)가 warnings를 받아서 audit_log에 박는다 — 순수 함수 유지.
            warnings.append({"code": "qr_too_small_clamped", "w_orig": w, "h_orig": h})
            w, h = MIN_QR_PT, MIN_QR_PT
        c.drawImage(qr_reader, x, y_bl, width=w, height=h)

    c.showPage()
    c.save()
    return buf.getvalue(), warnings   # bytes, warnings 튜플 반환
```

> **단일 라인 한정**: `drawCentredString`은 줄바꿈 미지원. 필요하면 `reportlab.platypus.Frame + Paragraph`로 교체.
> **Orientation 타입 검증**: `Literal["landscape","portrait"]` 덕에 잘못된 값은 Pydantic 단에서 422로 차단된다.
> **순수 함수 유지**: `issue_pdf`는 DB·audit log·전역 상태에 접근하지 않는다. QR이 너무 작으면 차단 대신 **MIN_QR_PT로 clamp**해서 스캔 가능성을 보장하고, warnings를 호출자에게 반환한다(§5.5에서 audit_log로 박음).

### 5.4.1 S3 헬퍼 계약 (`apps/api/app/services/s3.py`)

| 함수 | 시그니처 | 의미 |
|------|---------|------|
| `s3_get(key, *, return_metadata=None)` | `→ bytes` 또는 `→ (bytes, str)` | 객체 GET. `return_metadata="x-amz-meta-XXX"` 지정 시 `(body_bytes, metadata_value)` 튜플 반환. **metadata 키 부재 시 raise `MissingS3Metadata` (HTTPException 500 `internal_error`로 매핑)** — fallback 없음. 신규 업로드는 §4.2.1에서 항상 metadata를 박으므로 metadata 부재는 (a) 레거시 객체이거나 (b) 외부 도구가 metadata 없이 PUT한 비정상 상태. (a)는 plan.md §5의 backfill 스크립트로 컷오버 전 일괄 처리. 객체 자체 부재 → `HTTPException(404, "image_not_found")` |
| `s3_put(key, body, *, content_type, metadata=None)` | `→ None` | 객체 PUT. `metadata=dict`로 `x-amz-meta-*` 일괄 세팅 (§4.2.1에서 신뢰된 MIME 박을 때 사용) |
| `s3_delete(key)` | `→ None` | 객체 DELETE. NoSuchKey도 정상 종료 (idempotent) |
| `s3_presign(key, *, expires)` | `→ str` | GET용 presigned URL. `expires` 초 단위. SigV4 host는 `AWS_S3_PUBLIC_ENDPOINT or AWS_S3_ENDPOINT or AWS 기본`을 사용하는 별도 client에서 서명 (§7.1) |

내부적으로 boto3 client 2개 보유 (§7.1: 내부 PUT/GET용 vs presign 전용). 외부 호출자는 위 4개 함수만 사용.

### 5.5 발급 트랜잭션

```python
# apps/api/app/services/issue.py
from uuid import uuid4
from fastapi import HTTPException
from sqlalchemy import delete                  # presign 실패 보상 롤백용
from app.config import settings
from app.models import CertificateLog
from app.services.pdf import issue_pdf
from app.services.s3 import s3_get, s3_put, s3_delete, s3_presign
from app.services.audit import audit_log
from app.services.cleanup import enqueue_cleanup   # 모듈 정의는 §9.5.5

async def issue_certificate(db, cert, user) -> str:
    """
    Returns: presigned PDF URL. Raises HTTPException on failure.

    순서:
      1. 사전 가드(미만료, user_ids 포함) — §4.2.2 (라우트에서 이미 검증)
      2. log_id 선생성 (QR URL에 박을 ID)
      3. 배경 이미지 + 신뢰된 MIME을 S3에서 GET
      4. PDF 합성 (CPU bound)
      5. S3 PUT — 실패 시 raise (DB 무손상)
      6. CertificateLog INSERT (스냅샷 포함) — 실패 시 S3 보상 삭제
      7. presigned URL 생성 (실패 시 전체 보상 롤백 + presign_failed 응답)
    """
    log_id = uuid4()

    # 3. 배경 이미지 + 신뢰된 MIME
    bg_bytes, bg_mime = await s3_get(
        f"certs/images/{cert.content['image']['data']}",
        return_metadata="x-amz-meta-content-type",  # §4.5에서 저장한 신뢰된 MIME
    )

    # 4. PDF 합성. warnings는 audit log로 남기되 차단하지 않음(§5.4).
    pdf_bytes, pdf_warnings = issue_pdf(log_id, cert, user, bg_bytes, bg_mime)

    # 5. S3 업로드 — 실패 시 그대로 raise. DB는 아직 안 건드림.
    pdf_key = f"certs/issued/{log_id}.pdf"
    await s3_put(pdf_key, pdf_bytes, content_type="application/pdf")

    # 6. CertificateLog INSERT (스냅샷 포함). 실패 시 S3 보상.
    try:
        async with db.begin():
            db.add(CertificateLog(
                id=log_id,
                certificate_id=cert.id, user_id=user.id,
                user_name=user.name, user_email=user.email,
                certificate_name=cert.name,
                certificate_issued_at=cert.issued_at,
                certificate_expires_at=cert.expires_at,
                pdf_key=pdf_key,
            ))
    except Exception as e:
        # 보상: orphan PDF 정리. 정리 실패는 cleanup queue.
        try:
            await s3_delete(pdf_key)
        except Exception as ce:
            await audit_log("orphan_pdf_cleanup_failed", success=False, target_type="log",
                            target_id=log_id, error_code=str(ce), pdf_key=pdf_key)
            await enqueue_cleanup(key=pdf_key)
        await audit_log("issue_db_failed", success=False, target_type="cert",
                        target_id=cert.id, error_code=type(e).__name__)
        raise

    # 7. presigned URL 생성 — 실패 시 전체 보상(log + S3 PDF) 후 503 응답.
    #    SigV4 presign은 로컬 서명 호출이므로 실패는 거의 항상 설정/credentials 버그.
    #    presign이 실패하면 사용자에게 "발급 안 됨"으로 응답해 재시도가 깨끗하게 동작하도록.
    try:
        url = await s3_presign(pdf_key, expires=settings.AWS_S3_PRESIGN_EXPIRES)
    except Exception as e:
        # 보상: DB log + S3 PDF 둘 다 제거. 실패 시 cleanup queue.
        try:
            async with db.begin():
                await db.execute(delete(CertificateLog).where(CertificateLog.id == log_id))
        except Exception as ce:
            await audit_log("issue_log_rollback_failed", success=False, target_type="log",
                            target_id=log_id, error_code=str(ce))
        try:
            await s3_delete(pdf_key)
        except Exception:
            await enqueue_cleanup(key=pdf_key)
        await audit_log("presign_failed", success=False, target_type="log",
                        target_id=log_id, error_code=type(e).__name__)
        raise HTTPException(503, "presign_failed")

    # 성공 audit log + warnings flush. actor_id/request_id/ip/ua는 ContextVar에서 자동 수집(§8.2.1).
    await audit_log("issue_success", success=True, target_type="log", target_id=log_id,
                    cert_id=cert.id, warnings=pdf_warnings)
    return url
```

**불변식**:
- "검증은 유효하지만 PDF가 없는" 상태가 생길 수 없다 (S3 PUT 성공 후에만 DB INSERT).
- "검증은 없는데 S3에 orphan PDF가 떠다니는" 상태도 보상 삭제 또는 cleanup queue로 끝까지 회수한다.
- presign 실패 시에도 log row와 S3 PDF 둘 다 보상 롤백 → 사용자는 깨끗하게 재시도 가능 (`503 presign_failed`).
- 모든 실패/성공은 audit log 1줄을 남긴다 (§8.2).
- presigned TTL은 환경 변수 `settings.AWS_S3_PRESIGN_EXPIRES`로 단일 출처. §4.2.2의 "5분"은 기본값이지 하드코드가 아니다.

#### `enqueue_cleanup`

orphan S3 객체를 추후 청소하기 위한 큐. `apps/api/app/services/cleanup.py`에 정의. 백킹 스토어 결정은 §9.5 — 가장 간단한 구현은 `pending_s3_cleanups(key TEXT, created_at TIMESTAMPTZ)` 테이블에 INSERT + 주기적 sweep job. 큐 자체 INSERT도 실패하면 stdout audit log 1줄로 한정(추가 재시도 불가).

---

## 6. Frontend

### 6.1 디렉토리
```
apps/web/
├── index.html
├── vite.config.ts            # @vitejs/plugin-react, vite-plugin-svgr, @tailwindcss/vite
├── src/
│   ├── main.tsx              # QueryClientProvider, RouterProvider
│   ├── router.tsx            # createBrowserRouter
│   ├── api/                  # fetch wrappers (credentials: "include")
│   │   ├── client.ts
│   │   ├── certs.ts
│   │   └── users.ts
│   ├── auth/
│   │   ├── AuthProvider.tsx
│   │   └── RequireAuth.tsx
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Unregistered.tsx
│   │   ├── Home.tsx          # 본인 증명서 목록
│   │   ├── CertIssue.tsx     # /certs/:id
│   │   ├── Validate.tsx      # /validate/:logId
│   │   └── admin/
│   │       ├── Layout.tsx
│   │       ├── Dashboard.tsx
│   │       ├── Users.tsx
│   │       ├── Groups.tsx
│   │       ├── Certs.tsx           # 목록 + 삭제
│   │       ├── CertEdit.tsx        # /admin/certs/:id 메타데이터·expires_at 편집
│   │       └── CertNew/
│   │           ├── index.tsx           # matchMedia 가드 + CertNewForm 마운트
│   │           ├── CertNewForm.tsx     # 데스크탑 본체
│   │           ├── MobileBlocked.tsx   # 모바일 차단 안내
│   │           ├── CanvasForm.tsx      # Fabric.js, 원본 거의 그대로
│   │           ├── FileForm.tsx
│   │           └── UserForm.tsx
│   ├── components/
│   │   ├── CertPreview.tsx
│   │   ├── Pagination.tsx          # totalpages<=1 → null; page clamp
│   │   └── UserButton.tsx
│   ├── hooks/
│   │   ├── useDisclosure.ts
│   │   ├── useMediaQuery.ts        # matchMedia 래퍼 (§6.4 모바일 가드용)
│   │   └── useOutsideClick.ts
│   ├── lib/
│   │   ├── debounce.ts
│   │   ├── debounceFabric.ts
│   │   └── dataURI.ts
│   ├── types/                # backend Pydantic과 1:1
│   │   ├── content.ts
│   │   ├── user.ts
│   │   └── cert.ts
│   └── styles/index.css      # @import "tailwindcss"; + @theme { ... }  (Tailwind 4)
```

### 6.2 라우트 표
| 경로 | 가드 | 페이지 |
|------|------|--------|
| `/login` | 공개 (이미 로그인 시 `/`로 redirect) | `Login` (Google 버튼) |
| `/unregistered` | 공개 | `Unregistered` (OAuth 콜백 분기에서 보통 도달; 직접 URL도 허용, 페이지 자체는 민감 정보 없음) |
| `/` | 로그인 | `Home` (`GET /certs/me`) |
| `/certs/:id` | 로그인 + `user_ids` 포함 (서버에서 403) | `CertIssue` (발급 버튼) |
| `/validate/:logId` | 공개 (`/auth/me` 호출 안 함) | `Validate` |
| `/admin` | Admin | `Dashboard` |
| `/admin/users` | Admin | `Users` |
| `/admin/groups` | Admin | `Groups` |
| `/admin/certs` | Admin | `Certs` (목록·삭제) |
| `/admin/certs/:id` | Admin | `CertEdit` (메타데이터/`expires_at` 편집, PUT) |
| `/admin/certs/new` | Admin + PC (matchMedia JS 가드) | `CertNew` (캔버스 디자이너) |

**공개 라우트 정책**: `Login`, `Unregistered`, `Validate`는 `AuthProvider`의 `/api/auth/me` 호출 자체를 건너뛴다(§6.5). 그러지 않으면 미인증 사용자가 `/login`에 도달했을 때 401 → redirect → 다시 `/login` 무한 루프.

### 6.3 Tailwind 4 셋업
- 의존성: `tailwindcss@^4`, `@tailwindcss/vite@^4` (PostCSS·`autoprefixer` 불필요).
- `vite.config.ts`:
  ```ts
  import { defineConfig } from "vite";
  import react from "@vitejs/plugin-react";
  import svgr from "vite-plugin-svgr";
  import tailwind from "@tailwindcss/vite";
  export default defineConfig({ plugins: [react(), svgr(), tailwind()] });
  ```
- `src/styles/index.css`:
  ```css
  @import "tailwindcss";
  @theme {
    --font-sans: "Pretendard Variable", system-ui, sans-serif;
    /* 필요 시 커스텀 컬러/스페이싱 추가 */
  }
  ```
- v3 `tailwind.config.js`/`postcss.config.js`/`@tailwind base/components/utilities` 모두 폐기.

### 6.4 캔버스 디자이너 + 모바일 가드
- 원본 [CanvasForm.tsx](<../src/app/(full)/admin/certs/new/(forms)/CanvasForm.tsx>)를 Vite로 이식. 변경점:
  - `import { Canvas, ... } from "fabric"` 동일.
  - `next/image` 제거 → `<img>` 또는 Vite asset.
  - 좌표/스케일 정규화 로직 동일.
- 결과 페이로드는 `CertContent` 그대로. `image.data`는 **클라이언트가 Data URI로 보냄 → BE가 §4.2.1 절차로 S3에 올리고 키로 치환**.

**모바일 가드는 CSS가 아닌 JS로**:
```tsx
// /admin/certs/new 페이지 최상단
const isDesktop = useMediaQuery("(min-width: 768px) and (pointer: fine)");
if (!isDesktop) return <MobileBlocked />;
return <CertNewForm users={users} />;
```
원본은 `<div className="hidden md:block">`로만 가렸기 때문에 Fabric.js가 invisible canvas에 마운트되어 모바일에서 메모리 낭비/touch glitch가 발생. JS 가드는 컴포넌트 자체를 mount 안 함.

### 6.5 인증/권한 가드 (`RequireAuth`)

핵심 원칙:
1. **401은 *상태*이지 *redirect 트리거가 아니다*** — `useQuery(["me"])`의 401은 "비로그인"으로 해석할 뿐. 어떤 fetch 콜백에서도 `/login`으로 직접 navigate하지 않는다.
2. **`RequireAuth`만 navigate** — 현재 경로가 이미 공개 라우트(`/login`, `/unregistered`, `/validate/...`)면 navigate 안 함(이미 도달했으니 무한 루프 방지).
3. **`AuthProvider`는 공개 라우트에서 `/auth/me`를 호출 자체를 건너뛴다** — 401 응답 자체가 생성되지 않게.

```tsx
// auth/AuthProvider.tsx
const PUBLIC_PREFIXES = ["/login", "/unregistered", "/validate"] as const;
const isPublic = (path: string) =>
  PUBLIC_PREFIXES.some(p => path === p || path.startsWith(p + "/"));
//   ↑ "/validate"(끝 슬래시 없음), "/validate/abc", "/login", "/login/" 모두 커버.

export function AuthProvider({ children }: PropsWithChildren) {
  const { pathname } = useLocation();
  const skip = isPublic(pathname);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => apiClient.get<MeOut>("/auth/me"),
    enabled: !skip,                              // public 경로에서는 호출조차 안 함
    retry: false,
    throwOnError: false,                         // 401은 onError로 흘리지 않고 isError로 표시
  });
  // user = me.data ?? null (401/네트워크 실패는 둘 다 null로 통일).
  // loading = !skip && me.isLoading.
  // redirect 결정은 RequireAuth 전담 (§6.5 본문).
}

// auth/RequireAuth.tsx
// 라우터 설정상 Login/Unregistered/Validate 라우트는 RequireAuth 밖에 둔다.
// 따라서 여기서 location.pathname === "/login" 같은 belt-and-suspenders 분기는 두지 않는다.
export function RequireAuth({ admin = false, children }: { admin?: boolean; children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (admin && !user.is_admin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
```

### 6.6 API 클라이언트

```ts
// api/client.ts
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/api${path}`, {
    method,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "fetch",     // CSRF 가드 (§8). 헤더 자체가 cross-site 요청을 막음
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, detail.detail);
  }
  return res.status === 204 ? (undefined as T) : await res.json();
}

export class ApiError extends Error {
  constructor(public status: number, public detail: string | unknown[]) {
    super(typeof detail === "string" ? detail : "validation_error");
  }
}
```

- 모든 fetch는 `credentials: "include"` + `X-Requested-With: fetch` 헤더 (CSRF 기본 차단).
- **자동 navigate 없음** — `useMutation`/`useQuery`의 `onError`는 토스트만 띄움. redirect는 `RequireAuth`가 결정.
- React Query 키 컨벤션 + invalidate 매트릭스:

| Mutation | invalidate keys |
|----------|----------------|
| POST `/certs` | `["certs"]`, `["dashboard"]` |
| PUT `/certs/{id}` | `["certs"]`, `["certs", id]` |
| DELETE `/certs/{id}` | `["certs"]`, `["dashboard"]` |
| POST `/certs/{id}/issue` | `["certs", id, "logs"]`, `["certs", "me"]`, `["dashboard"]` |
| POST `/users` | `["users"]`, `["dashboard"]` |
| PUT `/users/{id}` | `["users"]`, `["users", id]` |
| DELETE `/users/{id}` | `["users"]`, `["dashboard"]` |
| POST `/users/file` | `["users"]`, `["dashboard"]` |
| POST `/groups` | `["groups"]`, `["dashboard"]` |
| PUT `/groups/{id}` | `["groups"]`, 영향받은 사용자들의 `["users"]` |
| DELETE `/groups/{id}` | `["groups"]`, `["users"]`(멤버십 변동), `["dashboard"]` |

### 6.7 IssueButton 패턴

**Popup blocker 회피**: `window.open`은 user gesture 동기 호출에서만 허용됨. async mutation의 `onSuccess`에서 호출하면 Safari/Chrome이 차단함. 해결: 클릭 시점에 빈 탭을 먼저 열고, mutation 성공 후 `location.href`로 채워 넣는다.

```tsx
// pages/CertIssue.tsx
const qc = useQueryClient();
const mutation = useMutation({
  mutationFn: () => apiClient.post<IssueOut>(`/certs/${id}/issue`),
});

const handleClick = () => {
  // 1) 클릭 동기 컨텍스트에서 빈 탭 open (popup blocker 통과)
  const w = window.open("about:blank", "_blank", "noopener,noreferrer");
  if (!w) { toast.error("팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요."); return; }
  // 2) 백엔드 호출
  mutation.mutate(undefined, {
    onSuccess: (data) => {
      w.location.href = data.url;
      qc.invalidateQueries({ queryKey: ["certs", id, "logs"] });
      qc.invalidateQueries({ queryKey: ["certs", "me"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("발급 완료.");
    },
    onError: (e: ApiError) => {
      w.close();
      toast.error(e.detail || "발급 실패");
    },
  });
};
return <button onClick={handleClick} disabled={mutation.isPending}>발급하기</button>;
```

원본의 `a.href = data.url; a.click()`은 같은 탭을 떠나서 SPA 상태가 사라졌다. 빈 탭 사전 open + invalidate로 두 문제 모두 해결, popup blocker도 회피.

### 6.8 CertNew Form 패턴

원본은 `console.log(result)` 후 무조건 `window.location.href`로 전환 — 실패 시에도 성공처럼 이동.

```tsx
const mutation = useMutation({
  mutationFn: (payload: CertCreate) => apiClient.post<CertOut>("/certs", payload),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ["certs"] });
    navigate("/admin/certs");
  },
  onError: (e: ApiError) => setError(typeof e.detail === "string" ? e.detail : "검증 실패"),
});
```

- **검증을 클라이언트에서도 한 번** (`name`/`issued_at`/`description`/이미지/텍스트/사용자 모두 필수 — 빈 값이면 mutation 실행 안 함).
- 실패 시 canvas 상태 보존 + 인라인 에러 메시지.
- 성공 시 `navigate` (react-router), `window.location` 사용 금지.
- `alert()` 금지 — 토스트 또는 인라인 메시지.

### 6.9 Pagination 컨트랙트

**Rules of Hooks**: useEffect는 early return 이전에. 그렇지 않으면 totalpages가 1↔2를 넘나들 때 render 간 hook 개수가 바뀌어 React가 throw.

```tsx
function Pagination({ page, setPage, total, perPage = 10 }: Props) {
  const totalpages = Math.ceil(total / perPage);

  // 모든 hook은 어떤 early return보다도 위.
  useEffect(() => {
    if (totalpages >= 1 && page > totalpages) setPage(totalpages);
  }, [page, totalpages, setPage]);

  if (totalpages <= 1) return null;                   // 0건/1페이지면 렌더 안 함
  // ... 페이지 번호 렌더링
}
```

- `total === 0` 또는 `total <= perPage` → 렌더 안 함.
- `page > totalpages`(데이터 줄어든 경우) → useEffect로 clamp.
- 우측 화살표 disabled 조건: `endPage === totalpages || totalpages === 0` (원본은 후자 누락).
- `setPage`도 deps 배열에 포함 (exhaustive-deps 린트 준수).

---

## 7. 환경 변수

### 7.1 Backend (`apps/api/.env`)
```env
ENV=dev                              # dev | prod
DATABASE_URL=postgresql+asyncpg://cert:cert@localhost:5432/cert_db
BASE_URL=http://localhost:5173       # FE 도메인 (QR/리디렉트용)
API_BASE_URL=http://localhost:8000   # BE 자기 자신
SESSION_SECRET=<openssl rand -hex 32>
SESSION_COOKIE_NAME=cert_session
SESSION_COOKIE_DOMAIN=               # prod에서만 설정
DEFAULT_ADMIN_EMAIL=admin@outta.ai

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8000/api/auth/google/callback

AWS_REGION=ap-northeast-2
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET_NAME=outta-certs
AWS_S3_ENDPOINT=                     # 내부 endpoint (컨테이너 내부에서 S3 호출용). MinIO/MinIO-호환만 채움
AWS_S3_PUBLIC_ENDPOINT=              # 브라우저가 presigned URL을 풀 endpoint. 비우면 AWS_S3_ENDPOINT 재사용
                                     # 로컬: AWS_S3_ENDPOINT=http://minio:9000, AWS_S3_PUBLIC_ENDPOINT=http://localhost:9000
AWS_S3_PRESIGN_EXPIRES=300           # seconds (원본 60에서 상향, 최대 604800 = 7일)

# 관찰성
LOG_LEVEL=info                       # debug | info | warning | error
SENTRY_DSN=                          # 비우면 비활성
```

Pydantic Settings로 로드. **`.env`에 선언한 키는 모두 클래스에도 존재해야 한다**(누락 시 코드에서 못 읽음). 미사용 키가 섞일 가능성에 대비해 `extra="ignore"`도 명시.

```python
from typing import Literal
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    ENV: Literal["dev", "prod"] = "dev"
    DATABASE_URL: str
    BASE_URL: str
    API_BASE_URL: str
    SESSION_SECRET: str
    SESSION_COOKIE_NAME: str = "cert_session"
    SESSION_COOKIE_DOMAIN: str | None = None        # prod에서만 채움
    DEFAULT_ADMIN_EMAIL: str
    GOOGLE_CLIENT_ID: str
    GOOGLE_CLIENT_SECRET: str
    GOOGLE_REDIRECT_URI: str
    AWS_REGION: str
    AWS_ACCESS_KEY_ID: str
    AWS_SECRET_ACCESS_KEY: str
    AWS_S3_BUCKET_NAME: str
    AWS_S3_ENDPOINT: str | None = None              # 내부 endpoint
    AWS_S3_PUBLIC_ENDPOINT: str | None = None       # presigned 발급용 (None이면 AWS_S3_ENDPOINT 사용)
    AWS_S3_PRESIGN_EXPIRES: int = 300

    LOG_LEVEL: Literal["debug", "info", "warning", "error"] = "info"
    SENTRY_DSN: str | None = None
```

**MinIO dev 보강**: boto3 client 2개를 만든다 — 하나는 `endpoint_url=AWS_S3_ENDPOINT`(내부 PUT/GET), 다른 하나는 `endpoint_url=AWS_S3_PUBLIC_ENDPOINT or AWS_S3_ENDPOINT`(`generate_presigned_url` 전용). SigV4는 host header를 서명에 포함하므로 사후에 URL string-replace로 host를 바꿀 수 없다 — 발급 시점에 올바른 endpoint를 써야 한다.

### 7.2 Frontend (`apps/web/.env`)
```env
VITE_API_BASE_URL=http://localhost:8000
```
운영에서는 동일 도메인에 reverse proxy(`/api/*` → BE)하면 환경 변수 자체가 필요 없다.

---

## 8. 보안

| 항목 | 정책 |
|------|------|
| 세션 쿠키 | `httpOnly`, `Path=/`, `Secure`(prod만), **`SameSite=Lax` (prod 포함)**. `Domain`은 `SESSION_COOKIE_DOMAIN`이 설정된 경우만. Strict는 OAuth 콜백을 깨뜨리므로 사용하지 않음 — CSRF는 §8.1로 보완 |
| OAuth | `email_verified` 강제 (§3.1 step 4). state/nonce 검증 Authlib에 위임 + 콜백 라우트에서 명시. `google_id` 무조건 덮어쓰기 금지 |
| 이메일 매칭 | 전 구간 `.lower()` 정규화. DB 컬럼에 `CHECK (email = lower(email))` |
| 입력 검증 | Pydantic 모델만 받음. `EmailStr`, UUID는 Path/Query 타입 힌트. `groups`/`group_ids`는 사전 존재 확인 |
| 권한 가드 | `Depends(require_admin)`. 자기 자신 demote/delete 금지, 마지막 Admin 보호 (§4.3.1) |
| CSRF | (a) `SameSite=Lax` + (b) 모든 변경(POST/PUT/DELETE) 라우트에서 `Origin` 또는 `Referer` allowlist 검증 + (c) 클라이언트가 `X-Requested-With: fetch` 헤더 동봉(브라우저는 cross-site에서 커스텀 헤더 보낼 때 preflight 필요 → CORS로 차단) |
| CORS | dev: `http://localhost:5173` 허용. prod: 동일 도메인이면 비활성. Allow-Credentials만 켜고 Origin 화이트리스트는 정확 매칭 |
| 이미지 MIME | 화이트리스트 `{image/png, image/jpeg, image/webp}`. 매직 바이트 검증(Pillow). EXIF 제거. 다운로드 시 신뢰된 MIME echo + `X-Content-Type-Options: nosniff` (§4.5) |
| CSP | `default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; connect-src 'self' <S3 PUBLIC>` |
| 비밀 키 | 모두 환경 변수. AWS Secrets Manager / Doppler 권장. 코드/로그에 echo 금지 |
| Admin 부트스트랩 | `DEFAULT_ADMIN_EMAIL`은 운영 전환 후 일반 사용자처럼 등록하고 환경 변수에서 제거 |
| S3 | 버킷은 비공개. 모든 다운로드는 BE 프록시 또는 presigned URL |
| Rate limit (slowapi) | `/auth/google/login`: 10/min/IP. `/auth/google/callback`: 20/min/IP. `/certs/{id}/issue`: 5/min/user. `/validate/{id}`: 30/min/IP. `/images/{key}`: 60/min/IP |
| 로깅 | 발급/삭제/Admin 변경은 audit log 1줄. 스키마는 §8.2 |

### 8.1 CSRF 미들웨어 — 구체

**적용 방식 단일화**: `BaseHTTPMiddleware`로 전역 등록. `Depends`로 라우트마다 부착하는 패턴은 신규 라우트 추가 시 누락 위험이 있어 사용하지 않음.

```python
# apps/api/app/middleware/csrf.py
from urllib.parse import urlparse
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app.config import settings

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

class CsrfMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method in SAFE_METHODS:
            return await call_next(request)
        # Origin / Referer allowlist
        origin = request.headers.get("origin") or request.headers.get("referer")
        if not origin:
            return JSONResponse({"detail": "missing_origin"}, status_code=403)
        host = urlparse(origin).netloc
        allowed = {urlparse(settings.BASE_URL).netloc}
        if settings.ENV == "dev":
            allowed |= {f"localhost:{p}" for p in (5173, 8000)}
        if host not in allowed:
            return JSONResponse({"detail": "origin_mismatch"}, status_code=403)
        # 클라이언트 fetch 헤더 강제 (cross-site 커스텀 헤더는 CORS preflight 필요 → 차단)
        if request.headers.get("x-requested-with") != "fetch":
            return JSONResponse({"detail": "missing_csrf_header"}, status_code=403)
        return await call_next(request)

# main.py에서
# app.add_middleware(CsrfMiddleware)
```

라우터 정의 시 추가 작업 없음 — 신규 변경 라우트는 자동으로 보호된다.

### 8.3 CSP 미들웨어

CSP 헤더는 전역 미들웨어가 set. `<S3 PUBLIC>` placeholder는 settings로 치환.

```python
# apps/api/app/middleware/security_headers.py
from app.config import settings

def _csp() -> str:
    s3 = settings.AWS_S3_PUBLIC_ENDPOINT or settings.AWS_S3_ENDPOINT or "https://*.s3.amazonaws.com"
    return "; ".join([
        "default-src 'self'",
        f"img-src 'self' data: {s3}",          # 배경 이미지 미리보기 + S3 직접 fetch 허용
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",   # Pretendard CDN
        f"connect-src 'self' {s3}",            # presigned PDF fetch (window.open 대신 a[download] 패턴 시)
        "frame-ancestors 'none'",
        "base-uri 'self'",
    ])

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        resp = await call_next(request)
        resp.headers["Content-Security-Policy"] = _csp()
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        resp.headers["X-Frame-Options"] = "DENY"
        return resp

# main.py
# app.add_middleware(SecurityHeadersMiddleware)
```

이 미들웨어가 §4.5의 `X-Content-Type-Options: nosniff`도 일괄 박는다 (라우트별로 따로 set할 필요 없음).

### 8.2 Audit log — 스키마 + 헬퍼 + 트랜잭션 정책

**스키마**: §2.2의 `AuditLog` SQLAlchemy 모델 참조. SQL DDL은 Alembic이 모델로부터 autogenerate.

#### 8.2.1 audit_log() 헬퍼 시그니처

```python
# apps/api/app/services/audit.py
from contextvars import ContextVar
from datetime import datetime
from uuid import UUID, uuid4
from sqlalchemy.ext.asyncio import async_sessionmaker

# 요청 단위 컨텍스트: §9.5 RequestIDMiddleware가 채운다.
request_id_var: ContextVar[str] = ContextVar("request_id", default="")
actor_id_var:   ContextVar[UUID | None] = ContextVar("actor_id",   default=None)
ip_var:         ContextVar[str | None]  = ContextVar("ip",         default=None)
ua_var:         ContextVar[str | None]  = ContextVar("ua",         default=None)

# 별도 세션 팩토리 — 비즈니스 트랜잭션과 분리.
audit_session_maker: async_sessionmaker  # main.py에서 주입

async def audit_log(
    action: str,
    *,
    success: bool = True,
    target_type: str | None = None,
    target_id: UUID | None = None,
    error_code: str | None = None,
    **meta,                                # 그 외 키는 모두 JSONB meta 컬럼으로 직렬화
) -> None:
    """
    Best-effort fire-and-forget audit log. 자체 트랜잭션, 자체 세션.
    비즈니스 트랜잭션 롤백이 audit log를 함께 롤백하지 않는다 — 실패 사실도 보존되어야 함.

    request_id / actor_id / ip / ua는 ContextVar에서 자동 수집 (§9.5 미들웨어가 set).
    실패 시 stdout에 fallback 1줄 출력하고 raise하지 않음.
    """
    row = AuditLog(
        id=uuid4(),
        request_id=request_id_var.get(),
        actor_id=actor_id_var.get(),
        action=action,
        target_type=target_type,
        target_id=target_id,
        ip=ip_var.get(),
        ua=ua_var.get(),
        success=success,
        error_code=error_code,
        meta=meta or {},
    )
    # 1) stdout JSON 1줄 — DB 실패와 무관하게 항상 emit (§9.5.1).
    log.info(
        "audit",
        action=action, success=success,
        target_type=target_type, target_id=str(target_id) if target_id else None,
        error_code=error_code,
        request_id=row.request_id, actor_id=str(row.actor_id) if row.actor_id else None,
        ip=row.ip, ua=row.ua, meta=row.meta,
    )
    # 2) DB row — 비즈니스 트랜잭션과 분리된 자체 세션.
    try:
        async with audit_session_maker() as session, session.begin():
            session.add(row)
    except Exception as e:
        # DB 실패 → stdout에 한 줄 더(구분 가능한 action 이름), raise 안 함.
        log.error("audit_log_db_failed", action=action, error=str(e))
```

#### 8.2.2 트랜잭션 정책

**모든 audit_log() 호출은 비즈니스 트랜잭션과 *분리된* 자체 세션·자체 트랜잭션을 쓴다 (best-effort)**.

근거:
- 비즈니스 실패도 감사 대상 — 비즈니스 트랜잭션 롤백에 audit가 함께 휘말리면 실패 흔적이 사라진다.
- 비즈니스 성공은 audit 실패와 무관하게 사용자 응답을 막지 않아야 한다.

호출 사이트가 자동으로 `success`를 결정하지 못하는 경우(예: §5.4 `qr_too_small_clamped` 같은 비기능적 경고)는 `success=True` + `meta`에 warning 사유 박는다.

호출 사이트 일람:
| 위치 | action | success | target_type/id |
|------|--------|---------|----------------|
| §5.5 issue success | `issue_success` | True | log / log_id |
| §5.5 issue_db_failed | `issue_db_failed` | False | cert / cert.id |
| §5.5 orphan_pdf_cleanup_failed | `orphan_pdf_cleanup_failed` | False | log / log_id |
| §5.5 presign_failed | `presign_failed` | False | log / log_id |
| §5.5 issue_log_rollback_failed | `issue_log_rollback_failed` | False | log / log_id |
| §4.2.3 s3_cleanup_failed | `s3_cleanup_failed` | False | cert / cert.id |
| §4.3.2 user_deleted | `user_deleted` | True | user / user.id |
| §4.4 admin_group_protected | `admin_group_protected` | False | group / group.id |
| §3.1 step 7 google_id 거부 | `google_id_mismatch` | False | user / user.id |

> **pdf_warnings 정책**: `issue_pdf`의 warnings 리스트는 `issue_success` row의 `meta.warnings`에 한 번에 묶여 들어간다 (§5.5 `audit_log("issue_success", ..., warnings=pdf_warnings)`). per-warning 별도 audit row를 만들지 않는다 — 한 발급 = 한 audit row 원칙.

---

## 9. 배포 / 운영

### 9.1 도커 (BE)
```dockerfile
FROM python:3.11-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libfreetype6 libjpeg62-turbo curl tini \
 && rm -rf /var/lib/apt/lists/*

# uv는 .venv/에 의존성을 설치한다. 시스템 Python에는 uvicorn이 없으므로
# .venv/bin을 PATH 앞쪽에 두고 실행해야 한다.
ENV PATH="/app/.venv/bin:$PATH" \
    UV_PROJECT_ENVIRONMENT=/app/.venv

COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev

COPY app ./app
# ChosunGs.ttf 동봉
COPY data ./data
COPY alembic.ini ./
COPY migrations ./migrations
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8000

# 헬스체크 — /api/healthz (liveness)
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/api/healthz || exit 1

# tini를 PID 1로 두어 SIGTERM이 uvicorn까지 전파되도록 함 (graceful shutdown).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-graceful-shutdown", "30"]
```

**`entrypoint.sh`** (마이그레이션 옵션 분기):
```bash
#!/bin/sh
set -e
if [ "$RUN_MIGRATIONS" = "1" ]; then
  echo "Running alembic upgrade head..."
  alembic upgrade head
fi
exec "$@"
```

→ 같은 이미지로 (a) `RUN_MIGRATIONS=1` 마이그레이션 잡, (b) `RUN_MIGRATIONS=0`(기본) API 워커 두 모드 모두 가능.

### 9.1.1 헬스체크 엔드포인트 (`/api/healthz`, `/api/readyz`)

§4에는 의도적으로 표에 안 넣음 — `/api/healthz`와 `/api/readyz`는 인프라용으로 슬림 처리.

```python
# apps/api/app/routes/health.py
from fastapi import APIRouter, status
from app.services.s3 import s3_health
from app.db import engine

router = APIRouter(prefix="/api", tags=["health"])

@router.get("/healthz", status_code=200)
async def healthz():
    """liveness — 프로세스가 살아 있으면 200. 외부 의존성은 검사하지 않음."""
    return {"status": "ok"}

@router.get("/readyz")
async def readyz():
    """readiness — DB + S3 ping. 둘 다 OK면 200, 아니면 503."""
    try:
        async with engine.connect() as conn:
            await conn.scalar(text("SELECT 1"))
        await s3_health()                # head_bucket
    except Exception as e:
        return JSONResponse({"status": "not_ready", "error": str(e)}, status_code=503)
    return {"status": "ready"}
```

오케스트레이터는 LB 트래픽 라우팅용으로 `/readyz`를, 컨테이너 재시작 판단용으로 `/healthz`를 사용.

### 9.2 FE 빌드/배포
```bash
pnpm -C apps/web build       # → dist/
# Cloudflare Pages / S3+CloudFront / Nginx 정적 호스팅
```

### 9.3 docker-compose (개발)
```yaml
services:
  postgres:
    image: postgres:15
    environment: { POSTGRES_USER: cert, POSTGRES_PASSWORD: cert, POSTGRES_DB: cert_db }
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cert -d cert_db"]
      interval: 5s
      timeout: 3s
      retries: 10

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: minio, MINIO_ROOT_PASSWORD: minio12345 }
    ports: ["9000:9000", "9001:9001"]
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 10

  # 일회성 마이그레이션 잡 — api보다 먼저 끝나고 종료
  api-migrate:
    build: ./apps/api
    env_file: apps/api/.env
    environment: { RUN_MIGRATIONS: "1" }
    command: ["true"]                              # entrypoint.sh가 마이그레이션 후 exit
    depends_on:
      postgres: { condition: service_healthy }

  api:
    build: ./apps/api
    env_file: apps/api/.env
    environment: { RUN_MIGRATIONS: "0" }            # 워커는 마이그레이션 안 함
    depends_on:
      postgres: { condition: service_healthy }
      minio:    { condition: service_healthy }
      api-migrate: { condition: service_completed_successfully }
    ports: ["8000:8000"]

  web:
    image: node:20
    working_dir: /app
    command: sh -c "corepack enable && pnpm i && pnpm dev --host"
    volumes: ["./apps/web:/app"]
    ports: ["5173:5173"]
```

### 9.4 마이그레이션 정책

- **첫 리비전**: `alembic revision --autogenerate -m "init"` 이후 손으로 검수 — Pydantic 모델만으로는 표현 못 하는 부분(현재 모델은 SQLAlchemy로 모두 표현되므로 추가 작업 거의 없음).
- **운영 적용 방식**:
  - Fly.io / Render: `release_command = "alembic upgrade head"` 사용 (별도 잡, 워커 시작 전).
  - k8s: `initContainer`로 `alembic upgrade head` 실행.
  - docker-compose: §9.3의 `api-migrate` 서비스로 분리.
  - **모든 워커가 직접 `alembic upgrade head`를 동시에 호출하는 패턴은 금지** — 다수 replica의 DDL race를 회피하기 위함.
- **expand/contract 정책**: 컬럼 drop은 두 번에 나눠 배포.
  1. Release N: 코드가 그 컬럼을 쓰지 않도록 변경 + 새 코드 배포.
  2. Release N+1: 컬럼 drop 마이그레이션.
- **TIMESTAMP(3) → timestamptz 데이터 마이그레이션**: 별도 ALTER 명시 — `ALTER TABLE x ALTER COLUMN issued_at TYPE timestamptz USING (issued_at AT TIME ZONE 'UTC')`. USING 절 없으면 서버 timezone에 종속(이 부분 plan.md §5에 상세).
- **CertificateLog 스냅샷 backfill**: 레거시 CockroachDB에서 마이그레이션 시 `users`/`certificates` JOIN 결과를 NOT NULL 스냅샷 컬럼에 채워야 한다. 자세한 절차는 plan.md §5.

### 9.5 관찰성 (Observability)

#### 9.5.1 구조화 로그

`structlog` 또는 `python-json-logger`로 stdout에 JSON 1줄 (12-factor).

```python
# apps/api/app/logging.py
import logging, structlog
from app.config import settings

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, settings.LOG_LEVEL.upper())),
)
log = structlog.get_logger()
```

**`audit_log()` (§8.2)가 stdout에도 1줄을 emit**한다(DB row 외에 추가). 운영 분리 가능:
- 라이트 환경: DB만 쓰고 stdout 라인은 INFO 레벨로 기록.
- 헤비: 둘 다 별도 sink(Loki/CloudWatch/Datadog)로 보내고 DB는 audit 전용 쿼리/리텐션에 사용.

#### 9.5.2 RequestIDMiddleware

```python
# apps/api/app/middleware/request_id.py
from uuid import uuid4
from starlette.middleware.base import BaseHTTPMiddleware
from app.services.audit import request_id_var, ip_var, ua_var

class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        rid = request.headers.get("x-request-id") or uuid4().hex
        token_rid = request_id_var.set(rid)
        token_ip  = ip_var.set(request.client.host if request.client else None)
        token_ua  = ua_var.set(request.headers.get("user-agent"))
        try:
            resp = await call_next(request)
            resp.headers["X-Request-ID"] = rid
            return resp
        finally:
            request_id_var.reset(token_rid)
            ip_var.reset(token_ip)
            ua_var.reset(token_ua)
```

`actor_id_var.set(user.id)`는 인증 의존성(`current_user`)이 통과한 직후에 set한다.

#### 9.5.3 메트릭

`prometheus_fastapi_instrumentator`로 `/metrics`. 기본 카운터·히스토그램에 더해 커스텀:
- `pdf_issue_duration_seconds`: histogram, label `success`.
- `s3_call_duration_seconds`: histogram, label `op`(get/put/delete/presign).

#### 9.5.4 에러 트래킹

`SENTRY_DSN`이 채워져 있으면 `sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENV, ...)`. dev에서는 보통 빈값.

#### 9.5.5 Cleanup queue

`enqueue_cleanup(key)`의 백킹 스토어:

```python
# apps/api/app/models.py (추가)
class PendingS3Cleanup(Base):
    __tablename__ = "pending_s3_cleanups"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    attempts: Mapped[int] = mapped_column(default=0, server_default="0")

# enqueue_cleanup = INSERT 1줄.
# 별도 worker 또는 cron이 주기적으로 `s3_delete(key)` 재시도 후 row 제거.
```

가장 간단한 worker는 docker-compose에 `api-cleanup` 서비스로 추가하거나, AWS Lambda + EventBridge 5분 cron.

### 9.6 그레이스풀 종료

- `uvicorn --timeout-graceful-shutdown 30` (§9.1 CMD).
- `tini`를 PID 1로 두어 SIGTERM이 uvicorn까지 전파 (§9.1 ENTRYPOINT).
- FastAPI `lifespan`에서 in-flight 카운터를 두지 않아도 위 두 가지로 충분 — uvicorn은 30초 동안 새 요청을 받지 않고 기존 요청 완료를 기다린다.
- k8s/Fly preStop hook = `sleep 5` (LB de-registration 시간 확보).

---

## 10. 테스트

### 10.1 Backend (pytest + httpx)

**픽스처 규약**:
- 트랜잭션 롤백 DB (`pytest_asyncio` + 외부 트랜잭션 wrap).
- 스키마는 **`alembic upgrade head`로 생성** — `Base.metadata.create_all()` 금지 (§2.2 정책).
- HTTP 클라이언트: `AsyncClient(transport=ASGITransport(app=app), base_url="http://test")` (httpx 0.28+ 필수).
- S3 모킹: `moto` 5.x.
- OAuth: Authlib client 호출을 monkeypatch (`google_userinfo_fixture`로 email/email_verified/sub 주입).

**Auth & 권한**
- signin 분기:
  - default admin / 신규 사용자: 사용자 row + Admin 그룹 모두 생성됨.
  - default admin / 기존 사용자: `google_id` 신규 sub로 덮어쓰기 보장 + Admin 그룹 멤버십 보장 (idempotent).
  - default admin / 기존 사용자 + 기존 다른 sub 박혀있음: step 6 예외로 신규 sub 덮어쓰기 (admin 복구).
- email_verified=false → 401 거부.
- 이메일 케이스: `Admin@Outta.AI` 입력 / `admin@outta.ai` 등록 → 정상 매칭.
- google_id 충돌:
  - 신규 sub가 다른 user에 매핑됨 → 401 `duplicate_google_id`.
  - 기존 sub와 다른 sub → 401 `account_linked_to_different_google_identity`(default admin 아닌 경우만).
- 권한 매트릭스: 비로그인/일반/Admin × 모든 변경 라우트.

**CSRF**
- Origin 헤더 없음 → 403.
- Origin이 allowlist 외 → 403.
- `X-Requested-With: fetch` 누락 → 403.
- 모든 GET은 CSRF 가드 통과.

**Certs**
- `POST /certs`:
  - Data URI MIME 화이트리스트(`image/png/jpeg/webp` allow, `text/html` 거부, SVG 거부).
  - Pillow 매직 바이트 미일치(헤더만 image/png인데 본문은 JPEG) → 400.
  - S3 PUT 검증 (`moto`).
  - 신뢰된 MIME이 metadata에 박힘.
- `POST /certs/{id}/issue`:
  - 발급 대상이 아닌 사용자 → 403 `not_a_recipient`.
  - 만료된 cert → 410 `certificate_expired`.
  - PDF 생성 실패 → log row 미생성 + S3 PDF 없음.
  - S3 PUT 실패 → log row 미생성.
  - DB INSERT 실패 → S3 PDF 보상 삭제.
  - presign 실패 → log 보상 + S3 PDF 보상 → 503 `presign_failed`.
  - QR rect < MIN_QR_PT → MIN_QR_PT로 clamp + `pdf_warning` audit log.
  - 좌표 변환: landscape/portrait 각 케이스 (`scale_size`, `top_left_rect_to_reportlab`, `top_left_baseline_to_reportlab`). (0,0) → reportlab bottom-left, (1024, 720) → top-right(landscape) 등.
  - QR URL이 `settings.BASE_URL`로 시작.
  - presigned URL의 host가 `AWS_S3_PUBLIC_ENDPOINT`에서 옴.
- `PUT /certs/{id}`:
  - `expires_at_clear=True` → expires_at NULL.
  - `expires_at_clear=True` + `expires_at` 동시 지정 → expires_at_clear 우선.
  - `user_ids`에 존재하지 않는 UUID → 400 `invalid_user_ids`.
- `DELETE /certs/{id}`:
  - logs는 보존(SET NULL 후 스냅샷 그대로).
  - S3 background image 삭제 실패 → 200 + cleanup queue에 INSERT.
  - 이미 발급된 PDF는 삭제 안 함 (Validate가 계속 동작).

**Users**
- `POST /users`: `email`이 자동 lower 변환됨.
- `DELETE /users/{id}`:
  - 자기 자신 삭제 → 409 `cannot_delete_self`.
  - 마지막 Admin → 409 `last_admin`.
  - 성공 시 `array_remove`로 `Certificate.user_ids`에서 dangling UUID 제거.
- `PUT /users/{id}`: 자기 Admin 박탈 → 409 `cannot_demote_self`.
- `POST /users/file` CSV:
  - 헤더 누락 → 400.
  - CP949 인코딩 → 400 `invalid_encoding`.
  - quoted comma 정상 파싱.
  - 5 MiB 초과 → 413.
  - 1001행 → 400.
  - 한 줄 실패 시 전체 롤백 (이전 행도 미커밋).
  - 파일 내 중복 이메일 → 400 `duplicate_in_file` (행 번호 포함).

**Groups**
- `DELETE /groups/{id}`: `Admin` 그룹 → 409 `admin_group_protected`.
- `PUT /groups/{id}`: 현재 이름이 Admin → 409. 새 이름이 Admin → 409.

**Validate**
- 유효한 log_id → 200 + 스냅샷 데이터.
- 만료된 cert → 200 + `expired=true` + 스냅샷 데이터.
- cert/user가 삭제됐어도 스냅샷으로 정상 응답.
- 존재하지 않는 log_id → 404.

**관찰성**
- audit_log가 비즈니스 트랜잭션과 분리된 세션에 INSERT됨 (비즈니스 롤백 후에도 audit row 살아남음).
- 모든 응답에 `X-Request-ID` 헤더 echo.

### 10.2 Frontend
- **Vitest + React Testing Library**:
  - `RequireAuth` 가드 매트릭스(로그인/비로그인 × admin/일반 × 공개/보호 라우트).
  - `Pagination`: totalpages 0/1/N 케이스, page > totalpages 클램프, Rules of Hooks 위반 없음.
  - `IssueButton` popup blocker 우회(빈 탭 → location 채움 → close on error).
  - `CertNew` 모바일 가드: matchMedia가 desktop false 반환 시 Fabric 미마운트.
  - API 클라이언트: 401에서 자동 navigate 발생 안 함, 토스트만.
  - CSRF 헤더 자동 부착(`X-Requested-With: fetch`).
- **MSW**: `MeOut`, `ApiError` shape.
- **Playwright E2E** 풀 시나리오:
  - 로그인 → 사용자 추가 → 그룹 생성 → 템플릿 생성 → 본인 발급 → 새 탭 PDF 다운로드 → QR 스캔 시뮬레이션 → Validate.
  - 만료 cert 발급 시도 → 410.
  - default admin 락아웃 시 복구 시나리오(다른 sub로 로그인 → admin 복구).

### 10.3 Coverage 게이트

- BE: 라인 ≥ 85%, branches ≥ 80%. issue/auth 모듈은 ≥ 95%.
- FE: 라인 ≥ 80%.
- E2E: 골든 패스 + 만료 + 락아웃 복구 3 시나리오 필수.

---

## 11. 원본 대비 변경/수정 사항

원본의 잠재 버그/약점 → 신규에서의 처리.

| # | 원본 위치 | 문제 | 신규에서 |
|---|----------|------|---------|
| 1 | [api/certs/[id]/route.ts:97](../src/app/api/certs/[id]/route.ts#L97) | `AWS_S3_BUCKET` 잘못된 키 → S3 image leak | `settings.AWS_S3_BUCKET_NAME` 단일 출처. DB-then-S3 순서 + S3 실패는 audit log + cleanup queue (§4.2.3). |
| 2 | [admin/page.tsx:52,96](<../src/app/(full)/admin/page.tsx>), [admin/certs/page.tsx:46](<../src/app/(full)/admin/certs/page.tsx>) | 0건일 때 `NaN%` | FE 공용 `percent()` 헬퍼 — 분모 0 가드. |
| 3 | [admin/certs/new/Form.tsx:146](<../src/app/(full)/admin/certs/new/Form.tsx#L146>) | "발급일자" 라벨 중복 (두 번째는 설명 칸) | 두 번째 라벨 → "증명서 설명". |
| 4 | [api/certs/[id]/issue/route.ts:283](../src/app/api/certs/[id]/issue/route.ts#L283) | presigned URL 60초 | `settings.AWS_S3_PRESIGN_EXPIRES` (기본 300, 환경 변수로 변경). |
| 5 | [api/users/file/route.ts](../src/app/api/users/file/route.ts) | 부분 실패 시 롤백 X + split(",")로 quoted comma 깨짐 | 헤더 필수, UTF-8 BOM strip, `csv.reader`, 사전 검증 후 단일 트랜잭션. 응답 형식 §4.3.3. |
| 6 | 모든 Admin API | 권한 체크 12줄 복붙 | `Depends(require_admin)`. |
| 7 | `Certificate.content`가 String | 인덱싱·타입안전 X | `JSONB` + Pydantic `CertContentIn`/`CertContentOut` 분리(§4.0). |
| 8 | `expires_at` 만료 검사 없음 / 폼에 입력 없음 | | (a) `POST /certs/{id}/issue`에서 410으로 차단, (b) `/api/validate/{id}` `expired` 필드, (c) FE Validate UX 분기, (d) CertNew/CertEdit 폼에 `<input type="date">`. |
| 9 | install.sh로 폰트 복사 | 빌드 워크어라운드 | reportlab `registerFont` 한 번 (도커 이미지에 `data/ChosunGs.ttf` COPY). |
| 10 | 테스트 없음 | | §10 매트릭스 + Coverage 게이트. |
| 11 | [auth.ts:36](../src/lib/auth.ts#L36) | default admin 이메일 사용자가 이미 있으면 `googleId`/Admin 연결 보장 안 됨 | idempotent upsert + 항상 Admin 그룹 보장. default admin은 google_id "다르면 거부" 규칙도 우회(복구 경로). |
| 12 | [issue/route.ts:137](../src/app/api/certs/[id]/issue/route.ts#L137) | 로그를 먼저 만들고 이후 PDF/S3 실패 시 검증 페이지만 유효해질 수 있음 | `log_id` 선생성 → PDF 합성 → S3 PUT → DB INSERT → presign. 모든 실패 단계에서 보상(§5.5). |
| 13 | [groups/[id]/route.ts:68](../src/app/api/groups/[id]/route.ts#L68) | `Admin` 그룹 삭제 보호가 UI에만 있음 | DELETE 거부 + PUT에서 (a) 현재 이름이 Admin인 그룹 변경 거부 (b) 새 이름이 Admin인 PUT 거부 (§4.4). |
| 14 | [lib/dataURI.ts:9](../src/lib/dataURI.ts#L9) + [api/certs/route.ts:78](../src/app/api/certs/route.ts#L78) + [api/images/[id]/route.ts:52](../src/app/api/images/[id]/route.ts#L52) | data URI MIME 그대로 신뢰 → `text/html`/SVG로 stored XSS → 세션 쿠키 탈취 가능 | (a) 업로드 시 `{image/png,jpeg,webp}` 화이트리스트 + Pillow 매직 바이트 + RGB 재인코딩(EXIF 제거), (b) S3 metadata에 신뢰된 MIME 저장, (c) GET 응답은 신뢰된 MIME echo + `nosniff` + CSP (§4.5/§8/§8.3). |
| 15 | [auth.ts:15](../src/lib/auth.ts#L15) | `email_verified` 미검증 → Google 미인증 이메일로 사전등록 계정 탈취 + `google_id` 무조건 덮어쓰기 | (a) `email_verified === true` 강제, (b) `google_id` NULL이거나 같은 sub일 때만 set; 다르면 401 `account_linked_to_different_google_identity`(default admin 예외), (c) IntegrityError → `duplicate_google_id`. (§3.1) |
| 16 | 모든 변경 라우트 | CSRF 미보호 (쿠키 인증만) | `CsrfMiddleware` 전역 적용: Origin/Referer allowlist + `X-Requested-With: fetch` 강제 (§8.1). |
| 17 | [api/users/route.ts:40-61](../src/app/api/users/route.ts#L40), [users/[id]/route.ts:42](../src/app/api/users/[id]/route.ts#L42) | `groups` payload untrusted Prisma `connect`/`set` → admin 자기 박탈/마지막 admin 잠금 가능 | UserCreate/UserUpdate Pydantic + `group_ids` 사전 존재 검증 + 자기 자신 demote/delete 금지 + 마지막 Admin 가드 (§4.3.1, §4.3.2). |
| 18 | [issue/route.ts:120-135](../src/app/api/certs/[id]/issue/route.ts#L120-L135) | `forEach(async)` 비동기 폰트 복사 + `__dirname/data` 동시 쓰기 race | 빌드 시 도커 이미지에 폰트 COPY + startup 1회 `pdfmetrics.registerFont` (§5.2). |
| 19 | [issue/route.ts:180-191](../src/app/api/certs/[id]/issue/route.ts#L180-L191) | 이미지 포맷을 S3 키 확장자로 추정 → 확장자 없는 키 시 `data:false;base64,...` → 500 | 업로드 시 신뢰된 MIME을 S3 metadata에 저장하고 GET 시 그 값으로 echo. Pillow로 PNG/JPEG/WebP 정규화 (§5.4 `_load_bg_image`). |
| 20 | [issue/route.ts:203](../src/app/api/certs/[id]/issue/route.ts#L203) | QR ECC=M 기본 + 임의 rect 크기 허용 → 작은 rect에서 스캔 불가 | ECC=Q 강제, `MIN_QR_PT=60pt`로 clamp + `pdf_warning` audit log (§5.4). |
| 21 | `Certificate.user_ids: UUID[]` FK 부재 | 삭제된 사용자 UUID가 dangling | 사용자 삭제 트랜잭션 내 `UPDATE certificates SET user_ids = array_remove(user_ids, :id)` + GIN 인덱스 (§2.2, §4.3.2). |
| 22 | `CertificateLog` FK RESTRICT + 라이브 조인 검증 | 사용자/cert 삭제 시 검증 깨짐(또는 삭제 자체 차단) | `SET NULL` + 발급 시 스냅샷 6컬럼(user_name/email, certificate_name/issued_at/expires_at, pdf_key) 저장 → 영구 보존 (§2.2). |
| 23 | `users.email` 케이스 sensitivity | `Admin@x.com` vs `admin@x.com` 매칭 실패 / 중복 row | 전 구간 `.lower()` 정규화 + DB `CHECK (email = lower(email))` (§2.2, §3.1, §4.0 `LowerEmail`). |
| 24 | [admin/certs/new/Form.tsx:92-109](<../src/app/(full)/admin/certs/new/Form.tsx#L92-L109>) | `res.ok` 미검사 + `window.location.href`로 강제 이동 → 실패도 성공처럼 처리 | `useMutation` + 인라인 에러 + react-router `navigate` (§6.8). |
| 25 | [(full)/admin/certs/new/page.tsx:30-35](<../src/app/(full)/admin/certs/new/page.tsx>) | `<div className="hidden md:block">`로만 모바일 차단 → Fabric은 마운트됨 | `useMediaQuery` 가드로 컴포넌트 자체 마운트 안 함 (§6.4). |
| 26 | [(full)/certs/[id]/IssueButton.tsx](<../src/app/(full)/certs/[id]/IssueButton.tsx>) | `a.href=url; a.click()`로 같은 탭 PDF → SPA 상태 손실 + 재발급 race | 클릭 동기 컨텍스트에서 빈 탭 open + mutation 성공 시 `location.href` 채움 + 캐시 invalidate (§6.7). |
| 27 | [components/Pagination.tsx](../src/components/Pagination.tsx) | `total=0` 시 빈 nav 렌더 + total<=perPage 시에도 단일 페이지 버튼 노출 | `totalpages <= 1` 시 null 리턴 + `page > totalpages` 시 useEffect로 clamp + Rules of Hooks 준수 (§6.9). |
| 28 | [(full)/admin/groups/page.tsx:32](<../src/app/(full)/admin/groups/page.tsx#L32>) | 잉여 `'` 문자가 DOM에 그대로 렌더됨 | `Groups.tsx` 이식 시 제거. |
| 29 | DELETE `/api/certs/{id}`가 발급된 PDF는 삭제 안 함 | 의도된 동작이지만 spec에 없었음 | 신규 spec: cert 삭제 후에도 이미 발급된 PDF(`certs/issued/<log_id>.pdf`)는 보존. 스냅샷 로그가 살아 있어 검증·다운로드 가능 (§4.2.3). |
| 30 | 응답 envelope `{result, data, error: {title, message}}` | FE 코드 분기가 HTTP status가 아닌 body field에 의존 | FastAPI 표준 `{"detail"}` + Pydantic 모델 직접 반환. FE는 `res.ok` + `res.detail` (§4.0.1). |

---

## 12. 기본값과 미정 사항

[plan.md §6](plan.md#6-미해결-결정-사항-user-확인-필요) 참조. 본 문서는 다음 기본값으로 작성:

- 모노레포(`apps/web`, `apps/api`)
- DB: PostgreSQL 15
- BE 패키지 매니저: uv
- OAuth: Authlib (단독, httpx-oauth 미사용)
- PDF: reportlab
- 세션: JWT httpOnly 쿠키 (7일), **SameSite=Lax (prod 포함)**, Path=/, Secure(prod)
- presigned URL: 300초 (`AWS_S3_PRESIGN_EXPIRES`로 변경 가능)
- 폰트: ChosunGs (원본 유지)
- S3 endpoint: MinIO/MinIO-호환 사용 시 **`AWS_S3_ENDPOINT`(내부) + `AWS_S3_PUBLIC_ENDPOINT`(브라우저용) 분리** — SigV4가 host를 서명에 포함하므로 사후 string-replace 불가
- 로깅: stdout 구조화 JSON(`structlog`) + audit는 DB `audit_logs` 테이블 (best-effort 별도 세션) + Sentry(선택)
- CSRF: SameSite=Lax + Origin/Referer allowlist + `X-Requested-With: fetch` 헤더 (`CsrfMiddleware`)
- 이메일: `lower()` 정규화 + DB CHECK
- 마이그레이션: 별도 `api-migrate` 잡 (워커가 직접 `alembic upgrade` 안 함)
- Coverage 게이트: BE 라인 ≥85% / 분기 ≥80% / issue·auth ≥95%, FE 라인 ≥80%

다른 결정이 있으면 본 문서에서 해당 섹션만 수정한다.
