# 登峰运动康复中心小程序

基于 PRD v1.3 的微信原生小程序与微信云开发实现。客户端在 `miniprogram/`，业务云函数在 `cloudfunctions/api/`，从仓库根目录导入微信开发者工具。五位教练和五项服务由管理员初始化，服务授权、真实账号、排班和余额须按机构实际数据录入。

## 已实现

- 学员：新档案或申请绑定已有档案、查看余额、按教练与项目查询可约时间、预约、取消、查看历史与训练记录。
- 教练：查看本人预约与排班、签到、查看和维护学员基本资料、查看全部学员的有效课程日志、填写本人课程的文字及最多三张图片。
- 管理员：处理档案绑定、人员关联和项目授权、代建档案、线下购课课时调整、排班、签到、取消、撤销误签到、查看扣课记录与通知状态。
- 服务端：预约占用课时，签到时扣一节并写流水；并发和重复请求由云数据库事务、确定 ID 的排班与课时文档、幂等操作记录控制。

## 本地验证

要求 Node.js 20 或更新版本。仓库根目录运行 `npm run check` 和 `npm test`。测试使用内存事务模拟器，验证业务规则；它不能替代真实云环境的并发与权限验收。

## 云开发部署

0. 如果尚无云开发环境：用微信开发者工具导入**仓库根目录**，确认项目 AppID 为 `wxa4262550e4e0cb25`；用该小程序的管理员或获授权开发者账号登录，点击工具栏的「云开发」，按首次开通向导完成授权并创建环境。创建完成后在云开发控制台复制完整的环境 ID（EnvId）。创建环境和选择套餐由小程序账号持有人在微信开发者工具中完成。
1. 项目 AppID 已写入 `project.config.json`：`wxa4262550e4e0cb25`。在 `miniprogram/config.js` 填写云环境 ID，并确认 AppID 与云环境已关联。
2. 使用传统文档型云数据库环境，创建以下集合：`accounts`、`students`、`therapists`、`therapistDays`、`studentDays`、`bookings`、`ledger`、`logs`、`operations`、`outbox`、`audits`、`scheduleTemplates`、`uploads`、`mediaArchives`。每个业务集合设置仅管理端可读写，或应用 [`cloudbase/database.rules.json`](cloudbase/database.rules.json) 的安全规则。客户端只通过 `api` 云函数访问业务数据。
3. 云存储使用 [`cloudbase/storage.rules.json`](cloudbase/storage.rules.json) 的自定义规则；教练仅能上传到 `staging/logs/`，保存日志时云函数将校验后的图片复制到仅服务端可写的 `private/logs/`。读取正式图片经云函数检查权限并签发临时链接。部署后必须用两种身份实测上传、读取、禁止越权下载和禁止覆盖正式图片。管理员可执行“清理未引用图片”：仅检查归档超过 24 小时的对象，仍被日志引用的图片延后 7 天复查，未引用的图片删除。临时上传区仍需按云存储保留策略定期清理。
4. 在云函数 `api` 配置环境变量 `CLOUD_ENV_ID`（完整云环境 ID），上传并部署 `cloudfunctions/api`，选择云端安装 `wx-server-sdk` 依赖。首位管理员先用本人微信打开开发版，在欢迎页复制自己的关联码，**不要先注册为学员**；把该码配置为 `BOOTSTRAP_ADMIN_OPENID` 并重新部署云函数，刷新小程序后进入管理员角色。该码属于本人身份标识，不要使用他人账号。如启用签到订阅通知，还需 `SIGNIN_TEMPLATE_ID`、`SIGNIN_TEMPLATE_PROJECT_FIELD`、`SIGNIN_TEMPLATE_TIME_FIELD`，以及 `MINIPROGRAM_STATE`（`developer`、`trial` 或 `formal`）。模板字段键需与申请到的模板一致；未配置时通知状态为 `notConfigured`，签到照常完成。
5. 使用管理员微信登录并确认首页进入管理员角色，在管理员首页点击“初始化人员目录”。初始化不授予其服务项目，也不填排班。
6. 请五位教练用本人微信打开小程序，在欢迎页复制“工作人员关联码”交给管理员；管理员在人员页关联对应教练、勾选项目。学员本人注册或由工作人员代建，再由管理员录入实际剩余课时与排班。不要用测试数据替代真实余额。

### 查询索引

在云开发控制台按实际查询建立复合索引，字段方向以 `createdAt` / `updatedAt` / `at` 的降序为主。至少验证：`bookings` 的 `date + createdAt`、`therapistId + date + createdAt`、`therapistId + status`（待签到数量）、`studentId + createdAt`、`studentId + date + createdAt`；`logs` 的 `studentId + valid + createdAt`（普通用户）和 `studentId + createdAt`（管理员）；`ledger` 的 `studentId + at`；`students` 的 `updatedAt`；`accounts` 的 `role + id`；`outbox` 的 `createdAt`；`mediaArchives` 的 `status + gcAfter`。逐一在真实环境执行对应列表查询并根据控制台报错补充索引。姓名和电话搜索使用正则，数据量增长后需评估搜索方案。

## 发布前验收

用三种真实身份在开发版、真机和实际云环境完成 PRD 的 AT01–AT35。重点检查：最后一节课跨日期并发预约只成功一次；同一时段两人抢约只成功一次；签到与取消竞争只有一个结果；签到重复提交只扣一次；撤销返课及日志作废；停用或换绑后权限即时失效；图片仅授权人员可读取；订阅消息在真实模板下发送并在拒绝授权时不影响签到。先备份数据库和云存储，再验证一次恢复流程。通过后再提交微信审核与发布。

公司原始 Logo 已保存为 `miniprogram/assets/dengfeng_logo.jpg`，在首次进入页及三类角色首页等比例展示。AppID 已配置；尚未提供云环境 ID、管理员 OpenID 和实际业务数据，因此尚未做云端联调、真机验收或发布。
