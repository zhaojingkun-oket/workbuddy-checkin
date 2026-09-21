# WorkBuddy 每日签到 — 云端无人值守版部署指南

**目标**：电脑关机也能每天自动签到。

**原理**：把签到脚本托管到 GitHub Actions，由 GitHub 的服务器按点执行。你的电脑只负责**偶尔导出一次令牌**，其余时间完全不用管。

---

## 一、为什么必须换到云端

原来的定时任务跑在你自己电脑上，由 WorkBuddy 客户端进程调度。**电脑关机 → 进程不在 → 任务不会被触发**，这不是改时间能解决的。

云端方案把"谁来触发"这件事交给 GitHub 的服务器：

| | 原方案（本机） | 新方案（GitHub Actions） |
|---|---|---|
| 触发方 | 你的电脑 | GitHub 服务器 |
| 电脑关机 | ❌ 不签到 | ✅ 照常签到 |
| 费用 | 免费 | 免费（公开仓库） |
| 需要你做的事 | 什么都不用 | 每 55 天左右重新导出一次令牌 |

---

## 二、前置条件

- 一个 GitHub 账号（已有）
- 本机能登录 WorkBuddy 桌面端（导出令牌用）
- git（已验证本机可用，版本 2.42.0）

---

## 三、部署步骤

### 第 1 步：在 GitHub 上建仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `workbuddy-checkin`
3. 可见性选 **Public**（公开仓库的 Actions 完全免费；私有仓库每月只有 2000 分钟免费额度，签到用不到 1 分钟，其实也够，但公开更省心）
4. **不要**勾选 "Add a README file"（避免冲突）
5. 点 **Create repository**

### 第 2 步：把本项目推上去

在本项目目录 `E:\Desktop\签到自动任务` 下执行（把 `你的用户名` 换成实际 GitHub 用户名）：

```bash
cd /e/Desktop/签到自动任务
git init
git add .github cloud .gitignore
git commit -m "feat: WorkBuddy 云端签到"
git branch -M main
git remote add origin https://github.com/你的用户名/workbuddy-checkin.git
git push -u origin main
```

> 推送时会要求登录。密码位置要填 **Personal Access Token**（不是账号密码）。
> 生成方式：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token，勾选 `repo` 权限，生成后复制。

### 第 3 步：导出登录态并写进 Secret

**3.1 先在本机导出令牌**（在 `E:\Desktop\签到自动任务` 下执行）：

```bash
node cloud/export-auth.js
```

会输出一整行 JSON（形如 `{"auth":{"accessToken":"...`）。**整行复制下来**，别漏字符。

3.2 打开仓库页面 → **Settings** → 左侧 **Secrets and variables** → **Actions** → 点 **New repository secret**

- **Name** 填：`WORKBUDDY_AUTH`
- **Secret** 粘贴刚复制的那整行 JSON
- 点 **Add secret**

> 存成 Secret 后，这个值在 GitHub 上是加密的，日志里只会显示 `***`，不会泄漏。

### 第 4 步：手动跑一次验证

1. 仓库页面 → **Actions** 标签
2. 左侧选 **WorkBuddy 每日签到**
3. 右侧点 **Run workflow** → 绿色按钮 **Run workflow**
4. 等十几秒，点进这次运行记录，看 **执行签到** 这一步的日志

**期望看到**：
```
[2026-09-21 09:46:44] 今日已签到（code=10001，今天已签到，请明天再来），无需重复领取。
[2026-09-21 09:46:44] RESULT: ALREADY
```

只要你看到 `RESULT: SUCCESS` 或 `RESULT: ALREADY`，就说明**云端链路完全打通了**。

---

## 四、执行时间

workflow 里配了两个时间点（**cron 按 UTC 解释，无时区概念**）：

| cron | UTC | 北京时间 | 作用 |
|---|---|---|---|
| `0 1 * * *` | 01:00 | **09:00** | 主签到 |
| `0 5 * * *` | 05:00 | **13:00** | 兜底（9 点挂了时补） |

脚本幂等：第二次执行会返回 `ALREADY`，不会重复领，也不会报错。

> ⚠️ GitHub Actions 的定时任务**不保证准点**。高峰期可能延迟 5~30 分钟，极端情况会跳过。
> 签到只要当天内完成即可，延迟无影响。

---

## 五、日常维护（这是唯一需要你动手的地方）

### 令牌有效期

令牌存的是"导出那一刻"的登录态，当前实测有效期约 **55 天**（`expiresAt`）。

**到期前必须重新导出一次**，否则签到会失败并报「令牌已过期」。

**怎么知道该换了？** 现在有多重提醒：

1. **自动预警（新增）**：脚本每次运行都会读取令牌剩余天数。**低于 10 天时**，
   workflow 会主动把这次运行判定为失败，从而触发 **GitHub 失败邮件** —— 你收到邮件就知道该重导了。
   预警阈值可用环境变量 `WB_CHECKIN_WARN_DAYS` 调整。
2. **日志可见**：每次签到日志都会打印「令牌剩余有效期：X 天」，可在 Actions 摘要直接看到。
3. **被动发现**：令牌真过期后签到会失败，同样会发失败邮件。

### 重新导出的步骤（约 1 分钟）

```bash
# 1. 先确保 WorkBuddy 桌面端是登录状态（打开一下即可）
# 2. 导出新令牌
cd /e/Desktop/签到自动任务
node cloud/export-auth.js

# 3. 复制输出的整行 JSON，到仓库 Settings → Secrets → Actions
#    点 WORKBUDDY_AUTH → Update secret → 粘贴新值 → 保存
```

---

## 五之一、关于「令牌自动更新」的结论

**自动刷新令牌在本方案中不可行，已实测确认。** 记录如下，避免后人重复踩坑。

### 桌面端的刷新机制（从源码确认）

`codebuddy-headless.js` 中的刷新实现：

```js
authToken = (await this.restOperations.post(`/v2${this.prefixPath}/auth/token/refresh`, {}, {
  headers: {
    ...this.enterpriseHeaders(session.auth),
    "X-Refresh-Token": session.auth.refreshToken,
    "X-Auth-Refresh-Source": "plugin",
  }
})).data.data;
```

- 刷新令牌走 **`X-Refresh-Token` 请求头**（不是 body）
- 真实路径带一个 **`prefixPath`** 变量，其取值来自运行时注入的产品配置
  （`configuration.authentication.attributes.prefixPath`），源码中**没有硬编码默认值**
- 认证 endpoint 来自注入配置（源码里 `DEV_ENV_ENDPOINTS` 显示 prod 为
  `https://copilot.tencent.com`），但认证路由与计费路由不在同一前缀下

### 实测过程与结论

对以下域名逐一探测：
`copilot.tencent.com`、`www.codebuddy.cn`、`www.workbuddy.cn`、
`tencent.sso.codebuddy.cn`、`codebuddy.cn`

结论：
- **计费/签到接口**（`/v2/billing/meter/*`）在多个域名均可访问，返回 200
- **认证/刷新接口**在**全部域名、全部路径变体下均为 404**

对照实验（用于判定 404 性质）：

| 请求路径 | 响应 | 判定 |
|---|---|---|
| `/zzz/definitely-not-exist` | `404 Route Not Found` | 网关层无此路由 |
| `/Auth/Token/Refresh`（大小写变体） | `404 Route Not Found` | 网关层无此路由 |
| `/auth/token/refresh` | `Unable to find matching target resource method` | 请求到达了后端 |

后者说明网关**对 `/auth/*` 整段前缀做了转发**，但后端不认我们构造的方法调用格式。
共尝试约 60 余种组合（路径后缀 `/refresh` `/Refresh` `/refreshToken` `/token`；
查询参数 `?method=` `?action=`；请求头 `X-Action` `X-TC-Action`；
body 内 `method` / `action`；GET / POST 方法），**均未命中**。

### 为什么不继续挖

继续唯一切实可行的办法是**抓桌面端真实发出的刷新请求**（需在本机配置抓包代理），
但收益有限：refreshToken 有效期仅比 accessToken 长 5 天（60 天 vs 55 天）。
**即自动续期最多把"每 55 天手动一次"变成"每 60 天手动一次"。**

因此**放弃自动刷新，改用到期预警**（见上一节）：把"手动导出"的间隔缩到最短、并确保你不会忘记。

> 若日后确需自动续期，正确路径是抓包拿到桌面端的实际请求（含 `prefixPath` 取值），
> 再按该格式构造请求。当前已知信息不足，不宜继续盲试。

---

## 六、邮件通知

用的是 **GitHub 自带的邮件通知**，不用配任何 SMTP。

| 场景 | 是否发邮件 | 说明 |
|---|---|---|
| 签到成功 | ❌ 不发 | 每天发成功邮件会变成骚扰 |
| 签到失败 | ✅ 发 | 代表真出问题了 |
| **令牌剩 10 天以内** | ✅ 发 | 主动预警，提醒你该重导令牌了 |

前两种情况都发给仓库 owner 的 GitHub 注册邮箱。

如果你希望**签到成功也收到邮件**，在 workflow 文件末尾加一个步骤即可，告诉我我来加。

> 收不到邮件？去 GitHub → Settings → Notifications → 确认 **Actions** 通知是开启的、且邮箱已验证。

---

## 七、文件说明

```
签到自动任务/
├── .github/workflows/checkin.yml   # 云端定时任务定义（cron、Secret 引用、到期预警）
├── cloud/
│   ├── checkin.js                  # 云端签到主脚本（从环境变量读令牌 + 有效期预警）
│   ├── export-auth.js              # 本机导出令牌（生成要填进 Secret 的 JSON）
│   └── verify-cloud.js             # 交付前自检（21 项，不联网）
├── .gitignore                      # 排除 auth.json / logs，防令牌误提交
├── scripts/                        # 原有本机版脚本（保留，可继续本地手动跑）
└── CLOUD_DEPLOY.md                 # 本文档
```

**云端版与本地版的区别**：只有"令牌从哪来"不同。本地版读桌面端的登录态文件；云端版读环境变量。签到接口、业务码处理、幂等逻辑完全一致。

---

## 八、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 日志报「获取登录态失败：未提供登录态」 | 没设 Secret，或名字写错 | 确认 Secret 名是 `WORKBUDDY_AUTH`（大小写敏感） |
| 日志报「登录态已过期」 | 令牌超期 | 按第五节重新导出 |
| 日志报「令牌已过期或无效（HTTP 401）」 | 令牌失效（可能桌面端登出过） | 重新登录桌面端 → 重新导出 |
| Actions 失败并提示「令牌仅剩 X 天」（这是**预期的预警**） | 令牌快到 10 天了 | 正常现象，按第五节重导即可 |
| 日志报「签到请求异常：请求超时」 | 海外机器访问腾讯接口慢 | 偶发可忽略；持续出现告诉我，改用其他平台 |
| Actions 页面看不到 workflow | 文件没推上去 | 确认 `.github/workflows/checkin.yml` 在仓库里 |
| 定时到点没跑 | Actions 定时任务有延迟，或仓库长期无活动被暂停 | 延迟属正常；若连续多天不跑，来告诉我 |
| 想调整预警阈值 | 默认 10 天 | 改 workflow 里的 `WB_CHECKIN_WARN_DAYS` 环境变量 |

---

## 九、安全须知

- `accessToken` 等同账号密码。**只填进 GitHub Secret**，不要写进代码、不要发到任何聊天工具
- `export-auth.js` 输出的 JSON **不要保存成文件后提交**（`.gitignore` 已排除 `auth.json`，但仍需你自己留意）
- 云端脚本只访问 `copilot.tencent.com`，不访问任何其他域名
- 仓库日志里令牌会显示为 `***`，但**不要把完整日志截图外发**
