// Claude Haiku intent parsing via tool use.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
export const NEEDS_REVIEW = 'Inbox: Needs Review';

export function buildTools(categoryLabels, accountNames) {
  const categoryEnum = [...categoryLabels, NEEDS_REVIEW];
  return [
    {
      name: 'log_expense',
      description:
        'Record money spent. Use NEEDS_REVIEW category if the envelope is genuinely ambiguous rather than guessing.',
      input_schema: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Amount spent, positive, in pesos' },
          payee: { type: 'string', description: 'Store / person / payee' },
          category: { type: 'string', enum: categoryEnum },
          account: { type: 'string', enum: accountNames, description: 'Omit if not mentioned' },
          date: { type: 'string', description: 'YYYY-MM-DD, only if a date is mentioned' },
          note: { type: 'string' },
        },
        required: ['amount', 'payee', 'category'],
      },
    },
    {
      name: 'get_balance',
      description: 'Get the remaining balance of one envelope this month.',
      input_schema: {
        type: 'object',
        properties: { category: { type: 'string', enum: categoryLabels } },
        required: ['category'],
      },
    },
    {
      name: 'get_spending',
      description: 'Get how much was spent in an envelope this month.',
      input_schema: {
        type: 'object',
        properties: { category: { type: 'string', enum: categoryLabels } },
        required: ['category'],
      },
    },
  ];
}

export async function parseMessage({ text, history = [], categoryLabels, accountNames, today, executeTool }) {
  const tools = buildTools(categoryLabels, accountNames);
  const system = [
    `You are a household envelope-budgeting assistant for a family in the Philippines. Today is ${today}.`,
    `Currency is PHP (₱); users may write plain numbers like "1,500" or "1.5k".`,
    `When the user reports spending, call log_expense. Pick the envelope (category) that best matches.`,
    `If no envelope clearly fits, use the "${NEEDS_REVIEW}" category instead of guessing.`,
    `If the message is not about budgeting, reply briefly and steer back to budgeting.`,
    `Keep all text replies to one or two short sentences.`,
  ].join('\n');

  const messages = [...history, { role: 'user', content: text }];
  let reply = null;

  for (let turn = 0; turn < 3; turn++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      system,
      tools,
      messages,
    });

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    const textBlocks = resp.content.filter((b) => b.type === 'text');

    if (toolUses.length === 0) {
      messages.push({ role: 'assistant', content: resp.content });
      reply = textBlocks.map((b) => b.text).join('\n').trim();
      break;
    }

    messages.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const tu of toolUses) {
      const result = await executeTool(tu.name, tu.input);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    messages.push({ role: 'user', content: results });

    if (resp.stop_reason !== 'tool_use') {
      reply = textBlocks.map((b) => b.text).join('\n').trim();
      break;
    }
  }
  return { reply, messages };
}
