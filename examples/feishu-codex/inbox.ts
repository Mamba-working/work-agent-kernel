// Product entry point used by independent ingress processes.
import { RouterInbox as FeishuInbox, type Projects, loadProjects } from 'work-agent-kernel/adapters/feishu';
import { dirname } from 'node:path';
export {MessageSchema} from 'work-agent-kernel/adapters/feishu';

export class RouterInbox extends FeishuInbox {
  constructor(path: string, configured: Projects = {}) {
    super(path, path === ':memory:' ? configured : loadProjects(dirname(path), configured));
  }
}
