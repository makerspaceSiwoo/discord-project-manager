# GitHub Actions로 Cloudflare 자동 배포

이 저장소의 `.github/workflows/deploy.yml`은 `main` push를 받아 다음 순서로 실행합니다.

1. Node.js 24 + `npm ci`로 잠긴 의존성 설치.
2. TypeScript 검사, 서비스 테스트, 배포 설정 테스트, Worker dry-run.
3. 필수 GitHub 입력값 검증, 운영용 Wrangler 설정 생성, 운영 번들 dry-run.
4. `project-manager` D1에 미적용 마이그레이션 적용.
5. 코드·정적 파일과 GitHub의 런타임 Secrets를 한 Worker 버전으로 배포.
6. `APP_ORIGIN/api/health` 응답 확인.

`feat/**` push와 `main` 대상 PR에서는 검증만 실행합니다. 배포는 `main`에서만, 실행자와 재실행자가 모두 저장소 소유자일 때 실행합니다. 현재 소유자는 `makerspaceSiwoo`입니다. 이 조건은 Actions 배포 제한이며 GitHub의 collaborator/브랜치 보호 설정을 변경하지 않습니다. 조직 저장소로 옮길 때는 이 조건을 허용할 사용자 또는 Environment 보호 규칙에 맞게 조정하세요.

배포 작업은 동시에 실행하지 않고, 시작된 마이그레이션·배포를 새 push 때문에 취소하지 않습니다. 검증 또는 입력값 검사가 실패하면 원격 변경 단계로 넘어가지 않습니다. 마이그레이션 성공 후 배포가 실패하면 DB 마이그레이션은 남으므로 운영 데이터가 생긴 뒤에는 이전 코드와 호환되는 추가형 마이그레이션을 작성하세요.

## 1. 입력할 Secrets

[Settings → Secrets and variables → Actions → Secrets](https://github.com/makerspaceSiwoo/discord-project-manager/settings/secrets/actions)에서 **New repository secret**으로 등록합니다. 이름은 아래와 정확히 일치해야 합니다. 실제 값을 코드·이슈·PR·채팅에 넣지 않습니다.

| 이름                    | 필수                 | 값의 출처                                                   |
| ----------------------- | -------------------- | ----------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | 예                   | Cloudflare 사용자 API Token. 아래 권한 안내 참고            |
| `DISCORD_PUBLIC_KEY`    | 예                   | Discord Developer Portal → General Information → Public Key |
| `DISCORD_BOT_TOKEN`     | 예                   | Discord Developer Portal → Bot → Token                      |
| `DISCORD_CLIENT_SECRET` | 예                   | Discord Developer Portal → OAuth2 → Client Secret           |
| `NOTION_TOKEN`          | 예                   | 이슈 DB에 연결한 Notion Internal Connection의 API 토큰      |
| `NOTION_WEBHOOK_SECRET` | Webhook 연결 후      | Notion 구독 검증 토큰                                       |
| `WEBHOOK_SETUP_KEY`     | Webhook 초기 연결 시 | 운영자가 생성한 충분히 긴 임의 문자열                       |

Public Key 자체는 공개 가능한 값이지만, 이 워크플로에서는 입력 위치를 통일하기 위해 Secrets에서 받습니다.

`CLOUDFLARE_API_TOKEN`은 Actions의 배포 권한입니다. Worker에 전달하지 않습니다. 나머지 값은 임시 JSON 파일에 기록하여 `wrangler deploy --secrets-file`로 Cloudflare Worker Secrets에 전달합니다. 이 파일은 로그나 artifact에 올리지 않고 작업 종료 시 삭제합니다. `.dev.vars`는 사용하지 않습니다.

Webhook 선택값은 비어 있으면 전달하지 않습니다. **GitHub Secret을 삭제하는 것만으로 기존 Cloudflare Secret이 삭제되지는 않습니다.** Webhook 초기 연결이 끝나면 GitHub의 `WEBHOOK_SETUP_KEY`를 삭제하고 Cloudflare Worker에서도 같은 Secret을 제거하세요. 필요하면 해당 계정에서 `npx wrangler secret delete WEBHOOK_SETUP_KEY`를 실행합니다.

### Cloudflare API Token 만들기

[Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)에서 사용자 API Token을 생성합니다. 계정 범위를 실제 배포 계정 하나로 제한합니다.

- Account → Workers Scripts → Edit
- Account → D1 → Edit
- Account → Account Settings → Read

Workers 편집 템플릿으로 시작할 수도 있지만 D1 편집 권한이 포함되는지 확인하세요. 이 프로젝트의 workers.dev 배포에는 사용자 소유 도메인/Zone을 추가하지 않습니다. 토큰은 GitHub의 `CLOUDFLARE_API_TOKEN`에 저장합니다. `wrangler login`으로 받은 로컬 OAuth 토큰을 복사할 필요는 없습니다.

## 2. 입력할 Variables

[같은 설정의 Variables 탭](https://github.com/makerspaceSiwoo/discord-project-manager/settings/variables/actions)에서 등록합니다. 아래 ID 3개는 2026-11-04에 등록해 두었습니다.

| 이름                     | 현재 값 / 입력 방법                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`  | `bd3131e3fbbbc53706ec8b9c1d17a245` — 등록 완료                                         |
| `CLOUDFLARE_DATABASE_ID` | `009e37b0-ef3b-4302-b352-8948367984c2` — 등록 완료                                     |
| `DISCORD_APPLICATION_ID` | `1567056733254324236` — 등록 완료                                                      |
| `APP_ORIGIN`             | **입력 필요:** `https://discord-project-manager.<본인-workers-서브도메인>.workers.dev` |

Cloudflare Workers & Pages에서 계정의 **workers.dev 서브도메인**을 확인하거나 최초 설정합니다. 2026-11-04 조회에서는 계정의 서브도메인 API가 404를 반환하여 URL은 미리 입력하지 않았습니다. 예시 문자열을 그대로 입력하지 마세요. URL에는 경로·쿼리를 넣지 않습니다.

이 자동 배포는 workers.dev 서브도메인 등록이나 D1 생성을 대신 수행하지 않습니다. 현재 계정에는 `project-manager` DB 및 초기 테이블, `enabled: false`인 `default` 프로젝트가 이미 준비되어 있습니다. 다른 팀은 자신의 D1을 만들고 해당 ID를 Variables에 지정합니다. DB 이름은 `project-manager`, 코드 바인딩은 `DB`로 유지합니다.

`wrangler.jsonc`는 로컬 개발 설정입니다. Actions는 이를 읽고 계정 ID, DB ID, APP_ORIGIN, Discord 앱 ID를 덮어쓴 `.wrangler.deploy.json`을 생성합니다. 공유 파일은 JSON 문법으로 유지하며, 운영 URL 때문에 로컬 URL을 수정할 필요가 없습니다.

## 3. 처음 실행하기

1. 위 필수 Secrets 5개와 `APP_ORIGIN`을 입력합니다.
2. 기능 브랜치의 PR을 `main`에 병합합니다. 최초 병합으로 자동 배포가 시작됩니다.
3. [Actions → Cloudflare](https://github.com/makerspaceSiwoo/discord-project-manager/actions)에서 Verify와 Deploy production이 모두 성공했는지 확인합니다.
4. 이후에는 소유 계정으로 `main`에 push할 때마다 배포됩니다. Secrets/Variables만 바꿨다면 **Run workflow → main**으로 재배포합니다. 값 저장만으로는 실행되지 않습니다.

자동 배포는 `config/project.example.json`을 D1에 매번 저장하지 않습니다. 운영자가 설정한 채널, 계정 연결, 투표 및 이슈 데이터와 `enabled` 상태를 유지합니다.

## 4. 배포와 봇 활성화의 차이

HTTP health 성공은 Worker 웹 응답을 확인한 것입니다. Discord·Notion 기능까지 검증했다는 의미가 아닙니다. 첫 배포 후 다음 연결은 필요합니다.

- Discord OAuth2 Redirect: `<APP_ORIGIN>/auth/callback`
- Discord Interactions Endpoint: `<APP_ORIGIN>/interactions`
- Discord 서버·역할·채널 ID와 Notion 속성 매핑을 프로젝트 설정에 반영
- Discord 슬래시 명령 등록, 계정 연결 및 Notion 권한 확인
- 실제 연결 검증 후 프로젝트 활성화

이 작업은 [설치 안내](setup.md)를 따릅니다. 기존 팀원이 있는 서버에 배포만으로 테스트 메시지를 보내거나, 비활성 프로젝트를 자동으로 활성화하지 않습니다.

## 문제 해결

- `Missing GitHub settings`: 표시된 이름으로 Repository Secrets/Variables를 입력하고 main에서 재실행.
- Cloudflare 인증 오류: Token 만료·계정 범위·Workers Scripts/D1 권한 확인.
- D1 not found: 선택한 계정에 `CLOUDFLARE_DATABASE_ID`가 실제로 존재하는지 확인.
- 첫 배포의 서브도메인 오류: Cloudflare에서 workers.dev 서브도메인을 먼저 등록.
- Deploy production이 skipped: main인지, 실행자·재실행자가 저장소 소유자인지 확인.
- HTTP health 실패: APP_ORIGIN과 실제 배포 URL을 비교. 이 단계 실패가 이미 완료된 배포나 마이그레이션을 되돌리지는 않음.
- Secret 교체: GitHub 값을 바꾼 뒤 main에서 Run workflow. Cloudflare에서만 바꾸면 다음 배포 때 GitHub 값으로 다시 덮어씀.

## 공식 참고

- [Cloudflare GitHub Actions 배포](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [D1 마이그레이션](https://developers.cloudflare.com/d1/reference/migrations/)

## GitHub Secrets로 연결 진단하기

`Inspect integrations` 수동 워크플로는 서버 ID와 Notion 루트 페이지 ID를 받아 채널·역할·멤버 및 하위 DB 스키마만 조회합니다. Discord 메시지나 Notion 페이지를 생성하지 않습니다. Repository Variable `INSPECTION_PUBLIC_KEY`에 운영자의 RSA 공개키(PEM)를 등록해야 합니다. 개인키는 운영자 기기에만 보관합니다.

조회 결과는 AES-256-GCM으로 암호화하고 데이터 키를 RSA-OAEP-SHA256으로 감싸서 `integration-inspection` artifact에 저장합니다(보존 1일). 공개 로그에는 결과 본문과 API 토큰을 출력하지 않습니다. 해당 개인키를 잃어버렸다면 새 키 쌍과 공개키로 다시 실행해야 합니다. 개인키를 GitHub에 등록하거나 커밋하지 마세요.
