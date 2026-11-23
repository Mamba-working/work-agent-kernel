// Product entry point used by independent ingress processes.
import { dirname } from 'node:path';
import { RouterInbox as FeishuInbox, type Projects } from '../adapters/feishu/inbox.ts';
import { loadProjects } from './project-registry.ts';
export * from '../adapters/feishu/inbox.ts';

export class RouterInbox extends FeishuInbox {
  constructor(path: string, configured: Projects = {}) {
    super(path, path === ':memory:' ? configured : loadProjects(dirname(path), configured));
  }
}
