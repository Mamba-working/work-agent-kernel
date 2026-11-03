# Project intent

Build a personal work agent around durable work items, plugin sources and replaceable harnesses. Keep model-owned task interpretation separate from code-owned state and delivery.

- Offline demos and tests do not access accounts. The opt-in `src/live` controller calls a model provider, runs Codex and sends owner notifications. Run live integrations only when the task explicitly authorizes them. Keep credentials and runtime data outside the repository.
- Before changing routing, session ownership or persistence, read `docs/ARCHITECTURE.md` and `docs/DESIGN-DECISIONS.md`.
- Before implementing an adapter, read `docs/CONTRACTS.md` and its live acceptance requirements in `docs/TESTING.md`.
- Use TypeScript, runtime schemas at external boundaries and inferred domain types. Keep business decisions in Router/Worker policies; code validates and executes decisions.
- Validate changes through public interfaces with real SQLite and controlled external adapters. Run `npm run check` and `npm run demo` before reporting completion.
- Distinguish executable prototype behavior, adapter simulations and live integration evidence in every delivery. Follow `docs/ROADMAP.md` for scope; do not silently add new infrastructure.
