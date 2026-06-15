# Repository Guidelines

## Project Structure & Module Organization

This Node.js ESM project exposes ACP agent backends through REST-compatible APIs. Main entrypoints live at the repository root:

- `acp-server-ollama.js` exposes the Ollama REST surface, defaulting to the `kiro` ACP backend.
- `acp-server-openai.js` exposes the OpenAI REST surface, defaulting to the `codex` ACP backend.
- `acp-server-codex.js` is a deprecated compatibility shim for the OpenAI server.
- `test/` contains Node test-runner suites plus mock ACP subprocesses.

Runtime output belongs in `logs/` and cache data belongs in `local_cache/`; both are ignored. Keep secrets in `.env`, using `.env.example` as the template.

## Build, Test, and Development Commands

- `npm install` installs dependencies from `package-lock.json`.
- `npm start` runs `acp-server-ollama.js` on the Ollama-compatible interface.
- `npm run openai` runs `acp-server-openai.js` on the OpenAI-compatible interface.
- `npm run start:dev` or `npm run openai:dev` enables `DEBUG=1` logging.
- `npm test` runs `node --test test/*.test.js` against mock ACP backends.
- `npm run format` applies Biome formatting.
- `npm run check` applies Biome formatting, linting, and import organization.

Use `--backend=kiro` or `--backend=codex` to override defaults, for example `node acp-server-openai.js --backend=kiro`.

## Coding Style & Naming Conventions

Use JavaScript ESM with root-level server files named by REST surface, not backend. Biome enforces tab indentation, single quotes, recommended lint rules, and organized imports. Prefer descriptive constants and helpers for protocol behavior, and keep duplicated backend configuration blocks byte-identical where tests require it.

## Testing Guidelines

Tests use Node’s built-in test runner. Add or update `*.test.js` files under `test/` for behavior changes. Prefer mock ACP subprocess coverage over tests requiring real Kiro, Codex, or API credentials. Run `npm test` before submitting changes, and run `npm run check` for style-sensitive edits.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, for example `Decouple ACP backend from REST interface`. Keep the subject specific and under roughly 72 characters when practical.

Pull requests should describe affected interface/backend behavior, list test results, and call out configuration or security implications. Include examples for new environment variables, ports, auth behavior, or command-line flags.

## Security & Configuration Tips

Never commit `.env`, logs, cache files, or credentials. `OPENAI_API_KEY` is required only when using the `codex` backend. Be careful with remote binding: the Codex backend has a safety gate for `HOST=0.0.0.0` unless auth or an explicit insecure override is configured.
