#Requires -Version 5.1
<#
.SYNOPSIS
    WorkBuddy 每日积分签到（Windows）

.DESCRIPTION
    读取本机 WorkBuddy 桌面端登录态 -> 调用腾讯官方签到接口。
    幂等：今日已签到会直接跳过，重复运行无副作用。

    结果以一行 machine-readable 摘要输出：
        RESULT: SUCCESS | ALREADY | FAILED
    退出码：0 = 成功（含今日已签到），1 = 失败

.PARAMETER NodePath
    指定 Node 二进制路径（也可用环境变量 WB_CHECKIN_NODE）

.PARAMETER ElectronPath
    指定 Electron 二进制路径，仅旧版 state.vscdb 回退分支需要
#>
param(
    [string]$NodePath = $env:WB_CHECKIN_NODE,
    [string]$ElectronPath = $env:WB_CHECKIN_ELECTRON
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$LogDir    = Join-Path $RootDir 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir ("checkin-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

$STATUS_URL = 'https://copilot.tencent.com/v2/billing/meter/checkin-status'
$CHECKIN_URL = 'https://copilot.tencent.com/v2/billing/meter/daily-checkin'

function Write-Log {
    param([string]$Msg)
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Msg
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Stop-WithResult {
    param([ValidateSet('SUCCESS','ALREADY','FAILED')][string]$Result, [string]$Msg)
    Write-Log $Msg
    Write-Log "RESULT: $Result"
    # 令牌绝不写入日志；临时文件在此清理
    Remove-TempFiles
    if ($Result -eq 'FAILED') { exit 1 } else { exit 0 }
}

$TempFiles = @()
function Remove-TempFiles {
    foreach ($f in $script:TempFiles) {
        if ($f -and (Test-Path $f)) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
    }
}

# ---------- 0. 错峰（可选） ----------
if ($env:WB_CHECKIN_JITTER) {
    $j = 0
    if ([int]::TryParse($env:WB_CHECKIN_JITTER, [ref]$j) -and $j -gt 0) {
        $wait = Get-Random -Minimum 0 -Maximum ($j + 1)
        Write-Log "错峰等待 ${wait}s"
        Start-Sleep -Seconds $wait
    }
}

# ---------- 1. 定位 Node ----------
if (-not $NodePath) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $NodePath = $cmd.Source }
}
if (-not $NodePath -or -not (Test-Path $NodePath)) {
    Stop-WithResult 'FAILED' '未找到 Node.js。请安装 Node.js，或用环境变量 WB_CHECKIN_NODE 指定路径。'
}

# ---------- 2. 取令牌 ----------
$decryptJs = Join-Path $ScriptDir 'decrypt-token.js'
if (-not (Test-Path $decryptJs)) { Stop-WithResult 'FAILED' "缺少 $decryptJs" }

if ($ElectronPath) { $env:WB_CHECKIN_ELECTRON = $ElectronPath }

$tokenJson = $null
try {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $raw = & $NodePath $decryptJs 2>$null
    $ErrorActionPreference = $prev
    $tokenJson = ($raw | Where-Object { $_ -and $_.Trim().StartsWith('{') } | Select-Object -Last 1)
} catch {
    Stop-WithResult 'FAILED' ('获取令牌失败：' + $_.Exception.Message)
}
if (-not $tokenJson) { Stop-WithResult 'FAILED' '获取令牌失败（未知原因）。请确认 WorkBuddy 桌面端已登录。' }

try { $tok = $tokenJson | ConvertFrom-Json } catch { Stop-WithResult 'FAILED' '令牌解析失败' }
if (-not $tok.ok) { Stop-WithResult 'FAILED' ('获取令牌失败：' + $tok.error) }

$AccessToken = $tok.accessToken
$Uid = $tok.uid
Write-Log "登录态来源：$($tok.source)"

# ---------- 3. 构造请求头（令牌写入临时文件，避免出现在命令行/进程列表） ----------
$hdrFile = Join-Path $env:TEMP ("wb-hdr-{0}.txt" -f [guid]::NewGuid().ToString('N'))
$TempFiles += $hdrFile
$headers = @()
$headers += "Authorization: Bearer $AccessToken"
if ($Uid) { $headers += "X-User-Id: $Uid" }
if ($tok.domain) { $headers += "X-Domain: $($tok.domain)" }
if ($tok.enterpriseId) { $headers += "X-Enterprise-Id: $($tok.enterpriseId)" }
if ($tok.tenantId) { $headers += "X-Tenant-Id: $($tok.tenantId)" }
$headers += 'Content-Type: application/json'
$headers += 'Accept: application/json'
$headers += 'User-Agent: WorkBuddy-Checkin/1.0.3'
Set-Content -Path $hdrFile -Value $headers -Encoding ASCII

# 令牌用完即从内存变量清除（管道已被 curl 消费）
Remove-Variable -Name AccessToken -ErrorAction SilentlyContinue

function Invoke-Api {
    param([string]$Url)
    $bodyFile = Join-Path $env:TEMP ("wb-body-{0}.txt" -f [guid]::NewGuid().ToString('N'))
    $script:TempFiles += $bodyFile
    $code = '000'
    try {
        # -H @file 避免令牌进入命令行；-o 分离响应体；-w 取真实 HTTP 状态码
        $code = (& curl.exe -s -X POST $Url -H "@$hdrFile" -d '{}' -o $bodyFile -w '%{http_code}' --max-time 30)
    } catch {
        return @{ Http = 0; Body = ''; Err = $_.Exception.Message }
    }
    $body = ''
    if (Test-Path $bodyFile) { $body = Get-Content $bodyFile -Raw -ErrorAction SilentlyContinue }
    return @{ Http = [int]($code | Select-Object -Last 1); Body = $body; Err = '' }
}

# ---------- 4. 查状态（幂等快速路径） ----------
$already = $false
try {
    $st = Invoke-Api $STATUS_URL
    if ($st.Http -eq 200 -and $st.Body) {
        $sj = $st.Body | ConvertFrom-Json
        $flag = $null
        if ($sj.PSObject.Properties['today_checked_in']) { $flag = $sj.today_checked_in }
        elseif ($sj.data -and $sj.data.PSObject.Properties['today_checked_in']) { $flag = $sj.data.today_checked_in }
        # 注意：v5.3.8 实测该字段可能不可靠（签完仍是 false），故仅作快速路径，不作为最终判定
        if ($flag -eq $true) { $already = $true }
    }
} catch { Write-Log '查询签到状态失败，继续尝试签到' }

if ($already) {
    Stop-WithResult 'ALREADY' '今日已签到（状态接口命中），跳过。'
}

# ---------- 5. 执行签到 ----------
$res = Invoke-Api $CHECKIN_URL
if ($res.Err) { Stop-WithResult 'FAILED' ('签到请求异常：' + $res.Err) }

# 401 判定必须用真实 HTTP 状态码：响应体里的随机 requestId 可能恰好含 '401' 造成误判
$bodyText = if ($res.Body) { $res.Body } else { '' }

# 重要：该网关用 HTTP 400 承载业务码（「今天已签到」code=10001 就是 400 返回），
# 必须先解析业务码，不能先把非 2xx 一律判为失败。
$parsed = $null
try { if ($bodyText) { $parsed = $bodyText | ConvertFrom-Json } } catch { $parsed = $null }

if ($parsed) {
    $code = $null
    $msg = ''
    if ($parsed.PSObject.Properties['code']) { $code = [string]$parsed.code }
    if ($parsed.PSObject.Properties['msg']) { $msg = [string]$parsed.msg }
    elseif ($parsed.PSObject.Properties['message']) { $msg = [string]$parsed.message }

    if ($code -eq '10001') {
        $extra = if ($msg) { "，$msg" } else { '' }
        Stop-WithResult 'ALREADY' "今日已签到（code=10001$extra），无需重复领取。"
    }
    if ($code -eq '0' -or $code -eq '200' -or $code -eq 'success') {
        $d = if ($parsed.data) { $parsed.data } else { $parsed }
        $credits = $null; $streak = $null
        foreach ($p in @('credits','credit','today_credit','daily_credit','rewardCredits','checkinCredits','awardCredits','points')) {
            if ($d.PSObject.Properties[$p]) { $credits = $d.$p; break }
        }
        foreach ($p in @('streak_days','continuousDays','consecutiveDays','streak','checkinDays','continuous_checkin_days')) {
            if ($d.PSObject.Properties[$p]) { $streak = $d.$p; break }
        }
        $detail = @()
        if ($null -ne $credits) { $detail += "获得 $credits 积分" }
        if ($null -ne $streak)  { $detail += "连续 $streak 天" }
        $tail = if ($detail.Count -gt 0) { '（' + ($detail -join '，') + '）' } else { '' }
        Stop-WithResult 'SUCCESS' "签到成功$tail"
    }
    if ($res.Http -eq 401 -or $res.Http -eq 403) {
        Stop-WithResult 'FAILED' "令牌已过期（HTTP $($res.Http)，code=$code）。请打开 WorkBuddy 桌面端刷新登录态后重试。"
    }
    Stop-WithResult 'FAILED' "签到未成功：code=$code $msg（HTTP $($res.Http)）"
}

# 无 JSON 响应体：此时才用 HTTP 状态码判定
if ($res.Http -eq 401 -or $res.Http -eq 403) {
    Stop-WithResult 'FAILED' "令牌已过期（HTTP $($res.Http)）。请打开 WorkBuddy 桌面端刷新登录态后重试。"
}
if ($res.Http -ge 500) {
    Stop-WithResult 'FAILED' "服务端错误：HTTP $($res.Http)"
}
if ($res.Http -lt 200 -or $res.Http -ge 300) {
    Stop-WithResult 'FAILED' "签到请求失败：HTTP $($res.Http)"
}
Stop-WithResult 'SUCCESS' "签到请求已发出并返回 HTTP $($res.Http)（响应非 JSON）。"
