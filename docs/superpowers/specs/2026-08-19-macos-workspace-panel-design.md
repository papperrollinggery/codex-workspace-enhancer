# macOS Codex 右侧工作台前向架构设计

状态：设计已获用户授权；实现细节由 Codex 在本文边界内自主选择

日期：2026-08-19

目标版本：Codex Workspace Enhancer 0.3.x

当前基线：`efebfbc` / 插件 `0.2.2` / Codex Desktop `26.814.41407`

## 1. 目标

在不回退现有原生 Visual Workspace、权限模型、worktree 继承、画布状态、发布质量和 SEO/GEO 资产的前提下，为 macOS Codex Desktop 增加一个显性、可操作、可扩展的右侧工作台入口。

最终体验必须同时满足：

1. 用户在增强窗口的 Codex 界面中始终能看到工作台入口，而不是依赖模型隐式发现工具。
2. 右侧面板能够直接处理当前任务的资产、画布、任务状态、worktree、变更和常用工具。
3. 完整画布仍可使用 MCP Apps 的 inline、fullscreen 和 PiP 显示模式。
4. 右侧面板与原生插件共享同一授权和画布事实源，不维护第二套状态。
5. 陌生项目不因 UI 注入而获得文件访问；审批、消息发送、文件删除仍由现有安全边界控制。
6. Codex 更新导致 DOM 锚点变化时，增强层自动撤销或降级，不能破坏原生界面。

## 2. 明确不做的事

- 不恢复或检出旧版本替换当前主线。
- 不修改或重签 `/Applications/ChatGPT.app`、`/Applications/Codex.app` 或 `app.asar`。
- 不伪造 `.app.json` Connector ID。
- 不让右侧面板自动批准项目、自动发送消息、自动执行删除或绕过 Codex 审批。
- 不把独立 Threadlines 类桌面客户端作为本目标的主交付物。
- 不用测试通过替代真实宿主可见性验收。

## 3. 研究基线

### 3.1 官方 MCP Apps

稳定规范提供 `inline`、`fullscreen`、`pip` 三种显示模式，并要求 View 和 Host 协商实际模式：

- <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>

当前原生插件依赖已经支持 PiP，但 `widget-resource.mjs` 与工具 schema 只声明了 inline/fullscreen。PiP 是不依赖 DOM 注入的官方扩展机会，应纳入新架构。

### 3.2 Codex App Server

App Server 提供线程、模型、插件、Skill、App、MCP、配置、审批事件和运行状态等 JSON-RPC 能力：

- <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>

它适合独立工作台或受控桥接，但当前没有公开的“第三方插件接入正在运行的 Desktop app-server stdio 会话”接口。因此首版不能假装拥有稳定的同进程 App Server 控制权；面板适配器必须允许以后接入 App Server，但首版仅使用已验证的只读数据源、原生路由标记和宿主按钮。

### 3.3 Codex Taskboard

`izscc/taskboard` 已证明 macOS 可以通过 loopback CDP：

- 在 Plugins 后注入原生风格入口；
- 保留原生侧栏；
- 以 iframe 覆盖主工作区；
- 使用原生项目、composer 和 route marker；
- 不修改 React、fetch、私有 chunk 或 Codex 数据文件。

来源：<https://github.com/izscc/taskboard>

其重要教训是：当前 Codex CSP 可能阻止任意 HTTP iframe，增强器需要在精确 renderer 上受控启用 CDP CSP bypass，并验证 OOPIF 真正加载。CDP 对同机进程具有较高权限，只能绑定 loopback，并在 UI 中明确展示运行状态。

### 3.4 Explodex

Explodex 把 Codex 挂载区域分为：

- Tier A：官方 Portal 锚点，如 `data-above-composer-portal`、`data-mcp-app-portal-target`、`data-thread-scroll-footer`；
- Tier B：Sidebar、Composer、Header 等启发式锚点；
- Tier C：只读布局属性，如 `data-app-shell-main-content-layout`、`data-tab-id`。

来源：<https://github.com/dan-dr/explodex/blob/main/docs/codex-architecture.md>

当前 `26.814.41407` 的 `app.asar` 已确认存在：

- `data-app-action-sidebar-scroll`
- `data-above-composer-portal`
- `data-mcp-app-portal-target`
- `data-thread-scroll-footer`
- `data-app-shell-main-content-layout`

因此新实现应优先使用 Tier A；原有 `data-app-action-sidebar-scroll` 继续作为侧栏存在性锚点，但不能成为唯一生命线。

### 3.5 ThreadDeck

ThreadDeck 的安全模式值得吸收：

- 校验目标进程所有者；
- 必要时短暂打开 inspector；
- 建立权限为 `0600` 的私有 Unix-domain command socket；
- 随后关闭 inspector；
- Accessibility 作为降级控制面。

来源：<https://github.com/y5862000/threaddeck-for-codex>

首版仍可使用持续 CDP 连接以支撑 iframe 请求拦截和 renderer 自愈，但实现必须把“短时 inspector + Unix socket”定义为后续安全收敛目标，桥接协议不得绑定到 TCP 语义。

### 3.6 Threadlines

Threadlines 展示了完整工作台的功能上限：对话、浏览器、项目文件、终端、Git、Diff、后台任务、恢复和多 Provider。

来源：<https://github.com/Threadlines/threadlines>

新右侧工作台不复制一整个 IDE，但应预留模块插槽，使资产、任务、变更、预览和工具能够逐步达到类似的“同屏可见、可操作、可恢复”体验。

### 3.7 上游 Sidebar Enhancer

当前上游已提供 macOS/Windows 注入器、项目管理、Skill 分组、资产控制台、任务状态、全局最近、中断任务、快捷入口设置和真实额度显示：

- <https://github.com/yubowen123/codex-sidebar-enhancer>

本仓库不能直接覆盖上游文件；应选择性移植经过测试的行为，并保留本分支的原生右侧工具轨、受保护素材规则和 0.2.2 原生插件能力。

## 4. 选定方案：双平面渐进式工作台

系统由“原生能力平面”和“可选工作台平面”组成。

```text
┌────────────────── Codex Desktop 26.814+ ──────────────────┐
│ 原生任务侧栏 │ 对话 / MCP App 主区 │ 右侧工作台 │ 48px 工具轨 │
└───────────────────────────────────────────────────────────┘
        │                 │                │
        │                 │                └─ Panel Shell Injector
        │                 └─ Visual Workspace MCP App
        └─ Native Codex UI / routes

Panel Shell Injector ── authenticated session ── Panel Bridge
                                                    │
                         ┌──────────────────────────┼────────────────────┐
                         │                          │                    │
                  shared workspace store     approved asset reads   status adapters
                         │                          │                    │
                  native MCP server          preview/cache         task/git/plugin
```

### 4.1 原生能力平面

继续由 `plugin/codex-workspace-enhancer/` 负责：

- 项目批准与 worktree 继承；
- 资产扫描和预览；
- 画布 revision、节点、选择和保存；
- MCP App 生命周期；
- inline/fullscreen/PiP；
- 模型上下文回传；
- 无自动发送。

原生平面始终可以独立使用。工作台未安装、未启动或失效时，0.2.2 及后续原生功能不能退化。

### 4.2 工作台平面

由当前 `assets/runtime/enhancer/` 前向演进而来：

- macOS launcher 启动一个明确标记的增强窗口；
- injector 连接该窗口的 loopback CDP；
- 仅在匹配 Codex renderer、稳定锚点和版本指纹时注入；
- 注入 48px 工具轨与可调整 complementary panel；
- 关闭时完整撤销 DOM、observer、Fetch interception、会话和本地服务。

它是当前版本的 UI 兼容层，不是旧版替换包。

### 4.3 Panel Bridge

新增最小本地桥接层，职责只有：

1. 将当前任务上下文映射到已批准的 workspace。
2. 复用原生 `workspace-store.mjs` 的验证、读取和保存逻辑。
3. 为右侧 iframe 提供有界、带会话的资产和画布 API。
4. 提供只读任务、worktree、Git、插件和运行状态适配器。
5. 向 injector 报告健康状态、版本和能力列表。

Panel Bridge 不能复制 workspace-store 的授权规则。需要共享实现时，应抽取公共模块，而不是复制代码。

## 5. 用户界面设计

### 5.1 布局

```text
┌────────────┬──────────────────────────────┬──────────────────────┬──────┐
│ 原生侧栏   │ 对话 / 完整 Visual Workspace │ 工作台 420–720px      │ 工具轨│
│            │                              │                      │ 48px │
│            │                              │ 当前项目 / 状态       │ 总览 │
│            │                              │ 资产 / 画布           │ 资产 │
│            │                              │ 任务 / Worktree       │ 画布 │
│            │                              │ Changes / Review      │ 任务 │
│            │                              │ Browser / Terminal    │ 变更 │
│            │                              │ Plugin / Skill        │ 工具 │
└────────────┴──────────────────────────────┴──────────────────────┴──────┘
```

规则：

- 工具轨宽 48px，按钮至少 40×40px。
- 面板最小 420px、默认 560px、最大为窗口宽度减去原生侧栏和 320px 对话区。
- 支持拖拽和键盘方向键调整宽度。
- 面板使用 `role="complementary"`，不伪装成 modal。
- Escape 关闭当前面板；焦点返回开启按钮。
- Reduced Motion、Reduced Transparency、Increased Contrast 有明确降级。
- 工具轨可排序、隐藏模块，但核心“总览”和“Visual Workspace”不可同时隐藏。

### 5.2 模块

#### 总览

- 当前项目、仓库、分支、worktree、任务标题；
- Visual Workspace 授权状态；
- 原生插件与 Panel Bridge 版本；
- 正在运行、等待用户、失败、完成的任务计数；
- 最近一次保存、最后一次宿主显示回执；
- 一键停止增强器并关闭本地会话。

#### 资产

- 当前批准项目的图片列表、搜索、文件夹和筛选；
- 有界预览和延迟加载；
- 选中后加入画布或更新模型上下文；
- 不直接移动、删除或改写源图。

#### 画布

- 右侧紧凑画布使用与原生 Visual Workspace 相同的 board revision；
- 支持选择、拖动、缩放、便签和刷新；
- “浮动”请求 PiP；
- “展开”请求 fullscreen；
- Host 不支持 PiP 时保持 dock，不把请求当成已授予。

#### 任务

- 当前项目相关线程；
- active、waiting、blocked、review、failed、completed 状态；
- 关联 branch/worktree；
- 打开原生线程；
- 首版只读展示，不在面板内代替原生审批。

#### 变更

- branch、ahead/behind、dirty 文件数；
- changed file 摘要；
- 打开原生 Review/文件预览；
- 不实现隐藏 commit、push 或 force 操作。

#### 工具

- Browser、Terminal、Review、Plugins、Skills、Automations 的宿主入口；
- 优先点击稳定原生入口或写入未发送 composer mention；
- 不调用私有 React 实例、不 patch fetch、不自动提交输入。

### 5.3 可扩展模块注册

面板采用静态受信任 registry：

```js
registerPanelModule({
  id,
  label,
  icon,
  order,
  requiredCapabilities,
  getStatus,
  mount,
  onTaskChanged,
  destroy,
});
```

首版不加载远程第三方脚本。以后新增模块只能来自已安装、经过 manifest 和哈希验证的本地包。

## 6. 显示模式

### 6.1 Dock

默认工作模式。由增强层提供，适合总览、资产、任务和轻量画布。

### 6.2 PiP

原生 MCP Apps 模式。View 增加 `pip` 能力并在 Host 提供时请求。PiP 是浮动层，不等于固定 Dock，因此仅作为快速查看和继续操作模式。

### 6.3 Fullscreen

完整画布模式。继续使用 display receipt 区分 requestedMode 和 actualMode。

### 6.4 Inline

工作台不可用或用户关闭增强器时的默认原生降级。

## 7. 数据与状态

### 7.1 唯一事实源

- 项目批准：原生 workspace catalog。
- 画布：原生 `<workspaceId>.canvas.json`。
- 面板 UI 偏好：增强器用户状态目录。
- 线程/任务状态：Codex 当前只读状态源与适配器缓存。
- Git：实时只读命令结果，不写入独立 Git 状态。

### 7.2 任务切换

任务 A → B 时：

1. 增加 task generation；
2. 禁用 A 面板交互；
3. 撤销 A 的 panel session；
4. 解析 B 的 workspace；
5. 加载 B 数据；
6. 任何晚到的 A 响应均因 generation 不匹配而丢弃。

### 7.3 并发

- 画布沿用 base revision 冲突处理；
- Panel 与 MCP App 可同时打开；
- 冲突时面板展示“已在另一视图更新”，要求刷新，不静默覆盖；
- 保存防抖但 teardown 必须 flush。

## 8. 安全边界

### 8.1 Desktop 与 CDP

- 只连接 `127.0.0.1`；
- 启动前验证端口监听者与目标 ChatGPT/Codex 进程；
- 只接受匹配 app scheme、Codex 标记和稳定锚点的 renderer；
- 不连接普通浏览器页面、登录页或不匹配 profile；
- UI 清楚显示“增强窗口”和调试连接状态；
- 关闭窗口或增强器时停止 CDP、Bridge 和子服务。

### 8.2 Panel Bridge

- 只绑定 loopback；
- 使用每次安装随机主令牌和每次面板随机 nonce；
- iframe 绑定精确 origin、frame/session id、task generation；
- API 限制方法、请求大小、扫描数量、并发和超时；
- 不把 bearer token 暴露给 iframe JavaScript；
- 通过 injector 服务端代理附加认证；
- 日志不记录 token、图片内容或私有绝对路径正文。

### 8.3 文件

- 仅访问原生 catalog 已批准的 exact realpath 或安全继承 worktree；
- 每次读取重新验证 realpath、regular file、symlink containment；
- 保留 FinalDelivery 和受保护创意路径规则；
- 面板首版不提供永久删除。

### 8.4 审批和消息

- 项目首次批准仍由原生 widget 完成；
- 面板只能展示等待状态并导航到原生审批；
- 加入对话只更新 composer/context，不发送；
- 面板不替 Codex 接受命令或文件修改审批。

## 9. 宿主兼容与故障恢复

### 9.1 版本指纹

每次注入记录：

- Codex/ChatGPT 版本；
- app bundle hash 的非敏感摘要；
- 必需锚点存在性；
- renderer URL/profile；
- Panel Bridge 和插件版本。

### 9.2 锚点策略

1. Tier A Portal；
2. 已验证的 `data-app-action-sidebar-scroll`；
3. 受限 heuristic；
4. 找不到时撤销增强并展示诊断，不继续猜测。

### 9.3 自愈

- renderer 替换时重新安装 document-start 脚本；
- observer/runtime token 保证旧实例不能复活；
- iframe/service 退出时展示 retry；
- 重试前重新校验 task generation 和 session；
- 连续失败进入 disabled 状态，避免无限重启。

## 10. 性能预算

- 空闲 injector CPU 接近 0，禁止无界轮询；
- DOM MutationObserver 只观察必要根节点并做批量防抖；
- 面板关闭后无活动 preview 请求；
- 图片读取并发不超过 3；
- 最近位置缓存有数量和字节上限；
- 单次同步不扫描完整会话目录；
- 大列表虚拟化；
- task change 首屏状态目标 300ms 内可见，资产后台加载。

## 11. 安装和生命周期

### 11.1 默认使用方式

- 原生插件继续通过 Git Marketplace 安装；
- macOS 工作台作为同一仓库的可选本机组件安装；
- `Codex Workspace Enhancer.app` 启动独立增强窗口，普通 ChatGPT/Codex 启动不受影响；
- 设置中可选择“登录后准备增强器”，但默认不强制重启普通应用。

### 11.2 状态可见性

启动器和面板必须显示：

- 插件版本；
- Bridge 端口或 socket；
- CDP 状态；
- 当前 workspace；
- 停止按钮；
- 日志位置；
- 是否运行在安全降级模式。

### 11.3 卸载

- 仅删除 manifest 拥有的 runtime、LaunchAgent、launcher 和日志；
- 保留原生插件画布、workspace catalog、AssetBrowser 用户配置和素材；
- 卸载工作台不卸载原生插件。

## 12. 实施分层

### M1：宿主与显示模式

- 增加 PiP schema、能力声明、回执和 QA；
- 更新当前宿主锚点指纹；
- 修复 macOS verify 文档与真实参数不一致。

### M2：可见工作台外壳

- 恢复并现代化 48px 工具轨；
- 实现总览、资产、画布、插件/Skill；
- 支持宽度、键盘、主题和完整撤销；
- 保持旧入口关闭，不使用第二套画布状态。

### M3：共享 Visual Workspace

- 抽取共享 workspace core；
- Panel Bridge 复用批准、扫描、预览和 board revision；
- Dock/PiP/fullscreen 状态同步；
- A→B task generation 验证。

### M4：任务与开发工作流

- 任务状态、worktree、Git changes、Review/Browser/Terminal 入口；
- 选择性移植上游全局最近、中断任务、快捷入口设置和状态标记；
- 面板模块 registry。

### M5：安装与发布

- 安装 dry-run、activate、verify、uninstall；
- 当前 `26.814.41407` 真实增强窗口验收；
- 源码、安装副本、插件和 Bridge 哈希一致；
- 独立安全/代码/视觉 cold review；
- 公开版本与 CI。

## 13. 测试与验收

### 13.1 确定性测试

- schema、语法、manifest；
- PiP/inline/fullscreen negotiation；
- panel module registry；
- exact root/worktree 继承；
- token、nonce、origin、frame/session、generation；
- revision conflict；
- 安装/回滚/卸载；
- 端口/进程/目标验证；
- stale renderer 和重复注入；
- Reduced Motion/Transparency/Contrast；
- no-auto-send、no-auto-approve、no-delete。

### 13.2 模拟宿主

- 1440×900、1280×800、窄窗口；
- light/dark；
- 工具轨按钮至少 40px；
- dock 420–720px；
- 无水平溢出；
- focus/keyboard/escape；
- A→B 反序响应；
- iframe error/retry；
- anchor missing fail-closed。

### 13.3 真实宿主

必须在当前安装副本上证明：

1. Enhanced launcher 打开的窗口显示工作台工具轨。
2. 普通 Codex 窗口不被注入。
3. 总览识别正确当前任务、项目和 worktree。
4. 已批准项目可直接打开 Dock 画布。
5. Dock 与 fullscreen 使用同一 board revision。
6. PiP 以非 pending receipt 证明实际模式，或明确记录 Host 不支持。
7. 第二 worktree 继承授权且无需重复点击。
8. 切换任务不泄漏旧项目资产。
9. 停止增强器后工具轨、panel、observer、CDP 和 Bridge 全部撤销。
10. 端口只监听 loopback，关闭后无监听进程。

## 14. 发布门禁

- 当前主线无回退；
- 原生插件全量 quality gate 通过；
- legacy/Panel Bridge 全量测试通过；
- 生产依赖无高危漏洞；
- 安装副本哈希匹配；
- GitHub CI 成功；
- fresh independent cold review 无 P0/P1；
- 真实宿主截图和状态回执存在；
- 未证明的显示模式、宿主采用或面板状态必须标记未验证。

## 15. 主要局限与后续空间

### 当前局限

- Codex 没有公开持久 sidebar contribution API；增强层仍受 DOM 变化影响。
- PiP 是否可用由 Host 决定。
- 当前 Desktop app-server 没有公开多客户端附着到既有 stdio 会话的稳定路径。
- CDP 持续开放期间，同机恶意进程可能尝试连接，必须显示风险并限制增强窗口用途。
- 部分宿主操作只能通过稳定原生入口或未发送 composer mention 发起。

### 后续优化

- 采用 ThreadDeck 式短时 inspector + 私有 Unix socket；
- Codex 官方开放 `ui.sidebar` / `ui.panel` 后移除 DOM injector；
- App Server 提供稳定 attach 时替换会话文件适配器；
- 模块化接入 automations、approval queue、notifications、remote environments；
- 支持团队 Taskboard 和共享素材索引，但必须另设身份与授权边界；
- 允许经过签名和审核的本地 panel modules，不加载任意远程脚本。

## 16. 设计自审结论

- 无未完成占位标记。
- 架构不依赖回退旧版本。
- 原生插件可独立工作，增强器失败不会破坏核心功能。
- 右侧面板、PiP、fullscreen 的职责清楚，不把三者混为同一宿主能力。
- 授权、删除、发送和审批边界与 0.2.2 一致。
- 实施范围分层，但最终验收覆盖本目标要求的完整右侧工作台入口。
