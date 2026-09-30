# Design QA

## Comparison Target

- Source visual truth: `D:\ML\Bill\.design-references\selected-option-1.png`
- Normalized source: `D:\ML\Bill\.design-references\selected-option-1-1024.png`
- Implementation screenshot: `D:\ML\Bill\.design-references\implementation-home-final.png`
- Full-view comparison: `D:\ML\Bill\.design-references\qa-comparison-final.png`
- Focused comparison: `D:\ML\Bill\.design-references\qa-comparison-focus-final.png`
- State: 首页，2026 年 8 月，演示数据，白天主题
- URL state: `?demo=1&qa=1&final=1#home`

## Viewport And Normalization

- Original source pixels: `1536 × 1024`。
- Source normalization: 高质量双三次下采样为 `1024 × 683`。
- Implementation CSS viewport: `1024 × 683`，`devicePixelRatio = 1`。
- Implementation screenshot pixels: `1024 × 683`。
- Fidelity capture uses a `1536 × 1024` desktop layout scaled uniformly to the normalized viewport。普通产品界面不启用该对比状态。

## Findings

没有仍需修复的 P0、P1 或 P2 差异。

- [P3] 账户服务图标采用统一图标库
  - Location: 首页账户概览。
  - Evidence: 视觉稿使用近似支付宝、微信的品牌色图标；实现使用 Phosphor Regular 的账户类型图标。
  - Impact: 不影响账户识别、交互或层级，并避免把第三方品牌标识固化进通用账户组件。
  - Follow-up: 后续若确认品牌资产使用规范，可为特定账户提供可选品牌图标包。

- [P3] 趋势线形状与视觉稿不同
  - Location: 首页收支趋势。
  - Evidence: 视觉稿使用平滑的示例累计曲线；实现根据真实交易日期绘制，因此工资到账日会出现明显跳变。
  - Impact: 实现更准确地表达实际现金流，属于数据驱动差异。
  - Follow-up: 可在后续加入逐日点位提示，但不应为了贴图而平滑真实数据。

## Required Fidelity Surfaces

- Fonts and typography: 使用统一系统无衬线字体，金额采用 tabular numerals；页面标题、模块标题、标签和金额层级与视觉稿一致。中文回退字体、权重、行高和截断均正常。
- Spacing and layout rhythm: 侧栏、月度摘要、流水主栏和右侧三模块比例与视觉稿一致；面板使用 12px 圆角、1px 边框和无静态宽阴影。桌面、1024px 和 375px 宽度均无水平溢出。
- Colors and visual tokens: 白底、苔藓绿、收入绿、支出红和细分隔线与目标一致。正文色对比高于 4.5:1；修正后的支出红对比约 4.74:1，辅助文字约 4.76:1。
- Image quality and asset fidelity: 目标没有照片、插画或商品图。品牌使用项目现有 favicon；所有界面图标来自本地 Phosphor Regular 字体库，没有 emoji、自绘 SVG、占位图或 CSS 插画。图表由真实数据在 canvas 中绘制。
- Copy and content: 首页保留本月收入、支出、结余、最近流水、账户、趋势和预算；未出现真实时薪、工作成本、自由基金、安全垫或情景模拟。
- Icons: 导航、分类、账户、编辑、删除和表单操作使用同一线性图标家族，尺寸与对齐一致。
- States and interactions: 已验证新增流水、保存成功、流水搜索、周报切换、工资到手估算、对话框关闭、桌面侧栏和移动底部导航。代码包含加载、空、读取错误、保存错误和危险操作确认状态。
- Accessibility: 语义按钮和表单标签可被浏览器识别；键盘焦点清楚；移动端主要操作满足 44px 触控目标；支持 `prefers-reduced-motion`。

## Comparison History

### Iteration 1

- Earlier [P2] responsive hierarchy: 1024px 视图过早折叠为纯图标侧栏，主栏和右栏比例偏离桌面稿。
- Fix: 1024px 使用 180px 完整侧栏，并重新分配流水与右侧摘要列宽；900px 以下才折叠侧栏。
- Post-fix evidence: `D:\ML\Bill\.design-references\implementation-home-1024-v3.png`。

- Earlier [P2] above-the-fold density: 首页多显示一条流水，账户面板纵向过高，预算底部超出目标画布。
- Fix: 首页最近流水保持三组九条，账户行使用紧凑桌面密度，保留完整预算信息。
- Post-fix evidence: `D:\ML\Bill\.design-references\implementation-home-qa-v2.png`。

- Earlier [P2] contrast: 原支出红与白底约 3.99:1，辅助文字约 4.15:1。
- Fix: 支出红调整为 `#cf3f3b`，辅助文字调整为 `#68766f`，分别约 4.74:1 和 4.76:1。
- Post-fix evidence: `D:\ML\Bill\.design-references\implementation-home-final.png`。

## Browser Verification

- 新增测试支出 `¥19` 后，本月支出从 `¥3,286` 更新为 `¥3,305`，新备注可在流水中搜索到。
- 流水关键词搜索返回 1 条匹配记录。
- 每周报表、支出分类和收支图正常渲染。
- 工资估算样例：税前 `¥10,000`，个人社保 `¥800`，公积金 `¥1,200`，个税 `¥300`，预计到手 `¥7,700`。
- 移动端 `375 × 812` 无水平溢出，底部导航和记一笔入口可用。
- 浏览器控制台错误和警告：0。

## Implementation Checklist

- [x] 视觉结构与选中方案一致。
- [x] 核心记账闭环可用。
- [x] 周报、月报、账户、分类和工资估算可用。
- [x] 桌面与移动端响应式通过。
- [x] 对比度、焦点和减少动态效果通过。
- [x] 交接文档与 Figma 路线图更新。

## Follow-up Polish

- 根据品牌授权决定是否增加第三方支付平台品牌图标。
- 后续给真实趋势点增加悬停明细，不改变当前简洁结构。

## Agent V1 Addendum

### Comparison Evidence

- Existing Option 1 baseline: `D:\ML\Bill\.design-references\implementation-home-final.png`
- Agent desktop, `1024 × 683`: `D:\ML\Bill\.design-references\agent-desktop-1024.png`
- Full shared-system comparison: `D:\ML\Bill\.design-references\agent-qa-comparison-full.png`
- Focused shared-chrome comparison: `D:\ML\Bill\.design-references\agent-qa-comparison-focus.png`
- Filled draft state: `D:\ML\Bill\.design-references\agent-desktop-flow.png`
- Mobile, `375 × 812`: `D:\ML\Bill\.design-references\agent-mobile.png`

Agent 是新增页面，没有同状态的独立视觉稿；因此本轮不重新发明视觉方向，而是把已经通过的方案 1 首页作为共享设计系统基准，对比侧栏、页面标题、面板、边框、圆角、按钮、字体、图标和响应式节奏。完整对比与聚焦对比均未发现仍需修复的 P0、P1 或 P2 差异。

### Agent Interaction Verification

- 本地基础问答：“本月花了多少？”返回 `15` 笔支出、合计 `¥3,286`。
- 自然语言记账：“今天午餐 28 元，微信支付”生成 `¥28 / 餐饮 / 微信` 的可编辑支出草稿。
- 点击确认后显示“已写入账本”，流水页出现来源为 Agent 的 `¥28` 午餐支出。
- “12:30 午饭”不会把时间误识别为金额；页面追问金额且不生成待确认草稿。
- “支付宝转账 100 元到微信”生成 `转账 / ¥100 / 支付宝 → 微信` 草稿，放弃后不写入流水。
- 模型设置页通过本地模拟 `/v1/chat/completions` 完成保存、连接测试和远程回答；未勾选记住时 API Key 不写入本地存储。
- `1280 × 800` 桌面和 `375 × 812` 移动端均无水平溢出；移动端右侧辅助栏隐藏，输入框、模型设置入口和底部助手导航可用。
- 浏览器运行时异常：0；控制台错误：0。

### Agent Checklist

- [x] 与现有视觉系统一致，没有引入第二套 AI 风格。
- [x] 本地基础模式无需模型配置即可使用。
- [x] 外部模型配置包含地址、模型名、可选 Key 和连接测试。
- [x] 草稿可编辑，确认前不写入正式流水。
- [x] 桌面双栏、移动单栏和数据边界文案通过。
- [x] README、产品范围、设计规范、交接文档与 Figma 路线图已更新。

final result: passed
