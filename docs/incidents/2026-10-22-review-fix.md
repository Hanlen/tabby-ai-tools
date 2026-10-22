# 2026-10-22：审查问题修复与 SSH 终端所有权事故

本次接收的明确授权是实际修复已确认的问题并验证。工作目录原有大量已跟踪及未跟踪改动，本次在其上增量修复，未 reset/clean、提交、推送、发布、安装或重启用户 Tabby，未修改全局模型和 AI 权限。没有适用于本项目源码的 AGENTS.md。原始 review 记录为 `/tmp/tabby-ai-review-20261022-1251.log`；该临时文件不随项目分发，本文件保存必要的结论与后续核验步骤，不包含凭据或连接主机信息。

## 1. P1：旧 CLI 快照中断共享 Codex

原始复现使用真实 `CodexClient.connect` 调用链及进程桩：任务快照为 old-codex、前台为 new-codex，得到 `disconnect new-codex`、`start old-codex`，任务 `interrupted`、`enabled=false`。

修复 `src/agent-backend.service.ts`、`src/scheduled-tasks.service.ts`、`src/scheduled-workflow-runner.ts`：后台执行和模型发现都申请独立后端；运行时采用当前 CLI 路径，保存的任务模型、推理强度、sandbox、审批仍独立传入。执行结束关闭该独立客户端，前台客户端保持原状。

`test/scheduled-backend.test.js` 实际执行 factory → scheduler → runner → CodexService → CodexClient.connect/close/disconnect，桩仅替换 RPC 与 OS 进程。任务创建后切换 CLI，两次后台连接均为 new-codex，前台断连次数为 0，任务完成且仍启用，模型和 high 同时进入 thread/start 与 turn/start；独立客户端已关闭。此项没有启动真实模型服务。

## 2. P2：配置档报告成功但未保存

从安装依赖 sourcemap 核对 `ProfilesService.newProfile/writeProfile/deleteProfile`：只变更内存；`ConfigService.save` 等待平台写入完成并传播错误。

修复 `src/tabby-capabilities.service.ts`：创建、更新、删除均等待 `config.save()` 后返回 `saved=true`；保存失败向调用方抛错，不报告已保存。保持现有 provider、built-in、敏感字段与原有 options 边界。删除仍走宿主 provider 生命周期，未伪造可回滚的 provider 副作用。

`test/tabby-capabilities.test.js` 分别阻塞三个分支的保存 Promise，确认完成之前不会返回；保存后的独立快照能看到创建、更新和删除；三个分支都验证磁盘失败传播。原有测试同时验证实际 save 调用次数为 3。这里验证保存合同与重读快照，未重启真实 Tabby。

## 3. P2：能力发现漏掉交互工具

新增无宿主依赖的 `src/tab-tool-definitions.ts` 保存唯一注册定义；`src/tab-tools.ts` 继续导出 `TAB_TOOLS`，能力服务从同一定义生成完整名称列表，不反向导入工具服务，避免循环依赖。

`test/tabby-capabilities.test.js` 验证 `attach_process`、`send_keys`，并将整个能力列表与实际注册定义逐项比较。原有工具定义测试继续验证名称唯一及供应商注册。

## 4. P2：失败探测丢失已上报用量

修复 `src/model-probe.ts`、`src/api-provider.ts`、`src/agent-backend.service.ts`：API SSE 和 Codex 事件在收到用量时即报告；工具名称、nonce、JSON、重复调用校验失败，以及流异常、超时、取消，都保留已知累计用量。取消仍是取消，不触发模型回退。未收到用量时不猜测消耗。

`src/scheduled-tasks.service.ts` 每次探测后先保存累计用量再记录日志；候选和默认都失败时用量仍留在运行记录和错误信息中。达到预算后停止，不启动正式任务；候选已超预算时也不再发起默认探测。正式任务用量继续与 probeTokens 累加。

回归位于 `test/model-probe.test.js`、`test/scheduled-tasks-service.test.js`、`test/api-agent.test.js`：600 tokens 的各种工具校验失败、真实本地 HTTP/SSE 不完整协议响应、OpenAI failed/incomplete 携带 usage、同事件工具格式错误、Codex 无效工具、超时/取消竞争、候选超额、累计恰好 500、累计 499、两次失败及日志写失败均覆盖。四种 API 的候选无工具调用 → 默认成功，累计为 30 而非 15；HTTP 拒绝未上报用量时仍为 15。

## 5. P2：CRLF 检出导致 skill 检查误报

修复 `scripts/bundle-tabby-skill.mjs`：在嵌入 Markdown 之前统一 CRLF 为 LF，比较目标 JSON 时只规范化外层换行；真实文本变更仍导致 stale 错误。没有通过跳过校验、吞掉错误或每次 check 自动重写来掩盖过期内容。

`test/tabby-knowledge.test.js` 覆盖源文件 LF/CRLF × bundle LF/CRLF 的四种组合、生成结果一致性、源文修改及 bundle 文本篡改；另在临时 Git 仓库真实用 `core.autocrlf=true` 建索引并 checkout-index，确认 Markdown 与 JSON 检出为 CRLF 后检查通过。临时测试没有 commit，也不改项目索引或全局 Git 配置。

## 6. 既存事故：SSH 空列表提前释放输入所有权

12:47 的现场报告：本任务 `send_input(submit=true)` 启动只读 git log 循环，返回 `sent=true`、`submitted=true`、`userInputLocked=true`。约一秒后屏幕仍在 alternate buffer 的 `(END)`，却报告 `runningProcesses=[]`、`controlledByAI=false`。随后发送 stdin `q` 被所有权校验拒绝，release_tab 也返回 false，最终由用户手动退出和中断。

旧实现每 500ms 枚举，连续两次非 null 空数组即释放；这项策略在 HEAD `8251f7e9ffff48918e3837f081e4d4ffd8ef0749` 已存在。当前安装的 `BaseSession` 声明没有 getChildProcesses；官方[本地 session 实现](https://github.com/Eugeny/tabby/blob/master/tabby-local/src/session.ts)在 PTY 上实现该方法，[BaseSession](https://github.com/Eugeny/tabby/blob/master/tabby-terminal/src/session.ts)没有远端进程枚举合同。现场没有宿主对象与远端枚举实现的运行时采样，不能断言具体哪个适配器产生了 `[]`；已确认的是原策略误把不可靠空结果当结束证据。

修复 `src/tab-tools.ts`：

- 只有已知 local profile 的枚举用于本地进程判断；SSH/未知 provider、缺方法、异常或无效结果返回 null。此状态依然必须经过用户接管确认，不能自动 attach 未验证进程。
- 本任务已启动的进程在远端列表不可用、alternate buffer 或长时间静默时保持所有权，stdin/send_keys 仍可用。其他 owner、只读策略、会话切换和关闭检查仍然有效。
- 对已验证 attach 的本地可执行进程，normal buffer 下连续观察到两次空列表可释放；枚举失败不会累计空次数。本任务提交的 shell 命令则不能仅用子进程消失判定结束，因为 `sleep 1; read answer` 等命令在等待 shell builtin 输入时也没有子进程，必须用 shell integration 或显式释放。
- 从 ownership 开始接收 shell integration 的 OSC 133 `C → D → A`（开始 → 结束 → 返回提示符）作为另一路结束证据；只退出 alternate buffer、提示符样式文本或单独 A 都不足以释放。处理跨输出块的序列与异步 xterm 渲染。
- 多行提交可能在中间命令之间出现提示符，不据此自动释放整批；核对全部结果后显式 release_tab。没有可靠枚举或 shell integration 的远端会话同样通过读屏核实后显式释放，绝不根据静默超时猜结束。
- 用户释放、任务 owner 释放、session closed/destroyed、替换会话、标签移除及服务销毁都恢复原输入函数并清理监听与计时器。已验证的本地 attach 遇到临时枚举失败会拒绝本次输入但保留 owner，恢复后可继续；明确不匹配则拒绝并释放。

`test/tab-tools.test.js` 覆盖 SSH 占位空列表、未知 attach/无确认接管、交互分页器 q、其他 owner、静默进程、本地真实结束观察、OSC 结束、异步渲染、多行批次、用户释放与关闭生命周期。

`test/terminal-pty.test.js` 另在本机 Linux 真正启动 util-linux script + Bash + less：模拟 SSH 枚举不可用，进入 `(END)` 后等待 1.2 秒仍持有控制，经 stdin q 正常退出，收到 shell completion 后释放；再执行真实 sleep/printf 并自动释放；`sleep; read` 在无子进程时保持锁，收到实际答案并结束后才释放。夹具不启动 SSH、不连接用户终端，也没有完整 xterm 渲染。缺少 Linux/bash/less/script 的平台明确跳过。**这证明本地 PTY 与实际分页器路径，不代表真实 Tabby/SSH 或 Windows 端到端通过。**

后续真实 Tabby/SSH 核验：使用专用测试终端，确认 unknown takeover 审批；启动短输出分页器，超过一秒后 read_tab 应仍 controlledByAI=true、runningProcesses=null；同一 owner 的 stdin q 应送达；核对返回提示符和结果后释放，检查用户可输入。另验证静默长进程、需要多次输入的终端 Agent、用户释放与 SSH 断开；如 shell integration 不可用，预期显式释放。不要在用户正在使用的终端无授权重放事故命令。

## 7. 已授权 fix 停在 review 的工作流遗漏

用户指出前次监督只返回 review、未继续启动 fix；本次已明确授权修复，并按修改、测试和复查完成交付，不把流程遗漏虚构成新的 P0。项目没有专门的 review/fix 编排器，因此没有修改关键词路由或将所有 review 请求转成自动改码。

更新 `skills/tabby/SKILL.md`、重新生成 `src/tabby-knowledge.json`，并在 `docs/development.md` 明确：review-only 只报告；明确授权 fix 后执行修改、测试、复查，对范围内确认的 P0/P1/P2 继续修复或记录外部阻碍；监督另一个终端 Agent 时不能把对方的 review 报告当作修复完成，同时保留提交/推送/部署等授权边界。

`test/thread-tools.test.js` 验证 Codex 新建与恢复线程实际携带完整共用 skill；`test/api-agent.test.js` 对四种 API 验证完整 skill 进入实际请求，并模拟 review-only 与 fix-authorized 的工具往返，后者通过原审批流程把明确修复要求发回 Agent，再读取修改/测试/复查反馈。模型响应是夹具，验证范围是上下文、协议和审批，没有声称真实模型能保证遵循流程。技能按 skill-creator 指南做窄范围修改，并通过 quick_validate。

本次已实际完成 1–6 的代码与回归修复，补上第 7 项知识/文档及协议回归；修复后复查发现的用量落盘时序、alternate screen 渲染、多行提前释放及本地 shell builtin 没有子进程的边界也已继续修复。

## 最终验证与复查

本机为 Linux / Node v20.20.2。最终执行结果：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run skill:check` | 通过；生产构建后再检查仍通过 |
| `npm test` | 422 项，417 通过，0 失败，5 项 Windows 专用跳过；原基线为 368/363/0/5 |
| `npm run build` | webpack 生产构建通过 |
| `git diff --check` 与未跟踪文件的 no-index 空白检查 | 通过 |
| skill-creator `quick_validate.py skills/tabby` | 通过 |
| 真实 Linux PTY Bash/less、sleep、shell builtin read | 通过，包含在全量测试中 |
| 临时 Git 仓库真实 CRLF 检出 | 通过，包含在全量测试中 |

最终测试日志为 `/tmp/tabby-ai-fix-tests-final-20261022.log`，构建日志为 `/tmp/tabby-ai-fix-build-final-20261022.log`，类型检查和 bundle 检查分别为 `/tmp/tabby-ai-fix-typecheck-final-20261022.log`、`/tmp/tabby-ai-fix-skill-final-20261022.log`。这些是本机临时证据路径，长期结论保存于本文件。

修复后再检查连接隔离和清理、真实 save 合同、工具注册一致性、失败用量与预算边界、CRLF stale 检测、终端所有权及完成信号、review/fix 授权边界。复查中新确认的边界问题已继续修复并纳入全量回归；没有剩余已确认且未修复的 P0/P1/P2，也没有将本次交付遗漏虚构成 P0。

外部验证限制仍然存在：没有连接用户正在运行的 Tabby/SSH 会话，无法对 12:47 事故的具体宿主适配器做运行时取样；没有真实 SSH/Windows 桌面端到端或真实供应商推理测试，也没有声称用模型夹具验证了真实模型的决策能力。当前插件未安装/发布到运行中的 Tabby，代码与 dist 产物留在工作树；无 shell integration 的提交命令及多行批次需要核实结果后显式释放。以上是验证或使用边界，不隐瞒为端到端已通过。
