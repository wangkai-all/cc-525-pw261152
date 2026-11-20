# 管理报表修订流程（Report Revision Workflow）

零依赖的 Node.js + TypeScript 应用，实现「指标口径 / 源数据变化 → 受影响报表自动识别 →
差异预览 → 复核审批 → 不可变发布 → 回滚」的完整闭环，并提供去重通知、权限控制与审计日志。

- 运行时：Node.js ≥ 22.6（使用原生 TypeScript type-stripping 与内置测试运行器，**无需 npm install**）
- 持久化：单个 JSON 文件，原子替换写入，重启后数据与 ID 序列连续
- 前端：原生 HTML/CSS/JS 单页应用，无构建步骤

## 快速开始

```bash
npm start                 # 默认 http://localhost:3000，数据文件 data/db.json
PORT=8080 npm start       # 自定义端口
DATA_FILE=/tmp/x.json npm start
npm test                  # 运行全部 29 个自动化测试
node scripts/persist-check.ts   # 验证跨重启持久化与 ID 序列
bash scripts/e2e.sh             # HTTP 端到端流程（需先启动服务）
```

打开页面后选择演示身份登录：

| 身份 | 角色 | 能力 |
| --- | --- | --- |
| 系统管理员 | admin | 全部操作，含发布、回滚、审计查看 |
| 业务分析师 | analyst | 发起变更、创建/提交/撤销修订、催办 |
| 复核负责人 | reviewer | 复核批准/驳回 |
| 只读访客 | viewer | 只读；与其他角色看到**完全相同**的明细与摘要 |

## 业务流程与状态机

```
指标口径/源数据变更
        │  影响分析（纯函数：what-if 重算 + 单元格 diff）
        ▼
受影响报表清单（每个报表一个 DRAFT 修订，共享 changeGroupId）
        │  提交（必须绑定原因；自动生成复核任务 + 通知）
        ▼
   SUBMITTED ──驳回──▶ REJECTED（终态）
        │ 批准
        ▼
   APPROVED ──管理员发布──▶ PUBLISHED（生成新的不可变版本 Vn，主数据此时才变更）
        │
   任意非终态可撤销 ──▶ CANCELLED（待处理复核任务联动取消）

回滚：不删除/覆盖任何历史，把目标版本快照重新发布为 Vn+1（source=ROLLBACK）
```

关键约束（均有测试覆盖）：

1. **已发布版本不可覆盖**：版本只追加；对已发布修订再次发布返回 `409 IMMUTABLE_VERSION`。
2. **修订必须绑定原因**：创建/回滚缺少原因返回 `400`，原因随修订、发布版本、审计日志持久化。
3. **审批前置**：仅 `APPROVED` 修订可发布；复核任务只能处理一次。
4. **基线保护**：发布时若发现差异基线已不是最新版本（期间有别的发布），拒绝发布并要求重建修订。
5. **发布前再校验**：发布时按存储的变更触发器重算，快照与差异必须与复核时完全一致，否则中止。
6. **回滚保护**：存在未结束修订时禁止回滚；回滚必须填写原因。

## 通知去重

通知身份键 = `事件类型 + 对象类型 + 对象ID + 接收人 + 渠道`（见 `src/notification.ts` 的
`dedupKeyOf`）。相同通知重复触发时不新增记录，只累加 `dupCount`；不同渠道（站内 SITE /
邮件 EMAIL）各自独立。修订详情与通知中心展示「通知条数」和「被抑制的重复数」，
`催办`接口专门用于验证重复通知行为（返回 `delivered` / `suppressedDuplicates`）。

## 权限与一致性

- 所有读取接口先过角色校验，但**所有角色共用同一套读模型投影**（`getReport` /
  `getRevision` 等），不存在按角色裁剪数值的分支；测试 `consistency: every role receives
  identical detail and summary numbers` 对四个角色的 diff、快照、摘要做深比较。
- 写权限矩阵：

| 操作 | admin | analyst | reviewer | viewer |
| --- | :-: | :-: | :-: | :-: |
| 影响预览 / 创建修订 | ✓ | ✓ | ✗ | ✗ |
| 提交 / 撤销 / 催办 | ✓ | ✓（自己的） | ✗ | ✗ |
| 复核决定 | ✓ | ✗ | ✓ | ✗ |
| 发布 / 回滚 | ✓ | ✗ | ✗ | ✗ |
| 审计日志 | ✓ | ✗ | ✗ | ✗ |

## 页面展示

- **报表与版本**：报表卡片、版本时间线（版本发布与修订事件混合排序）、当前版本明细、
  历史版本快照、复核/发布记录表；管理员可见回滚入口。
- **修订流程**：状态筛选、影响对象、差异摘要、通知状态（含重复抑制计数）及全部流转操作。
- **复核任务**：待办队列，批准/驳回需填写意见。
- **通知中心**：个人收件箱（管理员可见全量），重复通知以「重复抑制 ×N」标记。
- **审计日志**：管理员可见全部动作（创建、提交、批准/驳回、发布、撤销、催办、回滚）。

## HTTP API 摘要

认证：`POST /api/sessions {userId}` 返回 `sessionId`，之后请求带头 `x-session-id`。

| 方法 & 路径 | 说明 |
| --- | --- |
| GET `/api/me` `/api/users` `/api/metrics` `/api/source-data` | 元数据 |
| GET `/api/reports` `/api/reports/:id` `/api/versions/:id` | 报表/版本/时间线 |
| POST `/api/changes/preview` | 影响分析与差异预览（不落库） |
| POST `/api/revisions` | 按受影响报表批量创建 DRAFT 修订 |
| POST `/api/revisions/:id/submit` `/cancel` `/publish` `/remind` | 修订流转 |
| GET `/api/revisions` `/api/revisions/:id` | 修订列表/详情（含复核与通知状态） |
| GET `/api/review-tasks` · POST `/api/review-tasks/:id/decision` | 复核 |
| POST `/api/reports/:id/rollback` | 回滚发布为新版本 |
| GET `/api/notifications` `/api/audit` | 通知 / 审计（admin） |

## 代码结构

```
src/
  types.ts        领域模型与状态枚举
  domain.ts       纯函数：报表物化、what-if 场景、影响分析、单元格 diff、摘要
  notification.ts 通知投递与幂等去重
  service.ts      修订生命周期、权限、审批、不可变发布、回滚、共享读模型
  store.ts        JSON 文件存储（原子写）/ 测试用内存存储
  seed.ts         演示种子数据（3 报表 × 3 指标 × 2 期间，均有 V1 发布版本）
  server.ts       零依赖 HTTP 服务与静态资源
  errors.ts util.ts
public/           前端 SPA（index.html / app.js / styles.css）
test/             node:test 自动化测试（领域、流程、通知、权限、HTTP 共 29 例）
scripts/          e2e.sh 端到端脚本；persist-check.ts 重启持久化验证
```

## 设计说明

- **主数据延迟变更**：发起变更只在修订上保存 `trigger` 与提案快照，指标/数据源定义直到
  发布瞬间才修改，保证草稿期间线上报表口径不变。
- **同组变更**：一次变更影响多张报表时，各修订共享 `changeGroupId` 与完整
  `impactedReportIds`，发布其中一张不会破坏其他修订（幂等的主数据应用 + 基线保护兜底）。
- **可测试性**：时钟可注入（`FakeClock`），存储可换内存实现，业务逻辑与 HTTP 分层。
