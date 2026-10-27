#!/bin/bash
# Run on your own computer (macOS or Linux). It installs what it needs (the AWS CLI and the Session Manager
# plugin, under ~/.fieldtest/tools, no sudo), signs you in to AWS in the browser (aws login), creates a
# fieldtest server in your AWS account and opens its setup wizard:
#   curl -fsSL https://raw.githubusercontent.com/immensus-team/fieldtest/main/setup/launch.sh | bash -s -- --name shop
# Later:
#   bash launch.sh connect --name shop    # open the dashboard again
#   bash launch.sh delete --name shop     # delete the server and everything the stack made
set -euo pipefail
# Everything runs from main at the bottom: under `curl | bash` the script is read from stdin, and a
# command that reads stdin would otherwise eat the rest of it.

TEMPLATE=https://fieldtest-templates-7ca67686.s3.ap-northeast-2.amazonaws.com/ec2.yaml
TOOLS=$HOME/.fieldtest/tools
# aws login (console credentials in the browser) arrived in AWS CLI 2.32.0.
AWS_MIN=2.32
DOCS=https://github.com/immensus-team/fieldtest#readme

say() { printf '%s\n' "$*"; }
die() { printf '오류: %s\n' "$*" >&2; exit 1; }
usage() { die "사용법: launch.sh [create|connect|delete] --name <설치 이름> [--region <리전>] [--type <인스턴스 타입>]"; }


# Why the stack failed, from its first failed resource (an instance quota, a type the zone lacks).
failure() {
  "${AWS[@]}" cloudformation describe-stack-events --stack-name "$STACK" \
    --query "reverse(StackEvents[?ResourceStatus=='CREATE_FAILED'])[0].ResourceStatusReason" --output text 2>/dev/null
}

output() { "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

# A local port nothing listens on, from 4310 up.
free_port() {
  local p=4310
  while (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; do p=$((p + 1)); done
  echo "$p"
}

# major.minor of `aws --version` at least AWS_MIN.
aws_new_enough() {
  local v
  v=$(aws --version 2>/dev/null | sed -n 's#^aws-cli/\([0-9]*\)\.\([0-9]*\).*#\1 \2#p')
  [ -n "$v" ] || return 1
  set -- $v
  [ "$1" -gt 2 ] || { [ "$1" -eq 2 ] && [ "$2" -ge "${AWS_MIN#2.}" ]; }
}

# The AWS CLI and the Session Manager plugin, from AWS's own downloads, in the user's home: nothing asks
# for an administrator password. One already installed and new enough is used as it is.
install_tools() {
  local os arch tmp
  os=$(uname -s)
  arch=$(uname -m)
  mkdir -p "$TOOLS/bin"
  export PATH="$TOOLS/bin:$PATH"
  tmp=$(mktemp -d)
  if ! aws_new_enough; then
    say "AWS CLI를 설치합니다 ($TOOLS)."
    if [ "$os" = Darwin ]; then
      curl -fsSL https://awscli.amazonaws.com/AWSCLIV2.pkg -o "$tmp/AWSCLIV2.pkg"
      cat > "$tmp/choices.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <array>
    <dict>
      <key>choiceAttribute</key>
      <string>customLocation</string>
      <key>attributeSetting</key>
      <string>$TOOLS</string>
      <key>choiceIdentifier</key>
      <string>default</string>
    </dict>
  </array>
</plist>
XML
      installer -pkg "$tmp/AWSCLIV2.pkg" -target CurrentUserHomeDirectory -applyChoiceChangesXML "$tmp/choices.xml" >/dev/null
      ln -sf "$TOOLS/aws-cli/aws" "$TOOLS/bin/aws"
    else
      command -v unzip >/dev/null || die "unzip이 필요합니다 (예: sudo apt install unzip)."
      curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$([ "$arch" = aarch64 ] && echo aarch64 || echo x86_64).zip" -o "$tmp/awscliv2.zip"
      unzip -q "$tmp/awscliv2.zip" -d "$tmp"
      "$tmp/aws/install" -i "$TOOLS/aws-cli" -b "$TOOLS/bin" --update >/dev/null
    fi
    aws_new_enough || die "AWS CLI를 설치하지 못했습니다."
  fi
  if ! command -v session-manager-plugin >/dev/null; then
    say "Session Manager plugin을 설치합니다 ($TOOLS)."
    if [ "$os" = Darwin ]; then
      curl -fsSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/$([ "$arch" = arm64 ] && echo mac_arm64 || echo mac)/sessionmanager-bundle.zip" -o "$tmp/bundle.zip"
      unzip -q "$tmp/bundle.zip" -d "$tmp"
      mkdir -p "$TOOLS/sessionmanagerplugin"
      cp -R "$tmp/sessionmanager-bundle/." "$TOOLS/sessionmanagerplugin/"
      ln -sf "$TOOLS/sessionmanagerplugin/bin/session-manager-plugin" "$TOOLS/bin/session-manager-plugin"
    else
      command -v dpkg-deb >/dev/null || die "Session Manager plugin을 설치해 주세요: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html"
      curl -fsSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/$([ "$arch" = aarch64 ] && echo ubuntu_arm64 || echo ubuntu_64bit)/session-manager-plugin.deb" -o "$tmp/plugin.deb"
      dpkg-deb -x "$tmp/plugin.deb" "$TOOLS/plugin-deb"
      ln -sf "$TOOLS/plugin-deb/usr/local/sessionmanagerplugin/bin/session-manager-plugin" "$TOOLS/bin/session-manager-plugin"
    fi
    session-manager-plugin --version >/dev/null || die "Session Manager plugin을 설치하지 못했습니다."
  fi
  rm -rf "$tmp"
}

# Signed in already (a profile, keys, SSO), or a browser sign-in with the AWS console account.
sign_in() {
  aws sts get-caller-identity >/dev/null 2>&1 && return
  say "브라우저에서 AWS 콘솔 계정으로 로그인합니다."
  [ -n "$(aws configure get region 2>/dev/null || true)" ] || aws configure set region "$REGION"
  aws login </dev/tty || die "AWS에 로그인하지 못했습니다. IAM 사용자라면 SignInLocalDevelopmentAccess 정책이 필요합니다: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html"
  aws sts get-caller-identity >/dev/null 2>&1 || die "AWS 로그인을 확인하지 못했습니다."
}

open_url() {
  if command -v open >/dev/null; then open "$1"; elif command -v xdg-open >/dev/null; then xdg-open "$1" >/dev/null 2>&1; else say "브라우저에서 $1 을 여세요."; fi
}

# The SSM tunnel to the server's dashboard, then the browser once the wizard answers. The tunnel lives as
# long as this terminal.
connect() {
  local id port url tunnel
  id=$(output InstanceId)
  port=$(output OpenUrl | sed 's/.*://')
  [ -n "$id" ] && [ "$id" != None ] || die "$STACK 스택을 찾지 못했습니다 ($REGION)."
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && port=$(free_port)
  url=http://127.0.0.1:$port
  say "서버 연결을 기다립니다 ($id)."
  local tries=0
  until [ "$("${AWS[@]}" ssm describe-instance-information --filters "Key=InstanceIds,Values=$id" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" = Online ]; do
    tries=$((tries + 1))
    [ "$tries" -lt 90 ] || die "15분이 지나도 서버가 SSM에 연결되지 않습니다. 서브넷이 인터넷에 나갈 수 있는지 확인하세요."
    sleep 10
  done
  "${AWS[@]}" ssm start-session --target "$id" --document-name AWS-StartPortForwardingSession \
    --parameters "{\"portNumber\":[\"4310\"],\"localPortNumber\":[\"$port\"]}" </dev/null >/dev/null &
  tunnel=$!
  # The session-manager-plugin under aws holds the port; it goes with its parent.
  trap 'pkill -TERM -P $tunnel 2>/dev/null; kill $tunnel 2>/dev/null' EXIT HUP INT TERM
  say "설치가 끝나기를 기다립니다. 처음 설치는 10~15분 걸립니다."
  local waited=0
  until curl -fs -o /dev/null "$url/"; do
    kill -0 "$tunnel" 2>/dev/null || die "터널이 끊겼습니다. 다시 실행하세요: bash launch.sh connect --name $NAME"
    sleep 15
    waited=$((waited + 15))
    [ $((waited % 60)) -eq 0 ] && say "  ${waited}초째 기다리는 중"
    [ "$waited" -lt 2400 ] || die "40분이 지나도 응답이 없습니다. 설치 로그: $(output InstallLog)"
  done
  say "열었습니다: $url"
  open_url "$url"
  say "이 창을 닫으면 연결이 끊깁니다. 다시 열려면: bash launch.sh connect --name $NAME --region $REGION"
  wait "$tunnel"
}

main() {
ACTION=create
case "${1:-}" in create|connect|delete) ACTION=$1; shift ;; esac
NAME=""
REGION=""
TYPE=c8g.2xlarge
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME=${2:-}; shift 2 ;;
    --region) REGION=${2:-}; shift 2 ;;
    --type) TYPE=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$NAME" =~ ^[a-z0-9-]{1,32}$ ]] || die "--name은 영문 소문자·숫자·-, 32자 이하입니다 (예: --name shop)"
STACK=fieldtest-$NAME

[ "$(uname -s)" = Darwin ] || [ "$(uname -s)" = Linux ] || die "macOS나 Linux에서 실행하세요 (Windows는 WSL)."
install_tools
REGION=${REGION:-$(aws configure get region 2>/dev/null || true)}
REGION=${REGION:-ap-northeast-2}
sign_in
AWS=(aws --region "$REGION")

case "$ACTION" in
  create)
    STATUS=$("${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)
    if [ "$STATUS" = ROLLBACK_COMPLETE ]; then
      # A failed first try holds nothing; it is replaced.
      say "실패해 남은 $STACK 을 지우고 다시 만듭니다."
      "${AWS[@]}" cloudformation delete-stack --stack-name "$STACK"
      "${AWS[@]}" cloudformation wait stack-delete-complete --stack-name "$STACK"
    elif [ -n "$STATUS" ]; then
      say "$STACK 이(가) 이미 있습니다. 연결합니다."
      connect
      exit 0
    fi
    VPC=$("${AWS[@]}" ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
    [ "$VPC" != None ] || die "$REGION 에 기본 VPC가 없습니다. README의 Launch stack 링크로 VPC와 서브넷을 골라 만드세요: $DOCS"
    # A default subnet in a zone that offers the instance type.
    ZONES=$("${AWS[@]}" ec2 describe-instance-type-offerings --location-type availability-zone --filters "Name=instance-type,Values=$TYPE" --query 'InstanceTypeOfferings[].Location' --output text)
    [ -n "$ZONES" ] || die "$REGION 에서 $TYPE 을 쓸 수 없습니다. --type 으로 다른 Graviton 타입을 고르세요."
    SUBNET=$("${AWS[@]}" ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" Name=default-for-az,Values=true "Name=availability-zone,Values=$(echo $ZONES | tr ' ' ',')" --query 'Subnets[0].SubnetId' --output text)
    [ "$SUBNET" != None ] || die "기본 VPC에 $TYPE 을 쓸 수 있는 기본 서브넷이 없습니다."
    PORT=$(free_port)
    say "$REGION 에 $STACK 을 만듭니다 ($TYPE, 디스크 100 GB). 서버 비용은 이 AWS 계정에 청구됩니다."
    "${AWS[@]}" cloudformation create-stack --stack-name "$STACK" --template-url "$TEMPLATE" --capabilities CAPABILITY_IAM \
      --parameters "ParameterKey=InstallName,ParameterValue=$NAME" "ParameterKey=VpcId,ParameterValue=$VPC" \
      "ParameterKey=SubnetId,ParameterValue=$SUBNET" "ParameterKey=InstanceType,ParameterValue=$TYPE" \
      "ParameterKey=LocalPort,ParameterValue=$PORT" >/dev/null
    say "스택을 만드는 중입니다 (2~3분)."
    if ! "${AWS[@]}" cloudformation wait stack-create-complete --stack-name "$STACK" 2>/dev/null; then
      REASON=$(failure)
      case "$REASON" in
        *"vCPU"*) die "이 AWS 계정의 EC2 vCPU 한도가 모자랍니다. 더 작은 서버로 다시 실행하거나(--type c8g.xlarge) Service Quotas에서 한도를 늘리세요. 원인: $REASON" ;;
        *) die "스택을 만들지 못했습니다. 원인: ${REASON:-CloudFormation 콘솔에서 $STACK 의 이벤트를 확인하세요}" ;;
      esac
    fi
    connect
    ;;
  connect)
    connect
    ;;
  delete)
    say "$STACK 을 지웁니다. 서버와 디스크, 역할, 보안 그룹이 함께 지워집니다."
    "${AWS[@]}" cloudformation delete-stack --stack-name "$STACK"
    "${AWS[@]}" cloudformation wait stack-delete-complete --stack-name "$STACK"
    say "지웠습니다."
    ;;
esac
}

main "$@"
