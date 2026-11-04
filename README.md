# discord-project-manager · 플젝하는 연수리

프로젝트 관리를 위한 디코봇 (일정 투표, notion 이슈 생성, 주간 보고 등).

Notion을 이슈의 기준 데이터로, Discord를 팀 대화와 알림 공간으로 사용하는 소규모 팀용 서비스입니다. TypeScript Worker 하나에 HTTP Interactions, API, OAuth, Notion Webhook과 Cron을 모으고, 정적 웹 화면과 D1을 연결합니다. Gateway나 상시 프로세스, 유료 서비스, 도메인 구매가 필요하지 않은 배포 구성을 제공합니다.

**운영 설정:** 배포와 기능 활성화는 별개입니다. `enabled`는 전체 작업 실행, `features.issues`는 이슈 작업, `features.automation`은 투표·보고·예약 알림을 제어합니다. 첫 사용은 이슈만 켜고 본인 계정 연결부터 확인하세요. [설정 안내](docs/setup.md)

## 빠르게 실행하기

Node.js 22 이상(이번 검증: Node 26), npm이 필요합니다.

```sh
npm ci
npm run check
npm test
npm run db:local
npm run seed
npm run dev
```

`http://localhost:8787/?demo=1`에서 계정 없이 **가상 팀 데이터**로 시간표를 확인할 수 있습니다. 샘플 저장은 페이지 메모리에만 반영되며 실제 API 인증을 우회하지 않습니다. 실제 로그인은 `.dev.vars.example`을 `.dev.vars`로 복사하여 Discord 자격 증명을 입력하고 프로젝트를 설정한 뒤 이용합니다.

```sh
cp config/project.example.json config/project.local.json
node scripts/config.mjs config/project.local.json --validate
node scripts/config.mjs config/project.local.json --local
npm run build
```

`npm run build`는 **배포하지 않고** Worker 번들과 정적 자산 구성을 검사합니다. 모든 개발 의존성은 버전과 lockfile로 고정되어 있습니다. 비밀값은 로컬 `.dev.vars` 또는 GitHub Actions Secrets·Cloudflare Worker Secrets에 두고 Git에 넣지 않습니다.

Notion 이슈 DB에는 `요청 ID` 속성이 필요하지 않습니다. 생성 API는 최대 5초 동안 기다리며, 결과가 불명확하면 자동 재생성을 중단하고 확인을 안내합니다. 봇 내부의 작업 기록은 유지합니다.

## 포함 기능

| 영역      | 구현                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 계정 연결 | Discord OAuth, 브라우저에 바인딩된 일회용 state, HttpOnly 세션, Notion 이메일 조회·관리자 확인, 영구 ID 연결, People 지정·재조회, 중복 연결 차단, 해제·관리자 철회 |
| 이슈      | `/이슈 생성`, 최신 Modal Label/선택 필드, 선택 설명, 최종 확인, Notion 생성, 포럼 또는 텍스트 스레드, 양쪽 링크, Webhook 최신 재조회, 변경된 담당자만 알림            |
| 일정      | 주차별 대상 스냅샷, 196개 슬롯, 드래그/터치 포인터/방향키·스페이스, 명시적 저장, 응답 없음과 빈 응답 구분, 집계·상세 인원, 마감 시 SQL 저장 차단, 이전 결과          |
| 보고      | Notion 커서 끝까지 수집, 상위·미완료 필터, 마감/명시적 우선순위/생성일/ID 정렬, 분할 메시지, 인증된 전체 표, 원문·Discord 링크                                       |
| 운영      | D1 영속 작업 큐와 lease, 외부 생성 결과 확인, 재시도·검토 상태, 서명 검증, CSRF, 역할 재확인, 관리자 진단, 읽기 전용 스키마 검사, 반복 가능한 Discord 초기 설정      |

## 문서

- [최초 확인 내용과 설계](docs/architecture.md)
- [Discord·Notion 설정 및 Cloudflare 배포](docs/setup.md)
- [GitHub Actions 자동 배포 — 입력할 Secrets/Variables](docs/github-actions.md)
- [게스트 계정 연결 실환경 검증](docs/guest-verification.md)
- [무료 한도 근거와 운영 예산](docs/free-tier.md)
- [장애·중복·할당량 복구](docs/recovery.md)
- [검증 결과와 남은 한계](docs/verification.md)
- [표준 Notion 스키마](config/notion-schema.json), [프로젝트 설정 예시](config/project.example.json)

## 코드 구조와 확장

```text
src/
  index.ts                 HTTP API / Webhook / Cron 진입점
  interactions.ts          Discord 입력과 확인 단계
  core/
    auth.ts                OAuth / 세션 / 멤버 권한
    crypto.ts              서명 / 난수 / 해시
    db.ts                  D1 접근과 작업 등록
    effects.ts             외부 생성의 결과 확인
    jobs.ts                영속 작업의 단계별 실행
    types.ts               공통 타입
  adapters/
    discord.ts             Discord REST
    notion.ts              Notion data source / 페이지 / 댓글
    http.ts                호출 예산 / timeout / 429 분류
  modules/
    linking.ts             People 검증 / 기존 댓글 인증
    email-linking.ts       이메일 후보 조회 / 관리자 확인 / 연결 요청
    issues.ts              입력 검증 / Modal / 요약
    scheduling.ts          주차 / 마감 / 슬롯 / 집계
    reporting.ts           대상 필터 / 정렬 / 표시
public/                    한국어 화면, 빌드 없는 HTML/CSS/JS
migrations/                D1 SQL
scripts/                   설정 검증·적용 / Discord 초기 설정 / Notion 진단
```

업무 규칙은 `modules`, 외부 API는 `adapters`, 재시도와 실행 순서는 `core/jobs.ts`에서 확장합니다. 새 작업은 고유한 `jobs.id`와 작은 실행 단계를 정의하고, 외부 생성에는 `effect()` 및 조회 복구 함수를 함께 제공합니다. 다른 팀은 설정 파일과 Notion 속성 매핑을 바꾸어 동일 코드를 배포할 수 있습니다. 현재 Worker 하나는 `PROJECT_ID`로 지정한 한 프로젝트를 실행합니다.

결제·공개 SaaS 가입, 회의 자동 확정, 캘린더 등록, 채팅 양방향 복사, Discord 속성 수정·하위 작업 생성, Notion에서 직접 만든 이슈의 Discord 자동 생성은 범위에 포함하지 않습니다.
