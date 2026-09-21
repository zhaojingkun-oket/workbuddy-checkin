#!/usr/bin/env node
/**
 * checkin.js — WorkBuddy 每日积分签到（云端正交实现，GitHub Actions / 任意 Node 环境）
 *
 * 与本地版 scripts/checkin.js 的区别：
 *   本地版从 WorkBuddy 桌面端的本地登录态文件读取令牌；
 *   本版从环境变量 WORKBUDDY_AUTH 读取调用方预先导出的登录态 JSON（文件中转）。
 *   签到业务逻辑（接口、业务码、幂等、返回语义）与本地版保持一致。
 *
 * 用法：
 *   WORKBUDDY_AUTH_FILE=<json路径> node cloud/checkin.js
 *   WORKBUDDY_AUTH=<json字符串>   node cloud/checkin.js
 *
 * 结果：stdout 末尾打印 RESULT: SUCCESS | ALREADY | FAILED
 * 退出码：0 = 成功（含今日已签到），1 = 失败
 *
 * 幂等：先查状态；daily-checkin 返回 code=10001（今日已签到）同样视为成功。
 * 安全：令牌仅在内存中使用，不落盘、不回显；异常信息中不含令牌原文。
 */

'use strict';

const fs = require('fs');

const STATUS_URL = 'https://copilot.tencent.com/v2/billing/meter/checkin-status';
const CHECKIN_URL = 'https://copilot.tencent.com/v2/billing/meter/daily-checkin';

function pad(n) { return String(n).padStart(2, '0'); }
function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg) { console.log(`[${nowStr()}] ${msg}`); }

let exitCode = 0;
function finish(result, msg) {
  log(msg);
  log(`RESULT: ${result}`);
  exitCode = result === 'FAILED' ? 1 : 0;
  // Actions 汇总用：把结论写进 GITHUB_OUTPUT（本地运行无此文件时静默跳过）
  try {
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `result=${result}\n`, 'utf8');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `detail=${String(msg).replace(/\n/g, ' ')}\n`, 'utf8');
    }
  } catch (_) { /* ignore */ }
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

/* ---------- 0. 令牌有效期预警 ---------- */

// 剩余天数低于该阈值时发预警，提醒重新导出登录态
const WARN_DAYS = Number(process.env.WB_CHECKIN_WARN_DAYS || 10);

/**
 * 检查令牌剩余有效期，必要时发出预警。
 * 预警走 stderr 并写入 GITHUB_OUTPUT，便于 Actions 汇总与失败提醒。
 * @returns {{days:number|null, warning:boolean}}
 */
function checkExpiry(expiresAt) {
  if (!expiresAt) return { days: null, warning: false };
  const days = (Number(expiresAt) - Date.now()) / 86400000;
  const r = { days, warning: false };

  if (days <= 0) return r; // 已过期由 getToken 拦截，这里不重复处理

  if (days <= WARN_DAYS) {
    r.warning = true;
    const msg = `⚠️ 令牌仅剩 ${days.toFixed(1)} 天后过期，请尽快在本机重新导出登录态并更新 WORKBUDDY_AUTH`;
    process.stderr.write(msg + '\n');
    try {
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `expiry_warning=true\n`, 'utf8');
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `expiry_days=${days.toFixed(1)}\n`, 'utf8');
      }
    } catch (_) { /* ignore */ }
  }
  return r;
}

/* ---------- 1. 取令牌（环境变量 / 文件中转） ---------- */
function getToken() {
  let raw = '';

  if (process.env.WORKBUDDY_AUTH_FILE) {
    const p = process.env.WORKBUDDY_AUTH_FILE;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      return { ok: false, error: `读取 WORKBUDDY_AUTH_FILE 失败：${e.message}` };
    }
  } else if (process.env.WORKBUDDY_AUTH) {
    raw = process.env.WORKBUDDY_AUTH;
  } else {
    return { ok: false, error: '未提供登录态：请设置 WORKBUDDY_AUTH 或 WORKBUDDY_AUTH_FILE' };
  }

  let j;
  try {
    j = JSON.parse(raw.trim());
  } catch (e) {
    return { ok: false, error: '登录态不是合法 JSON：' + e.message };
  }

  const auth = j.auth || {};
  const account = j.account || {};
  const sso = account.sso || {};

  const token = auth.accessToken || j.accessToken || '';
  if (!token) return { ok: false, error: '登录态中没有 accessToken' };

  // 过期检查：过期则直接失败并给出明确指引，避免用死令牌去撞 401
  if (auth.expiresAt && Date.now() > Number(auth.expiresAt)) {
    return {
      ok: false,
      expired: true,
      error: '登录态已过期（expiresAt 已过）。请在本机重新登录 WorkBuddy 桌面端，' +
             '再导出登录态并更新 WORKBUDDY_AUTH。',
    };
  }

  return {
    ok: true,
    accessToken: token,
    expiresAt: auth.expiresAt,
    uid: account.uid || '',
    domain: auth.domain || sso.domain || '',
    enterpriseId: account.enterpriseId || '',
    tenantId: account.tenantId || '',
    source: process.env.WORKBUDDY_AUTH_FILE ? 'file' : 'env',
  };
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
  jitter();

  const tok = getToken();
  if (!tok.ok) {
    process.exit(finish('FAILED', `获取登录态失败：${tok.error}`));
  }
  log(`登录态来源：${tok.source}`);

  // 有效期检查：临近过期时预警（不阻断签到，令牌未过期仍可正常领取）
  const exp = checkExpiry(tok.expiresAt);
  if (exp.days !== null) {
    log(`令牌剩余有效期：${exp.days.toFixed(1)} 天`);
  }

  const headers = {
    Authorization: `Bearer ${tok.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'WorkBuddy-Checkin/1.0.4',
  };
  if (tok.uid) headers['X-User-Id'] = tok.uid;
  if (tok.domain) headers['X-Domain'] = tok.domain;
  if (tok.enterpriseId) headers['X-Enterprise-Id'] = tok.enterpriseId;
  if (tok.tenantId) headers['X-Tenant-Id'] = tok.tenantId;

  // 令牌已注入请求头，清掉内存引用
  tok.accessToken = undefined;

  // 查状态（快速路径；checkin-status 的 today_checked_in 实测不可靠，仅作参考）
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

  // 该网关用 HTTP 400 承载业务码（code=10001 今天已签到就是 400 返回），
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
    if (res.http === 401 || res.http === 403) {
      process.exit(finish('FAILED',
        `令牌已过期或无效（HTTP ${res.http}，code=${code}）。请在本机重新登录 WorkBuddy 桌面端，` +
        '导出登录态后更新 WORKBUDDY_AUTH。'));
    }
    process.exit(finish('FAILED', `签到未成功：code=${code} ${msg}（HTTP ${res.http}）`));
  }

  // 无 JSON 响应体：此时才用 HTTP 状态码判定
  if (res.http === 401 || res.http === 403) {
    process.exit(finish('FAILED',
      `令牌已过期或无效（HTTP ${res.http}）。请在本机重新登录 WorkBuddy 桌面端，导出登录态后更新 WORKBUDDY_AUTH。`));
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
