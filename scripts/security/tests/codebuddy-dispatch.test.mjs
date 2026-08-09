// ============================================================================
// scripts/security/tests/codebuddy-dispatch.test.mjs
//
// 运行：node --test scripts/security/tests/codebuddy-dispatch.test.mjs
// （注意：本机 Windows 上用目录形式 `node --test scripts/security/tests/`
//  会 MODULE_NOT_FOUND，必须给到文件路径。）
//
// 重点守两件事：
//   1. 没活的时候不能派单 —— 派一次就是一次真金白银的 AI 消耗；
//   2. @CodeBuddy 的位置必须能触发 NPC 事件 —— 位置错了会建出一个谁也不理的
//      Issue，巡检从此静默失效，而且没有任何报错。
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NPC_MENTION,
  PATROL_LABEL,
  buildPatrolIssue,
  buildReviewComment,
  embedJson,
  mentionIsSafe,
} from '../codebuddy-prompts.mjs';
import { decideWork, hasOpenPatrolIssue, headBranchOf } from '../codebuddy-dispatch.mjs';

const QUIET_DAY = {
  alerts: { collected: true, total: 0, alerts: [] },
  githubStatus: {
    cnb_main_sha: 'abc123',
    github_main_sha: 'abc123',
    github_ci: { total: 15, pending: 0, failed: 0, success: 13 },
  },
};

test('无告警、CI 全绿、两端同步 → 不派单', () => {
  const { needed, reasons } = decideWork(QUIET_DAY);
  assert.equal(needed, false);
  assert.deepEqual(reasons, []);
});

test('有告警 / CI 失败 / 不同步，各自都要派单', () => {
  assert.equal(decideWork({ ...QUIET_DAY, alerts: { collected: true, total: 3 } }).needed, true);

  const ciRed = { ...QUIET_DAY.githubStatus, github_ci: { total: 15, pending: 0, failed: 2, success: 11 } };
  assert.equal(decideWork({ ...QUIET_DAY, githubStatus: ciRed }).needed, true);

  const drift = { ...QUIET_DAY.githubStatus, github_main_sha: 'deadbee' };
  assert.equal(decideWork({ ...QUIET_DAY, githubStatus: drift }).needed, true);
});

test('采集本身失败也要派单，不能静默当成没事', () => {
  const broken = { ...QUIET_DAY, alerts: { collected: false, reason: 'CNB_TOKEN missing', total: 0 } };
  const { needed, reasons } = decideWork(broken);
  assert.equal(needed, true);
  assert.match(reasons.join(''), /采集失败/);
});

test('sha 未知时不算不同步（避免每天误派单）', () => {
  const unknown = { ...QUIET_DAY.githubStatus, github_main_sha: 'unknown' };
  assert.equal(decideWork({ ...QUIET_DAY, githubStatus: unknown }).needed, false);
});

test('已有未关闭的巡检 Issue 就不再建新的', () => {
  assert.equal(hasOpenPatrolIssue([{ number: 9, labels: [{ name: PATROL_LABEL }] }]), true);
  assert.equal(hasOpenPatrolIssue([{ number: 9, labels: [PATROL_LABEL] }]), true);
  assert.equal(hasOpenPatrolIssue([{ number: 9, labels: [{ name: 'bug' }] }]), false);
  assert.equal(hasOpenPatrolIssue([]), false);
  assert.equal(hasOpenPatrolIssue(null), false);
});

test('head 分支名同时兼容字符串与对象两种形态', () => {
  assert.equal(headBranchOf({ head: 'auto/security-fix-x-1a2b' }), 'auto/security-fix-x-1a2b');
  assert.equal(headBranchOf({ head: { name: 'auto/security-fix-y-3c4d' } }), 'auto/security-fix-y-3c4d');
  assert.equal(headBranchOf({}), null);
});

test('mentionIsSafe 认得出会导致不触发的四种位置', () => {
  assert.equal(mentionIsSafe(`${NPC_MENTION} 请处理`).safe, true);
  assert.equal(mentionIsSafe('```\n' + NPC_MENTION + '\n```').safe, false);
  assert.equal(mentionIsSafe(`> ${NPC_MENTION}`).safe, false);
  assert.equal(mentionIsSafe(`- ${NPC_MENTION}`).safe, false);
  assert.equal(mentionIsSafe(`1. ${NPC_MENTION}`).safe, false);
  assert.equal(mentionIsSafe(`| ${NPC_MENTION} |`).safe, false);
  assert.equal(mentionIsSafe(`<details>\n\n${NPC_MENTION}\n\n</details>`).safe, false);
  assert.equal(mentionIsSafe('正文里根本没提及').safe, false);
});

test('折叠块闭合之后的提及重新算安全', () => {
  const body = `<details>\n<summary>x</summary>\n\n数据\n\n</details>\n\n${NPC_MENTION} 请处理`;
  assert.equal(mentionIsSafe(body).safe, true);
});

test('巡检 Issue 正文：能触发、内嵌了数据、要求自己关闭', () => {
  const { title, body } = buildPatrolIssue({
    alerts: { total: 2, alerts: [{ id: 'a1' }] },
    alertsSummary: { overview: {} },
    githubStatus: QUIET_DAY.githubStatus,
    reasons: ['CNB 安全告警 2 条'],
    date: '2026-08-09',
  });
  assert.match(title, /2026-08-09/);
  assert.equal(mentionIsSafe(body).safe, true);
  assert.equal(body.startsWith(NPC_MENTION), true, '提及必须在首行，别埋在中间');
  assert.match(body, /"total": 2/, '告警数据必须随正文送过去');
  assert.match(body, /state_reason/, '必须明确交代怎么关闭 Issue');
  assert.match(body, /不要\*\*再写 @CodeBuddy/, '必须有防自触发提醒');
  assert.match(body, /auto\/security-triage-/);
  assert.match(body, /auto\/security-fix-/);
});

test('PR 复核评论：能触发、带上验证结果与合并开关', () => {
  const body = buildReviewComment({
    prNumber: 42,
    branch: 'auto/security-fix-xss-7f3a',
    verifyResults: { pr_ci_state: 'success', github_ci_state: 'failure' },
    autoMergeEnabled: 'true',
  });
  assert.equal(mentionIsSafe(body).safe, true);
  assert.equal(body.startsWith(NPC_MENTION), true);
  assert.match(body, /#42/);
  assert.match(body, /auto\/security-fix-xss-7f3a/);
  assert.match(body, /"github_ci_state": "failure"/, '验证结果必须随评论送过去');
  assert.match(body, /AUTO_MERGE_ENABLED = `true`/);
  assert.match(body, /wait_for_human/);
});

test('AUTO_MERGE_ENABLED 未设置时按 false 呈现', () => {
  const body = buildReviewComment({ prNumber: 1, branch: 'b', verifyResults: {}, autoMergeEnabled: undefined });
  assert.match(body, /AUTO_MERGE_ENABLED = `false`/);
});

test('超长数据被截断但仍是合法的折叠块', () => {
  const huge = { blob: 'x'.repeat(50_000) };
  const out = embedJson('大数据', huge, 500);
  assert.match(out, /已截断到 500 字符/);
  assert.equal((out.match(/```/g) || []).length, 2, '代码块必须闭合，否则后面的正文全被吞进去');
});
