#!/usr/bin/env node
/**
 * checkin.js — WorkBuddy 每日积分签到（跨平台主实现，Node 18+）
 *
 * 用法：
 *   node scripts/checkin.js
 *
 * 结果：stdout 打印一行 RESULT: SUCCESS | ALREADY | FAILED
 * 退出码：0 = 成功（含今日已签到），1 = 失败
 *
 * 幂等：先查状态；daily-checkin 返回 code=10001（今日已签到）同样视为成功。
 * 安全：accessToken 仅在内存中使用，不写入日志、不回显。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const LOG_DIR = path.join(ROOT_DIR, 'logs');

const STATUS_URL = 'https://copilot.tencent.com/v2/billing/meter/checkin-status';
const CHECKIN_URL = 'https://copilot.tencent.com/v2/billing/meter/daily-checkin';

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function nowStr() {
  const d = new Date();
  return `${todayStr()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let logFile = null;
function log(msg) {
  const line = `[${nowStr()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n', 'utf8'); } catch (_) { /* ignore */ }
}

let exitCode = 0;
function finish(result, msg) {
  log(msg);
  log(`RESULT: ${result}`);
  exitCode = result === 'FAILED' ? 1 : 0;
  return exitCode;
}

/* ---------- 0. 错峰（可选） ---------- */
function jitter() {
  const n = Number(process.env.WB_CHECKIN_JITTER || 0);
  if (!Number.isFinite(n) || n <= 0) return;
  const wait = Math.floor(Math.random() * (n + 1));
  log(`错峰等待 ${wait}s`);
  const until = Date.now() + wait * 1000;
  while (Date.now() < until) { /* 同步等待，保证退出码语义 */ }
}

/* ---------- 1. 取令牌 ---------- */
function getToken() {
  const decryptJs = path.join(SCRIPT_DIR, 'decrypt-token.js');
  if (!fs.existsSync(decryptJs)) return { ok: false, error: `缺少 ${decryptJs}` };

  const nodeBin = process.env.WB_CHECKIN_NODE || process.execPath;
  let out = '';
  try {
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE; // 否则 electron 会以 node 模式启动
    out = execFileSync(nodeBin, [decryptJs], {
      encoding: 'utf8', timeout: 60000, env,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch (e) {
    // 带上 stderr，否则只有一句 "Command failed" 无法定位（注意：stderr 只有安全提示，不含令牌）
    const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join(' | ').trim();
    return { ok: false, error: '执行 decrypt-token.js 失败: ' + detail };
  }
  const line = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('{')).pop();
  if (!line) return { ok: false, error: '获取令牌失败（未知原因）。请确认 WorkBuddy 桌面端已登录。' };
  try { return JSON.parse(line); } catch (e) { return { ok: false, error: '令牌输出解析失败' }; }
}

/* ---------- 2. 请求 ---------- */
async function api(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: '{}',
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { http: res.status, body: text };
  } catch (e) {
    return { http: 0, body: '', err: e.name === 'AbortError' ? '请求超时' : (e.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

/* ---------- main ---------- */
(async function main() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) { /* ignore */ }
  logFile = path.join(LOG_DIR, `checkin-${todayStr()}.log`);

  jitter();

  const tok = getToken();
  if (!tok.ok) { process.exit(finish('FAILED', `获取令牌失败：${tok.error}`)); }
  log(`登录态来源：${tok.source || 'unknown'}`);

  const headers = {
    Authorization: `Bearer ${tok.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'WorkBuddy-Checkin/1.0.3',
  };
  if (tok.uid) headers['X-User-Id'] = tok.uid;
  if (tok.domain) headers['X-Domain'] = tok.domain;
  if (tok.enterpriseId) headers['X-Enterprise-Id'] = tok.enterpriseId;
  if (tok.tenantId) headers['X-Tenant-Id'] = tok.tenantId;

  // 令牌已注入请求头，清掉内存引用
  tok.accessToken = undefined;

  // 查状态（快速路径；v5.3.8 实测 today_checked_in 可能不可靠，仅作参考）
  try {
    const st = await api(STATUS_URL, headers);
    if (st.http === 200 && st.body) {
      const sj = JSON.parse(st.body);
      const flag = pick(sj, ['today_checked_in']) ?? (sj.data ? pick(sj.data, ['today_checked_in']) : null);
      const d = sj.data || sj;
      const streak = pick(d, ['streak_days', 'continuousDays', 'consecutiveDays', 'streak', 'checkinDays', 'continuous_checkin_days']);
      const total = pick(d, ['total_credits', 'totalCredits', 'balance', 'availableCredits']);
      const info = [];
      if (Number(streak) > 0) info.push(`连续 ${streak} 天`);
      if (Number(total) > 0) info.push(`积分余额 ${total}`);
      if (info.length) log(`当前状态：${info.join('，')}`);
      if (flag === true || flag === 'true') {
        process.exit(finish('ALREADY', '今日已签到（状态接口命中），跳过。'));
      }
    }
  } catch (_) { /* 状态查询失败不阻断，继续签到 */ }

  // 执行签到
  const res = await api(CHECKIN_URL, headers);
  if (res.err) { process.exit(finish('FAILED', `签到请求异常：${res.err}`)); }

  // 重要：该网关用 HTTP 400 承载业务码（如「今天已签到」code=10001 就是 400 返回），
  // 因此必须先解析业务码，不能先把非 2xx 一律判为失败。
  let rj = null;
  try { rj = JSON.parse(res.body); } catch (_) { rj = null; }

  if (rj) {
    const rawCode = (rj.code === undefined || rj.code === null) ? null : rj.code;
    const code = String(rawCode);
    const msg = rj.msg || rj.message || '';

    if (code === '10001') {
      process.exit(finish('ALREADY', `今日已签到（code=10001${msg ? '，' + msg : ''}），无需重复领取。`));
    }
    if (code === '0' || code === '200' || code === 'success' || rawCode === 0) {
      const data = rj.data || rj;
      const credits = pick(data, ['credits', 'credit', 'today_credit', 'daily_credit', 'rewardCredits', 'checkinCredits', 'awardCredits', 'points']);
      const streak = pick(data, ['streak_days', 'continuousDays', 'consecutiveDays', 'streak', 'checkinDays', 'continuous_checkin_days']);
      const detail = [];
      if (credits !== null && credits !== undefined) detail.push(`获得 ${credits} 积分`);
      if (streak !== null && streak !== undefined) detail.push(`连续 ${streak} 天`);
      process.exit(finish('SUCCESS', `签到成功${detail.length ? '（' + detail.join('，') + '）' : ''}`));
    }
    // 其他业务码：落到下面的 HTTP 判定，附带业务信息
    if (res.http === 401 || res.http === 403) {
      process.exit(finish('FAILED', `令牌已过期（HTTP ${res.http}，code=${code}）。请打开 WorkBuddy 桌面端刷新登录态后重试。`));
    }
    process.exit(finish('FAILED', `签到未成功：code=${code} ${msg}（HTTP ${res.http}）`));
  }

  // 无 JSON 响应体：此时才用 HTTP 状态码判定
  if (res.http === 401 || res.http === 403) {
    process.exit(finish('FAILED', `令牌已过期（HTTP ${res.http}）。请打开 WorkBuddy 桌面端刷新登录态后重试。`));
  }
  if (res.http >= 500) {
    process.exit(finish('FAILED', `服务端错误：HTTP ${res.http}`));
  }
  if (res.http < 200 || res.http >= 300) {
    process.exit(finish('FAILED', `签到请求失败：HTTP ${res.http}`));
  }
  process.exit(finish('SUCCESS', '签到请求已发出并返回 HTTP 200（响应非 JSON）。'));
})().catch((e) => {
  process.exit(finish('FAILED', `签到脚本异常：${e && e.message ? e.message : e}`));
});
