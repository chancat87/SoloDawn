#!/usr/bin/env bash
# ============================================================================
# verify-fix.sh — 安全修复验证脚本
#
# 在安全修复 PR 的验证流水线（api_trigger_security_verify，auto/security-fix-* 分支）中
# 运行仓库现有的构建、静态检查、安全检查与相关测试，并读取 PR 的 CI 状态，
# 将结果汇总为 JSON 供 npc:go 独立审核 Agent 判定"是否满足自动合并条件"。
#
# 输出：
#   ${RESULTS:-.security/verify-results.json}   验证结果（构建期生成，不入库）
#
# 说明：
#   * 本脚本复刻仓库 GitHub CI（ci-basic.yml）的核心检查命令，保证口径一致；
#   * 失败不会中断流水线，最终以 JSON 汇总供 Agent 决策；
#   * 若工具缺失（如本地环境），对应检查标记为 skipped，Agent 不得据此判定通过。
# ============================================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

RESULTS="${RESULTS:-.security/verify-results.json}"
mkdir -p "$(dirname "$RESULTS")"

# 与仓库 GitHub CI（.github/actions/setup-rust/action.yml）保持一致的构建环境变量：
# aws-lc-sys 静态链接、libgit2 走 pkg-config、sqlx 离线（.sqlx/ 缓存）
export AWS_LC_SYS_STATIC=1
export AWS_LC_SYS_NO_PREGENERATED_SRC=1
export LIBGIT2_SYS_USE_PKG_CONFIG=1
export SQLX_OFFLINE=true

start_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
report="{\"started_at\":\"$start_ts\",\"repo\":\"${CNB_REPO_SLUG:-}\",\"branch\":\"${CNB_BRANCH:-}\",\"checks\":{}}"

# run_check <key> <desc> [advisory] <cmd...>
# 默认视为“硬性门禁”（hard gate）；若在 cmd 前标记 "advisory"，则该检查仅作参考
# （不影响自动合并判定）。如 cargo_fmt：main 基线存在大量历史 fmt 差异，且 GitHub CI
# 并不跑 fmt --check，故作为参考检查而非硬性门禁。
run_check() {
  local key="$1" desc="$2"; shift 2
  local gate="hard"
  if [[ "$1" == "advisory" ]]; then
    gate="advisory"; shift
  fi
  echo "==> [$key] $desc"
  if "$@" > /tmp/verify-${key}.log 2>&1; then
    report="$(echo "$report" | jq --arg k "$key" --arg d "$desc" --arg g "$gate" \
      '.checks[$k] = {description:$d, status:"passed", exit_code:0, gate:$g}')"
    echo "    -> passed"
  else
    local code=$?
    report="$(echo "$report" | jq --arg k "$key" --arg d "$desc" --arg g "$gate" --argjson c "$code" \
      '.checks[$k] = {description:$d, status:"failed", exit_code:$c, gate:$g}')"
    echo "    -> FAILED (exit=$code) [${gate}]"
  fi
}

skip_check() {
  local key="$1" desc="$2" reason="$3"
  report="$(echo "$report" | jq --arg k "$key" --arg d "$desc" --arg r "$reason" \
    '.checks[$k] = {description:$d, status:"skipped", reason:$r}')"
  echo "    -> skipped ($reason)"
}

command -v cargo >/dev/null 2>&1 && HAVE_CARGO=1 || HAVE_CARGO=0
command -v pnpm  >/dev/null 2>&1 && HAVE_PNPM=1  || HAVE_PNPM=0

# 与仓库 GitHub CI 保持一致的 crate 选择（排除 tray，其依赖桌面环境）
CARGO_SELECT="--workspace --exclude solodawn-tray"

# 1) 构建检查（后端）
if [[ "$HAVE_CARGO" == "1" ]]; then
  run_check cargo_check "cargo check (workspace, ci profile, locked)" \
    bash -c "cargo check $CARGO_SELECT --profile ci --locked"
  run_check cargo_fmt "cargo fmt --check (advisory)" advisory \
    bash -c "cargo fmt --all -- --check"
  run_check cargo_clippy "cargo clippy (workspace, -D warnings)" \
    bash -c "cargo clippy $CARGO_SELECT --all-targets --all-features --profile ci --locked -- -D warnings"
else
  skip_check cargo_check "cargo check" "cargo not installed"
  skip_check cargo_fmt "cargo fmt --check" "cargo not installed"
  skip_check cargo_clippy "cargo clippy" "cargo not installed"
fi

# 2) 后端相关测试（TARGET_TESTS 可覆盖；默认与仓库 CI 一致：nextest --lib）
if [[ "$HAVE_CARGO" == "1" ]]; then
  if [[ -n "${TARGET_TESTS:-}" ]]; then
    run_check relevant_tests "relevant tests: $TARGET_TESTS" bash -c "$TARGET_TESTS"
  elif command -v cargo-nextest >/dev/null 2>&1; then
    run_check backend_tests "cargo nextest run (workspace lib, ci profile, locked)" \
      bash -c "cargo nextest run $CARGO_SELECT --cargo-profile ci --lib --locked"
  else
    skip_check backend_tests "cargo nextest run" "cargo-nextest not installed"
  fi
else
  skip_check backend_tests "backend tests" "cargo not installed"
fi

# 3) 前端检查（lint / 类型 / 测试）
# 先安装前端依赖（与仓库 CI setup-frontend 一致），否则 eslint/vitest/tsc 缺失导致误报失败
if [[ "$HAVE_PNPM" == "1" && -d frontend ]]; then
  run_check frontend_install "pnpm install --frozen-lockfile" \
    bash -c "cd frontend && pnpm install --frozen-lockfile"
  if [[ "$(echo "$report" | jq -r '.checks.frontend_install.status // "failed"')" == "passed" ]]; then
    run_check frontend_lint "frontend lint" bash -c "cd frontend && pnpm run lint"
    run_check frontend_typecheck "frontend type check" bash -c "cd frontend && pnpm run check"
    run_check frontend_tests "frontend tests" bash -c "cd frontend && pnpm run test:run"
  else
    skip_check frontend_lint "frontend lint" "frontend deps install failed"
    skip_check frontend_typecheck "frontend type check" "frontend deps install failed"
    skip_check frontend_tests "frontend tests" "frontend deps install failed"
  fi
else
  skip_check frontend_lint "frontend lint" "pnpm not installed"
  skip_check frontend_typecheck "frontend type check" "pnpm not installed"
  skip_check frontend_tests "frontend tests" "pnpm not installed"
fi

# 4) 仓库既有安全审计
if [[ -f scripts/audit-security.sh ]]; then
  run_check security_audit "scripts/audit-security.sh" bash scripts/audit-security.sh
else
  skip_check security_audit "security audit" "scripts/audit-security.sh missing"
fi

# 5) PR CI 状态（构建/测试/静态检查的权威门禁；GitHub 侧不可用时保持 not_checked）
pr_ci_state="not_checked"
if [[ -n "${PR_NUMBER:-}" && -n "${CNB_REPO_SLUG:-}" ]] && command -v cnb >/dev/null 2>&1; then
  ci_json="$(cnb pulls list-pull-commit-statuses --repo "${CNB_REPO_SLUG}" --number "${PR_NUMBER}" --verbose 2>/dev/null || true)"
  if echo "$ci_json" | jq -e '.data.state?' >/dev/null 2>&1; then
    pr_ci_state="$(echo "$ci_json" | jq -r '.data.state // "unknown"')"
  elif echo "$ci_json" | jq -e '.state?' >/dev/null 2>&1; then
    pr_ci_state="$(echo "$ci_json" | jq -r '.state // "unknown"')"
  fi
fi

# 汇总
end_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
report="$(echo "$report" | jq --arg s "$pr_ci_state" --arg n "${PR_NUMBER:-}" --arg e "$end_ts" \
  '{started_at: .started_at, finished_at: $e, repo: .repo, branch: .branch,
    pr_number: $n, pr_ci_state: $s,
    passed: ([.checks[] | select(.status == "passed")] | length),
    failed: ([.checks[] | select(.status == "failed")] | length),
    skipped: ([.checks[] | select(.status == "skipped")] | length),
    checks: .checks}')"

echo "$report" | jq . > "$RESULTS"
echo ""
echo "=== 验证汇总 ==="
jq '{passed, failed, skipped, pr_ci_state}' "$RESULTS"
echo "输出：$RESULTS"
