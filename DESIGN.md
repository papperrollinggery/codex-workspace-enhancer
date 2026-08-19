---
name: Codex Workspace Enhancer
description: A spatial creative sidecar for images, canvas context, tasks, and changes inside Codex.
colors:
  primary: "#0A84FF"
  primary-light: "#006BD6"
  action: "#006BD6"
  primary-soft: "#102A47"
  canvas-dark: "#0D1016"
  surface-dark: "#171B24"
  surface-raised-dark: "#202631"
  ink-dark: "#F4F7FB"
  muted-dark: "#AEB6C3"
  canvas-light: "#F5F7FA"
  surface-light: "#FFFFFF"
  ink-light: "#18202B"
  muted-light: "#596579"
  positive: "#3BCB7F"
  warning: "#F2B84B"
  danger: "#FF6B72"
typography:
  title:
    fontFamily: "Avenir Next, PingFang SC, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Avenir Next, PingFang SC, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "13px"
    fontWeight: 450
    lineHeight: 1.5
  label:
    fontFamily: "Avenir Next, PingFang SC, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.35
  mono:
    fontFamily: "SFMono-Regular, Cascadia Mono, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 450
    lineHeight: 1.45
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-dark}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 12px"
  asset-tile:
    backgroundColor: "{colors.surface-raised-dark}"
    textColor: "{colors.ink-dark}"
    rounded: "{rounded.md}"
    padding: "0"
  context-strip:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.ink-dark}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
---

# Design System: Codex Workspace Enhancer

## Overview

**Creative North Star: "The Working Contact Sheet"**

界面是一张紧贴 Codex 对话的工作接触印相表。用户在偏暗的创作环境里快速扫过参考图、画布关系、任务和变更，因此真实素材必须比容器更醒目，操作状态必须比装饰更清楚。右侧 Dock 不是缩小的 IDE，也不是指标仪表盘，而是把视觉工作正在发生的部分浓缩成可继续操作的侧车。

默认采用高密度、低噪声、结构化的产品界面。层次主要来自色调、间距和内容比例，阴影只在浮层、拖拽或焦点状态出现。浅色模式保持同一信息结构，不以暖白或纸张隐喻改变产品性格。

这是本机创意生产 cockpit，不是通用文件管理器。它承担三个连续工作：**Collect** 用项目上下文收集与复核图片、视频、音频、生成结果和参考；**Compose** 在空间画布上比较关系、记录意图，并把经过选择的素材交给当前 Codex 对话；**Deliver safely** 保持 `FinalDelivery`、最终输出、生成记录、参考库和当日练习区域不受自动整理或破坏性操作影响。

**Key Characteristics:**

- 图片和画布节点占据主要面积，计数与路径降为辅助信息。
- 只有三种一级模式：工作台、资产、画布；任务、变更和工具在工作台内按上下文组织。
- 蓝色只表示当前选择、主要动作和明确的信息状态，不作背景装饰。
- 420px 到 720px 的 Dock 使用紧凑行、缩略图条和可折叠细节，不使用同尺寸卡片铺满。
- 所有过渡在 150 到 220ms 内完成，并尊重 Reduced Motion。
- 本地状态明确区分 draft、saving、saved、conflicted、missing source 与 failed，未发送内容永远不显示为已发送。

### Research lineage

设计吸收 Apple HIG 的 sidebar、materials 与 motion 规则，GitHub Primer 的 product navigation 与 split layout，VS Code 的 Activity Bar、Secondary Sidebar、View 和 Panel 分工，以及 Linear、Figma、Raycast 的高密度产品界面经验。MCP Apps 的 inline、fullscreen、PiP 协商和 Codex 社区的 OOPIF/CDP 实现只定义能力边界，不作为复制视觉外观的理由。

- [Apple HIG: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [GitHub Primer Product UI](https://primer.style/product/)
- [VS Code UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/overview)
- [Google Stitch DESIGN.md](https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-design-md/)
- [Official DESIGN.md index](https://github.com/VoltAgent/official-design-md)
- [Linear UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui)
- [Raycast visual refresh](https://www.raycast.com/blog/a-fresh-look-and-feel)
- [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
- [Explodex Codex architecture](https://github.com/dan-dr/explodex/blob/main/docs/codex-architecture.md)
- [Taskboard for Codex](https://github.com/izscc/taskboard)

## Colors

冷中性色形成剪辑台般的工作背景，蓝色负责导航与操作，素材图片提供界面中的大部分色彩。

### Primary

- **Focus Blue**：当前模式、焦点环和选中画布节点。单屏面积不超过 10%。
- **Focus Blue Soft**：选中背景与轻量信息提示，不承担正文背景。
- **Action Blue Deep**：承载白字主要按钮，保证至少 4.5:1 对比度；Focus Blue 继续用于轮廓、焦点和选中状态。

### Secondary

- **Ready Green**：授权有效、保存完成和连接正常，同时必须配合文字或图标。
- **Attention Amber**：保存中、部分结果和需要注意的非阻塞状态。
- **Stop Red**：错误与危险动作，不用于普通关闭按钮。

### Neutral

- **Editing Canvas**：Dock 主背景，接近黑但保留蓝灰色相。
- **Working Surface**：头部、工具条与主要内容面。
- **Raised Surface**：缩略图、选中行和可交互局部，禁止层层嵌套。
- **Primary Ink / Muted Ink**：正文与次级说明。正文必须达到 WCAG AA。

### Named Rules

**The Material Carries Color Rule.** 界面的饱和色主要来自用户图片；产品色不得和素材争夺注意力。

**The Ten Percent Blue Rule.** Focus Blue 在任何一个视图中最多覆盖约 10% 的可见面积。

## Typography

**Display Font:** Avenir Next / PingFang SC / SF Pro Text
**Body Font:** Avenir Next / PingFang SC / SF Pro Text
**Label/Mono Font:** SFMono-Regular / Cascadia Mono / Menlo

**Character:** 一套系统字体覆盖标题、正文和控件，依靠字重与密度建立层次。路径、分支和 revision 使用等宽字体，以便快速扫描和区分内容类型。

### Hierarchy

- **Title** (650, 15px, 1.3)：项目名、当前模式和区块标题。
- **Heading** (650, 16px, 1.3)：只用于模式主标题和授权/空状态标题。
- **Body** (450, 13px, 1.5)：说明、任务与变更内容，长段落限制在 70ch 内。
- **Label** (600, 12px, 1.35)：操作和短标签；Caption 使用 11px。不得使用全大写句子。
- **Mono** (450, 11px, 1.45)：路径、branch、revision 与技术标识。

### Named Rules

**The One Family Rule.** 产品界面只使用系统 sans 与一个等宽辅助栈，禁止引入展示字体。

**The Path Is Data Rule.** 路径和哈希用等宽字展示，但默认只显示末级与上下文，完整值通过 tooltip 或展开读取。

## Elevation

系统以色调分层为主，静止内容保持扁平。浮动 Dock 本身可使用一道窄阴影与宿主内容分离；内部列表、缩略图和区块不同时叠加边框与大模糊阴影。

### Shadow Vocabulary

- **Dock Separation** (`box-shadow: -8px 0 18px rgba(0,0,0,.18)`): 只用于整个右侧 Dock 与 Codex 主内容的边界。
- **Drag Lift** (`box-shadow: 0 6px 8px rgba(0,0,0,.22)`): 只在拖拽资产或画布节点时出现。
- **Focus Halo** (`box-shadow: 0 0 0 3px rgba(91,140,255,.24)`): 键盘焦点和选中状态。

### Named Rules

**The Flat Until Active Rule.** 静止表面没有装饰性投影，只有状态变化才产生抬升。

## Components

### Buttons

- **Shape:** 紧凑柔和的 10px 圆角，高度至少 40px。
- **Primary:** Focus Blue 背景、白色文字，水平内边距 14px，只用于一个当前主要动作。
- **Hover / Focus:** 150ms 色调变化；键盘焦点显示 3px Focus Halo。
- **Ghost:** 透明背景与次级文字，hover 使用单层 Raised Surface。

### Chips

- **Style:** 用于 branch、授权和 revision，6px 圆角或全圆状态点组合；不把普通正文塞进 pill。
- **State:** 颜色与文字同时表达状态。选中项使用 Focus Blue Soft，不使用渐变。

### Cards / Containers

- **Corner Style:** 主要区块 14px，局部缩略图与行项目 10px。
- **Background:** Working Surface 与 Raised Surface 两层足够。
- **Shadow Strategy:** 默认无阴影，遵循 Flat Until Active Rule。
- **Border:** 只在需要分隔点击区域时使用 1px 低对比边界。
- **Internal Padding:** 12px 或 16px，不嵌套同样的卡片容器。

### Inputs / Fields

- **Style:** 40px 高、10px 圆角、Working Surface 背景与清晰 placeholder。
- **Focus:** Focus Blue 边界与 3px halo。
- **Error / Disabled:** 错误提供文字；禁用降低对比但保持标签可读。

### Navigation

一级导航限制为工作台、资产、画布三个清晰模式。选中状态使用 Focus Blue Soft 与图标/文字组合。任务、变更和工具属于工作台内容，不再与核心视觉模式抢占同一横向标签栏。窄于 480px 时保留三项，不换成不可读的图标谜语。

Codex host tool rail 是 48px 的右缘启动器，只承载工作面板、旧资产库/空间画布和原生 Plugin/Skill 入口。它属于 chrome，不是内容。每个图标都有文字 tooltip、至少 40px 目标、pressed 状态和 roving tabindex。缺少稳定宿主锚点时，只撤销依赖该锚点的增强节点。

### Asset Contact Sheet

资产以真实 16:10 缩略图、短文件名和文件夹上下文构成自适应网格。hover 才强化次级操作，加载使用骨架，不使用中央 spinner。已在画布中的素材用清晰的选中标记表示。加入画布只写项目相对引用，不复制、移动、重命名或删除源图。

### Compact Canvas Map

紧凑画布展示真实节点比例、图片预览、便签色和当前选择。Dock 中用于定位与快速选择；“填写打开画布请求”只向 Codex composer 预填请求并明确不发送，用户发送后由宿主打开原生 Visual Workspace。Dock 与 fullscreen 共享 board revision。

完整空间画布遵守 `screen = world × scale + translation`。拖拽空白区域平移；触控板或滚轮平移；Command/Control + 滚轮围绕指针缩放；Shift 或 Command 点击追加选择；Shift 拖拽框选；Delete/Backspace 只移除画布引用；`0` 或 Fit 框选全部节点；便签在视口中心创建；附加到对话最多传递八个选中图片路径且不自动发送。每次保存携带 `baseRev`，冲突必须显示最新本地事实，禁止静默覆盖。

### Host and Material Boundary

原生 MCP App 继续负责项目授权、read-only asset、board revision 与对话上下文。Dock 通过 loopback-only CDP 接入增强窗口，应用包保持未修改。Glass 只允许出现在 host rail、顶栏、toolbar、popover、toast 等 chrome；媒体、asset tile、canvas node、note editor 和 dense list 必须使用不透明内容面。禁止 glass 嵌套 glass。

## Do's and Don'ts

### Do:

- **Do** 让用户进入面板后立刻看到项目名、实际图片和画布关系。
- **Do** 使用 8px 基础节奏、40px 交互目标和清楚的键盘焦点。
- **Do** 把任务、变更和工具设计成可扫读行与上下文区块，而不是指标卡。
- **Do** 在 420px、560px 和 720px 三个宽度验证重排、溢出和长中文标题。
- **Do** 保持请求模式、实际模式、授权来源和未发送状态可回读。
- **Do** 为 actionable component 覆盖 rest、hover、focus-visible、pressed、selected、disabled、busy、success 与 error 状态。
- **Do** 让 light/dark 保持相同层级，并验证 Reduced Motion、Reduced Transparency 与 Increased Contrast。
- **Do** 对损坏配置、丢失图片、revision 冲突、symlink 越界和受保护创意路径失败关闭且保留原数据。
- **Do** 把恶意文件名严格当作文本渲染，并以 CSP 阻止 inline event execution；固定图标是唯一允许的静态 SVG markup。
- **Do** 验证画布 reload persistence：切换 grid/canvas、重载 renderer 或重开 panel 后，project、revision 与 selection context 不丢失。
- **Do** 让 installation、runtime update 与 uninstall 只修改 owned user-library paths，并在跨组件失败时作为一个事务回滚。

### Don't:

- **Don't** 复刻“当前工程占位版面板”：六个等权横向标签、重复的状态卡片、大片空白和只显示数字却看不到图片或画布。
- **Don't** 使用“通用 SaaS 指标仪表盘”：大数字、小标签、同尺寸卡片网格和装饰性在线徽章。
- **Don't** 使用紫蓝渐变、霓虹发光、默认玻璃拟态和悬浮阴影堆叠的“AI 工具”外观。
- **Don't** 把整个 IDE 缩进 420px 侧栏，或重复 Codex 已有的导航与提交按钮。
- **Don't** 使用大于 1px 的彩色侧边条、渐变文字、重复线性渐变背景或 32px 以上的容器圆角。
- **Don't** 隐藏核心能力、自动发送输入、把 PiP/fullscreen 请求说成宿主已经授予，或维护第二套画布状态。
- **Don't** 修改签名应用包、默认 patch `app.asar`、把删除画布引用说成删除源文件，或让自动化处理 `FinalDelivery` 等受保护区域。
