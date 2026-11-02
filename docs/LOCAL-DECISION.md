# Run the local owner-decision demo

This offline demo carries a scope question across CLI process exits and writes a readable Markdown draft after your answer. Every `run`, `inspect`, and `answer` starts a fresh process. The provider is a deterministic fixture. It does not contact a model or a real account.

Run the driver from the repository root with Node.js 24.

```sh
node examples/local-decision/demo.ts
```

The driver chooses `Loading only`, repeats that answer once, and verifies one continuation in the original session. It prints the retained directory, database paths, draft path, and draft text. To choose the directory, pass `--directory /tmp/my-local-decision`. The directory must be empty. The driver never clears existing files.

To choose the other scope yourself, run the same flow manually.

```sh
export WORK_AGENT_DEMO_DIRECTORY="$(mktemp -d)"
node src/cli.ts run --plugins ./examples/local-decision/plugin.ts --db "$WORK_AGENT_DEMO_DIRECTORY/state.sqlite" --ticks 1
node src/cli.ts run --plugins ./examples/local-decision/plugin.ts --db "$WORK_AGENT_DEMO_DIRECTORY/state.sqlite" --ticks 1
node src/cli.ts inspect --db "$WORK_AGENT_DEMO_DIRECTORY/state.sqlite"
```

The first process admits the request. The second loads its persisted question. Copy `attentions[0].id` from `inspect` into the next command. The choices are `Loading only` and `Both`.

```sh
node src/cli.ts answer --db "$WORK_AGENT_DEMO_DIRECTORY/state.sqlite" --attention attention-id-from-inspect --choice 'Both'
node src/cli.ts run --plugins ./examples/local-decision/plugin.ts --db "$WORK_AGENT_DEMO_DIRECTORY/state.sqlite" --ticks 1
node src/cli.ts run --plugins ./examples/local-decision/plugin.ts --db "$WORK_AGENT_DEMO_DIRECTORY/state.sqlite" --ticks 1
node src/cli.ts inspect --db "$WORK_AGENT_DEMO_DIRECTORY/state.sqlite"
```

The answer command requires an existing database and uses the fixed local identity `owner`. It records the decision and returns the state. It does not dispatch work. Repeating the identical answer has no additional effect. This trusted local command does not authenticate a remote callback.

The next process admits a continuation in the same provider session. The last process reads the persisted ready report. Open the file URL in `works[0].results[0].report.evidence[0]`. Its draft names the chosen scope and includes the supplied input previews. The fixture retains earlier accepted request inputs because an owner-only continuation has no new source text.

The demo keeps three independent stores in the selected directory. Kernel owns `state.sqlite`. `DurableDemoHarness` owns `provider.sqlite` and `drafts`. `SqliteInbox` owns `inbox.sqlite`. The harness opens and closes its database for each operation. Its first synthetic report asks the scope question immediately, and Host observes that report on the next tick.

Verify the process loop with the behavioral test.

```sh
node --test test/local-decision.test.ts
```

The test chooses `Both`, checks repeated-answer behavior, reads the actual draft, and reopens the provider to recover the first admission receipt. It then adds a followup to the finished work and checks that the provider retains the scope choice instead of asking again. Commands run sequentially in one local directory. This evidence covers provider persistence and owner-decision continuity. It does not prove real model execution or remote delivery.
