# Kimi API、Kimi Coding Plan 与阿里云百炼 Coding Plan

[返回使用指南](guide.md#api-密钥与切换模型)

v0.4.0 提供三个独立的供应商选项，均通过 Chat Completions 接入，无需安装模型厂商的 CLI。支持文本流式回复、思考接收进度、工具调用、目标续行及历史恢复。模型本身支持图片不代表插件已支持图片输入；当前输入仍为文本与终端内容。

## 国内与国际端点

在 **Settings → AI Tools → 添加 API 连接** 中选择供应商，然后选择 **服务区域 → 中国内地／国际**。区域切换自动填写 Base URL，并清除旧模型列表；模型 ID 和密钥草稿保留，请重新核对。手动修改 Base URL 后会显示“自定义地址”，不会自动覆盖代理配置。服务区域代表购买平台的接口，不是自动测速、故障转移或套餐互转。

| 供应商选项 | 中国内地 Base URL | 国际 Base URL | 默认环境变量 | 预填模型 ID |
| --- | --- | --- | --- | --- |
| Kimi API（开放平台，按量付费） | `https://api.moonshot.cn/v1` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | `kimi-k3.1-pro` |
| Kimi Coding Plan（Kimi Code 会员） | `https://api.kimi.com/coding/v1` | `https://api.kimi.ai/coding/v1` | `KIMI_API_KEY` | `kimi-for-coding` |
| 阿里云百炼 Coding Plan | `https://coding.dashscope.aliyuncs.com/v1` | `https://coding-intl.dashscope.aliyuncs.com/v1` | `BAILIAN_CODING_PLAN_API_KEY` | `qwen3.7-plus` |

默认选择中国内地。请求路径由插件拼接为 `/chat/completions`，无需手动附加。选择端点时，请使用购买平台、套餐及区域对应的 Key；国内与国际的可用模型、权益和配额应分别以对应控制台为准。

Kimi 的开放平台 Key 和 Kimi Code 会员 Key 是两套配置，不能混用。Kimi Code Key 在 [Kimi Code 控制台](https://www.kimi.com/code/console) 创建。官方端点与区别见 [Kimi Code API 接入](https://www.kimi.com/code/docs/#api-接入)和[常见问题](https://www.kimi.com/help/kimi-code/faq)。

阿里 Coding Plan 使用套餐页面创建的专用 Key（`sk-sp-`），不能使用普通百炼按量 API Key。两类地址与额度不互通，套餐额度耗尽不会自动回退至按量计费。国内说明见[百炼 Coding Plan](https://help.aliyun.com/zh/model-studio/coding-plan)，国际接入见[Model Studio 第三方编程工具](https://www.alibabacloud.com/help/en/model-studio/more-tools)。Coding Plan 与 Token Plan 是不同产品，本选项预设的是 Coding Plan 地址。

## 模型、思考与工具调用

预填模型可手动修改，不代表账号已获得该模型权限。聚焦模型输入框或点击“获取模型”读取当前端点的 `/models`；服务端不提供模型列表时，保留手动输入。不要把 Kimi Code 的 `kimi-for-coding` 别名填入普通 Kimi API，也不要假定百炼支持所有 Kimi 直连模型。

新选择这三个供应商时，输出上限预填 `32768`，为思考和正文保留空间；可以在高级设置按模型上限调整。现有连接不会因为升级自动改写。

- **Kimi API**：K3／K3.1 Pro 通过 `reasoning_effort` 调整 `low`／`high`／`max`；已知仅支持思考的 K3、K3.1 Pro 和 K2.7 Code 模型不发送不兼容的 `thinking` 字段。关闭这些模型的思考会在发请求前提示修改配置。K2.6 等可切换模型仍可显式启用或关闭 Thinking。
- **Kimi Coding Plan**：根据服务端元数据或已知模型提供推理等级；`kimi-for-coding`、K3 和 K3.1 Pro 支持 `low`／`high`／`max`，高速模型不一概复用这些选项。K3.1 Pro 不能关闭思考。模型别名实际指向的版本及会员档位可能变化，见[官方模型配置](https://www.kimi.com/code/docs/kimi-code/models.html)。
- **百炼 Coding Plan**：使用自己的 `enable_thinking` 布尔参数；即使模型名为 `kimi-k2.5` 或 GLM，也遵循百炼协议。默认不强加思考参数；手动推理强度只应填写该端点和模型明确支持的值。见[百炼思考模式配置](https://help.aliyun.com/zh/model-studio/coding-plan-faq)。

三个连接都会处理分片 `tool_calls` 和流式 usage；历史中的 `reasoning_content` 在所属会话里保存并回传，跨供应商只交接通用文本，不泄露或重放内部推理。Kimi 请求带会话级 `prompt_cache_key`，同一会话工具续轮、后续消息和重启恢复保持一致，新会话独立。协议依据：[Kimi Chat Completions](https://platform.kimi.ai/docs/api/chat)、[思考与工具调用](https://platform.kimi.ai/docs/guide/use-thinking-models)。

## 使用范围与验证边界

Kimi Code 会员和百炼 Coding Plan 用于个人交互式编程。无人值守定时任务、批量脚本或应用后端应使用适合该场景的普通按量 API。插件提示此限制，模型知识也会提示选用合适的连接；当前并未增加套餐用途的运行时强制拦截。请求使用真实的 `tabby-ai-tools` 客户端标识，不冒用官方客户端，也不伪装成其他工具。参见 [Kimi Code 社区倡议](https://www.kimi.com/code/docs/kimi-code/community-guidelines.html)和[百炼使用须知](https://help.aliyun.com/zh/model-studio/coding-plan)。

本次使用本地 HTTP/SSE 夹具验证了协议、鉴权、区域切换、模型发现、流式回复、连续工具调用、思考参数、历史恢复和缓存标识；未调用收费模型，未用真实套餐账号核验厂商准入与额度扣减。点击设置中的“测试连接”会发送真实简短请求并消耗少量用量；HTTP 401 请核对 Key 与端点，403 请核对套餐、模型权限及工具准入，429 请检查额度与限流。错误不会自动改走其他计费端点。
