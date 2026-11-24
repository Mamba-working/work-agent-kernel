// Product entry point used by independent ingress processes.
import { dirname } from 'node:path';
import { RouterInbox as FeishuInbox, type Projects } from '../../src/adapters/feishu/inbox.ts';
import { loadProjects } from '../../src/adapters/feishu/project-registry.ts';
export * from '../../src/adapters/feishu/inbox.ts';

export class RouterInbox extends FeishuInbox {
  constructor(path: string, configured: Projects = {}) {
    super(path, path === ':memory:' ? configured : loadProjects(dirname(path), configured));
  }
}
