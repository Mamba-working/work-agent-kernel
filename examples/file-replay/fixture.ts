import { EventSchema } from '../../src/domain.ts';

const initial = EventSchema.parse({
  source: 'synthetic-chat', externalId: 'm1', revision: '1', thread: 'topic-7',
  actor: 'colleague', text: 'Check loading state', uri: 'example://synthetic-chat/m1/1',
});

export const replayFixture = {
  initial,
  revision: EventSchema.parse({ ...initial, revision: '2', text: 'Check loading and failure states', uri: 'example://synthetic-chat/m1/2' }),
  followup: EventSchema.parse({ ...initial, externalId: 'm2', text: 'Keep the existing retry action', uri: 'example://synthetic-chat/m2/1' }),
};
