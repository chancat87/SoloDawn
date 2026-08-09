#!/usr/bin/env node
// ============================================================================
// scripts/security/auto-merge-triage-log.mjs
//
// 自动合并「只改审计日志」的巡检 PR。
//
// 背景：巡检 Agent 有两条产出路径。判定为真实漏洞时走 auto/security-fix-*，
// 由 api_trigger_security_verify 流水线做验证 + AI 独立审核 + 自动合并；而判定
// 为误报 / 无新告警时，它只把结论写进 .security/triage-log.json 并开一个 docs
// PR —— 那条路径上没挂任何流水线，PR 就一直悬着等人点合并。巡检每天都跑，于是
// 每天早上多一个「只加了一段日志」的 PR 要人处理，纯噪音。
//
// 这个脚本补上那条路径的自动合并，守卫严到不可能夹带代码改动：
//   1. 源分支必须是 auto/security-triage-*（修复类分支走另一条带 AI 审核的线）；
//   2. PR 必须恰好只改 1 个文件，且完整路径就是 .security/triage-log.json；
//   3. 该文件在 PR 头部必须仍是合法 JSON 且 schema 没被换掉。
// 任何一条不满足、任何一步拿不准 → 一律不合并，原样留给人工（fail-closed）。
//
// 用 Node 而不是 shell+jq：巡检镜像基于 node:22，node 一定在；而这样守卫逻辑
// 可以在开发机上拿真实 API 响应直接跑测试（scripts/security/tests/）。
//
// CNB 接口的坑：pulls/{n}/files 里的 `filename` 只有**文件名**（basename），
// 完整仓库路径只出现在 `contents_url` 里。按 filename 判定会放行仓库任意目录下
// 的同名文件，所以路径必须从 contents_url 解析。
// ============================================================================

export const TRIAGE_LOG_PATH = '.security/triage-log.json';
export const TRIAGE_SCHEMA = 'solodawn-security-triage-v1';
export const BRANCH_PREFIX = 'auto/security-triage-';

/** 从 contents_url 里取出仓库相对路径；取不到返回 null。 */
export function pathFromContentsUrl(contentsUrl) {
  if (typeof contentsUrl !== 'string') return null;
  const marker = '/git/contents/';
  const at = contentsUrl.indexOf(marker);
  if (at < 0) return null;
  const path = decodeURIComponent(contentsUrl.slice(at + marker.length).split('?')[0]);
  return path || null;
}

/**
 * 守卫 2：PR 的改动范围。返回 { ok: true } 或 { ok: false, reason }。
 * 只认「恰好 1 个文件、路径就是审计日志、状态是 modify」。
 */
export function checkChangedFiles(files) {
  if (!Array.isArray(files)) return { ok: false, reason: '文件列表响应不是数组' };
  if (files.length !== 1) {
    return { ok: false, reason: `改动了 ${files.length} 个文件，只允许 1 个` };
  }
  const file = files[0];
  const path = pathFromContentsUrl(file?.contents_url);
  if (!path) return { ok: false, reason: '无法从 contents_url 解析出文件路径' };
  if (path !== TRIAGE_LOG_PATH) {
    return { ok: false, reason: `改动路径为 ${path}，不是 ${TRIAGE_LOG_PATH}` };
  }
  if (file.status !== 'modify') {
    return { ok: false, reason: `文件状态为 ${file.status ?? 'unknown'}，只允许 modify` };
  }
  return { ok: true };
}

/** 守卫 3：PR 头部那一版审计日志仍是合法 JSON 且 schema 未被换掉。 */
export function checkTriageLogContent(contentsResponse) {
  if (contentsResponse?.encoding !== 'base64' || typeof contentsResponse.content !== 'string') {
    return { ok: false, reason: '内容响应不是 base64 编码，无法校验' };
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(contentsResponse.content, 'base64').toString('utf8'));
  } catch (e) {
    return { ok: false, reason: `审计日志不是合法 JSON：${e.message}` };
  }
  if (parsed?.schema !== TRIAGE_SCHEMA) {
    return { ok: false, reason: `schema 为 ${JSON.stringify(parsed?.schema)}，期望 ${TRIAGE_SCHEMA}` };
  }
  return { ok: true };
}

// --- 以下为流水线运行部分；被 import 时不执行 ------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url.endsWith(String(process.argv[1]).replace(/\\/g, '/'));

/** 不合并并正常退出：守卫生效不是错误，PR 留给人工。 */
function skip(reason) {
  console.log(`==> 不自动合并：${reason}`);
  process.exit(0);
}

async function main() {
  const {
    CNB_TOKEN,
    CNB_REPO_SLUG: repo,
    CNB_PULL_REQUEST_IID: prIid,
    CNB_PULL_REQUEST_BRANCH: prBranch,
    CNB_PULL_REQUEST_SHA: prSha,
    CNB_API_ENDPOINT,
  } = process.env;
  const apiBase = CNB_API_ENDPOINT || 'https://api.cnb.cool';

  if (!CNB_TOKEN) skip('CNB_TOKEN 未设置（非流水线环境）');
  if (!repo) skip('CNB_REPO_SLUG 未设置');
  if (!prIid) skip('CNB_PULL_REQUEST_IID 未设置（非 PR 事件）');
  if (!prBranch) skip('CNB_PULL_REQUEST_BRANCH 未设置');
  if (!prSha) skip('CNB_PULL_REQUEST_SHA 未设置，无法按提交校验内容');

  // 守卫 1：源分支前缀。修复类分支必须走带 AI 独立审核的那条线。
  if (!prBranch.startsWith(BRANCH_PREFIX)) {
    skip(`源分支 ${prBranch} 不是 ${BRANCH_PREFIX}*`);
  }

  const api = async (method, path, body) => {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${CNB_TOKEN}`,
        Accept: 'application/vnd.cnb.api+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  };

  console.log(`==> 检查 PR #${prIid}（源分支 ${prBranch}）的改动范围`);
  let files;
  try {
    files = await api('GET', `/${repo}/-/pulls/${prIid}/files`);
  } catch (e) {
    skip(`无法读取 PR 文件列表：${e.message}`);
  }
  const scope = checkChangedFiles(files);
  if (!scope.ok) skip(scope.reason);

  let contents;
  try {
    contents = await api('GET', `/${repo}/-/git/contents/${TRIAGE_LOG_PATH}?ref=${prSha}`);
  } catch (e) {
    skip(`无法读取 ${TRIAGE_LOG_PATH}@${prSha}：${e.message}`);
  }
  const content = checkTriageLogContent(contents);
  if (!content.ok) skip(content.reason);

  console.log(`==> 守卫全部通过：PR #${prIid} 仅追加审计日志，执行合并`);
  try {
    await api('PUT', `/${repo}/-/pulls/${prIid}/merge`, {
      merge_style: 'squash',
      commit_title: `docs(security): 巡检审计日志更新（PR #${prIid}）`,
      commit_message:
        '由 auto-merge-triage-log 流水线自动合并：本 PR 仅修改 .security/triage-log.json，'
        + '已通过「单文件 + 路径精确匹配 + JSON schema」三项校验。',
    });
  } catch (e) {
    skip(`合并接口调用失败（可能有冲突或权限不足），保留 PR 等人工：${e.message}`);
  }
  console.log(`==> PR #${prIid} 已合并`);

  // 清理源分支；删不掉不算失败——PR 已经并了，残留分支下轮巡检会处理。
  try {
    await api('DELETE', `/${repo}/-/git/branches/${prBranch}`);
    console.log(`==> 已删除源分支 ${prBranch}`);
  } catch (e) {
    console.log(`==> 源分支 ${prBranch} 删除失败（忽略）：${e.message}`);
  }
}

if (isMain) {
  main().catch((e) => {
    // 兜底也走 fail-closed：报出来，但不把流水线判失败，PR 留给人工。
    console.log(`==> 不自动合并：未预期的错误 ${e.stack || e.message}`);
    process.exit(0);
  });
}
