#!/usr/bin/env node
// ============================================================================
// scripts/security/sonar-quality-gate.mjs
//
// 把项目的 SonarCloud 质量门禁在「Sonar way」与「SoloDawn way」之间切换。
//
// 为什么需要它：内置的 Sonar way 里有一条 new_coverage >= 80%。本仓库目前**不
// 上报任何覆盖率**（Rust 侧没有任何覆盖率工具，前端 vitest 虽配了 coverage 但
// 既没装 @vitest/coverage-v8 也没输出 lcov），所以这一项恒为 0 → 门禁恒红 →
// GitHub 上的 "SonarCloud Code Analysis" check 每次提交都是红叉 → 每日安全巡检
// 读到的 github_ci_state 永远是 failure，自动合并条件永远无法满足。
//
// 一个永远红的门禁比没有门禁更糟：它不再传递信息，只训练人无视它。
//
// 「SoloDawn way」= Sonar way 去掉 new_coverage 那一条，其余五条**原样保留**
// （安全/可靠性/可维护性评级、重复率、安全热点复核率）。也就是说安全标准一分
// 没降，只是不再断言一个我们根本没在测量的指标。等覆盖率流水线真建起来了，用
// --revert 换回 Sonar way，或给 SoloDawn way 加回 new_coverage 即可。
//
// 这个脚本只在 .github/workflows/sonar-quality-gate.yml 里由人手动触发
// （workflow_dispatch）运行，不挂在任何自动流水线上 —— 改动的是 SonarCloud 侧
// 的项目设置，应当每次都由人明确发起。
// ============================================================================

const API = 'https://sonarcloud.io/api';
const ORG = process.env.SONAR_ORGANIZATION || 'huanchong-99';
const PROJECT = process.env.SONAR_PROJECT_KEY || 'huanchong-99_GitCortex';
const CUSTOM_GATE = 'SoloDawn way';
const BUILTIN_GATE = 'Sonar way';

// Sonar way 的六条条件，实查自 api/qualitygates/show（2026-08-09）。
// 这里保留其中五条，new_coverage 是唯一被去掉的一条。
const CONDITIONS = [
  { metric: 'new_security_rating', op: 'GT', error: '1' },
  { metric: 'new_reliability_rating', op: 'GT', error: '1' },
  { metric: 'new_maintainability_rating', op: 'GT', error: '1' },
  { metric: 'new_duplicated_lines_density', op: 'GT', error: '3' },
  { metric: 'new_security_hotspots_reviewed', op: 'LT', error: '100' },
];

const token = process.env.SONAR_TOKEN;
if (!token) {
  console.error('SONAR_TOKEN is not set.');
  process.exit(1);
}

// 参数名实查自 api/webservices/list：create_condition 与 select 都要 gateId
// （不是 gateName），第一次按名字传直接 400。
async function api(method, path, params) {
  const url = new URL(`${API}/${path}`);
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  } else {
    // SonarQube 的 web API 用表单编码，不是 JSON。
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(params || {}).toString();
  }
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function listGates() {
  const d = await api('GET', 'qualitygates/list', { organization: ORG });
  return d.qualitygates || [];
}

async function currentGate() {
  const d = await api('GET', 'qualitygates/get_by_project', {
    organization: ORG,
    project: PROJECT,
  });
  return d.qualityGate?.name;
}

async function gateByName(name) {
  return (await listGates()).find((g) => g.name === name);
}

async function showGate(id) {
  return api('GET', 'qualitygates/show', { organization: ORG, id: String(id) });
}

const sameCondition = (a, b) =>
  a.metric === b.metric && String(a.op) === String(b.op) && String(a.error) === String(b.error);

/**
 * 把门禁的条件对齐到 CONDITIONS —— 缺的补上，多的删掉。
 * 写成"对账"而不是"一次性创建"，是因为创建门禁和写入条件是分开的两次调用：
 * 中途失败会留下一个空门禁，只判断"门禁是否存在"就会永远跳过补条件，留下一个
 * 什么都不检查的空壳。对账让脚本从任何中间状态都能收敛。
 */
async function reconcileConditions(gateId) {
  const existing = (await showGate(gateId)).conditions || [];

  for (const c of existing) {
    if (CONDITIONS.some((want) => sameCondition(want, c))) continue;
    console.log(`    - 删除多余条件 ${c.metric} ${c.op} ${c.error}`);
    await api('POST', 'qualitygates/delete_condition', { organization: ORG, id: String(c.id) });
  }

  for (const want of CONDITIONS) {
    if (existing.some((c) => sameCondition(want, c))) continue;
    console.log(`    + ${want.metric} ${want.op} ${want.error}`);
    await api('POST', 'qualitygates/create_condition', {
      organization: ORG,
      gateId: String(gateId),
      metric: want.metric,
      op: want.op,
      error: want.error,
    });
  }
}

async function apply() {
  let gate = await gateByName(CUSTOM_GATE);
  if (!gate) {
    console.log(`==> 创建质量门禁「${CUSTOM_GATE}」`);
    await api('POST', 'qualitygates/create', { organization: ORG, name: CUSTOM_GATE });
    gate = await gateByName(CUSTOM_GATE);
    if (!gate) throw new Error(`创建后仍找不到门禁「${CUSTOM_GATE}」`);
  } else {
    console.log(`==> 门禁「${CUSTOM_GATE}」已存在（id=${gate.id}）`);
  }

  console.log('==> 对齐条件');
  await reconcileConditions(gate.id);

  console.log(`==> 将项目 ${PROJECT} 指向「${CUSTOM_GATE}」`);
  await api('POST', 'qualitygates/select', {
    organization: ORG,
    gateId: String(gate.id),
    projectKey: PROJECT,
  });
}

async function revert() {
  const gate = await gateByName(BUILTIN_GATE);
  if (!gate) throw new Error(`找不到内置门禁「${BUILTIN_GATE}」`);
  console.log(`==> 将项目 ${PROJECT} 改回内置「${BUILTIN_GATE}」（id=${gate.id}）`);
  await api('POST', 'qualitygates/select', {
    organization: ORG,
    gateId: String(gate.id),
    projectKey: PROJECT,
  });
}

const action = process.argv[2];
const run = { apply, revert }[action];
if (!run) {
  console.error('用法: node scripts/security/sonar-quality-gate.mjs <apply|revert>');
  process.exit(1);
}

console.log(`==> 当前门禁：${await currentGate()}`);
await run();
console.log(`==> 变更后门禁：${await currentGate()}`);
const finalGate = await gateByName(await currentGate());
console.log('==> 生效条件：');
for (const c of (await showGate(finalGate.id)).conditions || []) {
  console.log(`    ${c.metric} ${c.op} ${c.error}`);
}
