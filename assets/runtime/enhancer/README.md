# Codex Sidebar Enhancer

一个面向 macOS Codex 桌面体验的本地侧栏增强工具。它为对话增加摘要、最近消息预览、双列卡片、项目标签搜索、最近使用排序和额度展示，同时不修改应用包或对话正文。

## 本地安装

从 `codex-workspace-enhancer` Skill 根目录先检查与预演，再激活：

```bash
node scripts/inspect-macos.mjs
node scripts/install-bundled-macos.mjs --dry-run
node scripts/install-bundled-macos.mjs --activate
node scripts/verify-macos.mjs --installed
```

安装器会自动：

1. 安装到 `~/Library/Application Support/Codex Sidebar Enhancer`；
2. 从当前 `PATH` 选择可执行的系统 Node.js 入口，并允许用 `--node-path` 显式覆盖；
3. 安装用户级 LaunchAgent，登录和应用重启后自动恢复；
4. 在 `~/Applications` 创建 **Codex Sidebar Enhancer.app** 启动器；
5. 保持正在运行的 Codex/ChatGPT 不变，不自动打开、退出或重启应用。

以后从 Spotlight、访达的“应用程序”或 `~/Applications` 打开 **Codex Sidebar Enhancer** 即可。它会以本地调试端口启动 Codex/ChatGPT；注入器只连接 `127.0.0.1:9231`。

`asset-console/public/index.html` 是安装包源码，不是独立预览入口。直接以 `file://` 打开时只会显示启动说明；完整资产工作台必须从 Codex 侧栏的“资产控制台”进入，才能取得本地服务、私有会话令牌和当前任务上下文。

## 本地卸载

```bash
node scripts/uninstall-bundled-macos.mjs --dry-run
node scripts/uninstall-bundled-macos.mjs --uninstall
```

卸载会停止增强进程，并移除 manifest 明确拥有的运行时、用户级 LaunchAgent、启动器和增强日志；AssetBrowser 配置、令牌、账本、项目、媒体和未列入 manifest 的创意交付文件全部保留。

## 功能

- 每条对话直接展示核心总结。
- 原生悬浮预览增加核心总结、最近输入和最近输出；消息最多展示 3 行。
- 列表/卡片滑块支持鼠标和键盘切换，并记住选择。
- 同一文件夹内一行两张半透明卡片，固定展示名称、最后沟通时间、AI 总结和 3 个核心标签。
- 3 个标签分别提炼任务对象、工作类型和交付结果，过滤版本号、状态码及孤立工具名。
- “置顶 / 项目 / 最近”改为可访问的 Tab，一次只展示一个分组。
- 项目文件夹改为标签：按真实最近沟通时间降序排列，默认两行，可展开全部。
- 搜索框可模糊搜索文件夹名和项目名，命中后直接展示对应文件夹。
- 顶部 6 个功能入口改为图标卡片；超过 6 个时自动换行。
- Codex 主工作区右侧提供常驻工具轨：资产库、空间画布、插件与 Skill 都从原生界面内打开；资产面板支持拖拽或方向键调宽，关闭后不残留宿主 DOM。
- 顶部展示 Codex 自身记录的真实剩余比例和重置时间，不自行估算额度。
- 常用入口提供 Skill 管理工作台：读取完整安装目录，默认以单列清单呈现常用项；支持创作工作分类、搜索和星标，并保留原生详情与完整列表。
- “新对话”首页集中展示 Taskboard 中正在执行的项目；点击卡片直接进入关联对话。
- 项目执行完成后继续显示为“待查看”，首次点击后收起；钉住的项目跨状态、跨重启持续展示。
- 检测到本机 Asset Console 时，提供与当前 Codex 任务联动的资产工作区，接受 macOS POSIX、Windows drive 与 UNC 绝对路径。“待处理 / 项目素材 / 精选库”分别表示文件位置，“关联项目”单独决定当前任务的项目目标，今日练习独立保留。自动整理、重复清理与生成归档会保护 FinalDelivery、成片、最终输出、生成记录、参考库和每日练习当天目录。批量选择后可移动、附加到当前对话，或丢弃但不删除文件；最多支持 8 项且不会自动发送。
- 每个项目提供可持久化的空间画布：图片自由拖拽、空白处平移、指针中心缩放、框选/多选、便签、适合视图、方向键微调和刷新恢复。画布只保存项目内引用，不复制、移动或删除原始图片；在 Codex 内可把所选图片附加到对话，但不会自动发送。

## 系统要求

- macOS 13 或更新版本；
- 已安装 Codex 或包含 Codex 工作区的 ChatGPT 桌面应用；
- 本地存在 `~/.codex` 会话目录；
- Node.js 22 或更新版本。安装器会从当前 `PATH` 选择可执行入口；找不到时会明确失败，不会猜测或修改桌面应用内置运行时。

当前机器检测到的 ChatGPT/Codex 为 `26.810.52044`。由于增强服务按要求保持停止，本次只完成了当前源码、离线宿主和安装产物验证；该版本的实时 DOM 仍需以后从 Enhancer launcher 启动时复验。Codex 更新如果更改侧栏 DOM 锚点，注入会跳过找不到稳定锚点的功能，而不是猜测性改写页面。

## 隐私与安全

- 只读访问 `~/.codex/session_index.jsonl` 与 `~/.codex/sessions`；
- 不修改 `/Applications/ChatGPT.app`、`/Applications/Codex.app`、`app.asar` 或对话数据；
- AssetBrowser 与调试服务只绑定 loopback；不上传对话、额度、标签或素材；
- CDP 只使用回环地址 `127.0.0.1:9231`；
- 安装内容完全位于当前用户目录，可通过卸载脚本完整移除。

这一安全边界也意味着：直接从 Dock 打开原始 ChatGPT/Codex 时不会加载增强 UI。公开的 Codex++/patcher 类方案通过修改 `app.asar`、加载 preload 并在 macOS 重签应用实现“普通启动即生效”，但会扩大升级、签名与恢复风险；本项目不在未明确授权时采用该路径。

## 更新与排查

更新时重新运行安装命令即可。安装器会原子替换旧版本，并迁移早期 `com.yubowen.codex-conversation-preview` LaunchAgent。

日志位置：

```text
~/Library/Logs/CodexSidebarEnhancer/injector.log
~/Library/Logs/CodexSidebarEnhancer/injector.error.log
```

如果增强没有出现：

1. 退出 Codex/ChatGPT；
2. 打开 `~/Applications/Codex Sidebar Enhancer.app`；
3. 等待约 5 秒；
4. 仍未出现时查看上述日志。

## 本地开发

```bash
git clone https://github.com/yubowen123/codex-sidebar-enhancer.git
cd codex-sidebar-enhancer
npm install
npm test
npm run inject
```

实时界面验收脚本需要已用 `9231` 端口启动的 Codex：

```bash
node scripts/verify-shortcut-grid.mjs
node scripts/verify-section-tabs.mjs
node scripts/verify-folder-switcher.mjs
node scripts/verify-card-view.mjs
node scripts/verify-reload-persistence.mjs
node scripts/verify-home-projects.mjs
node scripts/verify-skill-manager.mjs
```

右侧工具轨另有不启动 Codex、不开放端口的离线宿主测试：

```bash
NODE_PATH=/path/to/node_modules node scripts/verify-native-right-rail.mjs
```

## License

[MIT](./LICENSE)
