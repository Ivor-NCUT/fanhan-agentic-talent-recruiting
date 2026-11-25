# fanhan-ntn 招聘 CLI 安全修复复核

- 分支：`fix/notion-cli-safety-20261125`
- 基线：PR #1 head `a457c58`
- 目标集成分支：`feat/notion-recruiting-cli`
- 范围：`scripts/fanhan-ntn`、对应测试、Skill/插件清单、当前流程文档与本文档。没有新增运行时依赖，没有修改旧 Python 业务工具逻辑。
- 结论：反馈中的 10 类问题均已逐项复现并修复；第二轮复核又修复了关系属性 `property_item` 解析、provider/endpoint 严格绑定和本地锁过期回收 3 个发布阻塞项；第三轮复核修复了 safety 契约 fail-open、`fill_job_json` 回填过期描述/弱复核、关系写入超过 Notion 上限的问题；第四轮文档/策略统一声明 Notion 为唯一当前在线招聘库，Twenty/`recruiting-crm`/旧 Base 仅作历史/离线兼容。最终 Node 测试 70/70、Python 测试 7/7 通过。生产 Notion schema、真实模型端点和跨机器并发**未验证**，见“未验证边界”。

## 1. 证据等级

| 等级 | 本报告中的含义 |
|---|---|
| A. 已复现 | 先用独立测试/夹具在原代码上跑出失败，保留日志 |
| B. 已修复 | 代码已改，目标测试通过 |
| C. 已回归 | 全量 Node + Python 测试通过 |
| D. 未验证 | 没有真实 Notion/模型/生产数据证据，只做了 mock/fixture |

本报告只把 A+B+C 的条目写成“已修复”。涉及真实工作区 schema、API 行为或生产并发的条目都归入 D。

## 2. 基线复现（修复前）

测试文件先于修复建立，使用 fake `ntn` 子进程、临时 HOME、临时缓存和合成页面数据，不访问真实 Notion，不读取真实 key。

```bash
cd /workspace/recruiting-cli-fix-20261125/repo
node --test scripts/fanhan-ntn/test/*.test.mjs
```

修复前结果：

```text
tests 43
pass 6
fail 37
exit 1
```

日志：`/workspace/recruiting-cli-fix-20261125/baseline-node-tests.log`

第二轮发布阻塞项先单独补测试再修复，基线为：

```text
node --test scripts/fanhan-ntn/test/ntn.test.mjs scripts/fanhan-ntn/test/llm.test.mjs
tests 24
pass 14
fail 10
exit 1
```

日志：`/workspace/recruiting-cli-fix-20261125/round2-baseline-focused.log`。失败覆盖：关系属性端点把外层 `property_item.id` 当关联页面 ID、>100 条关系只保留 26 条、缺少 `relation.id` 不报错、已编码属性 ID 二次编码、lookalike provider 主机/路径伪装/HTTP/未知 provider 未拒绝、provider 与 endpoint 不一致仍选 key、官方 `/v1` 未归一化、live owner 的陈旧锁被抢、release 删除他人 token 的锁。

第三轮 safety / fill / 关系上限先补测试再修复，基线为：

```text
node --test scripts/fanhan-ntn/test/cli.test.mjs scripts/fanhan-ntn/test/ntn.test.mjs
tests 37
pass 29
fail 8
exit 1
```

日志：`/workspace/recruiting-cli-fix-20261125/round3-baseline-focused.log`。失败覆盖：缺全局 safety 配置仍写、mapped duplicate/seeking 未生效、空/未知求职状态被当安全、`--mark-recommended` 缺关系前置仍先 PATCH、写关系超过 Notion 100 项上限未拦截、fill 清空描述后回填缓存旧描述、缺失/错误类型 JSON 属性被当空、写后内容不一致仍报成功。

基线失败覆盖了全部 10 类反馈，主要包括：

- `link --yes` 使用缓存关系、顺序写入丢前一次新增、关系只读内联 25 条；
- 雇佣类型不识别 `part_time`，把历史实习/否定句/职位名当当前意向；
- 重复、不求职、已推荐公司不参与筛选；全局撤回/不推荐没有显式 schema 契约；
- 同名职位跨公司被合并；`--json --no-llm` 混入非 JSON 文本；BM25 重复词压过稀有技能；
- `sync` 部分失败仍发布缓存、`request_status.incomplete` 未拦截、目录/文件权限过宽；
- `--batch` 未实现但被接受；缓存时效不可见；岗位状态缺失被当作在招；只支持一种 select/status 形态；
- 当前 Notion 职位描述被历史检索 JSON 覆盖；
- 空候选人 JSON `{}` 没有回退说明；文档没有说明不是旧去重/跟进/日志系统的替代品；
- `DEEPSEEK_API_KEY` 会在 Perplexity 端点下被隐式使用；
- `fill_job_json.mjs` 默认直接 PATCH，没有新鲜读取与冲突检查。

Python 侧修复前运行 `python3 -m unittest discover -s tests -v` 为 7 个测试、6 通过、1 失败：`.claude-plugin/plugin.json` 的 `skills` 清单没有登记 `./skills/fanhan-recruiting-notion`。修复后 7/7 通过。该基线是终端观测结果，未单独保存修复前日志；修复后日志见第 6 节。

## 3. 逐项修复

### 3.1 `link --yes` 不再信任缓存关系

文件：`src/cli.mjs`、`src/ntn.mjs`

- `link` 默认只做本地预演，不读取 Notion、不写 Notion。
- `--yes` 每次新鲜 `GET` 候选人/岗位页面，并读取关系属性端点，完整跟随 `has_more`/`next_cursor`，不再只依赖内联的 25 条。
- 关系属性端点返回的是 `property_item` 列表：关联页面 ID 只取嵌套的 `item.relation.id`，绝不把外层 `item.id`（属性项 ID）当页面 ID；缺少 `relation.id`、非 `relation` item、非法列表结构都 fail-closed，不静默丢项。内联条目（`page.properties.*.relation[].id`）与属性端点 wire shape 分开处理。已百分号编码的属性 ID 原样保留，避免二次编码。
- 写入前把“新鲜关系 + 本次新增”合并去重；顺序执行时第二次写入能看到第一次的结果。
- 写入前按 `safety` 映射验证「重复」「求职状态」及全局「不推荐/撤回」字段：字段名可配置，缺字段、空值、未知值、非明确否/未命中值、未支持类型都拒绝，不把空 select/未知文本当安全。
- `--yes` 在任何 PATCH 前要求全局 `doNotRecommend` / `withdrawn` 显式配置；`--mark-recommended` 还必须在任何 PATCH 前完整验证推荐公司属性/公司关系，并预检所有计划写入。
- 写入前验证岗位状态必须新鲜可读且为「招聘中」；关系数组超过 Notion PATCH 公开上限 100 项时，在第一个 PATCH 前拒绝，避免静默截断/覆盖。
- 写入后重新读取关系并逐项复核；任何写入/复核失败都以非 0 退出，不打印“已成功”。
- 同一台机器用带 owner token 的 `wx` 锁文件串行化；陈旧锁只有在 owner PID 已死亡且内容未变化时才回收，live owner 即使超过 5 分钟也不抢锁；release 只删除自己 token 的锁。**这是有界的本机锁，不是服务端 CAS**，文档和 CLI 输出均不声称跨机器原子性。
- 全局「不推荐/撤回」字段只有在 `~/.fanhan-ntn/config.json` 的 `safety` 显式配置真实字段名时才启用；字段缺失或命中保护值即拒绝，不猜测字段。

对应测试：`link dry-run writes nothing...`、`link fails closed when safety schema is absent...`、`link fails closed when fresh job status is missing`、`concurrent link is serialized...`、`link write failure exits nonzero...`、`link honours an explicitly configured withdrawn safety field`。

### 3.2 雇佣类型与地点

文件：`src/parse.mjs`

- 支持 `full_time` / `internship` / `part_time`，输出统一为 `{value, basis}`；未知保留 `unknown`。
- 只把结构化字段或明确意向语句（`求职意向：`、`工作性质：`、`本岗位为…`、`招聘类型：` 等）当作当前意向。
- 年份、历史/过往/实习经历、职位名称中的“可实习”、否定句（如“不接受实习”）、单独的“可实习”都不会被强制识别为实习。
- 结构化字段出现“不接受/不考虑/非/无”等否定/限制表述时返回 `unknown`，不静默取一个值。
- 期望城市与当前地点分开：`cities` 只来自期望/偏好城市，`currentLocationText`/`currentCities` 单独保留。

对应测试：`employment: historical years...`、`employment: negated internship...`、`employment: historical internship...`、`employment: explicit structured intent...`、`employment: 可实习 title...`、`employment: structured Notion property...`、`employment: candidate structured JSON part_time...`、`cities: desired cities stay separate...`。

### 3.3 重复、不求职、已推荐与全局保护

文件：`src/pool.mjs`、`src/cli.mjs`

- 候选池默认排除：重复候选人、明确不求职/撤回、已推荐过目标公司；`--include-duplicates` / `--include-not-seeking` / `--include-recommended` 可显式放开。
- 岗位状态缺失不再默认“招聘中”；默认排除，`--include-unknown-status` 可放开。
- `status` / `audit` 显示安全字段是“已配置”还是“未配置”。未配置的全局保护不会假装存在。
- `link --yes` 缺少基础安全字段或全局字段时 fail-closed；显式配置后，缺失/空值/未知值/命中保护/未支持类型都拒绝。
- `safety` 中显式配置但为空/非字符串的字段名视为无效，不回退到默认字段；默认字段只在该配置项未出现时使用。

对应测试：`pool exposes duplicate, not-seeking and already-recommended exclusions`、`pool excludes missing job status...`、相关 `link` 安全测试。

### 3.4 同名职位、稳定 ID、JSON 输出、BM25

文件：`src/cli.mjs`、`src/pool.mjs`、`src/text.mjs`

- 职位记录按页面 `id` 区分，同名不同公司不再按名称合并；输出同时暴露稳定 ID。
- `match --json --no-llm` 只向 stdout 写 JSON；诊断/进度走 stderr 或被抑制，JSON 可被 `JSON.parse`。
- BM25 查询词先去重，重复词不会把分数乘倍；保留稀有技能权重。
- 超过上限时记录“超限后按关键词召回 N/M”，明确这是召回不是评分。

对应测试：`match --json --no-llm writes JSON only to stdout and keeps same-title jobs distinct`、`BM25 recall does not multiply repeated query terms over rare skills`。

### 3.5 `sync` 原子发布、权限、批次参数

文件：`src/ntn.mjs`、`src/cli.mjs`、`scripts/fill_job_json.mjs`

- 三张表先全部拉到暂存目录；任何一页失败、游标缺失、`request_status.incomplete` 都会中止，旧缓存完整保留。
- 成功后按“备份 → 逐个原子 rename → 失败回滚”发布；不会出现一半新一半旧。
- 缓存目录 `0700`、文件 `0600`；已存在文件也会收紧权限。
- 删除未实现的 `--batch`，显式报错并提示使用 `--concurrency`；`--concurrency` 必须是正整数，0/负数/小数/非数字在访问缓存前就拒绝。
- 未知职类保留为空 key，不折叠成 `other`；运营 `operations` 与增长/市场 `growth_marketing` 通过别名和相邻关系协调，不硬排除。
- `fit.score * 25` 数值刻度不变；`level` 是期望分四舍五入档，`modalLevel` 是概率众数档，字段分开，不互相替换。

对应测试：`sync follows all pages...`、`sync leaves the complete old cache untouched...`、`sync rejects request_status incomplete...`、`queryAll...`、`judge rejects non-positive...`、`match rejects removed --batch...`。

### 3.6 缓存时效、状态字段与 fail-closed

文件：`src/cli.mjs`、`src/parse.mjs`

- `status` / `list` / `get` 输出缓存同步时间、距今多久、是否超过 `FANHAN_CACHE_STALE_MS`（默认 24h）。
- 写路径不依赖旧缓存做安全结论：`link --yes` 和 `fill_job_json --yes` 都新鲜读取页面；fill 的 dry-run 只读缓存预览，不访问 Notion。
- 岗位状态缺失不默认 active；默认排除。
- `select` 和 `status` 两种 Notion 属性形态都通过 `choice()` 读取；字段缺失返回 `null`，不编造默认值。
- README 明确：生产 schema 未在本仓库验证。

对应测试：`cache age and staleness...`、`job status: select and status property types...`、`pool excludes missing job status...`、`link fails closed when fresh job status is missing`。

### 3.7 当前职位描述与历史检索 JSON 双来源

文件：`src/parse.mjs`、`src/cli.mjs`

- 当前 Notion「职位描述」优先；历史检索 JSON 的 description/text 只作为 `retrievedDescription` 保留，不覆盖当前描述。
- `descriptionDiff` 暴露 `changed/currentLength/retrievedLength`；`get --job` 默认打印完整当前描述，不截断；有差异时明确提示“历史检索 JSON 与当前描述不同，仅供对照”。
- 招聘偏好同样保留当前值、检索值及来源，不静默覆盖。

对应测试：`job description: current Notion text is not overwritten...`、`get --job shows the full current description...`。

### 3.8 文档边界与空 JSON 回退

文件：`README.md`、`SKILL.md`、`src/parse.mjs`

- 文档明确写出：本 CLI **不是**旧邮件/电话/线程去重、跟进附件、服务日志系统的完整替代品；这些能力未实现，不冒充。
- 空对象 `{}`、空字符串、无法解析 JSON 都按“无有效检索 JSON”处理；回退到备注/邮件正文时输出 `hasJson`、`materialSource`、`fallbackReason`，并说明材料来源。
- 未验证/未实现能力一律 fail-closed，不静默“尽量做”。

对应测试：`empty candidate JSON falls back to notes/email with an explanation`。

### 3.9 provider / endpoint / key 严格绑定

文件：`src/llm.mjs`

- 先校验 endpoint（必须是 HTTPS、无内嵌账号密码、无 query/hash），再选择任何凭据；未知显式 provider 直接拒绝，不静默当 custom。
- provider 特定 key 与 Keychain 只用于精确匹配的官方 origin：`https://api.perplexity.ai`、`https://api.deepseek.com`，允许根路径或 `/v1`。lookalike 域名（如 `api.perplexity.ai.evil.invalid`）、路径伪装（如 `evil.invalid/perplexity`）不会匹配 provider key。
- 显式 provider 必须与 endpoint 一致；官方 endpoint 不能声明成另一个 provider，非官方 endpoint 必须显式 `provider=custom` 且只接受 `FANHAN_LLM_API_KEY`。
- key 查找顺序：`FANHAN_LLM_API_KEY` → 与官方 provider 匹配的 `PERPLEXITY_API_KEY` / `DEEPSEEK_API_KEY` → 官方 Perplexity Keychain。
- 禁止跨 provider 隐式回退：`DEEPSEEK_API_KEY` 不会在 `api.perplexity.ai` 下被使用。
- `llmConfig` 返回 `provider/base/model/keySource/source/hint`；错误和日志不包含 key 值；测试只注入合成 key 和 mock 服务，不读取真实 key。

对应测试：`llm config binds provider, endpoint and key explicitly`、`llm config never silently uses a DeepSeek key against the Perplexity endpoint`、`llm config rejects lookalike hosts and path/query tricks before using provider keys`、`llm config rejects insecure URLs, embedded auth, and unknown explicit providers`、`llm config rejects provider/endpoint mismatches instead of falling back to another key`、`llm config requires explicit generic opt-in for custom endpoints`、`official /v1 bases are accepted without double-appending the decisions path`。

### 3.10 `fill_job_json.mjs` 默认 dry-run 与严格写后复核

文件：`scripts/fill_job_json.mjs`

- 默认只读缓存预览，不读 Notion、不 PATCH、不拿锁；只有显式 `--yes` 才写。
- `--yes` 逐岗位新鲜 `fetchPage`，并严格要求：
  - 「职位描述」属性存在、类型为 `rich_text`、当前值非空且与缓存一致；为空/缺失时拒绝，**不回退到缓存旧描述**；
  - 「职位检索 JSON」属性存在、类型为 `rich_text`、当前值为空；缺失/错误类型不再当空；
  - 已有非空 JSON 或描述与缓存不一致 → 冲突。
- 生成后、PATCH 前立即再读一次页面，重新验证描述/JSON 仍满足条件，并比较 `last_edited_time`；预检后被并发修改则中止。
- PATCH 后重新读取，解析实际 JSON，按规范化 JSON 比较期望 payload 与哈希；仅“非空”不算成功，内容不一致/非法 JSON 都非 0 退出。
- 写入时持有本机锁；rich_text 按 1800 字符分块。
- 预检与 PATCH 之间仍有一个非 CAS 窗口；没有 Notion 事务/条件写时无法完全消除，已在文档中保留该边界。

对应测试：`fill_job_json defaults to dry-run...`、`fill_job_json refuses a cleared fresh description...`、`fill_job_json refuses missing or non-rich-text target JSON properties`、`fill_job_json fails when post-write content differs...`、`fill_job_json rechecks immediately before PATCH...`。

### 3.11 第二轮发布阻塞项

文件：`src/ntn.mjs`、`src/llm.mjs`

- 关系属性端点按公开 Notion property-item wire shape 解析：关联页面 ID 取 `item.relation.id`，不取外层属性项 `id`；`>25`、`>100` 条均完整保留。缺 `relation.id`、非 `relation` item、非法列表结构、坏内联条目全部 fail-closed；官方列表顶层 `type=property_item` 与 item 顶层 `type=relation` 分开判断。
- 属性 ID 使用“逐段编码但保留已有 `%XX`”的函数，已编码 ID 不二次编码。
- endpoint 先做 HTTPS、hostname/origin、query/hash、内嵌账号密码校验，再选择 key/Keychain；官方 origin 精确匹配（根路径或 `/v1`），lookalike 域名和路径伪装不命中 provider key；显式 provider 必须与 endpoint 一致；自定义 HTTPS endpoint 必须 `provider=custom` + `FANHAN_LLM_API_KEY`；未知 provider、HTTP、provider/endpoint 不一致直接拒绝，错误不含密钥。
- 本地锁加入 owner token 与 live PID 检查：live owner 即使锁文件超过 5 分钟也不回收；只有 owner 已死亡且内容未变化才回收；release 只删自己 token 的锁。仍是**有界的本机锁**，不是跨机器 CAS。

对应测试：`readRelation paginates ...`、`readRelation preserves more than 100 relations ...`、`readRelation tolerates an already percent-encoded property id ...`、`readRelation fails closed on property-item results ...`、`readRelation fails closed on malformed inline relation entries`、`llm config rejects lookalike hosts ...`、`llm config rejects insecure URLs ...`、`llm config rejects provider/endpoint mismatches ...`、`llm config requires explicit generic opt-in ...`、`official /v1 bases ...`、`local lock does not steal a stale lock ...`、`local lock reclaims ...`、`local lock release never deletes ...`。

### 3.12 第三轮安全契约 / 严格回填 / 关系上限

文件：`src/cli.mjs`、`src/ntn.mjs`、`scripts/fill_job_json.mjs`、`test/*.mjs`

- `safetyContract` 的 `duplicate` / `seeking` / `recommendedCompanies` / `doNotRecommend` / `withdrawn` 统一规范化；显式空值/非字符串不会回退默认，视为缺失。
- `assertCandidateSafety` 使用配置后的真实字段名，不再硬编码「是否重复」「求职状态」；支持 checkbox/number/select/status/rich_text/multi_select，未知类型直接拒绝。
- 安全值必须可解释：checkbox 必须是显式 bool；select/status 空值不能当安全；未知文本不能绕过；`不重复`/`未撤回` 等明确否值不会被“重复/撤回”子串误判；不求职/已撤回/未知求职状态都拒绝。
- `link --yes` 在读取/第一个 PATCH 前验证全局 safety 配置；`--mark-recommended` 在第一个 PATCH 前读取并验证推荐公司属性、岗位公司关系、所有计划写入的关系数组上限，缺任何前置都零写入。
- `link` dry-run 只做本地预演，不读取/写入 Notion；缺全局配置时明确提示 `--yes` 会拒绝。
- Notion 公开 page property schema 的 relation 写入数组 `maxItems=100`；`updatePage` 统一在发送前拒绝 >100 项，`link` 还在所有计划写入前一次性预检，避免先写候选人再在岗位写入时才发现超限。关系**读取**仍支持 >25、>100 并完整翻页。
- `fill_job_json` 严格描述/属性 schema、PATCH 前二次读取、写后规范化 JSON 哈希比较；dry-run 零 PATCH/零 Notion 读取。

对应测试：`link --yes fails closed when global safety protections are not configured`、`link honours mapped duplicate/seeking fields and validates their values`、`link rejects unsupported safety field types...`、`link --yes rejects empty or unknown seeking...`、`link --mark-recommended validates all safety and relation prerequisites before any PATCH`、`link fails closed before any PATCH when a relation would exceed the Notion write limit`、`updatePage rejects relation writes above the Notion array limit...`、`fill_job_json refuses a cleared fresh description...`、`fill_job_json refuses missing or non-rich-text target JSON properties`、`fill_job_json fails when post-write content differs...`、`fill_job_json rechecks immediately before PATCH...`。

### 3.13 第四轮文档/策略：Notion 唯一在线招聘库

文件：根 `README.md`、`scripts/fanhan-ntn/README.md`、四个 Skill 的 `SKILL.md`/路由描述、`.claude-plugin/plugin.json`、历史字段映射。

- 按 2026-11-25 18:28 的用户口径，当前合集在线招聘数据统一为 **Notion**，通过 `fanhan-ntn` / `fanhan-recruiting-notion` 访问。
- Twenty / `recruiting-crm` / 旧飞书 Base / Workbench / Teable 只保留为历史或用户显式提供的离线快照兼容；当前在线路径不自动回退，也不因 Notion 缺字段/连接失败/无结果而改查旧库。
- 当前流程不再使用“数据还在 Twenty 时改用 `$recruiting-crm`”“Notion 是可选数据源”等表述；删除对旧在线入口的推荐。
- `job-resume-intelligent-matching-fanhan` 与 `job-resume-match-audit` 增加顶部 current-path banner，历史正文、离线脚本、Twenty 字段映射与旧 Python 工具均保留，不删除、不迁移。
- 历史 Twenty/Base 字段映射明确标注“历史/离线兼容”；`plugin.json` 描述与 `openai.yaml` 路由描述不再声称查询 Twenty。
- Notion CLI 未覆盖的在线能力（邮箱/手机号/线程去重、跟进附件、服务日志/发送流水、自动消息发送等）统一 fail-closed：停止并报告缺口，不引导改用旧 Twenty；文档不编造生产 schema，不包含候选人 PII。
- 该轮为文档/策略变更，未改运行时代码；Node 70/70、Python 7/7 仍通过，日志 `round4-final-node-tests.log`、`round4-final-python-tests.log`。

## 4. 端到端 mock 覆盖

测试使用 `test/helpers.mjs` 内的 fake `ntn` 子进程和临时 HOME，覆盖：

- 游标分页超过 25 条；
- 关系属性端点按真实 `property_item` wire shape 分页超过内联 25 条，并覆盖 >100 条、外层属性 ID 不得写入、缺 `relation.id` fail-closed、已编码属性 ID 不二次编码；
- 429/rate limit/5xx 重试；
- `request_status.incomplete` 中止；
- `select` / `status` 两种属性形态；
- 状态缺失；
- 顺序写与并发写（本机锁；live owner 不抢锁、dead owner 才回收、release 校验 token）；
- JSON stdout 与退出码；
- 缓存原子发布、回滚、`0700`/`0600`；
- 模型部分失败/全部失败；
- dry-run 不 PATCH、不产生写请求；
- safety 缺配置/映射字段/空值/未知值/不支持类型均零 PATCH；
- `--mark-recommended` 缺推荐公司属性或公司关系时零 PATCH；
- fill 描述被清空/缺失、JSON 属性缺失/错误类型、写后内容被改、PATCH 前被并发修改都非 0，危险场景零写入。

## 5. 测试轮次与结果

| 轮次 | 命令 | 结果 |
|---|---|---|
| 基线 | `node --test scripts/fanhan-ntn/test/*.test.mjs` | 43 tests，6 pass，37 fail |
| parse/pool | `node --test .../parse.test.mjs .../pool.test.mjs` | 首轮 19 tests，18 pass，1 fail（BM25 夹具重复词过多）；修正夹具后 19/19 |
| ntn | `node --test .../ntn.test.mjs` | 首轮 6 tests，5 pass，1 fail（retry 夹具消息未含可识别瞬态信号）；修正后 6/6 |
| llm | `node --test .../llm.test.mjs` | 首轮 7 tests，6 pass，1 fail（部分失败夹具按错误字段选择）；修正后 7/7 |
| cli | `node --test .../cli.test.mjs` | 首轮 11 tests，9 pass，2 fail（缓存时效/空缓存、fill 描述长度）；修复后 11/11；补 4 个安全回归后 15/15 |
| 第二轮基线 | `node --test .../ntn.test.mjs .../llm.test.mjs` | 24 tests，14 pass，10 fail |
| 第二轮修复后聚焦 | 同上 | **25 tests，25 pass，0 fail，exit 0** |
| 第三轮基线 | `node --test .../cli.test.mjs .../ntn.test.mjs` | 37 tests，29 pass，8 fail |
| 第三轮修复后聚焦 | 同上 | **39 tests，39 pass，0 fail，exit 0** |
| 全量 Node（最终） | `node --test scripts/fanhan-ntn/test/*.test.mjs` | **70 tests，70 pass，0 fail，exit 0** |
| Python（最终） | `python3 -m unittest discover -s tests -v` | **7 tests，OK，exit 0** |
| 第四轮（文档/策略） | Node 全量 + Python 全量 + 语法检查 | **Node 70/70、Python 7/7，均 exit 0** |

测试夹具/契约调整共 7 处，均为修正“测试输入与契约不一致”，不是放宽生产断言：

1. BM25 夹具原来让重复查询词在记录中占绝对主导，测试目标变成“重复词也不该赢”，与“去重后 BM25”契约不符；调整重复次数并保留稀有技能对比。
2. retry 夹具原消息没有 `429`/`rate limit`/`5xx` 等瞬态信号；生产实现已覆盖这些信号，夹具改为 `429 too many requests`。
3. llm 部分失败夹具按结果下标选择失败项，与实现按请求 body 关联的契约不符；改为按 body 中的人选标识选择。
4. fill 夹具原职位描述只有 10 余字，不满足脚本“描述足够长才生成”的目标集条件；改为更长的真实形态描述，目标集非空后才验证 dry-run/`--yes`/冲突。
5. CLI 模型部分失败夹具原来用本地 `http` + `PERPLEXITY_API_KEY` 模拟官方 Perplexity；严格绑定后这不再是合法组合。改为自签名 HTTPS 本地服务 + `provider=custom` + `FANHAN_LLM_API_KEY`，仅在该测试子进程关闭证书校验，没有放宽生产校验。
6. 第三轮成功 `link` 夹具显式配置合成全局不推荐/撤回字段；生产契约现在要求 `--yes` 前显式配置，这是补齐安全输入，不是放宽断言。
7. 第三轮新增 fake `ntn` 的写后内容覆盖与 GET 时并发变更钩子，只用于证明“写后不一致/预检后变化”会失败，生产校验未放宽。

## 6. 未验证边界（必须保留）

1. **生产 Notion schema 未验证**：字段名、`select`/`status` 实际类型、关系属性 ID、权限、页面是否存在全局撤回字段，都只按公开文档、fake `ntn` 和现有代码假设测试；没有连接真实 Notion 验证 property-item 响应。safety 的“明确安全值”词表也是保守契约，不是生产枚举验证。
2. **跨机器并发未验证**：本机锁只防同一台机器的并发进程，不是 Notion/服务端 CAS；两台机器同时写仍可能互相覆盖。锁回收也只覆盖 live/dead owner 的常规竞态，不声称文件系统级原子 CAS。`fill_job_json` 的 PATCH 前预检与 PATCH 之间仍有非 CAS 窗口。
3. **候选人 + 多岗位写入不是事务**：候选人关系写成功、后续岗位失败时无法整体回滚；但会非 0 退出并明确报告失败，不会谎报全部成功。
4. **真实模型端点未验证**：Decisions API 的鉴权、限流、响应结构只用 mock；测试不读取、不发送真实 key。
5. **生产数据质量未重新统计**：README 中 136/576、38/97 是历史统计，可能已变化。
6. **旧 Python 工具逻辑未改**：只修了插件清单、Skill 文档与历史映射标注；旧 `run_match.py` 的业务逻辑未在本轮回归范围内。
7. **未实现能力**：邮箱/手机号/线程级去重、跟进附件、服务日志/发送流水、自动消息发送，明确不在本 CLI 内；这些能力按 fail-closed 报缺口，不回退旧库。
8. **关系写入上限依据公开 schema**：100 项来自 Notion 公开 page property value schema 的 `maxItems=100`，未对目标工作区逐字段验证；读取仍支持 >100 页。
9. **Notion 能力覆盖未做生产验收**：文档只声明当前 CLI 已实现的能力；Notion 原生是否支持更复杂的附件、去重或发送流程未在真实工作区验证。

## 7. 复现命令

```bash
cd /workspace/recruiting-cli-fix-20261125/repo

# Node 全量
node --test scripts/fanhan-ntn/test/*.test.mjs

# 只跑 CLI e2e
node --test scripts/fanhan-ntn/test/cli.test.mjs

# Python
python3 -m unittest discover -s tests -v

# 语法检查
for f in scripts/fanhan-ntn/src/*.mjs \
         scripts/fanhan-ntn/scripts/fill_job_json.mjs \
         scripts/fanhan-ntn/bin/fanhan-ntn.mjs; do
  node --check "$f" || exit 1
done
```

日志：

- `/workspace/recruiting-cli-fix-20261125/baseline-node-tests.log`
- `/workspace/recruiting-cli-fix-20261125/after-node-tests.log`
- `/workspace/recruiting-cli-fix-20261125/after-python-tests.log`
- `/workspace/recruiting-cli-fix-20261125/final-node-tests.log`
- `/workspace/recruiting-cli-fix-20261125/final-python-tests.log`
- `/workspace/recruiting-cli-fix-20261125/round2-baseline-focused.log`
- `/workspace/recruiting-cli-fix-20261125/round2-final-focused.log`
- `/workspace/recruiting-cli-fix-20261125/round2-final-node-tests.log`
- `/workspace/recruiting-cli-fix-20261125/round2-final-python-tests.log`
- `/workspace/recruiting-cli-fix-20261125/round3-baseline-focused.log`
- `/workspace/recruiting-cli-fix-20261125/round3-final-focused.log`
- `/workspace/recruiting-cli-fix-20261125/round3-final-node-tests.log`
- `/workspace/recruiting-cli-fix-20261125/round3-final-python-tests.log`
- `/workspace/recruiting-cli-fix-20261125/round4-final-node-tests.log`
- `/workspace/recruiting-cli-fix-20261125/round4-final-python-tests.log`

## 8. 变更文件

- `scripts/fanhan-ntn/src/cli.mjs`：命令层、缓存原子发布、安全写回、JSON 输出、缓存时效。
- `scripts/fanhan-ntn/src/parse.mjs`：雇佣类型/城市/职类/描述双来源/空 JSON 回退。
- `scripts/fanhan-ntn/src/pool.mjs`：重复/不求职/已推荐/状态缺失/职类协调/BM25 召回。
- `scripts/fanhan-ntn/src/ntn.mjs`：分页、重试、完整性检查、关系读取、锁、权限、原子写。
- `scripts/fanhan-ntn/src/llm.mjs`：provider/key 绑定、并发校验、部分失败、档位命名。
- `scripts/fanhan-ntn/scripts/fill_job_json.mjs`：默认 dry-run、新鲜读取、冲突、锁、非 0 失败。
- `scripts/fanhan-ntn/test/*.test.mjs`：70 个 Node 回归测试。
- `scripts/fanhan-ntn/README.md`、`skills/fanhan-recruiting-notion/SKILL.md`：安全边界、能力范围与 Notion 唯一在线路径。
- 根 `README.md`、`skills/fanhan-agentic-talent-recruiting/SKILL.md`、`skills/job-resume-intelligent-matching-fanhan/SKILL.md`、`skills/job-resume-match-audit/SKILL.md`：当前路径 banner、历史/离线分流、fail-closed 缺口说明。
- `.claude-plugin/plugin.json`、各 Skill `agents/openai.yaml`：Skill 注册与路由描述。
- `references/twenty-field-mapping.md`、`references/base-field-mapping.md`：历史/离线兼容标注。

## 9. 结论

在隔离环境、fake `ntn`、mock HTTP 和合成数据下，10 类反馈、第二轮 3 个发布阻塞项、第三轮 safety/fill/关系上限问题均完成“基线失败 → 修复 → 定向回归 → 全量回归”；第四轮完成 Notion 唯一在线库的文档/策略收口。没有执行任何生产 Notion/Twenty 写入、真实模型调用、push、PR、merge 或部署。生产 schema、真实模型、跨机器并发与 PATCH 前非 CAS 窗口仍需在目标工作区单独验证。
