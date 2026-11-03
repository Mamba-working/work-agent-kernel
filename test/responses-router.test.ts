import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { ResponsesRouter } from '../src/live/responses-router.ts';
import { createDecision, event, setup } from './support.ts';

async function responsesEndpoint(t: TestContext, replies: unknown[] = []) {
  const requests: { method: string | undefined; url: string | undefined; body: string }[] = [];
  const server = createServer(async (request, response) => {
    request.setEncoding('utf8');
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(replies.shift()));
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const router = new ResponsesRouter({ baseUrl: `http://127.0.0.1:${address.port}/v1/`, apiKey: 'test-key', model: 'test-model' });
  return { router, requests, replies };
}

function completedText(text: string) {
  return { status: 'completed', output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  ] };
}

function completed(decision: unknown) {
  return completedText(JSON.stringify({ decision }));
}

test('Responses decisions create, associate and ignore events using the full recalled text', async t => {
  const endpoint = await responsesEndpoint(t, [completed(createDecision({ goal: 'Prepare a review memo' }))]);
  const kernel = setup(t).open({ router: endpoint.router });
  const first = kernel.ingest(event({ text: 'A'.repeat(900) + ' Prepare a review memo.' }));
  const [workId] = await kernel.routeNext() ?? [];
  assert(workId);
  assert.equal(kernel.work(workId).goal, 'Prepare a review memo');
  assert.deepEqual(kernel.work(workId).pendingInputs, [first]);
  assert.equal(endpoint.requests[0]?.method, 'POST');
  assert.equal(endpoint.requests[0]?.url, '/v1/responses');
  assert.match(endpoint.requests[0]?.body ?? '', /A{900} Prepare a review memo\./);

  endpoint.replies.push(completed({ kind: 'attach', workId, reason: 'New evidence for the review' }));
  const addition = kernel.ingest(event({ source: 'document', externalId: 'd1', thread: 'comment', text: 'Add the budget table to the memo.' }));
  assert.deepEqual(await kernel.routeNext(), [workId]);
  assert.deepEqual(kernel.work(workId).pendingInputs, [first, addition]);
  assert(endpoint.requests[1]?.body.includes(workId));

  endpoint.replies.push(completed({ kind: 'ignore', reason: 'Greeting only' }));
  const greeting = kernel.ingest(event({ externalId: 'g1', thread: 'greeting', text: 'Good morning!' }));
  assert.deepEqual(await kernel.routeNext(), []);
  assert.equal(kernel.event(greeting).disposition, 'ignored');
  assert.equal(kernel.works().length, 1);
  assert.equal(endpoint.requests.length, 3);
});

test('invalid model replies preserve the pending event for a later valid decision', async t => {
  const invalid = [
    [{ status: 'incomplete', output: [] }, /incomplete or invalid Responses envelope/],
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Private refusal' }] }] }, /missing structured output/],
    [completedText('malformed private model text'), /invalid route JSON/],
    [completed({ kind: 'invented', reason: 'Invalid variant' }), /invalid route decision/],
    [completed({ kind: 'attach', workId: 'unknown-work', reason: 'Unknown reference' }), /unknown work item/],
    [completed(createDecision({ harness: 'unknown-harness' })), /unknown harness/],
    [completed(createDecision({ workflow: 'unknown-workflow' })), /unknown workflow/],
    [completed(createDecision({ scope: 'execute' })), /unauthorized scope/],
  ] satisfies [unknown, RegExp][];
  const endpoint = await responsesEndpoint(t, invalid.map(([reply]) => reply));
  const kernel = setup(t).open({ router: endpoint.router });
  const key = kernel.ingest(event());
  for (const [, error] of invalid) {
    await assert.rejects(kernel.routeNext(), error);
    assert.equal(kernel.event(key).disposition, 'pending');
    assert.deepEqual(kernel.works(), []);
  }

  endpoint.replies.push(completed({ kind: 'ignore', reason: 'Reference only' }));
  assert.deepEqual(await kernel.routeNext(), []);
  assert.equal(kernel.event(key).disposition, 'ignored');
  assert.equal(endpoint.requests.length, invalid.length + 1);
});
