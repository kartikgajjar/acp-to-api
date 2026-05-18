const BASE_URL   = process.env.ACP_URL     ?? 'http://localhost:3456';
const AUTH_TOKEN = process.env.ACP_API_KEY ?? 'sk-local-dev-key';
const MODEL      = process.env.ACP_MODEL   ?? 'auto';

const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
  method:  'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
  body:    JSON.stringify({
    model:    MODEL,
    messages: [{ role: 'user', content: 'Hello! Who are you?' }],
  }),
});

if (!res.ok) {
  const err = await res.json().catch(() => ({}));
  console.error(`Error ${res.status}:`, err?.error?.message ?? res.statusText);
  process.exit(1);
}

const data = await res.json();
console.log(data.choices[0].message.content);
