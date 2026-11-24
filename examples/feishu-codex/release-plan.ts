import { type RouterExtension } from 'work-router-kit';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const releasePlan: RouterExtension = () => ({
  instructions: '用户问演示卡片的发布日期时，调用 read_release_plan，依据返回值回答。',
  tools: [{
    name: 'read_release_plan',
    description: '查询演示卡片的发布计划',
    schema: z.strictObject({}),
    async run() {
      const file = new URL('./release-plan.example.json', import.meta.url);
      return { value: JSON.parse(await readFile(file, 'utf8')) };
    },
  }],
});
