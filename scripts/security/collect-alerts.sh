#!/usr/bin/env bash
# ============================================================================
# collect-alerts.sh — CNB 安全告警采集
#
# 从 CNB「安全」能力读取当前仓库可获取的安全告警（代码漏洞 / 敏感信息 /
# 代码问题 / 许可证 / 依赖漏洞等），汇总为机器可读 JSON，供后续 AI 验证、
# 记录与跟踪使用。只读操作，不修改任何代码、不写入任何密钥。
#
# 输出：
#   ${OUTPUT:-.security/alerts.json}            全部告警快照（含详细描述）
#   ${SUMMARY:-.security/alerts-summary.json}   按类型统计的概览
#
# 设计要点：
#   * 使用 CNB_TOKEN（流水线内置、可信事件下具备 repo-code:r 权限）调用
#     CNB OpenAPI，无需额外密钥。
#   * 仅读取，绝不打印/写入 Token 等敏感信息。
#   * 若 CNB_TOKEN 缺失（例如本地手动运行），自动降级为跳过远端采集，
#     仅输出空快照并明确标注。
# ============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

OUTPUT="${OUTPUT:-.security/alerts.json}"
SUMMARY="${SUMMARY:-.security/alerts-summary.json}"
REPO_SLUG="${CNB_REPO_SLUG:-}"
API_BASE="${CNB_API_ENDPOINT:-https://api.cnb.cool}"
ACCEPT="Accept: application/vnd.cnb.api+json"

mkdir -p "$(dirname "$OUTPUT")" "$(dirname "$SUMMARY")"

note() { echo "==> $*"; }

api_get() {
  # api_get <url-path> [extra curl args...]
  local url_path="$1"; shift
  curl -fsSL --retry 3 --retry-connrefused \
    -H "Authorization: Bearer ${CNB_TOKEN}" \
    -H "$ACCEPT" \
    "$@" \
    "${API_BASE}${url_path}"
}

if [[ -z "${CNB_TOKEN:-}" || -z "$REPO_SLUG" ]]; then
  note "CNB_TOKEN 或 CNB_REPO_SLUG 未设置（非流水线环境），跳过远端告警采集。"
  echo '{"collected":false,"reason":"CNB_TOKEN or CNB_REPO_SLUG missing","repo":"'"${REPO_SLUG}"'","alerts":[],"summary":{}}' > "$OUTPUT"
  echo '{}' > "$SUMMARY"
  exit 0
fi

note "采集 CNB 安全告警（repo=${REPO_SLUG}）"

alerts="[]"
# 分类型采集代码扫描问题（code_vulnerability / code_sensitive / code_issue 均经由
# repo-code-issue 接口暴露，rule 前缀区分；无效 rule 会被接口以 400 拒绝，忽略即可）。
for rule in VUL_CRITICAL VUL_ERROR VUL_WARN VUL_HINT SENSITIVE_HIGH SENSITIVE_MEDIUM SENSITIVE_LOW ISSUE_CRITICAL ISSUE_ERROR ISSUE_WARN; do
  page_json="$(api_get "/${REPO_SLUG}/-/code/issues?issue_rule=${rule}&risk_level=all&page=1&page_size=100" 2>/dev/null || true)"
  if [[ -z "$page_json" ]] || ! echo "$page_json" | jq -e '.list? | type == "array"' >/dev/null 2>&1; then
    continue
  fi
  if [[ "$alerts" == "[]" ]]; then
    alerts="$(echo "$page_json" | jq -c '.list')"
  else
    alerts="$(jq -c -n --argjson a "$alerts" --argjson b "$(echo "$page_json" | jq -c '.list')" '$a + $b')"
  fi
done

# 全量兜底：再取一次不过滤 rule 的列表，避免遗漏新规则前缀
all_json="$(api_get "/${REPO_SLUG}/-/code/issues?risk_level=all&page=1&page_size=100" 2>/dev/null || true)"
if echo "$all_json" | jq -e '.list? | type == "array"' >/dev/null 2>&1; then
  extra="$(jq -c -n --argjson a "$alerts" --argjson b "$(echo "$all_json" | jq -c '.list')" '[ $b[] | . as $x | ($a | map(.id) | index($x.id)) == null | select(.) | $x ]')"
  if echo "$extra" | jq -e 'length > 0' >/dev/null 2>&1; then
    alerts="$(jq -c -n --argjson a "$alerts" --argjson b "$extra" '$a + $b')"
  fi
fi

# 去重（按 id）
alerts="$(echo "$alerts" | jq -c 'unique_by(.id)')"

# 逐个补全详情（repo-code-issue detail 接口），只保留关键字段并附加详情 URL
enriched="[]"
while IFS= read -r aid; do
  [[ -z "$aid" || "$aid" == "null" ]] && continue
  detail_json="$(api_get "/${REPO_SLUG}/-/code/issues/${aid}" 2>/dev/null || echo '{}')"
  if echo "$detail_json" | jq -e '.id? != null' >/dev/null 2>&1; then
    one="$(echo "$detail_json" | jq -c --arg url "https://cnb.cool/${REPO_SLUG}/-/code/issues/${aid}" '{
      id, rule, rule_title, display_name, risk_level, state, tool,
      file_path, line_no, occur_version, revision, author_name, created_at,
      description: (.description // ""), extra_msg: (.extra_msg // ""),
      detail_url: $url
    }')"
  else
    one="$(echo "$alerts" | jq -c --arg id "$aid" --arg url "https://cnb.cool/${REPO_SLUG}/-/code/issues/${aid}" '.[] | select(.id == $id) | {
      id, rule, rule_title, display_name, risk_level, state, tool,
      file_path, line_no, occur_version, revision, author_name, created_at,
      description: (.description // ""), extra_msg: (.extra_msg // ""),
      detail_url: $url
    }' | head -n1)"
  fi
  if [[ -n "$one" && "$one" != "null" ]]; then
    enriched="$(jq -c -n --argjson a "$enriched" --argjson b "$one" '$a + [$b]')"
  fi
done < <(echo "$alerts" | jq -r '.[].id // empty')

# 安全概览（各类型开启/忽略计数）
overview="$(api_get "/${REPO_SLUG}/-/security/overview?tab=all" 2>/dev/null || echo '{}')"
summary="$(echo "$overview" | jq -c '{overview: .}')"

# 落盘
echo "$enriched" | jq -c '{collected: true, repo: "'"${REPO_SLUG}"'", collected_at: (now | todate), total: (length), alerts: .}' > "$OUTPUT"
echo "$summary" > "$SUMMARY"

note "采集完成：$(echo "$enriched" | jq 'length') 条告警"
note "输出：$OUTPUT"
