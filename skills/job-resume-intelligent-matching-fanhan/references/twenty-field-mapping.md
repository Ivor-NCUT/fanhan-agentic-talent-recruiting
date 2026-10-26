# Twenty 招聘字段映射

在实时查库、读取原始简历、转换批量匹配输入或获授权写回时读取。先使用外部 `recruiting-crm` 的工作区查询流程；连接与认证规则以该 Skill 为准。本文件记录业务映射，不保存工作区地址、凭据、对象 UUID 或业务数据。

## 发现与查询

以下 API 名称和选项是 2026-10-26 核验过的映射线索；标签可以重命名，其他工作区也可能不同。每次执行先用当前 CLI 帮助和实时 metadata 核对，不用中文标签代替 API 名称：

```bash
twenty --help
twenty auth status --remote <remote> --no-input --json
twenty metadata object list --remote <remote> --no-input --json
twenty metadata field list person --remote <remote> --no-input --json
twenty metadata field list recruitmentJob --remote <remote> --no-input --json
twenty metadata field list company --remote <remote> --no-input --json
twenty metadata field describe person contactRoles --remote <remote> --no-input --json
twenty data list --help
twenty api graphql --help
```

确认字段与选项后，可用 CLI 的 `data list` / `data get` 或 `api graphql` 查询。REST 筛选语法与 GraphQL 不混用。`data list --fields` 只控制人类表格列，JSON/NDJSON 仍返回完整记录；需要限制敏感字段时用 GraphQL 选择集。以下是只验证候选人与在招岗位过滤及公司关系的第一页查询，不能用作完整匹配结果：

```graphql
{
  people(first: 1, filter: {contactRoles: {containsAny: ["CANDIDATE"]}}) {
    edges { node { id } }
    pageInfo { hasNextPage endCursor }
  }
  recruitmentJobs(first: 1, filter: {jobStatus: {eq: RECRUITING}}) {
    edges { node { id company { id } } }
    pageInfo { hasNextPage endCursor }
  }
}
```

正式匹配按所需字段扩展选择集，对每个对象独立用 `endCursor` 作为下一页 `after`，直到 `hasNextPage=false`。按 ID 去重，保留稳定排序；缺失或重复游标、超限及任一页失败均记为不完整。CLI `--all` 也须检查是否受上限截断。服务端不能精确筛选时，在完整读取的相关对象集合内过滤并记录范围，不把空返回和查询失败混为一谈。

## 候选人：`person` / `people`

| 业务含义 | 当前 API 字段与处理 |
|---|---|
| 人员身份 | `contactRoles` 是多选；`CANDIDATE` 才表示候选人。猎头、伙伴或线索不能直接当候选人；身份缺失先待确认。 |
| 姓名 | `name` 是 `FULL_NAME`，组合 `firstName`、`lastName` 为展示字符串，保留原 `id`。 |
| 职位类目 | `candidateJobCategories`，按下表解码枚举，再做集合相交。 |
| 求职状态 | `candidateJobSearchStatus`：`OPEN`、`EXPLORING` 可继续筛选；`NOT_LOOKING` 排除主动推荐；`UNKNOWN` 或空值保留待确认，不当作积极求职。 |
| 检索材料 | `candidateSearchJson` 是 `RAW_JSON`；直接读取对象，若工具返回字符串则独立解析为对象。不要沿用旧 Base 的 Object unsupported 或文本/附件 JSON 回退链。 |
| 实习/正职、地点、薪资、到岗 | 从 JSON 的 `preferences` 与 `candidatePreferences` 里的明确原文获取；当前雇佣类型路径为 `preferences.employmentType.value`，同时保留 `evidence`。没有独立的旧 `实习 & 正职` 字段假设。 |
| 补充证据 | `candidatePortfolio`、`candidateServiceNotes` 为富文本；笔记标为顾问记录，不自动视为候选人确认。 |
| 原始材料 | `candidateResumes`、`candidateSupplementFiles` 为 `FILES`；另有 `attachments` 关系，按实际关联读取。 |

同时检查 `candidateAiStatus`、`candidateAiInputHash`、`candidateCategoryStatus` 和 `candidateCategoryHash`，以及 JSON 的 `sourceHash`、当前源材料与生成时间。生成中、失败、哈希不一致或材料更新后未重新整理的结果不作为已验证的新资料；分类也必须对应当前 JSON。缺失/损坏/过期 JSON 逐项计数。可以在当前任务授权范围内读取原始材料继续审核，但不要把临时提取写成 CRM 已生成结果，也不自动切换 retry 开关。没有可用 JSON 不代表没有候选人。

明确的最新求职意向优先于旧 JSON；来源冲突保留双方及日期，进入待确认。求职状态与向具体公司分享简历的同意是两件事。

## 职位与公司

职位对象为 `recruitmentJob` / `recruitmentJobs`；不要把标准 `opportunity` 当成职位表。

| 业务含义 | 当前 API 字段与处理 |
|---|---|
| 职位名称与原文 | `name`、`jobDescription`（富文本）；保留完整 JD，不用摘要替代硬条件。 |
| 结构化 JD | `jobSearchJson`（RAW_JSON）；同时检查 `jobAiStatus`、`jobAiInputHash`、`jobCategoryHash` 与源材料，旧 JSON 不覆盖新 JD。 |
| 分类与属性 | `jobCategories`；`jobAttributes` 含 `INTERNSHIP`、`FULL_TIME`、`PART_TIME`、`ONSITE`、`REMOTE`、`HYBRID`，以实时选项为准。兼职不能归成全职或实习兼容。 |
| 招聘状态 | `jobStatus`：`RECRUITING` 表示招聘中；`PAUSED`、`CLOSED` 排除；`NEEDS_DETAILS`、空值或未知值待确认。 |
| 招聘偏好 | `jobRecruitmentPreferences`、`companyRecruitmentPreferences`；与明确硬条件区分，矛盾时保留证据。 |
| 公司关系 | `company` → `company` / `companies`；通过关系 ID 获取公司，不按同名猜关联。 |

公司名称与官网线索来自 `name`、`domainName`，招聘偏好为 `recruitmentPreferences`；业务介绍从实际可读字段、关联备注或附件获取，缺失时核对官方资料。`recruitmentStatus` 是公司合作状态，不能替代岗位的 `jobStatus`。私人服务笔记用于内部判断，不原样进入对外话术。

## 类别与本地批量输入

查询时用实时枚举值；给现有 `run_match.py` 时用它支持的规范类目：

| 当前 Twenty 值 | 当前标签 | 本地 `role_categories` |
|---|---|---|
| `GROWTH` | 增长/运营/市场 | 增长/运营/市场 |
| `PRODUCT` | 产品 | 产品 |
| `ENGINEERING` | 研发 | 研发 |
| `ALGORITHM` | 算法 | 算法 |
| `DESIGN` | 设计 | 设计 |
| `SALES` | 商务/销售 | 商务/销售 |
| `DATA` | 数据分析 | 数据 |
| `OTHER` | 其他 | 其它 |

旧输入的 `首席科学家` 类别仍可用于离线匹配，但当前 CRM 没有对应独立枚举；按实际职责与已验证分类确认候选池，不自造枚举或自动并入 `OTHER`。

本地脚本只接收规范化快照，不直接接收 REST 包装、GraphQL edges 或原始 Twenty 记录。Agent 按以下映射准备原有 [输入 Schema](../schemas/match-input.schema.json)，无需新增 CRM 客户端：

- 候选人：`id` 保留原值；`name` 转为姓名字符串；`role_categories` 解码；`resume_json` 保留完整检索 JSON；`engagement` 填确认过的自然语言意向（如“实习”“全职”“实习或全职”），未知留空。不要把英文选项键 `FULL_TIME` 或嵌套对象直接当意向字符串。
- 岗位：`id`、`title = name`；`description` 为 `jobDescription` 的可读原文；`role_categories` 解码；`attributes` 为属性标签组成的对象，例如 `{"type":"全职","work_mode":"远程"}`。富文本优先读 `markdown`，仅有 BlockNote 时提取文本，不能将对象打印成 JD。
- JSON 事实数组可能是 `{value,evidence}` 对象，保留在 `resume_json`；若填写脚本的 `skills`，仅传字符串数组。原始附件/证据链接单独保留；私有下载 URL 不放入公开输出。
- 先按身份、求职状态、招聘状态、资料时效与硬条件排除或挂起，再交脚本初筛；脚本不负责这些 CRM 状态检查，也不替代完整审核。

## 原始文件与获授权写回

从选定候选人记录获取 `FILES` 返回的 `fileId`、`label`、`url`、`extension` 或实际附件关系，核对归属后使用当前授权文件入口。过期链接重新从同一记录解析；权限拒绝不得改用旧 CRM 或其他身份绕过。只下载本次必要材料，校验格式、大小和文件内容；对外发文件需单独满足既有分享同意和发送授权，不能公开带凭据的 URL。

只有用户要求写回时才检查 `recruitingMatch` 的实际结构及现有应用契约。当前有 `candidate`、`vacancy`、`runKey`、`recordKind`、`matchState`、`resultJson` 等，但单条记录可能表示整批运行或一对匹配；不能套用旧 Base 结果表字段或覆盖工作流内部 JSON。优先使用已支持的应用入口，核对影响与授权，写后回读；不明确的写入契约不靠猜测补齐。`matchingRetry` 与生成重试字段可能触发工作流，不属于读取操作。
