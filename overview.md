# WorkBuddy 每日签到 — 实现总结

日期：2026-09-09

## 执行结果

**今日签到成功（今日已签到）**

```
[2026-09-09 18:10:13] 今日已签到（code=10001，今天已签到，请明天再来），无需重复领取。
[2026-09-09 18:10:13] RESULT: ALREADY
EXITCODE=0
```

说明：运行时该账号当天已完成签到，接口返回业务码 `10001`（今天已签到）。按幂等设计判定为**成功**，非失败。

## 做了什么

原工作区只有 `SKILL.md`，缺少 `scripts/`。补齐了完整实现：

| 文件 | 作用 |
|---|---|
| `scripts/decrypt-token.js` | 读取本地登录态。Node 主路径读 v5.3.8+ 明文 `workbuddy-desktop.info`；回退 Electron 解密旧版 `state.vscdb` |
| `scripts/checkin.js` | **签到主实现**（跨平台，Node 18+，推荐入口） |
| `scripts/checkin.sh` | macOS / Linux / Git Bash 版 |
| `scripts/checkin.ps1` | Windows PowerShell 版 |

结果语义统一：stdout 打印 `RESULT: SUCCESS | ALREADY | FAILED`，退出码 `0` = 成功（含今日已签到）、`1` = 失败。
日志写入 `logs/checkin-YYYY-MM-DD.log`，已确认不含任何令牌内容。

## 关键修正（实测发现，已回写 SKILL.md）

1. **业务码走 HTTP 400** —— `daily-checkin` 的 `code=10001`（今天已签到）是 **HTTP 400** 返回，不是 200。
   若先判 HTTP 后判业务码，会把「今日已签到」误报成失败（初版即踩此坑）。
   现已改为**先解析业务码，再回退 HTTP 状态码**。
2. 响应错误字段是 **`msg`**（非 `message`）。
3. `checkin-status` 真实字段为 `data.streak_days` / `data.total_credits` / `data.daily_credit` / `data.today_credit`。
4. `today_checked_in` 实测恒为 `false`（已签到也是 false），只能当快速路径，不能作最终判定。
5. Git Bash 两个坑：`env` 可能是 shim 会吞子进程输出（改用 `unset`）；Windows 版 node/curl 不认 MSYS 路径 `/e/...`、`/tmp/...`（需 `cygpath -w`，否则 node 静默无输出、curl 返回 000）。

## 定时任务

已创建自动化「WorkBuddy 每日积分签到」：每天 09:00 执行一次，运行 `node scripts/checkin.js`，
汇报「签到成功 / 今日已签到 / 失败（附原因）」。

## 待确认

- 当前为单一时间点（09:00）。若电脑常在该时段关机，可再加晚间补签时间点（脚本幂等，重复运行无副作用）。
- `checkin.ps1` 未能在本沙箱实际执行验证（PowerShell 工具在此环境不回显输出），逻辑已与 `checkin.js` 对齐，建议本地手动跑一次确认。
