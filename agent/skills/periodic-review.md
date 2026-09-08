# 阶段/年度回顾文案技能

用户主动查看“回顾”、 “复盘”、阶段总结、月度总结或年度总结时使用。只负责把本地程序算好的事实转成简短文案，不重新计算或猜测任何数值。

## 输入与事实边界

- 输入必须是本地聚合好的 `facts` 数组；每项至少包含 `id`、`value`、`label` 和 `valueType`。
- 只能使用输入 facts 中已经存在的事实，不能凭空补充对比、趋势、金额、次数、日期或百分比。
- 数据覆盖不足 3 个月时，不描述“趋势”“连续变化”或“越来越”，只陈述当前范围内的事实。
- `transfer` 不属于收入或支出，不能在回顾里重复统计。

## 文案规则

- 不给建议、不评判、不制造消费羞耻，不出现“你应该”“建议”“要不要控制一下”“又乱花钱了”等措辞。
- 不使用表情符号；每条 highlight 最多一个感叹号，全篇最多两个。
- `headline` 不超过 24 个汉字，不能直接写具体金额、日期、次数或百分比。
- 最终数字的千分位、货币符号、日期和数量格式化由前端渲染；模型只输出占位符和文案。
- 允许有一点点“打工人”式自嘲，但信息必须比梗更清楚。

## 输出契约

只输出以下 JSON，不要输出 Markdown、解释或其他字段。当前 Agent 会在服务端补充 `kind: "periodic_review"`，所以模型本身可以省略 `kind`：

```json
{
  "headline": "一句话总结，不超过24个汉字，不能包含具体数字",
  "highlights": [
    {
      "fact_id": "对应 facts 里的 id",
      "line": "一句话叙述这个事实，用 {{fact_id}} 占位符引用数值"
    }
  ],
  "closing": "结尾一句话，中性、不给建议、不评判，呼应 headline 但不重复"
}
```

规则：

- `highlights` 最多 5 条，按真实性和“有意思程度”排序。
- 每个 `fact_id` 必须存在于输入 facts；`line` 中出现的每一个 `{{fact_id}}` 也必须存在于输入 facts。
- 同一条 `line` 可以引用多个 facts，例如同时使用 `{{top_category}}` 和 `{{top_category_amount}}`。
- 不要在占位符之外书写金额、日期、百分比或其他需要事实支撑的数字。

## 调用时的 facts 示例

```json
[
  { "id": "total_months", "value": 6, "label": "记账月数", "valueType": "count" },
  { "id": "total_income", "value": 48000, "label": "累计收入", "valueType": "currency" },
  { "id": "total_expense", "value": 31200, "label": "累计支出", "valueType": "currency" },
  { "id": "top_category", "value": "餐饮", "label": "支出最多的分类", "valueType": "text" },
  { "id": "top_category_amount", "value": 9800, "label": "该分类累计金额", "valueType": "currency" },
  { "id": "biggest_single_expense", "value": 1200, "label": "单笔最大支出金额", "valueType": "currency" },
  { "id": "biggest_single_expense_note", "value": "换手机", "label": "单笔最大支出备注", "valueType": "text" },
  { "id": "best_saving_month", "value": "3月", "label": "结余最高的月份", "valueType": "month" },
  { "id": "best_saving_month_amount", "value": 4200, "label": "该月结余金额", "valueType": "currency" },
  { "id": "streak_positive_months", "value": 5, "label": "连续结余为正的月数", "valueType": "count" }
]
```

期望输出示例：

```json
{
  "headline": "这段时间，日子过得挺明白",
  "highlights": [
    { "fact_id": "total_income", "line": "累计收入 {{total_income}} 元" },
    { "fact_id": "top_category", "line": "钱大多花在了{{top_category}}上，累计 {{top_category_amount}} 元" },
    { "fact_id": "biggest_single_expense", "line": "最大方的一笔是{{biggest_single_expense_note}}，一下花了 {{biggest_single_expense}} 元" },
    { "fact_id": "best_saving_month", "line": "{{best_saving_month}}是结余最高的月份，攒下了 {{best_saving_month_amount}} 元" },
    { "fact_id": "streak_positive_months", "line": "连续 {{streak_positive_months}} 个月结余为正" }
  ],
  "closing": "数字都在这儿，怎么花是你的自由"
}
```
