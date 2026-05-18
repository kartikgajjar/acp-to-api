import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.ACP_URL     ?? 'http://localhost:3456/v1',
  apiKey:  process.env.ACP_API_KEY ?? 'sk-local-dev-key',
});

const completion = await client.chat.completions.create({
  model:    process.env.ACP_MODEL ?? 'auto',
  messages: [{ role: 'user', content: 'Hello! Who are you?' }],
});

console.log(completion.choices[0].message.content);
