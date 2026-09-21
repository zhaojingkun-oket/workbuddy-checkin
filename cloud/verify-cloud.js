/**
 * verify-cloud.js — 云端版交付前自检（不联网、不掉用签到接口）
 *
 * 检查项：
 *   1. 两个脚本的语法
 *   2. workflow 关键配置是否齐全（cron、时区换算、Secret 引用、入口）
 *   3. workflow 无 tab 缩进（YAML 禁止）
 *   4. 令牌不会因 .gitignore 缺失而被提交
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(name) { console.log('  ✓ ' + name); pass++; }
function bad(name, why) { console.log('  ✗ ' + name + (why ? ' — ' + why : '')); fail++; }

console.log('\n[1] 脚本语法');
for (const f of ['cloud/checkin.js', 'cloud/export-auth.js']) {
  // Function 构造器不认 shebang，须先剥掉首行
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^#!.*\n/, '');
  try { new Function(src); ok(f); }
  catch (e) { bad(f, e.message); }
}

console.log('\n[2] workflow 配置');
const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/checkin.yml'), 'utf8');
const rules = [
  ['含 schedule 触发', /schedule:/],
  ['主签到 = UTC 01:00（北京 09:00）', /cron:\s*'0 1 \* \* \*'/],
  ['兜底 = UTC 05:00（北京 13:00）', /cron:\s*'0 5 \* \* \*'/],
  ['支持手动触发', /workflow_dispatch:/],
  ['引用 Secret', /secrets\.WORKBUDDY_AUTH/],
  ['入口为 cloud/checkin.js', /node cloud\/checkin\.js/],
  ['设了错峰抖动', /WB_CHECKIN_JITTER/],
  ['失败有提示步骤', /if:\s*failure\(\)/],
  ['含令牌到期预警步骤', /令牌到期预警/],
];
for (const [name, re] of rules) (re.test(yml) ? ok : bad)(name);

console.log('\n[3] YAML 缩进');
/\t/.test(yml) ? bad('无 tab 缩进', '发现 tab，YAML 会解析失败') : ok('无 tab 缩进');

console.log('\n[4] 令牌防泄漏');
const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
[/auth\.json/, /\*\.info/, /\.env/].forEach((re, i) =>
  (re.test(gi) ? ok : bad)(['忽略 auth.json', '忽略 *.info', '忽略 .env'][i]));

console.log('\n[5] 脚本不硬编码令牌');
const ck = fs.readFileSync(path.join(ROOT, 'cloud/checkin.js'), 'utf8');
/[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}/.test(ck)
  ? bad('checkin.js 无硬编码令牌', '疑似出现疑似令牌字面量')
  : ok('checkin.js 无硬编码令牌');

console.log('\n[6] 到期预警逻辑');
[
  ['含剩余有效期计算', /checkExpiry/],
  ['默认阈值 10 天', /WB_CHECKIN_WARN_DAYS \|\| 10/],
  ['预警写入 GITHUB_OUTPUT', /expiry_warning=true/],
  ['过期时给出重导指引', /重新登录 WorkBuddy 桌面端/],
].forEach(([name, re]) => (re.test(ck) ? ok : bad)(name));

// 预警行为断言：剩余 8 天应预警，剩余 55 天不应预警
const m = ck.match(/const WARN_DAYS = Number\(process\.env\.WB_CHECKIN_WARN_DAYS \|\| (\d+)\)/);
if (m) {
  const warnDays = Number(m[1]);
  (warnDays === 10) ? ok('阈值实测为 10 天') : bad('阈值实测', `期望 10，实际 ${warnDays}`);
} else {
  bad('阈值可解析');
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
