#!/usr/bin/env node
// ============================================================================
// scripts/security/codebuddy-dispatch.mjs
//
// 把安全巡检 / 修复复核的活派给 @CodeBuddy。
//
// 以前这两处 AI 是流水线里的 `type: npc:go` 阶段，直接在当前构建里跑。现在改成：
// 流水线只做采集和验证（纯 shell），然后**建 Issue 或在 PR 上留评论并 @CodeBuddy**，
// 由 CNB 的 NPC 事件把 CodeBuddy 拉起来干活。两点好处：
//   1. 计费口径走 NPC 事件（@CodeBuddy），而不是自建 npc:go 的额度；
//   2. 没活的日子直接不派单 —— 以前是每天雷打不动把 AI 叫醒一次，哪怕零告警。
//
// work_mode 是关键：CNB 的建 Issue（api.PostIssueForm）与发评论
// （api.PostIssueCommentForm / api.PullCommentCreationForm）都有 work_mode 字段。
// 不开的话 CodeBuddy 的 CNB_TOKEN 以只读为主，能回话但推不了代码，等于白派。
//
// 守卫：正文里的 @CodeBuddy 一旦落进代码块/引用/列表/表格/折叠块就不会触发事件，
// 派单前用 mentionIsSafe() 挡一道，宁可失败退出，也不要建出一个没人理的 Issue。
// ============================================================================

import { readFileSync } from 'node:fs';
import {
  PATROL_LABEL,
  buildPatrolIssue,
  buildReviewComment,
  mentionIsSafe,
} from './codebuddy-prompts.mjs';

const API_BASE = process.env.CNB_API_ENDPOINT || 'https://api.cnb.cool';
const REPO = process.env.CNB_REPO_SLUG || '';
const TOKEN = process.env.CNB_TOKEN || '';

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 有没有值得叫醒 CodeBuddy 的活。没有就一分钱不花。 */
export function decideWork({ alerts, githubStatus }) {
  const reasons = [];
  const total = Number(alerts?.total ?? 0);
  if (total > 0) reasons.push(`CNB 安全告警 ${total} 条`);
  const ci = githubStatus?.github_ci || {};
  const failed = Number(ci.failed ?? 0);
  if (failed > 0) reasons.push(`GitHub CI 有 ${failed} 项检查失败`);
  const cnbSha = githubStatus?.cnb_main_sha;
  const ghSha = githubStatus?.github_main_sha;
  if (cnbSha && ghSha && cnbSha !== 'unknown' && ghSha !== 'unknown' && cnbSha !== ghSha) {
    reasons.push('CNB 与 GitHub 的 main 不同步');
  }
  if (alerts && alerts.collected === false) {
    reasons.push(`告警采集失败（${alerts.reason || '原因未知'}），需人工确认`);
  }
  return { needed: reasons.length > 0, reasons };
}

/**
 * 已经有一个没关的巡检 Issue 就不再派单。
 * CodeBuddy 干完会自己关；关不掉说明上一轮卡住了，这时再堆一个新的只会更乱。
 */
export function hasOpenPatrolIssue(issues) {
  if (!Array.isArray(issues)) return false;
  return issues.some((it) => {
    const labels = (it?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name));
    return labels.includes(PATROL_LABEL);
  });
}

/** 从 PR 对象里取源分支名；CNB 的 head 有时是字符串、有时是对象。 */
export function headBranchOf(pr) {
  const head = pr?.head;
  if (typeof head === 'string') return head;
  return head?.name || head?.ref || null;
}

async function api(method, path, body) {
  if (!TOKEN || !REPO) throw new Error('CNB_TOKEN 或 CNB_REPO_SLUG 未设置，无法调用 CNB API');
  const res = await fetch(`${API_BASE}/${REPO}/-${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.cnb.api+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CNB API ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function assertMentionSafe(body, what) {
  const { safe, reason } = mentionIsSafe(body);
  if (!safe) throw new Error(`${what} 的正文无法触发 NPC 事件：${reason}`);
}

function skip(reason) {
  console.log(`跳过派单：${reason}`);
  process.exit(0);
}

async function patrol() {
  const alerts = readJson('.security/alerts.json');
  const alertsSummary = readJson('.security/alerts-summary.json', {});
  const githubStatus = readJson('.security/github-status.json', {});

  const { needed, reasons } = decideWork({ alerts, githubStatus });
  if (!needed) skip('无新告警、CI 全绿且两端 main 同步 —— 不叫醒 CodeBuddy，本轮零 AI 消耗');

  const open = await api('GET', `/issues?state=open&page_size=50&labels=${encodeURIComponent(PATROL_LABEL)}`);
  const list = Array.isArray(open) ? open : open?.list || [];
  if (hasOpenPatrolIssue(list)) {
    skip(`已有未关闭的巡检 Issue（#${list.map((i) => i.number).join(', #')}），先把它处理完`);
  }

  const { title, body } = buildPatrolIssue({ alerts, alertsSummary, githubStatus, reasons });
  assertMentionSafe(body, '巡检 Issue');
  const created = await api('POST', '/issues', {
    title,
    body,
    labels: [PATROL_LABEL],
    work_mode: true,
  });
  console.log(`已派单给 @CodeBuddy：Issue #${created?.number ?? '?'} —— ${reasons.join('；')}`);
}

async function review() {
  const verifyResults = readJson('.security/verify-results.json');
  const branch = process.env.CNB_BRANCH || '';
  let prNumber = Number(process.env.PR_NUMBER || 0);

  if (!prNumber) {
    const open = await api('GET', '/pulls?state=open&page_size=50');
    const list = Array.isArray(open) ? open : open?.list || [];
    const match = list.find((pr) => headBranchOf(pr) === branch);
    if (!match) skip(`分支 ${branch} 上没有 open 状态的 PR，无从复核`);
    prNumber = match.number;
  }

  const body = buildReviewComment({
    prNumber,
    branch,
    verifyResults,
    autoMergeEnabled: process.env.AUTO_MERGE_ENABLED,
  });
  assertMentionSafe(body, 'PR 复核评论');
  await api('POST', `/pulls/${prNumber}/comments`, { body, work_mode: true });
  console.log(`已派单给 @CodeBuddy：PR #${prNumber} 独立复核`);
}

const COMMANDS = { patrol, review };

if (process.argv[1] && process.argv[1].endsWith('codebuddy-dispatch.mjs')) {
  const cmd = COMMANDS[process.argv[2]];
  if (!cmd) {
    console.error('用法：node scripts/security/codebuddy-dispatch.mjs <patrol|review>');
    process.exit(2);
  }
  cmd().catch((err) => {
    console.error(`派单失败：${err.message}`);
    process.exit(1);
  });
}
