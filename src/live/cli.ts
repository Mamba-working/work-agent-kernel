import { parseArgs } from 'node:util';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { stateDirectory } from './config.ts';
import { EventSchema } from '../domain.ts';
import { Kernel } from '../kernel.ts';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    text: { type: 'string' }, thread: { type: 'string' },
  } });
  const directory = stateDirectory();
  switch (positionals[0]) {
    case 'serve': {
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { await (await import('./service.ts')).serve(abort.signal); }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
      return;
    }
    case 'submit': {
      if (!values.text) throw new Error('submit requires --text');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const event = EventSchema.parse({ source: 'owner', externalId: id, revision: '1',
        thread: values.thread ?? id, actor: 'owner', text: values.text,
        uri: `${pathToFileURL(join(directory, 'events.jsonl')).href}#${id}`, occurredAt: new Date().toISOString() });
      appendFileSync(join(directory, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
      process.stdout.write(JSON.stringify({ eventId: id, thread: event.thread }) + '\n');
      return;
    }
    case 'status': {
      const path = join(directory, 'kernel.sqlite');
      if (!existsSync(path)) throw new Error('No state database; start the service first');
      const kernel = new Kernel({ path });
      try {
        process.stdout.write(JSON.stringify({
          health: existsSync(join(directory, 'health.json')) ? JSON.parse(readFileSync(join(directory, 'health.json'), 'utf8')) : null,
          works: kernel.works(), attentions: kernel.attentions(), notices: kernel.notices(),
        }, null, 2) + '\n');
      } finally { kernel.close(); }
      return;
    }
    default: throw new Error('Usage: node src/live/cli.ts serve | submit --text TEXT [--thread THREAD] | status');
  }
}
main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Live command failed' }) + '\n');
  process.exitCode = 1;
});
