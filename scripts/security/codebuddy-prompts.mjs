#!/usr/bin/env node
// ============================================================================
// scripts/security/codebuddy-prompts.mjs
//
// 派给 @CodeBuddy 的任务正文（Issue 正文 / PR 评论正文）。
//
// 为什么正文里要内嵌数据：@CodeBuddy 不是在当前流水线里跑的。我们建 Issue /
// 发评论 → CNB 触发 issue.comment@npc / pull_request.comment@npc → CodeBuddy 在
// **另一条流水线**里从零克隆仓库执行。alerts.json / verify-results.json 都是构建
// 期生成、未入库的文件，它那边看不到。所以这些数据必须随正文一起送过去。
//
// @ 提及的位置是硬约束：CNB 文档明确「引用(blockquote)、代码块、折叠块(details)、
// 有序/无序列表、表格、部分 HTML 标签」里的 @ 不会触发 NPC 事件。正文里的
// @CodeBuddy 必须是独立的普通段落，mentionIsSafe() 就是用来守这条的。
// ============================================================================

export const NPC_MENTION = '@CodeBuddy';
export const PATROL_LABEL = 'security-patrol';
export const MAX_EMBED_CHARS = 12000;

/** 共用红线。两条派单路径都必须原样带上，CodeBuddy 那边读不到我们的 systemPrompt。 */
export const REDLINES = [
  '禁止读取、打印或提交任何 Token / API Key / Cookie / 密码等密钥；',
  '禁止修改 CNB/GitHub 密钥仓库（solodawn-secrets）中的凭证；',
  '禁止执行与本仓库安全处置无关的外部操作；',
  '禁止 force push main、禁止修改或删除既有提交历史；',
  '禁止删除正常功能、关闭安全检查、扩大白名单或降低安全标准来规避告警；',
  '禁止仅凭 admin / password / token / localhost / test 等关键词判定漏洞或加入忽略列表；',
  '禁止修改以下自我管控文件：.cnb.yml 的 AUTO_MERGE_ENABLED 与任何自动合并判定逻辑、',
  '  .security/policy.yml（尤其 auto_merge 与 suppression 段）、',
  '  sonar-project.properties 的 sonar.exclusions 源文件条目。需要调整时只能写进结论交人工。',
];

/** 防自触发：CodeBuddy 的回复里若再出现 @CodeBuddy，会把自己再叫起来一轮。 */
export const NO_SELF_MENTION =
  '你后续的所有评论、PR 描述、提交信息里都**不要**再写 @CodeBuddy —— ' +
  '那会重新触发 NPC 事件，把你自己无限叫醒。';

/** 把数据包成代码块内嵌进正文；超长则截断并标注（截断的是数据，不是要求）。 */
export function embedJson(label, value, max = MAX_EMBED_CHARS) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text == null) text = 'null';
  let note = '';
  if (text.length > max) {
    text = text.slice(0, max);
    note = `\n（内容过长已截断到 ${max} 字符，完整数据请自行在仓库/平台侧复查）`;
  }
  return `<details>\n<summary>${label}</summary>\n\n\`\`\`json\n${text}\n\`\`\`\n\n</details>${note}`;
}

/**
 * 校验正文里**至少有一处** @ 提及落在能触发 NPC 事件的位置。
 *
 * 不是「所有提及都必须能触发」：正文末尾那句「不要再写 @CodeBuddy」是故意塞进
 * 有序列表里的 —— 它只是给 CodeBuddy 看的说明，本身不该把人再叫起来一轮。
 * 所以这里只要求存在一处有效提及，其余落在列表/代码块里的属于预期。
 *
 * 返回 { safe, reason }。派单前必须过这一关，否则会建出一个谁也不理的 Issue，
 * 而且不会有任何报错 —— 巡检从此静默失效。
 */
export function mentionIsSafe(body) {
  if (typeof body !== 'string' || !body.includes(NPC_MENTION)) {
    return { safe: false, reason: '正文里没有 @CodeBuddy' };
  }
  let inFence = false;
  let inDetails = 0;
  let firstBlocked = '';
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    const opens = (line.match(/<details/gi) || []).length;
    const closes = (line.match(/<\/details>/gi) || []).length;
    if (line.includes(NPC_MENTION)) {
      let blocked = '';
      if (inFence) blocked = '落在代码块里';
      else if (inDetails > 0) blocked = '落在折叠块里';
      else if (/^>/.test(trimmed)) blocked = '落在引用块里';
      else if (/^([-*+]\s|\d+[.)]\s)/.test(trimmed)) blocked = '落在列表里';
      else if (/^\|/.test(trimmed)) blocked = '落在表格里';
      if (!blocked) return { safe: true, reason: '' };
      if (!firstBlocked) firstBlocked = blocked;
    }
    inDetails += opens - closes;
    if (inDetails < 0) inDetails = 0;
  }
  return { safe: false, reason: `所有 @CodeBuddy 都无法触发（首处${firstBlocked}）` };
}

function redlineBlock() {
  return REDLINES.map((l) => (l.startsWith('  ') ? l : `- ${l}`)).join('\n');
}

/** 巡检派单：建 Issue，正文即任务书。 */
export function buildPatrolIssue({ alerts, alertsSummary, githubStatus, reasons = [], date }) {
  const day = date || new Date().toISOString().slice(0, 10);
  const title = `[安全巡检] ${day} 待处置`;
  const body = [
    `${NPC_MENTION} 请接手本次 SoloDawn 安全巡检的处置工作。`,
    '',
    '## 为什么建这个 Issue',
    '',
    `每日巡检流水线跑完后发现有需要判断的事项：${reasons.join('；') || '见下方数据'}。`,
    '巡检本身只做采集，判断和修复交给你。下面的数据是流水线现采的，仓库里没有这些文件，',
    '不要去找 .security/alerts.json —— 它是构建期产物，你这条流水线里不存在。',
    '',
    '## 必读',
    '',
    '- `.security/policy.yml`：完整策略，处置前必须读；',
    '- `.security/triage-log.json`：既有判定记录，**已处理过的告警直接复用结论，不要重复建 PR**；',
    '- `.security/README.md`：流程说明。',
    '',
    '## 红线（不得逾越）',
    '',
    redlineBlock(),
    '',
    '## 判定要求',
    '',
    '不要因为扫描器标记「高危」就认定为真实漏洞，也不要只看关键词。每条告警都要结合实际源码、',
    '调用路径、数据流、配置与真实可利用条件确认。依赖漏洞要核对 Cargo.lock / pnpm-lock.yaml 与',
    '上游 advisory 的 fixed 版本；敏感信息告警要区分测试夹具 / 占位符 / 示例 / 文档与真实密钥。',
    '',
    '## 处置分支',
    '',
    '**A. 判定为误报 / 测试代码 / 示例配置 / 无真实安全影响**',
    '',
    '不改业务代码。把结论（告警 id、误报原因、判断依据、日期）写进 `.security/triage-log.json`，',
    '用分支 `auto/security-triage-<4位随机>` 开一个 PR，且该 PR **只能改这一个文件**。',
    '满足这两条时 main.pull_request 流水线会自动校验并合并、删分支；夹带任何其他文件都会被守卫',
    '拒绝并留给人工，所以不要把日志更新和别的改动混在一个 PR 里。',
    '',
    '**B. 确认是真实漏洞**',
    '',
    '用分支 `auto/security-fix-<关键词>-<4位随机>` 做最小化修复（不改变无关功能/接口/架构），',
    '开 PR（base=main），PR 正文必须包含：原始告警、是否确认可利用、根因、修改内容、影响范围、',
    '测试和验证结果。PR 建好后必须触发验证流水线，不可跳过：',
    '',
    '```sh',
    'cnb build start-build --repo ${CNB_REPO_SLUG} --branch <修复分支> \\',
    '  --event api_trigger_security_verify --env PR_NUMBER=<PR编号>',
    '```',
    '',
    '**C. 拿不准**',
    '',
    '不要硬猜也不要反复试。把卡点写清楚，留给人工。同一问题最多尝试 3 轮：先读 triage-log 里该',
    '问题的 attempts 计数，≥3 就停止再提修复 PR、标记 needs_human；否则本轮 attempts 加一并记录',
    '本轮做法，下一轮禁止重复同一做法。同一手段连续两轮无效时，先怀疑「这个旋钮根本没接线」，',
    '去查该检查的真实来源，而不是继续换写法。',
    '',
    '## 收尾（必做）',
    '',
    '1. 在本 Issue 下回复一条中文总结：告警总数、逐条判定、创建的 PR（编号/分支/验证流水线触发情况）、',
    '   GitHub 同步与 CI 结论、需要人工关注的遗留项。',
    `2. ${NO_SELF_MENTION}`,
    '3. 回复完**自己关闭本 Issue**：`PATCH /{repo}/-/issues/{number}`，全部处置完用',
    '   `{"state":"closed","state_reason":"completed"}`；有遗留项交人工时用',
    '   `{"state":"closed","state_reason":"not_planned"}` 并在总结里写明遗留了什么。',
    '   不要留着不关 —— 巡检每天跑，未关闭的巡检 Issue 会让第二天不再派单。',
    '',
    '## 本次数据',
    '',
    embedJson('CNB 告警概览（alerts-summary.json）', alertsSummary),
    '',
    embedJson('CNB 告警明细（alerts.json）', alerts),
    '',
    embedJson('GitHub 同步与 CI 状态（github-status.json）', githubStatus),
  ].join('\n');
  return { title, body };
}

/** 修复 PR 复核派单：在 PR 上留评论，正文即任务书。 */
export function buildReviewComment({ prNumber, branch, verifyResults, autoMergeEnabled }) {
  const enabled = autoMergeEnabled === true || autoMergeEnabled === 'true';
  return [
    `${NPC_MENTION} 请对本 PR（#${prNumber}，分支 \`${branch}\`）做一次独立安全复核。`,
    '',
    '「独立」的意思是：只看这个 PR 的变更本身，不要沿用创建它时的思路。你只做最小范围复核，',
    '不做任何无关修改。验证流水线已经跑完，结果在最后一节，仓库里没有 verify-results.json，',
    '它是构建期产物，你这条流水线里不存在。',
    '',
    '## 红线（不得逾越）',
    '',
    redlineBlock(),
    '',
    '若本 PR 改动了上述自我管控文件里的门禁项，一律判定 `wait_for_human`。',
    '',
    '## 复核内容',
    '',
    '1. 对照 PR 描述里的原始告警，核实修复是否真的针对那条告警；',
    '2. 逐文件检查：安全回归（是否引入命令注入 / 路径穿越 / 权限绕过 / 硬编码密钥 / 敏感泄露）、',
    '   功能回归（是否改变无关功能、接口行为或架构）、过度修改（是否超出最小修复范围、',
    '   删除正常功能、关闭安全检查、扩大白名单或降低安全标准）。',
    '',
    '## 门禁判定',
    '',
    '- 只有 `gate=hard` 的检查算门禁（cargo_check / cargo_clippy / frontend_lint / frontend_tests /',
    '  backend_tests / security_audit / frontend_install 等），任一 failed → 不得自动合并；',
    '- `gate=advisory`（如 cargo_fmt，main 基线本身未全绿且 GitHub CI 不跑 fmt）仅供参考，不阻断；',
    '- 硬性检查存在 skipped → 视为有不确定性，不得自动合并；',
    '- `pr_ci_state` 必须为 success；',
    '- **`github_ci_state` 必须为 success**，failure 或 pending 一律不得合并。这一条对应 issue #5',
    '  第 7 条的「安全检查通过」：SonarCloud 的 Quality Gate 是 GitHub 侧的 check-run，',
    '  只看 CNB 流水线的 `pr_ci_state` 看不到它。`github_ci_failed_checks` 里的失败项要逐条写明。',
    '',
    '## 合并决策',
    '',
    `本次 AUTO_MERGE_ENABLED = \`${enabled}\`。仅当以下**全部**满足才执行合并：`,
    '',
    '- AUTO_MERGE_ENABLED 为 true；',
    '- 漏洞已确认，且修复范围明确、低风险；',
    '- 全部硬性检查 passed 且无 skipped；',
    '- pr_ci_state == success 且 github_ci_state == success；',
    '- 未改动上述自我管控文件；',
    '- 你本次复核未发现新的高风险问题；',
    '- 无需要人工判断的架构 / 权限 / 兼容性变化。',
    '',
    '任何一项不满足或存在不确定性 → **保留 PR 等人工**，绝不强并。',
    '',
    '## 收尾（必做）',
    '',
    '1. 在本 PR 下回复一条中文结论，逐条写明上面每个门禁项的取值、最终决策',
    '   （`auto_merge` / `wait_for_human` / `reject`）与理由；',
    `2. ${NO_SELF_MENTION}`,
    '3. 决策为 `auto_merge` 时，自己合并本 PR 并**关闭它**，然后删除源分支 `' + branch + '`；',
    '   再检查其他已合并 / 已关闭 PR 的残留源分支，一并删除，最终仓库只保留 main。',
    '4. 决策为 `reject` 时，说明理由后关闭本 PR 并删除源分支；',
    '   决策为 `wait_for_human` 时，**不要动 PR 状态**，原样留着等人。',
    '',
    '## 验证流水线结果',
    '',
    embedJson('verify-results.json', verifyResults),
  ].join('\n');
}
