import { parseArgs } from 'node:util';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemo } from './demo.ts';
import { Host, loadPlugins } from './host.ts';
import { Kernel } from './kernel.ts';
import { AttentionId } from './domain.ts';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    directory: { type: 'string' }, db: { type: 'string' }, plugins: { type: 'string' }, ticks: { type: 'string', default: '2' },
    attention: { type: 'string' }, choice: { type: 'string' },
  } });
  let result: unknown;
  switch (positionals[0]) {
    case 'demo': result = await runDemo(values.directory ?? mkdtempSync(join(tmpdir(), 'work-agent-demo-'))); break;
    case 'run': {
      if (!values.db || !values.plugins) throw new Error('run requires --db and --plugins');
      const ticks = Number(values.ticks);
      if (!Number.isSafeInteger(ticks) || ticks < 1) throw new Error('--ticks must be a positive integer');
      const plugins = await loadPlugins(values.plugins);
      const kernel = new Kernel({ path: values.db, ...plugins });
      try {
        const host = new Host({ kernel, sources: plugins.sources }); const errors = [];
        for (let index = 0; index < ticks; index++) errors.push(...await host.tick());
        result = { errors, works: kernel.works(), notices: kernel.notices() };
        if (errors.length) process.exitCode = 1;
      } finally { kernel.close(); }
      break;
    }
    case 'inspect': {
      if (!values.db || !existsSync(values.db)) throw new Error('inspect requires an existing --db');
      const kernel = new Kernel({ path: values.db });
      try { result = { works: kernel.works(), attentions: kernel.attentions(), notices: kernel.notices() }; }
      finally { kernel.close(); }
      break;
    }
    case 'answer': {
      if (!values.db || !existsSync(values.db)) throw new Error('answer requires an existing --db');
      if (!values.attention || !values.choice) throw new Error('answer requires --attention and --choice');
      const attentionId = AttentionId.parse(values.attention);
      const kernel = new Kernel({ path: values.db });
      try {
        kernel.answer({ attentionId, choice: values.choice, actor: 'owner' });
        result = { works: kernel.works(), attentions: kernel.attentions(), notices: kernel.notices() };
      } finally { kernel.close(); }
      break;
    }
    default: throw new Error('Usage: node src/cli.ts demo | run --plugins ./plugin.ts --db state.sqlite [--ticks 2] | inspect --db state.sqlite | answer --db state.sqlite --attention attention-id --choice choice');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown failure' }) + '\n');
  process.exitCode = 1;
});
