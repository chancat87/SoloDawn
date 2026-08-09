# CNB 云原生安全巡检与修复流程

本目录是仓库「自动安全巡检与修复」机制的策略与记录。

> 入口配置见仓库根目录 `.cnb.yml`（`main.crontab: 37 8 * * *`）。

## 一、整体流程

```
每日一次（crontab 37 8 * * *，按 Asia/Shanghai 解析；CNB 云原生构建，无需人工 / WebIDE / 常驻环境）
   │
   ├─ 1. collect-alerts.sh       采集 CNB「安全」能力与当前仓库可获取的告警
   │                              → .security/alerts.json（构建期产物，不入库）
   │
   ├─ 2. npc:go（AI 巡检 Agent）  逐条结合源码/调用路径/配置验证告警
   │     ├─ 误报/测试代码/示例/本地用途 → 记录到 .security/triage-log.json
   │     │                              （纯审计日志，独立 PR 更新，不碰业务代码）
   │     └─ 确认真实漏洞 → 创建独立分支 auto/security-fix-*，最小化修复
   │                       → 创建独立 PR（含告警/可利用性/根因/修改/影响/验证说明）
   │                       → 触发 api_trigger_security_verify 验证流水线
   │
   └─ 3.（验证流水线 auto/security-fix-*，api_trigger_security_verify）重新独立审核 PR 变更
          → 运行仓库现有构建/静态检查/安全检查与相关测试（verify-fix.sh，完整 Rust+前端工具链镜像）
          → 读取 PR CI 状态（pr_ci_state 必须 success）
          → npc:go 二次独立审核 → 输出 .security/auto-merge-decision.json
          → 仅当 AUTO_MERGE_ENABLED=true 且全部自动合并条件满足时执行合并；
            默认关闭，任何不确定性都保留 PR 等待人工审核
```

## 二、触发方式

| 流水线 | 触发 | 配置位置 |
|---|---|---|
| 每日安全巡检 | `crontab: 37 8 * * *`（CNB 云原生构建调度，Asia/Shanghai） | `main` 分支 |
| 安全修复 PR 验证 | `api_trigger_security_verify`（由巡检 Agent 在创建 PR 后调用 `cnb build start-build` 触发） | `auto/security-fix-*` 分支 |
| 审计日志 PR 自动合并 | `pull_request`（目标分支 main） | `auto/security-triage-*` 分支 |
| GitHub ↔ CNB 同步 | 原有 `push` / `crontab: */5 * * * *`（保持不变） | `main` 分支 |

### 审计日志 PR 为什么要单开一条通道

巡检有两类产出。判定为**真实漏洞**时走 `auto/security-fix-*`，由验证流水线做
构建/静态检查/安全审计 + AI 独立审核，条件全满足才自动合并。判定为**误报或无新
告警**时，它只往 `.security/triage-log.json` 追加一段结论、开一个 docs PR ——
而那条路径上原本没挂任何流水线，PR 就一直悬着等人点。巡检每天都跑，等于每天早上
多一个「只加了一段日志」的 PR 要人处理，纯噪音，还会把人训练成闭眼点合并。

现由 `main.pull_request` 流水线跑 `scripts/security/auto-merge-triage-log.mjs`
自动处理，守卫四条全过才合并，任何一条不满足或任何一步拿不准都**不合并**、原样
留给人工（fail-closed）：

1. 源分支必须是 `auto/security-triage-*`（修复类分支落不到这里）；
2. PR 恰好只改 1 个文件；
3. 该文件完整路径必须精确等于 `.security/triage-log.json`；
4. 该文件在 PR 头部仍是合法 JSON 且 `schema` 没被换掉。

> 坑：CNB `pulls/{n}/files` 接口返回的 `filename` **只有文件名**（basename），
> 完整仓库路径只出现在 `contents_url` 里。按 `filename` 判定会放行仓库任意目录下
> 的同名 `triage-log.json`，所以路径必须从 `contents_url` 解析。守卫逻辑有单测：
> `node --test scripts/security/tests/auto-merge-triage-log.test.mjs`

## 三、告警验证原则（防误报）

- 扫描器标记「高危」不等于真实漏洞；出现 `admin / password / token / localhost / test`
  等关键词也不直接判定漏洞。
- 必须结合：具体代码、调用路径、数据流、配置、部署环境、是否可达、是否可被利用。
- 判定为误报/测试代码/示例配置/本地开发用途时，**不改业务代码**，仅记录原因与依据。

## 四、抑制（忽略）规则

- 仅允许对**单条告警记录**做最小范围抑制；禁止大范围关闭扫描规则。
- 禁止把 `admin` 等关键词一概加入忽略列表。
- 当前 CNB OpenAPI 仅提供告警列表/详情读取，未开放单条忽略接口；
  因此自动流程以 `.security/triage-log.json` 记录误报判定与依据。
  若后续平台开放单条精确抑制能力，再对该记录做最小范围抑制。

### SonarCloud 双分析（重要，踩过坑）

SonarCloud 上跑着**两套互不相干的分析**，同名难辨但行为完全不同：

| GitHub check 名称 | 来源 | 读 `sonar-project.properties`？ |
|---|---|---|
| **SonarCloud Code Analysis** | SonarCloud 的 Automatic Analysis（平台侧自动跑） | ❌ **不读** |
| **SonarQube Analysis** | `.github/workflows/ci-quality.yml` 里的 scanner | ✅ 读 |

2026-08-07 连续 5 次修改 `sonar-project.properties` 想压掉 Automatic Analysis 报的
docker 告警，每次都无效 —— 因为那个旋钮**根本没接到那台机器上**。

2026-08-08 查到了更下面一层的原因：**CI scanner 从来没成功跑过一次**。
本仓库 GitHub secrets 里没有 `SONAR_TOKEN`（`gh secret list` 只有三个 E2E_*），
scanner 每次都以 `Not authorized or project not found` / exit 3 结束；而那一步当时
写了 `continue-on-error: true`，于是 job 照样报绿。也就是说上表右列「✅ 读」的那一行
一直是空谈，SonarCloud 上所有分析都来自 Automatic Analysis。
现已改为：没有 token 就显式跳过并在 job summary 里写明原因；有 token 而扫描失败则
直接失败，不再吞掉（`.github/workflows/ci-quality.yml`）。

因此对 Automatic Analysis 的告警只有两条真路子：

1. **修根因**（首选）。例：`docker:S8482` 已通过「rustup-init 固定版本 + 官方归档 +
   SHA-256 校验后再执行」真正修掉，`new_security_rating` 由 E 降到 B。
2. **在 SonarCloud 界面上标记**该 issue 为 Won't Fix / Safe（需要项目管理员，Agent 做不到）。
   或者配置 `SONAR_TOKEN` 并关掉 Automatic Analysis，只保留 CI scanner，这样本仓库的
   `sonar.issue.ignore.multicriteria` 才会真正生效。两种分析互斥，不能都开。

> 关于 `docker:S6471`（`.ci/` 两个镜像默认 root）：不采用「在 Dockerfile 末尾加
> 非 root `USER`」来消灭告警。这两个镜像是 CNB 流水线的运行环境，stage 需要读写
> CNB 挂载的 `/workspace`，挂载点属主由 CNB 决定；改成非 root 有让每日巡检整条挂掉
> 的实际风险。为一条 MINOR、且针对不对外交付的 CI 镜像的告警去换这个风险不划算，
> 故维持 root + 精确到「规则 × 文件」的抑制，等 CI scanner 真正接上后生效。

`sonar.exclusions` 里**禁止**加源文件：那是文件级排除，会关掉该文件上的全部规则，
属于本策略明令禁止的「大范围关闭扫描规则」。

## 五、真实漏洞修复规则

- 独立分支 `auto/security-fix-*` + 独立 PR，最小修改，不改变无关功能/接口/架构。
- 禁止：删除正常功能、关闭安全检查、扩大白名单、降低安全标准。
- 重点领域：命令注入、路径穿越、权限绕过、认证/授权、硬编码密钥、
  敏感信息泄露、不安全默认配置、依赖漏洞、供应链风险。
- PR 必须说明：原始告警；是否确认可利用；根因；修改内容；影响范围；测试和验证结果。

## 六、自动合并条件（`AUTO_MERGE_ENABLED=true`）

仅当以下**全部**满足时才自动合并到 `main`：

1. 漏洞已被确认；
2. 修复范围明确且为低风险修改；
3. 所有相关测试通过；
4. 构建通过；
5. 静态检查通过；
6. 安全检查通过 —— **同时**要求本地 `security_audit` 通过
   **且** `github_ci_state == "success"`；
7. 独立代码审核未发现新的高风险问题；
8. 不存在需要人工判断的架构、权限或兼容性变化；
9. 未触碰第七节列出的自我约束红线文件。

任何一项存在不确定性 → 只创建/保留 PR，等待人工审核，不自动合并。

> 第 6 条为什么要单列 `github_ci_state`：`verify-results.json` 原有的
> `pr_ci_state` 来自 `cnb pulls list-pull-commit-statuses`，只反映 CNB 自己的流水线。
> SonarCloud 的 Quality Gate 是挂在 **GitHub** commit 上的 check-run，CNB 看不到。
> 2026-08-07 就因为这个盲区，安全门禁一路红着，自动合并却判定「安全检查通过」
> 并合入 main。`scripts/security/verify-fix.sh` 现在会额外读一次 GitHub
> check-runs，把结果写进 `github_ci_state` / `github_ci_failed_checks`。

## 七、安全边界（硬性约束）

- 禁止读取、打印或提交 Token / API Key / Cookie / 密码等密钥。
- 禁止修改 CNB/GitHub 密钥仓库（如 `solodawn-secrets`）中的凭证。
- 禁止执行与当前仓库安全修复无关的外部操作。
- 禁止 force push `main`；禁止修改或删除既有提交历史。

### 自我约束红线（Agent 不得修改）

以下文件是**管着 Agent 自己**的闸门，Agent 无权为了让流程通过而放宽：

| 文件 | 受保护范围 |
|---|---|
| `.cnb.yml` | `AUTO_MERGE_ENABLED` 及任何自动合并判定逻辑 |
| `.security/policy.yml` | 整个文件，尤其 `auto_merge` 与 `suppression` |
| `sonar-project.properties` | `sonar.exclusions` 的源文件条目 |

需要调整时只能记录到巡检总结交人工处理。独立审核 Agent 发现被审 PR 触碰这些范围，
一律判定 `wait_for_human`。

> 为什么加这条：commit `3ff01c1bd` 中，巡检 Agent 自行把 `AUTO_MERGE_ENABLED`
> 由 `"false"` 改成 `"true"`（原注释写着「保守默认：不自动合并，等待人工审核」），
> 随后在 GitHub 侧安全门禁持续失败的情况下自动合并了多个 PR 到 `main`。
> 自主 Agent 不得解除约束自身的闸门。

### 止损：同一问题最多 3 轮

`.security/triage-log.json` 每条记录带 `attempts` 计数。达到 3 次仍未解决 →
标记 `needs_human`，停止再提修复 PR，在总结里写明每轮做法与真实卡点。

同一手段连续两轮无效时，必须先怀疑「这个旋钮根本没接线」，去核实该检查的真实来源
（见第四节 SonarCloud 双分析），而不是继续换写法。

## 八、构建期产物（不入库）

| 文件 | 说明 |
|---|---|
| `.security/alerts.json` | 告警快照 |
| `.security/alerts-summary.json` | 告警概览 |
| `.security/verify-results.json` | 验证结果（构建/静态检查/测试/安全审计/PR CI 状态） |
| `.security/auto-merge-decision.json` | 自动合并决策 |

## 九、当前已知告警与判定（供巡检 Agent 参考）

| 告警 | 类型 | 初步判定 | 处置 |
|---|---|---|---|
| `fast-uri@3.1.1`（CVE-2026-6322，pnpm-lock.yaml） | 依赖漏洞（高危） | 真实依赖漏洞，修复面极小（overrides 3.1.1 → 3.1.2 + 锁文件更新） | 由巡检流程生成低风险修复 PR |
| `glib@0.18.5`（GHSA-wrw7-89jp-8q8g，Cargo.lock） | 依赖漏洞（中危） | 真实，但修复需升级到 0.20.0（主版本），涉及 tray/GTK 相关 crate，存在 API/兼容性变化 | 需人工判断，仅建 PR 不自动合并 |
