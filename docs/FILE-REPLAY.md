# Run the file replay demo

Run the following commands from the repository root with Node.js 24.

```sh
npm ci --ignore-scripts
node examples/file-replay/demo.ts
```

The driver creates a temporary directory and runs the normal CLI twice in separate processes. Each command completes two ticks with the synthetic EchoHarness before exiting. The first command finishes the seed task. The second command reopens the kernel after the driver appends a duplicate, a revised message, and a followup.

Read the printed JSON. `cursor` is `"4"`, while `events` contains three distinct events with their original text and URI. The single work item is `ready`, has three inputs and two results, and keeps its session ID. `deliveredNotices` is `2`.

To retain the files at a chosen location, pass an unused directory.

```sh
node examples/file-replay/demo.ts --directory /tmp/my-file-replay
node src/cli.ts inspect --db /tmp/my-file-replay/state.sqlite
```

The driver refuses to overwrite an existing `events.jsonl` or `state.sqlite`. It leaves its files in place for inspection.

To use the example plugin directly, point `WORK_AGENT_DEMO_DIRECTORY` at a directory that contains `events.jsonl`.

```sh
WORK_AGENT_DEMO_DIRECTORY=/tmp/my-file-replay node src/cli.ts run \
  --plugins ./examples/file-replay/plugin.ts \
  --db /tmp/my-file-replay/state.sqlite --ticks 2
```

Append canonical Event objects, one per line. The fixture starts with this row.

```json
{"source":"synthetic-chat","externalId":"m1","revision":"1","thread":"topic-7","actor":"colleague","text":"Check loading state","uri":"example://synthetic-chat/m1/1","occurredAt":null}
```

Keep consumed rows unchanged. To edit a message, append another row with the same `externalId` and a new `revision`. A repeated row moves the file cursor but does not add another event or work input. The example router creates work only for the fixed seed event. Later events on `topic-7` reach that work through its existing subscription. An unexpected unassigned event fails visibly.

If collection fails, repair the unread rows and retry. The source parses all unread rows before returning a batch, so a malformed row cannot consume an earlier valid row from that batch. A final newline is allowed. Blank rows, invalid Events, invalid cursors, and files shorter than the committed cursor fail. The source does not detect edits to consumed rows or support file rotation.

This demo proves local file replay and SQLite persistence. Its routing is scripted and its execution is synthetic. It does not connect to a chat account, run a model, or recover an in-flight EchoHarness run across process exit.
