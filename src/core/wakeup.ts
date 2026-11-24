// Local producers write their durable queue first. The file carries no commands or data.
import { closeSync, openSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const marker = (directory: string, name: string) => join(directory, name);

export function notifyApplication(directory: string, name = 'application.wake') {
  // The queue is already committed; periodic reconciliation covers a lost hint.
  try {
    writeFileSync(marker(directory, name), '1', { mode: 0o600 });
  } catch {
    /* advisory */
  }
}

export function watchApplication(directory: string, wake: () => void, name = 'application.wake') {
  const path = marker(directory, name);
  closeSync(openSync(path, 'a', 0o600));
  const watcher = watch(path, wake);
  watcher.on('error', () => watcher.close());
  return () => watcher.close();
}
