import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_TOOL_DEFINITIONS,
  executeAgentTool,
  extractTransactionCandidates,
  resolveCategoryCandidates,
} from './tools.mjs';

const SKILL_FILES = ['ledger-entry.md', 'ledger-query.md', 'draft-validation.md'];

function isTransactionRequest(text, candidates) {
  return candidates.length > 0 && /记|花|买|付|消费|支出|收入|工资|薪资|到账|奖金|报销|退款|退回|返款|转账|充值|会员|GPT|OpenAI|外卖|早餐|午饭|午餐|晚餐|地铁|公交|打车|房租|水电|燃气|购物/.test(text);
}

function toolChoiceForRequest(transactionRequest, needsValidationTool) {
  return transactionRequest && needsValidationTool
    ? { type: 'function', function: { name: 'validate_transaction_drafts' } }
    : 'auto';
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function assistantContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((item) => item?.text || item?.content?.text || '').join('').trim();
  return '';
}

export async function createLedgerAgent({ root, complete }) {
  const [agentGuide, ...skills] = await Promise.all([
    readFile(join(root, 'agent', 'AGENT.md'), 'utf8'),
    ...SKILL_FILES.map((file) => readFile(join(root, 'agent', 'skills', file), 'utf8')),
  ]);
  const skillText = [agentGuide, ...skills].join('\n\n---\n\n');

  return {
    async run({ config, messages = [], ledgerContext = {} }) {
      const history = messages
        .filter((message) => message && ['user', 'assistant'].includes(message.role))
        .slice(-12)
        .map((message) => ({ role: message.role, content: String(message.content || '').slice(0, 4000) }));
      const userText = String(history.at(-1)?.content || '');
      const candidates = extractTransactionCandidates(userText, {
        today: ledgerContext.today,
        availableCategories: ledgerContext.availableCategories || [],
        availableAccounts: ledgerContext.availableAccounts || [],
      });
      const categoryHints = resolveCategoryCandidates(candidates, {
        availableCategories: ledgerContext.availableCategories || [],
      });
      const transactionRequest = isTransactionRequest(userText, candidates);
      const needsValidationTool = transactionRequest && candidates.length > 1;
      const system = `${skillText}

## 当前任务

你必须先读取脚本预处理结果，再处理用户原话。预处理结果是防漏金额和防日期误判的事实层；模型负责理解语义、选择分类和组织最终 JSON。

脚本预处理候选（只读观察结果）：
${jsonText(candidates)}

分类候选（只读观察结果）：
${jsonText(categoryHints)}

账本上下文：
${jsonText(ledgerContext)}

## 最终输出契约

始终只返回一个合法 JSON 对象，不要 Markdown，不要输出思考过程。只能使用：
{"kind":"transaction_draft","reply":"简短说明","drafts":[{"type":"expense|income|transfer","amountYuan":数字,"category":"可用分类名称","account":"可用账户名称","toAccount":"转入账户名称或空字符串","occurredAt":"ISO 时间","note":"备注","tags":["标签"]}]}
或 {"kind":"answer","reply":"基于账本上下文的回答"}，或 {"kind":"clarify","reply":"只追问一个最关键的缺失信息"}。

${needsValidationTool ? '这是复杂记账任务：必须为预处理候选中的每一个金额生成一笔草稿，并先调用 validate_transaction_drafts。校验失败时根据工具观察结果修正一次，再返回最终 JSON。' : transactionRequest ? '这是单笔记账任务：根据预处理候选生成一笔结构化草稿并返回最终 JSON。' : '这是查询或普通对话任务；需要账本数据时调用 query_ledger，然后返回最终 JSON。'}
不要把候选金额合并，不要只返回最后一笔，不要把退款/退回写成支出，不要把工资卡文字当成工资收入。`;
      const conversation = [{ role: 'system', content: system }, ...history];
      const baseOptions = {
        maxTokens: 3200,
        thinking: { type: 'disabled' },
        ...(transactionRequest && !needsValidationTool ? {} : { tools: AGENT_TOOL_DEFINITIONS, toolChoice: toolChoiceForRequest(transactionRequest, needsValidationTool) }),
      };
      let completion;
      try {
        completion = await complete(config, conversation, baseOptions);
      } catch (error) {
        if (!/tool|function|unsupported|not support|tool_choice/i.test(error instanceof Error ? error.message : '')) throw error;
        completion = await complete(config, conversation, {
          maxTokens: 3200,
          thinking: { type: 'disabled' },
        });
      }

      for (let round = 0; round < 2; round += 1) {
        const message = completion?.message || {};
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (!toolCalls.length) {
          const reply = assistantContent(message);
          if (!reply) throw new Error('模型没有返回可读取的最终内容。');
          return { reply, candidateCount: candidates.length, toolRounds: round };
        }
        conversation.push(message);
        for (const toolCall of toolCalls) {
          const name = toolCall?.function?.name || '';
          let args = {};
          try {
            args = JSON.parse(toolCall?.function?.arguments || '{}');
          } catch {
            args = { invalidArguments: true };
          }
          let observation;
          try {
            observation = executeAgentTool(name, args, { userText, candidates, ledgerContext });
          } catch (error) {
            observation = { valid: false, errors: [error instanceof Error ? error.message : 'Agent tool 执行失败。'] };
          }
          conversation.push({
            role: 'tool',
            tool_call_id: toolCall.id || `tool-${round}`,
            name,
            content: jsonText(observation),
          });
        }
        completion = await complete(config, conversation, {
          maxTokens: 3200,
          thinking: { type: 'disabled' },
        });
      }
      throw new Error('Agent 工具校验轮次超限，请缩短输入后重试。');
    },
  };
}
