#!/usr/bin/env bash
#
# checkin.sh — WorkBuddy 每日积分签到（macOS / Linux / Git Bash）
#
# 结果以一行 machine-readable 摘要输出：
#     RESULT: SUCCESS | ALREADY | FAILED
# 退出码：0 = 成功（含今日已签到），1 = 失败
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/checkin-$(date +%F).log"

STATUS_URL="https://copilot.tencent.com/v2/billing/meter/checkin-status"
CHECKIN_URL="https://copilot.tencent.com/v2/billing/meter/daily-checkin"

TMP_FILES=()
cleanup() { for f in "${TMP_FILES[@]:-}"; do [ -n "$f" ] && rm -f "$f" 2>/dev/null; done; }

log() {
  local line="[$(date '+%F %T')] $1"
  echo "$line"
  echo "$line" >>"$LOG_FILE"
}

finish() { # $1=RESULT $2=MSG
  log "$2"
  log "RESULT: $1"
  cleanup
  [ "$1" = "FAILED" ] && exit 1
  exit 0
}

# ---------- 0. 错峰（可选） ----------
if [ -n "${WB_CHECKIN_JITTER:-}" ]; then
  j=$(shuf -i 0-"$WB_CHECKIN_JITTER" -n 1 2>/dev/null || echo 0)
  [ "${j:-0}" -gt 0 ] && { log "错峰等待 ${j}s"; sleep "$j"; }
fi

# ---------- 1. 定位 Node ----------
NODE_BIN="${WB_CHECKIN_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"; fi
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  finish FAILED "未找到 Node.js。请安装 Node.js，或用 WB_CHECKIN_NODE 指定路径。"
fi

# ---------- 2. 取令牌 ----------
# 注意：Git Bash 里 pwd 给出 MSYS 路径（/e/...），Windows 版 node.exe 无法识别，
# 必须用 cygpath 转成 Windows 路径，否则 node 静默无输出。
DECRYPT_JS="$SCRIPT_DIR/decrypt-token.js"
if command -v cygpath >/dev/null 2>&1; then
  DECRYPT_JS="$(cygpath -w "$DECRYPT_JS" 2>/dev/null || echo "$DECRYPT_JS")"
fi
[ -f "$DECRYPT_JS" ] || [ -f "$SCRIPT_DIR/decrypt-token.js" ] || finish FAILED "缺少 $DECRYPT_JS"

# 注意：不要用 `env -u ELECTRON_RUN_AS_NODE`（某些 Git Bash 的 env 是 shim，会吞掉子进程输出），
# 直接 unset 即可——checkin.sh 本身就在独立进程里运行。
unset ELECTRON_RUN_AS_NODE
TOKEN_JSON="$("$NODE_BIN" "$DECRYPT_JS" 2>/dev/null | grep '^{' | tail -n 1)"
[ -n "$TOKEN_JSON" ] || finish FAILED "获取令牌失败（未知原因）。请确认 WorkBuddy 桌面端已登录。"

get_field() { # sed 解析优先，回退 python3
  printf '%s' "$TOKEN_JSON" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}
OK="$(printf '%s' "$TOKEN_JSON" | sed -n 's/.*"ok"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -n 1)"
if [ "$OK" != "true" ]; then
  ERR="$(get_field error)"
  finish FAILED "获取令牌失败：${ERR:-未知原因}"
fi

ACCESS_TOKEN="$(get_field accessToken)"
UID_V="$(get_field uid)"
DOMAIN_V="$(get_field domain)"
ENTERPRISE_V="$(get_field enterpriseId)"
TENANT_V="$(get_field tenantId)"
SOURCE_V="$(get_field source)"
[ -n "$ACCESS_TOKEN" ] || finish FAILED "获取令牌失败：accessToken 为空"
log "登录态来源：${SOURCE_V:-unknown}"

# ---------- 3. 请求头（写入临时文件，避免令牌进入命令行） ----------
HDR_FILE="$(mktemp 2>/dev/null || echo "/tmp/wb-hdr-$$.txt")"
TMP_FILES+=("$HDR_FILE")
{
  echo "Authorization: Bearer $ACCESS_TOKEN"
  [ -n "$UID_V" ] && echo "X-User-Id: $UID_V"
  [ -n "$DOMAIN_V" ] && echo "X-Domain: $DOMAIN_V"
  [ -n "$ENTERPRISE_V" ] && echo "X-Enterprise-Id: $ENTERPRISE_V"
  [ -n "$TENANT_V" ] && echo "X-Tenant-Id: $TENANT_V"
  echo "Content-Type: application/json"
  echo "Accept: application/json"
  echo "User-Agent: WorkBuddy-Checkin/1.0.3"
} >"$HDR_FILE"
unset ACCESS_TOKEN

api() { # $1=url ; 打印 "HTTPCODE<TAB>BODY"
  local url="$1" bf bfw hdw
  bf="$(mktemp 2>/dev/null || echo "/tmp/wb-body-$$.txt")"
  TMP_FILES+=("$bf")
  # Windows 版 curl.exe 不认识 MSYS 路径（/tmp/...），必须转成 Windows 路径，
  # 否则 -o 写入失败，curl 返回 000。
  bfw="$bf"; hdw="$HDR_FILE"
  if command -v cygpath >/dev/null 2>&1; then
    bfw="$(cygpath -w "$bf" 2>/dev/null || echo "$bf")"
    hdw="$(cygpath -w "$HDR_FILE" 2>/dev/null || echo "$HDR_FILE")"
  fi
  local code
  code="$(curl -s -X POST "$url" -H "@$hdw" -d '{}' -o "$bfw" -w '%{http_code}' --max-time 30 2>/dev/null)"
  printf '%s\t%s' "${code:-000}" "$(cat "$bf" 2>/dev/null)"
}

# ---------- 4. 查状态（快速路径，字段不可靠仅作参考） ----------
STATUS_OUT="$(api "$STATUS_URL")"
STATUS_CODE="${STATUS_OUT%%$'\t'*}"
STATUS_BODY="${STATUS_OUT#*$'\t'}"
if [ "$STATUS_CODE" = "200" ] && printf '%s' "$STATUS_BODY" | grep -q '"today_checked_in"[[:space:]]*:[[:space:]]*true'; then
  finish ALREADY "今日已签到（状态接口命中），跳过。"
fi

# ---------- 5. 执行签到 ----------
OUT="$(api "$CHECKIN_URL")"
HTTP="${OUT%%$'\t'*}"
BODY="${OUT#*$'\t'}"

# 重要：该网关用 HTTP 400 承载业务码（「今天已签到」code=10001 就是 400 返回），
# 必须先解析业务码，不能先把非 2xx 一律判为失败。
RESP_CODE="$(printf '%s' "$BODY" | sed -n 's/.*"code"[[:space:]]*:[[:space:]]*"\{0,1\}\([0-9A-Za-z_]*\)"\{0,1\}.*/\1/p' | head -n 1)"
RESP_MSG="$(printf '%s' "$BODY" | sed -n 's/.*"\(msg\|message\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\2/p' | head -n 1)"

if [ "$RESP_CODE" = "10001" ]; then
  finish ALREADY "今日已签到（code=10001${RESP_MSG:+，$RESP_MSG}），无需重复领取。"
fi

if [ "$RESP_CODE" = "0" ] || [ "$RESP_CODE" = "200" ] || [ "$RESP_CODE" = "success" ]; then
  CREDITS="$(printf '%s' "$BODY" | sed -n 's/.*"\(credits\|credit\|today_credit\|daily_credit\|rewardCredits\|checkinCredits\|awardCredits\|points\)"[[:space:]]*:[[:space:]]*"\{0,1\}\([0-9]*\)"\{0,1\}.*/\2/p' | head -n 1)"
  STREAK="$(printf '%s' "$BODY" | sed -n 's/.*"\(streak_days\|continuousDays\|consecutiveDays\|streak\|checkinDays\|continuous_checkin_days\)"[[:space:]]*:[[:space:]]*"\{0,1\}\([0-9]*\)"\{0,1\}.*/\2/p' | head -n 1)"
  DETAIL=""
  [ -n "$CREDITS" ] && DETAIL="获得 $CREDITS 积分"
  [ -n "$STREAK" ] && DETAIL="${DETAIL:+$DETAIL，}连续 $STREAK 天"
  finish SUCCESS "签到成功${DETAIL:+（$DETAIL）}"
fi

# 其余情况交给 HTTP 状态码判定
case "$HTTP" in
  401|403) finish FAILED "令牌已过期（HTTP $HTTP${RESP_CODE:+，code=$RESP_CODE}）。请打开 WorkBuddy 桌面端刷新登录态后重试。" ;;
esac
if printf '%s' "$HTTP" | grep -qE '^5[0-9][0-9]$'; then
  finish FAILED "服务端错误：HTTP $HTTP"
fi
if ! printf '%s' "$HTTP" | grep -qE '^2[0-9][0-9]$'; then
  finish FAILED "签到请求失败：HTTP $HTTP${RESP_CODE:+，code=$RESP_CODE} ${RESP_MSG}"
fi
finish FAILED "签到未成功：code=${RESP_CODE:-未知} ${RESP_MSG}（HTTP $HTTP）"
