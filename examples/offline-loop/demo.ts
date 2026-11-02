import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { StateSchema } from '../../src/domain.ts';

const snapshotSchema = z.object({
  works: z.array(StateSchema.shape.works.valueType),
  attentions: z.array(StateSchema.shape.attentions.valueType),
  notices: z.array(StateSchema.shape.outbox.valueType),
});

export function runOfflineLoop(directory: string) {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length) throw new Error('Use an empty demo directory');
  const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
  const plugin = fileURLToPath(new URL('./plugin.ts', import.meta.url));
  const database = join(directory, 'state.sqlite');
  let step = 0;
  const command = (...args: string[]): unknown => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', env: { ...process.env, WORK_AGENT_DEMO_DIRECTORY: directory },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`CLI ${args[0]} failed: ${result.stderr || result.stdout}`);
    writeFileSync(join(directory, `${++step}-${args[0]}.json`), result.stdout);
    return JSON.parse(result.stdout);
  };
  const tick = () => command('run', '--plugins', plugin, '--db', database, '--ticks', '1');
  const inspect = () => snapshotSchema.parse(command('inspect', '--db', database));
  const first = { source: 'synthetic-chat', externalId: 'm1', revision: '1', thread: 'topic-7', actor: 'colleague', text: 'Check the original loading requirement', uri: 'example://chat/m1' };
  const source = join(directory, 'events.jsonl');
  writeFileSync(source, JSON.stringify(first) + '\n');
  tick(); tick();
  const waiting = inspect();
  appendFileSync(source, [
    first,
    { ...first, revision: '2', text: 'Check the revised mobile requirement' },
    { ...first, externalId: 'm2', text: 'Please keep the existing image while loading', uri: 'example://chat/m2' },
  ].map(event => JSON.stringify(event) + '\n').join(''));
  tick();
  const whileWaiting = inspect();
  const attention = whileWaiting.attentions.find(item => item.state.kind === 'pending');
  if (!attention) throw new Error('Expected an owner question');
  command('answer', '--db', database, '--attention', attention.id, '--choice', 'Loading only');
  const answered = inspect();
  tick(); tick();
  const final = inspect();
  const report = final.works[0]?.results.at(-1)?.report;
  if (report?.kind !== 'ready' || !report.evidence[0]) throw new Error('Expected draft evidence');
  const artifact = readFileSync(fileURLToPath(report.evidence[0]), 'utf8');
  tick();
  const replayed = inspect();
  return { directory, waiting, whileWaiting, answered, final, replayed, artifact };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { directory: { type: 'string' } } });
  const result = runOfflineLoop(resolve(values.directory ?? mkdtempSync(join(tmpdir(), 'work-agent-offline-loop-'))));
  process.stdout.write(JSON.stringify({
    mode: 'synthetic offline process demo', directory: result.directory,
    work: result.final.works[0], attention: result.final.attentions[0],
    noticeStates: result.final.notices.map(row => row.state.kind),
  }, null, 2) + '\n');
}
