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

- 岗位状态不是「招聘中」（`--include-closed` 可放开）
- 正式/实习冲突（双方都明确标注时才排除，`--any-employment` 可放开）
- 职类跨度过大（`--any-category` 可放开）

超过条数上限（默认 60）时，用关键词召回裁剪，并在输出里明确写「超限后按关键词召回 60/225」——这是**召回**，不是评分。

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

`fanhan-ntn sync` 拉全量到 `~/.fanhan-ntn/`，之后所有查询走本地缓存，秒级响应。

## 用法

```bash
# 凭据（key 走 stdin 进 Keychain，不出现在命令行参数里）
pbpaste | fanhan-ntn auth login
export FANHAN_DECIDER_MODEL=pplx-decider-latest   # 可选，默认即此
export FANHAN_DECIDER_BASE=https://api.perplexity.ai  # 可选

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

# 写回关系（默认预演）
fanhan-ntn link --candidate "示例候选人" --jobs "算法工程师 - LLM后训练"
fanhan-ntn link --candidate "示例候选人" --jobs "算法工程师 - LLM后训练" --yes
```

## 与旧 CLI 的对应关系

| 旧（Twenty） | 新（Notion） | 说明 |
|---|---|---|
| `candidates upload` + `tasks` 队列 | 取消 | Notion 入库时已完成解析，没有异步流水线 |
| `tasks list/retry` | `audit` | 变成数据体检清单 |
| `match` | `match` | 从服务端模型打分改为本地筛选 + 外部模型判断 |
| `draft` / `share` | 保留在 Agent 侧 | CLI 不负责文案生成与发送 |
| `companies/jobs/candidates` | `list` / `get` | 数据由人工在 Notion 维护，CLI 主要读 |

## 已知数据问题（会影响判断质量）

1. **候选人 136/576 缺检索 JSON**，其中部分连备注、邮件正文都没有（空壳记录）。这类记录送模型时会降级为备注/正文，或直接缺材料。
2. **职位 38/97 缺检索 JSON**，但职位描述完整，可确定性补生成。
3. **两张表都没有「雇佣类型」「地点」结构化字段**，只能从 JSON 里的自由文本推断，推断结果一律标注来源（如「岗位=待确认（职位正文：未标注）」），置信不足时明确告知，不做静默假设。
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

排序只看 `fit`，其余三项作为并列参考，不做加权。单对约 4–5k input tokens，$0.02/1M，80 对成本约 0.7 美分。

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
