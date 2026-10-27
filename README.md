# fieldtest

웹·데스크톱 앱 레포를 24시간 직접 써 보며 결함을 찾고, 고치고, PR로 올리는 QA 에이전트다. 자기 서버에 설치해서
검사할 레포 하나를 연결한다. 설치를 여러 개 만들면 레포 여러 개를 따로 검사할 수 있다.

- 탐색: 사용 세션이 업무 목표를 정해 앱을 쓰고, 판정 세션이 어긋난 단계를 재현해 결함·개선·의도된 동작으로 가른다.
- 수정: 구현 세션이 재현 테스트를 먼저 쓰고 고친다. 실행기가 테스트 조작·변경 크기·레포 검사를 확인하고, Codex가 검토한다.
- 사람: 대시보드나 Slack에서 티켓마다 진행·거절·수정을 고른다. 진행하면 PR이 열리고, 서버의 Codex 리뷰와 CI를 거쳐 merge된다.
- 레시피: 처음 설치할 때 에이전트가 레포를 읽고 설치·실행·로그인·검사 방법을 정해 직접 돌려 본다. 깨지면 스스로 고친다.

## 준비물

| 무엇 | 쓰는 곳 |
| --- | --- |
| AWS 계정 (또는 Ubuntu 24.04 서버) | 에이전트가 도는 서버. 기본 `c8g.2xlarge`, 디스크 100 GB |
| AWS CLI와 [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) | 내 컴퓨터에서 대시보드 열기 |
| GitHub 계정 | 검사할 레포에 push 권한. PR과 merge가 이 계정 이름으로 남는다 |
| Claude 구독 | 탐색·판정·구현 세션 |
| ChatGPT 구독 (Codex) | 코드 검토와 PR 리뷰 |
| Slack 워크스페이스 (선택) | 사람이 결정할 티켓과 오류 알림 (DM). 없으면 대시보드에서만 본다 |

서버 비용은 내 AWS 계정에, AI 사용량은 내 구독에 청구된다.

## 설치

### 1. 서버 만들기

[**Launch stack (서울 리전)**](https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks/quickcreate?templateURL=https://fieldtest-templates-7ca67686.s3.ap-northeast-2.amazonaws.com/ec2.yaml&stackName=fieldtest-main&param_InstallName=main)
링크를 열면 AWS 콘솔에 [`setup/ec2.yaml`](setup/ec2.yaml)이 채워진 스택 생성 화면이 나온다. 다른 리전은 링크의 `region=`을
바꾸거나, CloudFormation에서 **스택 생성 → 템플릿 파일 업로드**로 같은 파일을 올린다.

- 스택 이름: `fieldtest-<설치 이름>` (예: `fieldtest-shop`)
- `InstallName`: 설치 이름. 영문 소문자·숫자·`-`
- `VpcId`, `SubnetId`: 인터넷이 되는 서브넷 (기본 VPC면 된다)
- `LocalPort`: 내 컴퓨터에서 쓸 포트. 설치를 여러 개 동시에 열려면 설치마다 다르게 준다 (4310, 4311, …)
- IAM 역할을 만든다는 확인란에 체크한다.

서버가 뜨면 설치 스크립트가 10~15분 돈다. 인바운드 포트는 열지 않는다.

AWS가 아닌 Ubuntu 24.04 서버라면:

```bash
sudo git clone https://github.com/immensus-team/fieldtest.git /srv/fieldtest/code
sudo bash /srv/fieldtest/code/setup/install.sh base --name <설치 이름>
```

### 2. 접속

스택의 Outputs에 있는 `ConnectCommand`를 내 컴퓨터에서 실행하고, `OpenUrl`(예: `http://127.0.0.1:4310`)을 연다.
AWS가 아닌 서버는 `ssh -L 4310:127.0.0.1:4310 <서버>`로 연다.

### 3. 설치 마법사

브라우저에서 단계를 따라간다. 단계마다 바로 확인하고, 창을 닫아도 이어서 할 수 있다.

1. 서버 점검
2. GitHub 로그인 (device code)
3. 검사할 레포 고르기
4. Claude 연결 (승인 후 코드 붙여 넣기)
5. Codex 연결 (브라우저에서 승인한 뒤, 넘어간 주소를 붙여 넣기)
6. Slack (선택): manifest로 앱 만들기 → 토큰 두 개 넣기 → 봇에게 DM 보내기. "Slack 없이 계속"으로 건너뛰면
   알림은 대시보드에서만 본다. 나중에 대시보드의 서버 화면에서 "Slack 연결"로 이어서 연결한다
7. 레시피 만들기: 에이전트가 레포를 읽고 실행 방법을 정해 직접 검증한다. 가짜 값으로 안 되는 키가 있으면 여기서 묻는다
8. 레시피 확인: 실행 방법과 화면 스크린샷을 보고 시작하거나 고칠 점을 적는다
9. 시작: 루프·watch(연결했다면 Slack도)가 켜지고 대시보드로 넘어간다

Playwright e2e가 없는 레포는 "e2e 준비" 제안 티켓이 먼저 올라온다. 그 PR이 merge되면 탐색이 시작된다.

## 쓰기

대시보드에서 티켓을 보고 진행·거절·수정을 고른다. Slack 메시지의 버튼이나 스레드 답장(`진행`, `거절 <이유>`,
`수정 <내용>`)도 같다. 서버에서는 사람 계정으로 CLI를 쓸 수 있다:

```bash
sudo -iu fieldtest fieldtest status
sudo -iu fieldtest fieldtest show QA-0001
sudo -iu fieldtest fieldtest recipe show
```

새 레포는 모든 티켓이 사람 승인을 거친다. 자동으로 merge할 작은 수정의 기준은 레시피의 `autoRoute`로 정한다.

## 업데이트와 삭제

```bash
sudo -iu fieldtest git -C /srv/fieldtest/code pull
sudo -iu fieldtest bash /srv/fieldtest/code/setup/start.sh
```

삭제는 CloudFormation 스택을 지우면 된다.

## 구조

- 사람 계정(`fieldtest`): GitHub 로그인, Slack 토큰, 승인된 레시피, 대시보드·watch·Slack 서비스.
- 에이전트 계정(`fieldtest-agent`): Claude·Codex 로그인, 루프, rootless Docker. GitHub에 쓸 수 없고, 사람 소유
  미러에서만 읽고, 승인된 레시피를 바꿀 수 없다. 인스턴스 메타데이터(IAM 자격 증명)에 접근하지 못한다.
- 코드 `/srv/fieldtest/code`, 데이터 `/srv/fieldtest/data`, 설정 `/etc/fieldtest/install.json`.

## 검사

```bash
npm test
cd web && npm run typecheck && npm run build
```

이 저장소에는 라이선스가 없다. 코드를 볼 수는 있지만 사용·수정·배포 권한은 주지 않는다.
