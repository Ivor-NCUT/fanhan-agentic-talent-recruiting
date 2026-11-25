# fanhan-ntn · 泛函招聘 Notion 版 CLI

把原来的 Twenty 服务端招聘 CLI 改成以 **Notion 三张表为数据源**、**大模型做判断** 的版本。

## 核心设计：事实与判断分离

招聘是非标判断，不适合用固定权重算分。所以这一版只做两件事：

| 层 | 谁来做 | 做什么 |
|---|---|---|
| 事实层 | CLI（确定性） | 取数、解析、归一、**硬性排除**、把原始材料交给模型 |
| 判断层 | Perplexity Decider（System 1） | 读原始检索 JSON 与 JD 原文，直接给出匹配概率分布与档位 |

**CLI 不产生任何分数。** 输出里的每一个数字都来自模型；命令行只负责“把哪些记录、以什么原文形态送进去”。

硬性排除只用不可争辩的事实：

- 岗位状态不是「招聘中」；**状态缺失不默认招聘中**（`--include-closed` / `--include-unknown-status` 可显式放开）
- 正式/实习/兼职明确冲突（双方都明确标注时才排除，`--any-employment` 可放开）
- 职类跨度过大；未知职类保留，不强行归入「其它」（`--any-category` 可放开）
- 候选人标记重复、明确不求职/已撤回、已推荐过该公司（分别用 `--include-duplicates` / `--include-not-seeking` / `--include-recommended` 显式放开）

超过条数上限（默认 60）时，用**查询词去重后**的关键词召回裁剪，并在输出里明确写「超限后按关键词召回 60/225」——这是**召回**，不是评分。同一个查询词重复出现不会把分数乘倍。

## 缓存、写回与安全边界

- `sync` 先拉完三张表，任何一页失败或 `request_status.incomplete` 都会中止；只有完整成功才一次性原子替换缓存，不会发布混合代际，也不会留下半套新缓存。
- `~/.fanhan-ntn/` 目录权限收紧为 `0700`，缓存文件为 `0600`（包括已存在的缓存）。
- `list` / `get` / `status` 会显示缓存同步时间、距今多久、是否超过 `FANHAN_CACHE_STALE_MS`（默认 24 小时）。
- `link --yes` 每次新鲜读取候选人与岗位页面及关系属性，完整翻页（超过 25 项不丢），本地合并去重；写前按 `safety` 映射检查重复、求职状态和全局保护字段，写后逐项复核。并发写只用**本机文件锁**串行化，**不是服务端 CAS**，不保证跨机器并发。
- `safety` 可映射 `duplicate` / `seeking` / `recommendedCompanies` / `doNotRecommend` / `withdrawn`。`--yes` 前必须显式配置全局不推荐/撤回；字段缺失、空值、未知值、不支持的 Notion 类型或不是明确否/未命中值都会拒绝，不把空 select/未知文本当安全。显式配置但为空的字段名视为无效，不回退默认。
- `link --yes` 在第一个 PATCH 前完成 `--mark-recommended` 的推荐公司属性/公司关系/所有关系数组上限预检；缺任何前置都零写入。
- 写入岗位关系前，新鲜读取岗位状态；状态缺失或不是「招聘中」直接拒绝。
- 关系**读取**支持 >25、>100 条并完整翻页；关系**写入**按 Notion 公开 schema 的 `maxItems=100` 在发送前拒绝超限，不会静默截断或覆盖。
- `scripts/fill_job_json.mjs` 默认 dry-run，只读缓存预览、不访问 Notion；只有显式 `--yes` 才新鲜读取并写。写前要求「职位描述」非空且与缓存一致、「职位检索 JSON」属性存在且为空；描述被清空时**不回退缓存旧描述**。PATCH 前立即再读一次并检查并发变化，写后按规范化 JSON 比较内容与哈希；任何读取/写入/复核失败都以非 0 退出。预检与 PATCH 之间仍是本机非 CAS 窗口。

## 数据源

通过本机 Notion 官方 CLI（`ntn`）读取，无需另建 integration：

| 表 | 用途 |
|---|---|
| 候选人库 | 候选人检索 JSON、职类、备注、邮件正文、关系字段 |
| 职位 JD 库 | 职位描述、职位类目、职位检索 JSON、岗位状态、关系字段 |
| 公司库 | 公司名称、官网、招聘偏好、关联职位 |

三张表的 data source ID 属于工作区配置，**不写在代码里**。在 `~/.fanhan-ntn/config.json` 写入：

```json
{
  "candidates": "<候选人库 data source id>",
  "jobs": "<职位 JD 库 data source id>",
  "companies": "<公司库 data source id>"
}
```

或用环境变量 `FANHAN_DS_CANDIDATES` / `FANHAN_DS_JOBS` / `FANHAN_DS_COMPANIES` 覆盖。查 ID：`ntn datasources resolve <database_id>`。

`fanhan-ntn sync` 拉全量到 `~/.fanhan-ntn/`，之后所有查询走本地缓存，秒级响应。缓存是快照，不保证与 Notion 实时一致；过期阈值和每次同步时间会显示在命令输出里。

## 用法

```bash
# 凭据（key 走 stdin 进 Keychain，不出现在命令行参数里）
pbpaste | fanhan-ntn auth login
export FANHAN_DECIDER_MODEL=pplx-decider-latest   # 可选，默认即此
export FANHAN_DECIDER_BASE=https://api.perplexity.ai  # 可选，官方根路径或 /v1
# 自定义 HTTPS endpoint 必须同时设置 FANHAN_DECIDER_PROVIDER=custom
# 并显式提供 FANHAN_LLM_API_KEY；不会借用 PERPLEXITY/DEEPSEEK key 或 Keychain。

fanhan-ntn status
fanhan-ntn sync
fanhan-ntn audit

# 场景一：拿职位 JD 找候选人
fanhan-ntn match --job "高级音质音效算法研究员" --top 10 --explain

# 场景二：拿候选人 JSON 找岗位
fanhan-ntn match --candidate "示例候选人" --top 10
fanhan-ntn match --candidate-json ./candidate.json --top 10
fanhan-ntn match --job-json ./jd.json --top 10

# 单对判断 + 原始 JSON
fanhan-ntn explain "示例候选人" "算法工程师 - LLM后训练" --raw

# 只看筛选结果，不调模型
fanhan-ntn match --job "增长运营" --no-llm

# 写回关系（默认预演，不联网、不写 Notion；--yes 才写）
fanhan-ntn link --candidate "示例候选人" --jobs "算法工程师 - LLM后训练"
fanhan-ntn link --candidate "示例候选人" --jobs "算法工程师 - LLM后训练" --yes
# 显式把岗位关联公司写回候选人「推荐过的公司」
fanhan-ntn link --candidate "示例候选人" --jobs "算法工程师 - LLM后训练" --yes --mark-recommended

# 为缺检索 JSON 的岗位生成 JSON（默认 dry-run；--yes 前会新鲜读取、二次预检并校验写后 JSON 内容）
node scripts/fanhan-ntn/scripts/fill_job_json.mjs
node scripts/fanhan-ntn/scripts/fill_job_json.mjs --yes
```

## 与旧 CLI 的对应关系

| 旧（Twenty） | 新（Notion） | 说明 |
|---|---|---|
| `candidates upload` + `tasks` 队列 | 取消 | Notion 入库时已完成解析，没有异步流水线 |
| `tasks list/retry` | `audit` | 变成数据体检清单 |
| `match` | `match` | 从服务端模型打分改为本地筛选 + 外部模型判断 |
| `draft` / `share` | 保留在 Agent 侧 | CLI 不负责文案生成与发送 |
| `companies/jobs/candidates` | `list` / `get` | 数据由人工在 Notion 维护，CLI 主要读 |

**这不是旧邮件/电话/线程去重系统的完整替代品。** 新 CLI 没有实现、也不声称实现：

- 邮箱/手机号/邮件线程级去重；
- 跟进邮件附件与附件归档；
- 旧服务日志、发送记录与审计流水；
- 任何未在代码中明确实现的能力。

遇到上述需求时应回到旧工具或人工流程，不要用本 CLI 的 `duplicate` 字段冒充全局去重。未实现/未验证的能力一律按 fail-closed 处理，不静默“尽量做”。

## 已知数据问题（会影响判断质量）

1. **候选人缺检索 JSON**（历史统计 136/576，可能已变化），其中部分连备注、邮件正文都没有（空壳记录）。这类记录送模型时会明确降级为备注/正文，并标出 `materialSource` / `fallbackReason`；空对象 `{}` 也按缺 JSON 处理，不当作有效材料。
2. **职位缺检索 JSON**（历史统计 38/97，可能已变化），但职位描述完整时可确定性补生成；生成器默认 dry-run。
3. **线上 schema 未在本仓库验证**：`select` 与 `status` 两种属性类型都做了兼容，但生产工作区是否同时存在、字段名是否一致仍以实际页面为准。雇佣类型只认结构化字段或明确的意向语句；年份、历史实习、职位名称、否定句不会被当作当前意向。地点区分「期望城市」与「当前地点」。
4. 部分候选人 `preferences` 是带大量限定语的历史记录（“记录无日期，当前意向待确认”），这类不确定性会作为风险项传给模型。
5. 部分记录姓名为占位符（“待补全候选人 · f39e87f5”），但材料本身完整，仍可参与判断。

## 判断模型如何工作

调用 Perplexity Decisions API（`POST /v1/decisions`），每对候选人×岗位发一次请求，`state` 里同时放岗位原文与候选人原始检索 JSON，问四个独立问题：

| 问题 | 类型 | 返回 |
|---|---|---|
| `fit` | score（5 档） | 概率加权分位 → 折算 0–100，附完整概率分布与 confidence |
| `must_have` | noul | 硬性要求满足概率 |
| `employment_conflict` | noul | 正式/实习明确冲突概率（信息缺失不算冲突） |
| `seniority_ok` | noul | 职级是否大致对等 |

排序只看 `fit`，其余三项作为并列参考，不做加权。`fit.score * 25` 的数值刻度保持不变；CLI 的 `level` 是「期望分四舍五入」档位，并额外输出 `modalLevel`（概率最高的众数档），二者字段名不同，不互相替换。单对约 4–5k input tokens，$0.02/1M，80 对成本约 0.7 美分。

凭据严格绑定 provider / endpoint / key：provider 特定 key 与 Keychain 只用于精确匹配的官方 HTTPS origin（`api.perplexity.ai`、`api.deepseek.com`，允许根路径或 `/v1`）。`DEEPSEEK_API_KEY` 只在 provider=deepseek 时使用，绝不会被静默发往 `api.perplexity.ai`。自定义 HTTPS endpoint 必须显式 `provider=custom` + `FANHAN_LLM_API_KEY`，不会借用 provider 专用 key；lookalike 域名、query/hash、内嵌账号密码、HTTP 和未知 provider 都在选凭据前拒绝，错误信息不包含密钥。测试只使用合成 key 和 mock 服务，不读取真实 key。

## 目录

```
bin/fanhan-ntn.mjs   入口
src/ntn.mjs          Notion 数据访问（调用 ntn CLI，翻页、写回）
src/parse.mjs        属性解析与归一（雇佣类型/城市/职类推断）
src/pool.mjs         硬性排除与召回（不含打分）
src/llm.mjs          Perplexity Decider 批量判断（原始 JSON → 概率 → 档位）
scripts/fill_job_json.mjs  为缺 JSON 的岗位按描述确定性生成检索 JSON
src/auth.mjs         Keychain 凭据存取
src/text.mjs         分词与 BM25（仅用于召回裁剪）
src/cli.mjs          命令层
```

## 测试

```bash
cd scripts/fanhan-ntn
node --test test/*.test.mjs
```

测试使用 fake `ntn` 子进程、临时 HOME 和 mock `fetch`，不连接真实 Notion、不调用真实模型、不读取真实 key。生产 schema 与跨机器并发未验证，详见仓库根目录的 `docs/notion-cli-safety-review.md`。
