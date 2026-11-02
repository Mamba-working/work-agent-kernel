import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { eventKey } from '../../src/domain.ts';
import { Kernel } from '../../src/kernel.ts';
import { replayFixture } from './fixture.ts';

const { values } = parseArgs({ options: { directory: { type: 'string' } } });
const directory = values.directory ? resolve(values.directory) : mkdtempSync(join(tmpdir(), 'work-agent-file-replay-'));
mkdirSync(directory, { recursive: true });
const database = join(directory, 'state.sqlite');
const inputFile = join(directory, 'events.jsonl');
if (existsSync(database) || existsSync(inputFile)) throw new Error('Use a directory without state.sqlite or events.jsonl');
const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';

function run(): void {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../src/cli.ts', import.meta.url)), 'run',
    '--plugins', fileURLToPath(new URL('./plugin.ts', import.meta.url)), '--db', database, '--ticks', '2',
  ], { env: { ...process.env, WORK_AGENT_DEMO_DIRECTORY: directory }, stdio: ['ignore', 'pipe', 'inherit'] });
}

writeFileSync(inputFile, jsonl(replayFixture.initial), { flag: 'wx' });
run();
const first = new Kernel({ path: database });
let workId;
let sessionId;
try {
  assert.equal(first.events().length, 1);
  assert.equal(first.cursor('synthetic-chat'), '1');
  const works = first.works();
  assert.equal(works.length, 1);
  const work = works[0];
  assert(work);
  assert.equal(work.execution.kind, 'ready');
  workId = work.id;
  sessionId = work.sessionId;
} finally { first.close(); }

appendFileSync(inputFile, jsonl(replayFixture.initial, replayFixture.revision, replayFixture.followup));
run();
const reopened = new Kernel({ path: database });
try {
  const events = reopened.events().map(record => record.event);
  const work = reopened.work(workId);
  assert.deepEqual(events, [replayFixture.initial, replayFixture.revision, replayFixture.followup]);
  assert.equal(reopened.cursor('synthetic-chat'), '4');
  assert.equal(reopened.works().length, 1);
  assert.equal(work.execution.kind, 'ready');
  assert.equal(work.sessionId, sessionId);
  assert.deepEqual(work.inputs, events.map(eventKey));
  assert.equal(work.results.length, 2);
  const notices = reopened.notices();
  assert.equal(notices.length, 2);
  assert(notices.every(notice => notice.state.kind === 'delivered'));
  process.stdout.write(JSON.stringify({
    directory, inputFile, database, cursor: reopened.cursor('synthetic-chat'), events,
    work: { id: work.id, sessionId: work.sessionId, execution: work.execution, inputCount: work.inputs.length, resultCount: work.results.length },
    deliveredNotices: notices.length,
  }, null, 2) + '\n');
} finally { reopened.close(); }
