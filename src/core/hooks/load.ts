import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { LifecycleHook } from './lifecycle.ts';

function isHook(value: unknown): value is LifecycleHook {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof Reflect.get(value, 'id') === 'string' &&
    ['beforeRoute', 'beforeNotify'].includes(Reflect.get(value, 'phase')) &&
    typeof Reflect.get(value, 'run') === 'function' &&
    ['deliver', 'readResolution'].every(
      (k) => Reflect.get(value, k) === undefined || typeof Reflect.get(value, k) === 'function',
    )
  );
}
// Explicitly selected local modules execute as trusted service code.
export async function loadBusinessHooks(file: string): Promise<LifecycleHook[]> {
  const extension = await import(pathToFileURL(resolve(file)).href);
  if (typeof extension.createHooks !== 'function') throw Error('Hook module must export createHooks()');
  return z.array(z.custom<LifecycleHook>(isHook)).parse(await extension.createHooks());
}
