---
name: fanhan-recruiting-notion
description: 当前唯一在线招聘库：以 Notion 三张表（候选人库、职位 JD 库、公司库）做招聘双向检索与匹配判断。用户要拿 Notion 里的候选人找岗位、拿 JD 找候选人、需要可复现的匹配分数与档位、或要把匹配结果写回 Notion 关系字段时使用。不要改用 Twenty / $recruiting-crm 或旧 Base；Notion 未覆盖的能力停止并报告缺口。
---

# 泛函招聘 Notion 版检索与匹配

> **当前唯一在线招聘数据库（2026-11-25 起）**：候选人、职位、公司只通过本 Skill 和 `scripts/fanhan-ntn` 查/写 Notion。Twenty、`recruiting-crm`、旧飞书 Base 是历史或用户显式提供的离线快照，不是当前生产库，也不作为 Notion 缺少能力时的回退。遇到无法在 Notion CLI 完成的在线操作，停止并报告缺口。

用 `scripts/fanhan-ntn` 这个 CLI 读写 Notion 三张表。CLI 只做事实层：取数、归一、硬性排除、把原始材料交给判断模型；**分数全部由判断模型给出，CLI 不做加权**。

## 前置条件

1. 本机装好 Notion 官方 CLI 并登录：`ntn whoami` 能返回工作区。
2. 判断模型凭据（Perplexity Decider）：`pbpaste | fanhan-ntn auth login`，key 经 stdin 存入 Keychain，不出现在命令行参数与日志里。凭据严格绑定 provider / endpoint / key：provider 专用 key 与 Keychain 只用于精确匹配的官方 HTTPS origin（根路径或 `/v1`）；自定义 HTTPS endpoint 必须显式 `provider=custom` + `FANHAN_LLM_API_KEY`，不会借用其他 provider 的 key，也不会把 `DEEPSEEK_API_KEY` 静默发往 Perplexity 端点。
3. 安装 CLI 本身：在 `scripts/fanhan-ntn` 下执行 `npm link`，得到 `fanhan-ntn` 命令。

三张表的 data source ID 默认指向泛函自己的工作区，换工作区时用 `FANHAN_DS_CANDIDATES` / `FANHAN_DS_JOBS` / `FANHAN_DS_COMPANIES` 覆盖。

## 标准流程

```bash
fanhan-ntn status                 # 连接、缓存时效、模型与安全字段
fanhan-ntn sync                   # 完整成功才原子替换缓存；不完整则保留旧快照
fanhan-ntn audit                  # 缺 JSON / 缺职类 / 空壳 / 安全字段清单
```

`sync` 的缓存目录为 `0700`、文件为 `0600`。`list` / `get` / `status` 会显示缓存同步时间与是否过期；过期缓存只能作为线索，涉及写回或对外结论时先重新 `sync` 或按命令提示重新读取最新页面。

拿到 JD 或简历之后：

```bash
# JD 找人
fanhan-ntn match --job "<职位名或页面ID>" --top 10 --max-records 100
fanhan-ntn match --job-json ./jd.json --top 10 --max-records 100

# 简历找岗
fanhan-ntn match --candidate "<候选人名或页面ID>" --top 10
fanhan-ntn match --candidate-json ./candidate.json --top 10

# 单对复核（会打印概率分布与原始 JSON）
fanhan-ntn explain "<候选人>" "<职位>" --raw
```

## 判断结果怎么读

每对输出四项，彼此独立：

| 字段 | 含义 |
|---|---|
| `评分` / `档位` | 模型对整体匹配的概率加权判断，5 档，折算 0–100 |
| `硬性要求` | 岗位写明的学历/年限/必备技术栈是否能在材料中找到对应事实的概率 |
| `类型冲突` | 正式 vs 实习是否存在明确冲突的概率；任一方未标注不算冲突 |
| `职级匹配` | 职级是否大致对等 |

排序只看 `评分`。`硬性要求` 低而 `评分` 高时，要在交付里明确指出这个矛盾，不能只报分数。

## 边界

- **不编造**：候选人材料没写的经历、年限、成果一律按未知处理，不得因为岗位需要就替候选人补上。年份、历史实习、职位名称里的“可实习”、否定句都不会被当作当前雇佣意向。
- **命中记录不等于推荐**：`--top` 是候选范围，不是推荐名单；对外推荐前按受众再过一遍。
- **写回需显式授权**：`link` 默认只预演，必须加 `--yes` 才写 Notion。`--yes` 会新鲜读取页面和完整关系，按 `safety` 映射检查重复/求职状态/全局不推荐/撤回/岗位状态，并在第一个 PATCH 前预检 `--mark-recommended` 的公司与关系前置；写入后复核。本地锁只防同一台机器并发，不是服务端 CAS。写入前把候选人与职位 ID 列给用户确认。
- **全局保护字段不凭空编造**：`safety` 的 `duplicate`/`seeking`/`recommendedCompanies`/`doNotRecommend`/`withdrawn` 可映射真实字段名，但全局“不推荐/撤回”必须在 `~/.fanhan-ntn/config.json` 显式配置。字段缺失、空值、未知值、不支持类型或不是明确否/未命中值都拒绝；未配置时 `status`/`audit` 会显示，`link --yes` 直接拒绝，不提供发布级全局保护。
- **关系写入有上限**：关系读取支持 >25、>100 条；写入按 Notion 公开上限 100 项在第一个 PATCH 前拒绝超限，不静默截断。
- **生成文案不等于发送**：本 Skill 只产出名单、分数与理由，不代发消息、不声称已联系候选人。
- **数据缺口要如实说**：缺检索 JSON 的记录会降级用备注/邮件正文判断，输出里会标 `materialSource` / `fallbackReason`；空对象 `{}` 也按缺 JSON 处理。这类结论的可信度低于有 JSON 的记录。
- **职类口径**：未知职类保留、不强行归入“其它”；岗位类目与候选人跨度过大或被判断为不兼容时才排除，用 `--any-category` 可放开，但要在结论里说明放开了。运营/增长/市场按相邻职类处理，不给未知职类硬扣默认值。
- **状态缺失不等于在招**：岗位状态缺失默认排除，不默认“招聘中”；需要时显式 `--include-unknown-status`。
- **描述与 JSON 双来源**：当前 Notion「职位描述」优先，历史检索 JSON 只作对照并标出差异；`get --job` 默认展示完整当前描述，不静默截断或覆盖。
- **不是旧系统完整替代，也不回退**：本 Skill 不提供邮箱/手机号/邮件线程级去重、跟进附件归档、旧服务日志/发送流水，也不声称实现这些能力。遇到这些在线需求应停止并报告能力缺口，或由人工确认 Notion 之外的替代流程；不得改用 Twenty / `recruiting-crm` / 旧 Base 作为当前生产库，也不要用本 CLI 的 `duplicate` 字段冒充全局去重。用户显式提供的离线快照只能按离线材料分析，并标注来源、时效与未核实的在招状态。
- **补 JSON 默认 dry-run**：`scripts/fanhan-ntn/scripts/fill_job_json.mjs` 默认只读缓存预览、不访问 Notion；显式 `--yes` 才会新鲜读取，要求描述非空且与缓存一致、JSON 属性存在且为空，PATCH 前再检查并发变化，写后比较规范化 JSON 内容/哈希；失败非 0 退出。
- **未验证的线上 schema**：仓库内测试使用 fake `ntn` / mock HTTP，不代表生产 Notion 字段、权限、并发与模型端点已经验证；上线前需在目标工作区核对。
