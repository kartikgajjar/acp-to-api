/**
 * DEPRECATED entrypoint — kept for backward compatibility.
 * The OpenAI REST surface now lives in acp-server-openai.js (the file name
 * reflects the interface, not the backend). This shim simply forwards to it.
 * It will be removed in a future release. Update your scripts to call
 * acp-server-openai.js (or `npm run openai`).
 */
console.warn('[deprecated] acp-server-codex.js → use acp-server-openai.js (or `npm run openai`)');
import './acp-server-openai.js';
