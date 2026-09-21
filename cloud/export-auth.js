#!/usr/bin/env node
/**
 * export-auth.js — 把本机 WorkBuddy 登录态导出为云端签到所需的 auth.json
 *
 * 用途：云端环境（GitHub Actions 等）读不到本机登录态文件，需要把令牌导出成
 *      一个 JSON 字符串，存进云端平台的 Secret。本脚本负责该导出。
 *
 * 用法：
 *   node cloud/export-auth.js                  # 打印 JSON 到 stdout（复制粘贴用）
 *   node cloud/export-auth.js --out auth.json  # 写到文件（注意：文件含令牌，勿提交）
 *   node cloud/export-auth.js --b64            # 输出 base64（部分平台更友好）
 *
 * 安全：输出的内容等同账号密码。请勿提交到仓库、勿粘贴到公共场合。
 *      脚本本身只做读取与格式化，不联网、不上传。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = process.env.WB_CHECKIN_APP_NAME || 'WorkBuddy';

/** 候选登录态文件（与 scripts/decrypt-token.js 的探测顺序保持一致） */
function candidates() {
  const p = process.platform;
  const out = [];
  if (p === 'win32') {
    // 优先 LOCALAPPDATA：桌面端实际写在这里，APPDATA 下可能是过期副本
    if (process.env.LOCALAPPDATA) {
      out.push(path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'));
    }
    if (process.env.APPDATA) {
      out.push(path.join(process.env.APPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'));
    }
  } else if (p === 'darwin') {
    out.push(path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'));
  } else {
    out.push(path.join(os.homedir(), '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'));
  }
  return out;
}

function fail(msg) {
  process.stderr.write('[error] ' + msg + '\n');
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
  const asB64 = args.includes('--b64');

  // 只取存在且非空的第一个候选
  let file = null;
  for (const c of candidates()) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).size > 0) { file = c; break; }
    } catch (_) { /* ignore */ }
  }
  if (!file) {
    fail('未找到 WorkBuddy 登录态文件。请确认已安装并登录 WorkBuddy 桌面端（v5.3.8+）。');
  }

  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail('解析登录态文件失败：' + e.message);
  }

  const auth = j.auth || {};
  if (!auth.accessToken) {
    fail('登录态文件中没有 accessToken，请先在桌面端登录。');
  }

  // 只保留云端签到真正需要的字段，避免把整份登录态（含无关个人信息）带出去
  const slim = {
    auth: {
      accessToken: auth.accessToken,
      expiresAt: auth.expiresAt,
      domain: auth.domain || '',
    },
    account: {
      uid: (j.account || {}).uid || '',
      sso: { domain: ((j.account || {}).sso || {}).domain || '' },
    },
  };

  const text = JSON.stringify(slim);

  // 有效期提示（打印到 stderr，不污染 stdout 的令牌管道）
  if (auth.expiresAt) {
    const leftH = (Number(auth.expiresAt) - Date.now()) / 3600000;
    process.stderr.write(`[info] 令牌剩余有效期约 ${leftH.toFixed(1)} 小时（${(leftH / 24).toFixed(1)} 天）\n`);
    if (leftH <= 0) {
      process.stderr.write('[warn] 该令牌已过期，请先在桌面端重新登录再导出！\n');
    }
  }
  process.stderr.write('[security] 以下输出等同账号密码，请勿提交仓库或公开分享。\n');

  const payload = asB64 ? Buffer.from(text, 'utf8').toString('base64') : text;

  if (outFile) {
    fs.writeFileSync(outFile, payload, 'utf8');
    process.stderr.write(`[info] 已写入 ${path.resolve(outFile)}\n`);
    process.stderr.write('[warn] 该文件含令牌，请勿提交到 git（已在 .gitignore 中排除 auth.json）。\n');
  } else {
    process.stdout.write(payload + '\n');
  }
}

main();
