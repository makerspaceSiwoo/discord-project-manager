# 설치, 연결, 배포

초기 상태는 비활성입니다. 아래 절차를 운영자가 자신의 계정에서 수행합니다. 이 저장소 구현 과정에서는 실제 서비스에 로그인·배포·게시하지 않았습니다.

## 0. 설치 구조와 로컬 준비

코드는 Cloudflare Workers에서 실행하고, Discord 앱에 Worker의 `/interactions` 주소를 연결합니다. D1은 설정·계정 연결·투표·작업 큐를 저장합니다. 배포 후에는 개인 컴퓨터를 계속 켜둘 필요가 없습니다. [GitHub Actions 설정](github-actions.md)을 완료하면 main push로 배포됩니다. Discord 연결과 프로젝트 활성화는 별도 설정입니다.

Node.js 22 이상을 설치한 뒤 저장소 폴더에서 실행합니다.

```sh
npm ci
npm run check
npm test
cp .dev.vars.example .dev.vars
cp config/project.example.json config/project.local.json
```

이미 설정 파일이 있다면 복사 명령을 생략하여 기존 값을 유지합니다. `.dev.vars`에는 아래 표의 값을 편집기로 입력합니다. 이 파일과 `config/project.local.json`은 Git에서 제외됩니다. 비밀값을 채팅이나 GitHub에 붙이지 않습니다.

| 변수                                         | 확인 위치                                                    |
| -------------------------------------------- | ------------------------------------------------------------ |
| `DISCORD_APPLICATION_ID`                     | Developer Portal → 앱 → General Information → Application ID |
| `DISCORD_PUBLIC_KEY`                         | 같은 화면의 Public Key                                       |
| `DISCORD_BOT_TOKEN`                          | 앱 → Bot → Token (발급 또는 재설정)                          |
| `DISCORD_CLIENT_SECRET`                      | 앱 → OAuth2 → Client Secret                                  |
| `NOTION_TOKEN`                               | 팀 공용 Notion Internal Connection의 토큰                    |
| `NOTION_WEBHOOK_SECRET`, `WEBHOOK_SETUP_KEY` | 아래 Webhook 단계에서 설정; 처음에는 비워 둠                 |

화면만 먼저 확인하려면 아래 명령을 실행하고 `http://localhost:8787/?demo=1`을 엽니다. 가상 팀 데이터이며 실제 Discord/Notion 연결을 확인하는 절차는 아닙니다.

```sh
npm run db:local
npm run seed
npm run dev
```

## 1. Discord 앱

[Discord Developer Portal](https://discord.com/developers/applications)에서 앱을 만들고 봇 표시 이름을 **플젝하는 연수리**로 설정합니다. Application ID, Public Key, Bot Token, OAuth Client Secret을 확보합니다.

- 설치 범위: `bot`, `applications.commands`. 앱의 Guild Install 설치 링크(또는 OAuth2 URL Generator로 만든 링크)를 열어 운영할 서버에 봇을 초대합니다. 서버를 관리할 권한이 있는 계정으로 진행합니다.
- 웹 로그인 OAuth 범위: `identify`만 사용합니다. 로그인 후 bot REST로 서버 역할을 확인합니다.
- OAuth Redirect URI: `https://<worker>.<계정>.workers.dev/auth/callback`과 개발용 `http://localhost:8787/auth/callback`을 정확하게 등록합니다.
- Interactions Endpoint URL: 배포 후 `https://<worker>.<계정>.workers.dev/interactions`.
- **Server Members Intent(GUILD_MEMBERS)**를 켭니다. Gateway 연결은 사용하지 않지만 List Guild Members REST 자체가 이 설정을 요구합니다. [공식 Guild API](https://docs.discord.com/developers/resources/guild#list-guild-members)
- Message Content Intent는 필요하지 않습니다.

런타임 봇은 채널 보기, 메시지 보내기, 메시지 기록 보기, 링크 임베드, 공개 스레드 생성, 스레드에 메시지 보내기, 스레드 관리 권한을 받습니다. 설치 도구로 리소스를 생성할 때만 Manage Channels와 Manage Roles를 추가하며, 작업 후 제거할 수 있습니다. Administrator 권한을 봇에게 줄 필요가 없습니다. 봇 역할을 생성할 팀원 역할보다 위에 둡니다.

| 설정                | 기본 채널/역할   | 종류                              |
| ------------------- | ---------------- | --------------------------------- |
| memberRoleId        | 연수리-팀원      | 팀원에게 부여할 역할              |
| schedulingChannelId | 일정-투표        | 텍스트 + 주차별 스레드            |
| issueChannelId      | 프로젝트-이슈    | 포럼, 또는 텍스트 + 이슈별 스레드 |
| reportChannelId     | 주간-보고        | 텍스트                            |
| adminRoleIds        | 기존 관리자 역할 | ID를 명시적으로 설정              |

포럼 기본값은 Community 서버에서 사용합니다. 조건을 충족하지 못하면 `issueChannelMode: "text"`로 바꿉니다. 기존 채널을 ID로 매핑해도 됩니다. 포럼에 필수 태그가 설정되어 있다면 해제하거나 `adapters/discord.ts` 사용 지점에 프로젝트별 태그 매핑을 확장해야 합니다.

```sh
# config/project.local.json에 guildId와 adminRoleIds 입력
# .dev.vars에 Discord 값 입력 후, 생성할 리소스 확인
node --env-file=.dev.vars scripts/setup.mjs config/project.local.json
# 확인한 역할·채널을 생성하고 슬래시 명령 등록
node --env-file=.dev.vars scripts/setup.mjs config/project.local.json --apply
```

Discord 사용자 설정 → 고급 → 개발자 모드를 켜면 서버·역할의 메뉴에서 ID를 복사할 수 있습니다. `guildId`는 서버 ID, `adminRoleIds`는 관리자 역할 ID 배열입니다. 설치 도구가 생성한 팀원 역할·채널 ID는 설정 파일에 저장됩니다. 생성 후 본인과 팀원에게 `연수리-팀원` 역할을 부여하세요.

`node --env-file=.dev.vars`는 설치 도구에 로컬 비밀값을 전달합니다. Wrangler가 읽는 `.dev.vars`는 일반 `node` 명령에 자동 적용되지 않습니다.

기본 실행은 읽기와 계획만 수행합니다. `--apply`는 누락된 역할/채널을 생성하고 이 앱의 지정 명령 이름만 upsert합니다. 다른 명령을 일괄 삭제하지 않습니다. 생성 직전 journal을 저장하며 응답 유실 시 재생성을 중단합니다. 실제 생성 리소스를 찾아 설정 ID에 반영하면 복구합니다. 기존 채널 구조와 권한은 덮어쓰지 않으므로 실제 접근 권한을 별도 검사하세요. 이름 중복이면 중단합니다. 이 도구는 로컬 설치 단계에만 사용하며 외부 API 429이면 실행을 멈추고 다시 실행합니다.

등록 명령: `/계정연결`, `/이슈생성`, `/일정`, `/연동상태`. 마지막은 기본 관리자 전용이며 Discord 서버의 앱 명령 권한과 `adminRoleIds`를 함께 맞춥니다. 폼은 [공식 Modal 컴포넌트](https://docs.discord.com/developers/components/reference#label)에 따른 Label 안의 Text Input, String Select를 사용합니다. 최초 응답 제한 3초, 토큰 유효기간 15분을 전제로 느린 작업은 지연 응답합니다. [Interactions 응답 문서](https://docs.discord.com/developers/interactions/receiving-and-responding)

## 2. Notion 공용 연결과 스키마

워크스페이스 소유자가 팀 공용 Internal Connection을 만들고, 이슈 DB 및 별도 인증 페이지에 연결을 추가합니다. 필요한 기능은 콘텐츠 읽기·삽입·수정, 댓글 읽기, 사용자 정보 읽기입니다. 팀원에게 관리자 권한 또는 개인 토큰을 요구하지 않습니다. [Notion 연결 권한 문서](https://developers.notion.com/guides/authorization/overview)

1. 기존 DB가 있다면 원본을 유지하고 database ID와 data source ID를 확인합니다. `/v1/databases/{database_id}`의 `data_sources`에서 실제 원본 data source를 확인합니다. 링크된 DB 화면의 ID를 원본으로 추정하지 않습니다.
2. `config/notion-schema.json` 명세에 맞춰 **Notion UI에서 새 DB를 만들거나**, 기존 속성 이름과 자료형을 `notion.properties`에 매핑합니다. API 자동 스키마 생성·덮어쓰기는 제공하지 않습니다.
3. 상위 작업/하위 작업은 같은 data source를 가리키는 양방향 Relation으로 설정합니다. Notion의 하위 작업 기능을 켰다면 생성된 실제 속성 이름을 사용합니다.
4. 상태는 실제 `status` 또는 `select`로 지정하고 `statusType`을 맞춥니다. 유형과 우선순위는 Select입니다. 상태 옵션을 코드가 자동 생성한다고 가정하지 않습니다. 표준 UI 스키마는 `미시작 / 진행 중 / 완료 / 취소`입니다.
5. 작업 ID는 Unique ID 또는 Rich text를 지원합니다. Unique ID 사용을 권장합니다. Rich text 모드는 비어 있으면 페이지 ID 앞부분으로 표시합니다. 생성일은 Created time, Discord는 URL입니다. Notion에 요청 ID 속성을 추가할 필요는 없습니다. 기존 고유 ID 속성 이름이 `Id`라면 `notion.properties.taskId`에 `Id`를 지정합니다.
6. 이슈 DB 안에 **전용 검증 행**을 하나 만듭니다. 실제 업무가 아니며 사용자가 수정하지 않도록 표시합니다. `probePageId`로 지정하고 보고서에서 제외합니다. 인증 시 이 행의 People 값은 바뀌며 최신 검증 대상이 남습니다. 다른 업무 행을 지정하지 마세요.
7. 팀원이 댓글을 작성할 수 있는 별도 인증 페이지를 준비하고 `verificationPageId`에 입력합니다. 이 페이지의 댓글이 지나치게 쌓이면 별도 보관 후 새 페이지로 교체합니다.

```sh
node --env-file=.dev.vars scripts/notion-schema.mjs config/project.local.json
```

위 명령과 관리자 웹의 연동 진단은 속성/자료형을 조회하며 DB를 변경하지 않습니다. 이슈 생성은 최신 data source 부모와 People ID를 사용합니다. API 버전은 문서에서 확인한 `2026-03-11`로 고정했습니다. 버전 변경 시 게스트, 페이지 생성, 댓글, Webhook 계약을 재검증하세요.

## 3. 게스트 검증

[별도 절차](guest-verification.md)를 실제 **게스트** 2명과 수행합니다. OAuth가 실제 환경에서 성공하고 `owner.user.id`의 의미가 검증된다면 OAuth 연결 경로를 추가할 수 있습니다. 현재 코드는 검증되지 않은 OAuth 사용자 연결을 자동 선택하지 않습니다. 댓글 대안도 검증 기록을 남기고 활성화해야 합니다.

공용 연결 자격 증명은 `NOTION_TOKEN`, 개인 연결은 D1의 검증된 Discord/Notion ID입니다. 서로 구분합니다.

## 4. Cloudflare Free 배포

GitHub에서 값을 입력하고 자동 배포하려면 [Actions 전용 안내](github-actions.md)를 따릅니다. 아래는 로컬 CLI로 수동 배포하는 대안입니다. 두 방식으로 동시에 배포할 필요는 없습니다.

먼저 대시보드의 Workers 계정 플랜이 **Free**인지 확인합니다. 이 구성은 업그레이드, 결제 수단 등록, 도메인 구매를 수행하지 않습니다.

```sh
npx wrangler login
npx wrangler d1 create project-manager
```

D1 이름은 `project-manager`, 코드의 binding 이름은 `DB`입니다. 이미 같은 이름의 DB가 있다면 `npx wrangler d1 list`로 확인하고 스키마가 현재 브랜치와 호환되는지 점검한 뒤 해당 DB ID를 사용합니다. 설정의 이름 변경만으로 기존 원격 DB의 이름이나 데이터가 이전되지는 않습니다.

반환된 database ID를 `wrangler.jsonc`의 `d1_databases[0].database_id`에 입력합니다. `APP_ORIGIN`은 실제 workers.dev URL로 바꾸고 후행 `/`는 제거합니다. `PROJECT_ID`는 설정 JSON의 `id`와 같아야 합니다.

```sh
npm run db:remote
node scripts/config.mjs config/project.local.json --remote
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put NOTION_TOKEN
npm run deploy
```

배포 결과의 URL을 확인한 후 `APP_ORIGIN`이 실제 URL과 일치하는지 확인합니다. 수정했다면 다시 배포합니다. Discord Developer Portal에 해당 URL의 `/auth/callback`을 OAuth Redirect로, `/interactions`를 Interactions Endpoint로 저장합니다. Discord의 endpoint 검증에 성공해야 슬래시 명령 요청이 이 Worker로 전달됩니다.

로컬에서는 동일한 항목을 `.dev.vars`에 넣습니다. `.dev.vars.example`에는 실제 값이 없습니다. OAuth state·세션은 난수와 D1 해시로 관리하여 별도 세션 서명 비밀값이 필요하지 않습니다.

정적 파일은 `/public`, 보호된 엔드포인트만 Worker 우선 실행입니다. 디폴트 `* * * * *` UTC Cron 1개가 매분 D1의 지역 시각 기반 예약을 확인합니다. 시간대를 바꾸면 현재 진행 주차가 없는 상태에서 설정을 변경하세요. 마감 시각 자체는 프로젝트 시간대의 월요일 00:00 고정입니다.

## 5. Notion Webhook

1. 충분히 긴 임의 문자열을 `WEBHOOK_SETUP_KEY` secret으로 설정합니다. 아직 `NOTION_WEBHOOK_SECRET`은 설정하지 않습니다.
2. 구독 URL은 `https://<worker>.workers.dev/webhooks/notion?setup=<일회용설정값>`으로 등록합니다. 이 URL은 비밀값이므로 공유하지 않습니다. 원본 이벤트/요청 URL을 로그로 남기지 않는 운영 설정을 사용합니다.
3. 최초 `verification_token`은 D1 `setup_secrets`의 `notion_verification`에 1회 저장됩니다. Cloudflare의 권한 있는 D1 콘솔에서 값만 확인하여 Notion의 구독 확인란에 입력합니다. Git, 이슈, 채팅, 공유 로그에 붙이지 않습니다.
4. 같은 값을 `wrangler secret put NOTION_WEBHOOK_SECRET`으로 저장합니다. `WEBHOOK_SETUP_KEY`는 제거하고 D1 임시 값을 삭제합니다. 구독 URL에 남은 query 값은 이후 인증에 사용되지 않고 원본 본문 HMAC 검증만 수행됩니다. 값 노출이 우려되면 구독을 정상 URL로 재등록하고 재검증합니다.
5. 페이지 생성 이외에 속성 변경, 본문 변경, 삭제/휴지통, 복원 등 필요한 페이지 이벤트를 구독합니다. 서명은 `X-Notion-Signature`, HMAC 키는 검증 토큰입니다. [Notion Webhook 공식 문서](https://developers.notion.com/reference/webhooks)

실제 구독 인증, 서명 헤더, 삭제·보관 이벤트 payload는 운영 전 실환경에서 확인해야 합니다. 서명이 잘못되면 401, 검증된 이벤트의 D1 저장이 실패하면 오류를 반환해 서비스 측 재전송 대상이 됩니다. 저장 후에는 D1 작업으로 처리하므로 Notion이 보낸 순서와 무관하게 최신 페이지를 읽습니다.

## 6. 활성화와 템플릿 재사용

관리자 계정에 팀원 역할과 관리자 역할을 부여하고 `/?view=admin`에서 진단합니다. 실제 channel type, guild ID, Notion 속성과 선택지, 대상 명단을 확인합니다. 초기 설정 도구는 전체 멤버를 페이지네이션하여 출력합니다. 웹 진단은 한 페이지와 다음 cursor를 반환합니다.

게스트 인증 체크리스트의 증거를 `notion.guestEvidence`에 기록하고 `guestVerificationEnabled`를 켭니다. 공용 연결·권한을 확인한 뒤 `enabled: true` 설정을 D1에 적용합니다. 검증 직후 `/이슈생성`으로 시험 작업 1개를 만들고 변경 반영을 확인합니다.

Notion 복제 링크와 Discord 서버 템플릿 링크는 실제로 발급하지 않았습니다. 운영자가 배포용 템플릿을 만들 경우 비밀값·실제 팀 데이터·계정 연결 정보를 제거하세요. Discord 기본 템플릿이 포럼을 복제한다고 전제하지 않고, 초기 설정 도구가 누락된 포럼 또는 텍스트 대안을 보완합니다. 다른 팀은 별도 Worker와 D1을 사용하면 설정·비밀값·권한 경계가 단순합니다.

## 7. 팀원이 사용하는 방법

운영자가 설정·연결 검증을 마치고 활성화한 다음 사용합니다.

| 할 일            | 사용 방법                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 계정 연결        | Discord에서 `/계정연결` → 웹에서 Discord 로그인 → 안내된 Notion 인증 페이지에 새 댓글로 코드 작성 → 원래 브라우저에서 댓글 확인 → 본인 Notion ID 확인 후 연결 |
| 가능한 시간 입력 | `/일정` 또는 주간 투표 메시지의 링크 → 내 시간표 → 가능한 칸 선택 → 저장. 가능한 시간이 없으면 전용 체크박스를 선택하고 저장                                  |
| 팀 시간표 확인   | 팀 시간표에서 모든 시간대의 가능한 인원 수를 보고, 칸을 눌러 인원 확인. 응답 없음과 불가능 응답을 따로 표시하며 회의 시간을 자동 선택하지 않음                |
| 이슈 만들기      | `/이슈생성` → 제목·마감일·연결된 담당자·유형·우선순위 입력 → 필요한 경우 설명 추가 → 최종 확인. 완료되면 Notion 이슈와 Discord 스레드가 연결됨                |
| 이슈 수정        | Notion에서 수정. Webhook과 작업 큐를 거쳐 연결된 Discord 요약에 반영                                                                                          |
| 주간 보고 보기   | `주간-보고` 채널의 메시지와 전체 표 링크 확인                                                                                                                 |
| 운영 상태 확인   | 관리자 `/연동상태` 또는 웹 `/?view=admin`에서 진단과 작업 상태 확인                                                                                           |

기본 시간대는 한국 시간입니다. 일요일 09:00에 다음 월요일~일요일 시간표가 열리고, 일요일 23:00에 미응답자에게 알림을 보내며, 월요일 00:00에 저장을 마감합니다. 주간 보고는 월요일 09:00부터 처리합니다. 날짜는 `2026-11-09 ~ 2026-11-15`처럼 표시합니다. 아직 투표가 열리지 않았다면 다음 예약 시점까지 실제 시간표가 없을 수 있습니다.

이슈 생성 확인에는 즉시 비공개 처리 중 응답을 보내고, Notion 생성 API는 최대 5초 동안 기다립니다. 성공 시 페이지 링크를 안내하고 Discord 스레드 연결을 이어갑니다. 시간 초과·응답 유실·불명확한 오류는 자동 재생성하지 않고 `review`로 멈추며 Notion에서 생성 여부를 확인하도록 안내합니다. 5초는 Notion 생성 요청의 제한이며, 멤버 권한 확인·작업 대기·Discord 연결 전체의 완료 시간을 보장하지 않습니다. 작업 큐는 매분 단계적으로 처리하므로 동기화·보고가 즉시 끝나지 않을 수 있습니다. 봇은 Gateway에 상시 접속하지 않아 Discord에서 오프라인으로 보일 수 있습니다. 접속 표시 대신 슬래시 명령 응답과 관리자 진단으로 확인하세요.

설정을 바꾸면 JSON만 편집하는 것으로 끝나지 않습니다. 다음 명령으로 운영 D1에 적용합니다.

```sh
node scripts/config.mjs config/project.local.json --validate
node scripts/config.mjs config/project.local.json --remote
```

코드를 수정한 경우에는 `npm run check`, `npm test`, `npm run build` 확인 후 `npm run deploy`를 실행합니다. Actions를 설정한 경우 main push가 검증·마이그레이션·배포를 실행합니다. feature 브랜치와 PR에서는 검증만 실행합니다.
