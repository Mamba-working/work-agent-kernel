# Work Agent Kernel

[简体中文](README.md) · **English**

Work Agent Kernel is a local TypeScript framework for keeping a task going across conversations. The router decides whether to create a work item or continue an existing one. The kernel validates the decision and saves execution state and results in SQLite.

For example, you ask Codex Desktop to draft a release checklist. The next day, someone in a Feishu chat says, “Add rollback steps to yesterday’s checklist.” The router can attach that message to the original work item so Codex can continue in the same session.

## Quick start

With **Node.js 24**, run the offline demo from the repository root. It uses a temporary SQLite database and simulated workers. No account or API key is required.

```sh
npm ci --ignore-scripts
npm run demo
```

The demo pauses a work item for a user decision, then resumes it. Look for `sameSessionAfterAnswer: true` in the output to confirm that the worker resumed the original session.

## Use and extend

The guides below are in Chinese.

- **Run the default app.** Configure the router and install the Desktop plugin to browse sessions by project, submit tasks, and trace results. [Router setup](docs/ROUTER.md) · [Plugin installation](plugins/router-inbox/README.md)
- **Connect another tool.** Register an adapter at startup to replace a message source, planning runtime, worker, or notification channel. [Adapter contracts](docs/extensions/contracts.md)
- **Add a business rule.** A hook can let a request continue, pause it, or stop it. For example, messages from an unbound chat can wait for approval while other requests proceed. [Hook guide](docs/extensions/hooks.md)

[Architecture and routing](docs/architecture/routing.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
