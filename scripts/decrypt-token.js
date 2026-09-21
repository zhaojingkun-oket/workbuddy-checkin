#!/usr/bin/env node
/**
 * decrypt-token.js — 提取 WorkBuddy 本地登录态（accessToken）
 *
 * 运行时策略：
 *   1) Node 优先：读取 v5.3.8+ 的明文 JSON 登录态 workbuddy-desktop.info（纯 Node，无需 Electron）
 *   2) 回退：旧版 WorkBuddy/CodeBuddy 把 session 用 Electron safeStorage 加密存在 state.vscdb，
 *      此时用 Electron 执行 safeStorage.decryptString() 解密
 *
 * 输出（stdout）：一行 JSON
 *   { "ok": true, "accessToken": "...", "uid": "...", "domain": "", "enterpriseId": "", "tenantId": "", "source": "plaintext|vscdb" }
 * 或
 *   { "ok": false, "error": "原因" }
 *
 * 安全：安全提示与进度一律写 stderr，绝不污染 stdout 的 JSON 管道。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_NAME = process.env.WB_CHECKIN_APP_NAME || 'WorkBuddy';

function fail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(1);
}

function warn(msg) {
  process.stderr.write(msg + '\n');
}

/* ------------------------------------------------------------------ *
 * 候选路径
 * ------------------------------------------------------------------ */

// v5.3.8+ 明文登录态（主路径）
function plaintextCandidates() {
  const p = process.platform;
  const out = [];
  if (p === 'win32') {
    // 1.0.3 起优先探 %LOCALAPPDATA%：桌面端实际写在 Local，旧版只探 APPDATA 会读到过期令牌
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

// 旧版加密登录态（回退路径）
function vscdbCandidates() {
  const p = process.platform;
  const out = [];
  if (p === 'win32') {
    if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, APP_NAME, 'User', 'globalStorage', 'state.vscdb'));
    if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'CodeBuddy', 'User', 'globalStorage', 'state.vscdb'));
  } else if (p === 'darwin') {
    out.push(path.join(os.homedir(), 'Library', 'Application Support', APP_NAME, 'User', 'globalStorage', 'state.vscdb'));
    out.push(path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddy', 'User', 'globalStorage', 'state.vscdb'));
  } else {
    out.push(path.join(os.homedir(), '.config', APP_NAME, 'User', 'globalStorage', 'state.vscdb'));
    out.push(path.join(os.homedir(), '.config', 'CodeBuddy', 'User', 'globalStorage', 'state.vscdb'));
  }
  return out;
}

function firstExisting(list) {
  for (const p of list) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 路径 1：明文 JSON（v5.3.8+ 主路径）
 * ------------------------------------------------------------------ */

function readPlaintext(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, error: '读取登录态文件失败: ' + e.message };
  }

  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: '登录态文件不是合法 JSON: ' + e.message };
  }

  const auth = j.auth || {};
  const token = auth.accessToken || (j.accessToken || '');
  if (!token) return { ok: false, error: '登录态文件中没有 accessToken（桌面端可能未登录）' };

  const account = j.account || {};
  const sso = account.sso || {};

  // 过期检查（桌面端会自动刷新，这里只做提示，不阻断）
  if (auth.expiresAt && Date.now() > Number(auth.expiresAt)) {
    warn('[warn] accessToken 已过 expiresAt，请打开 WorkBuddy 桌面端刷新登录态');
  }

  return {
    ok: true,
    accessToken: token,
    uid: account.uid || '',
    domain: auth.domain || sso.domain || '',
    enterpriseId: account.enterpriseId || '',
    tenantId: account.tenantId || '',
    source: 'plaintext',
    sourceFile: file,
  };
}

/* ------------------------------------------------------------------ *
 * 路径 2：旧版 state.vscdb（Electron safeStorage 解密）
 * ------------------------------------------------------------------ */

function findElectron() {
  if (process.env.WB_CHECKIN_ELECTRON && fs.existsSync(process.env.WB_CHECKIN_ELECTRON)) {
    return process.env.WB_CHECKIN_ELECTRON;
  }
  const tryCmd = (cmd, args) => {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000 }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch (_) { /* ignore */ }
    return null;
  };
  if (process.platform === 'win32') {
    return tryCmd('where', ['electron']) || tryCmd('cmd', ['/c', 'where electron 2>nul']);
  }
  return tryCmd('which', ['electron']);
}

function readVscdb(file, electronBin) {
  if (!electronBin) {
    return { ok: false, error: '未找到 Electron 运行时（旧版 state.vscdb 解密需要）。请运行 setup 脚本安装，或用 WB_CHECKIN_ELECTRON 指定路径' };
  }

  // sqlite 读取：优先 Node 22+ 内置 node:sqlite，回退 python3（需显式开启）
  const helper = path.join(os.tmpdir(), 'wb-checkin-vscdb-' + process.pid + '.js');
  const useNodeSqlite = (() => {
    try { require('node:sqlite'); return true; } catch (_) { return false; }
  })();
  const allowPy = process.env.WB_CHECKIN_ALLOW_PY_FALLBACK === '1';

  if (!useNodeSqlite && !allowPy) {
    return { ok: false, error: '无法读取 state.vscdb：本机不支持 node:sqlite，且未开启 python3 回退（WB_CHECKIN_ALLOW_PY_FALLBACK=1）' };
  }

  const dbFile = file.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const script = `
const { app, safeStorage } = require('electron');
const { execFileSync } = require('child_process');
const DB = '${dbFile}';
const USE_NODE_SQLITE = ${useNodeSqlite};

function readRows() {
  if (USE_NODE_SQLITE) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%auth%' OR key LIKE '%token%' OR key LIKE '%session%'").all();
    db.close();
    return rows;
  }
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const code = "import sqlite3,json;c=sqlite3.connect('file:"+DB+"?mode=ro',uri=True);print(json.dumps(c.execute(\\"SELECT key,value FROM ItemTable\\").fetchall()))";
  const out = execFileSync(py, ['-c', code], { encoding: 'utf8' });
  return JSON.parse(out).map(([key, value]) => ({ key, value }));
}

app.whenReady().then(async () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'safeStorage 不可用（Linux 需桌面会话 + keyring）' }));
      app.quit(); return;
    }
    const rows = readRows();
    for (const r of rows) {
      let v = r.value;
      if (typeof v === 'string' && /^[A-Za-z0-9+/=]+$/.test(v) && v.length > 24) {
        try { v = safeStorage.decryptString(Buffer.from(v, 'base64')); } catch (_) { continue; }
      }
      if (typeof v === 'string' && v.trim().startsWith('{')) {
        try {
          const j = JSON.parse(v);
          const tok = j.accessToken || (j.auth && j.auth.accessToken);
          if (tok) {
            const acc = j.account || {};
            process.stdout.write(JSON.stringify({
              ok: true, accessToken: tok, uid: acc.uid || (j.auth && j.auth.uid) || '',
              domain: (j.auth && j.auth.domain) || '', source: 'vscdb', sourceFile: DB
            }));
            app.quit(); return;
          }
        } catch (_) { /* not this row */ }
      }
    }
    process.stdout.write(JSON.stringify({ ok: false, error: 'state.vscdb 中未找到可解密的登录态' }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
  app.quit();
});
`;

  try {
    fs.writeFileSync(helper, script);
    // Agent 沙箱可能注入 ELECTRON_RUN_AS_NODE=1，会让 electron 以 node 模式启动，必须摘掉
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    const out = execFileSync(electronBin, [helper], {
      encoding: 'utf8',
      timeout: 60000,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    const line = out.split('\n').filter(Boolean).pop();
    return line ? JSON.parse(line) : { ok: false, error: 'Electron 未返回任何内容' };
  } catch (e) {
    return { ok: false, error: 'Electron 解密失败: ' + (e.message || e) };
  } finally {
    try { fs.unlinkSync(helper); } catch (_) { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

(function main() {
  const plain = firstExisting(plaintextCandidates());
  if (plain) {
    const r = readPlaintext(plain);
    if (r.ok) {
      warn('[security] 已读取本地登录态（' + r.source + '）。accessToken 等同账号密码，仅在内存中使用，不会落盘/入日志。');
      process.stdout.write(JSON.stringify(r) + '\n');
      return;
    }
    warn('[warn] 明文登录态读取失败：' + r.error + '，尝试回退旧版 state.vscdb');
  }

  const db = firstExisting(vscdbCandidates());
  if (db) {
    const r = readVscdb(db, findElectron());
    if (r.ok) {
      warn('[security] 已解密旧版登录态（state.vscdb）。accessToken 等同账号密码，仅在内存中使用，不会落盘/入日志。');
      process.stdout.write(JSON.stringify(r) + '\n');
      return;
    }
    fail(r.error);
    return;
  }

  fail('未找到本地登录态。请确认已安装并登录 WorkBuddy 桌面端（v5.3.8+ 需 Node.js）');
})();
