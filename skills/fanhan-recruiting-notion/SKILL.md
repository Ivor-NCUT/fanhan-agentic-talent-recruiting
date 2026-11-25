---
name: fanhan-recruiting-notion
description: 以 Notion 三张表（候选人库、职位 JD 库、公司库）为数据源做招聘双向检索与匹配判断。用户要拿 Notion 里的候选人找岗位、拿 JD 找候选人、需要可复现的匹配分数与档位、或要把匹配结果写回 Notion 关系字段时使用。数据还在 Twenty 时不要用本 Skill，改用 $recruiting-crm 相关子 Skill。
---

# 泛函招聘 Notion 版检索与匹配

用 `scripts/fanhan-ntn` 这个 CLI 读写 Notion 三张表。CLI 只做事实层：取数、归一、硬性排除、把原始材料交给判断模型；**分数全部由判断模型给出，CLI 不做加权**。

## 前置条件

1. 本机装好 Notion 官方 CLI 并登录：`ntn whoami` 能返回工作区。
2. 判断模型凭据（Perplexity Decider）：`pbpaste | fanhan-ntn auth login`，key 经 stdin 存入 Keychain，不出现在命令行参数与日志里。
3. 安装 CLI 本身：在 `scripts/fanhan-ntn` 下执行 `npm link`，得到 `fanhan-ntn` 命令。

三张表的 data source ID 默认指向泛函自己的工作区，换工作区时用 `FANHAN_DS_CANDIDATES` / `FANHAN_DS_JOBS` / `FANHAN_DS_COMPANIES` 覆盖。

## 标准流程

```bash
fanhan-ntn status                 # 先看连接、缓存与数据缺口
fanhan-ntn sync                   # 全量拉到本地缓存（数百条约 1-2 分钟）
fanhan-ntn audit                  # 缺 JSON / 缺职类 / 空壳记录清单
```

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

- **不编造**：候选人材料没写的经历、年限、成果一律按未知处理，不得因为岗位需要就替候选人补上。
- **命中记录不等于推荐**：`--top` 是候选范围，不是推荐名单；对外推荐前按受众再过一遍。
- **写回需显式授权**：`link` 默认只预演，必须加 `--yes` 才写 Notion；写入前把候选人与职位 ID 列给用户确认。
- **生成文案不等于发送**：本 Skill 只产出名单、分数与理由，不代发消息、不声称已联系候选人。
- **数据缺口要如实说**：缺检索 JSON 的记录会降级用备注/邮件正文判断，输出里会标出来；这类结论的可信度低于有 JSON 的记录。
- **职类口径**：候选人职类为空、或岗位类目与候选人跨度过大时会被排除，用 `--any-category` 可放开，但要在结论里说明放开了。
