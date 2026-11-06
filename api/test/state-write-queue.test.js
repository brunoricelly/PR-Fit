import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateWriteQueue } from '../state-write-queue.js';

test('StateWriteQueue serializes a user and releases its entry after an exception', async () => {
  const queue = new StateWriteQueue();
  let enterFirst;
  let releaseFirst;
  const entered = new Promise(resolve => { enterFirst = resolve; });
  const blocked = new Promise(resolve => { releaseFirst = resolve; });
  const order = [];

  const first = queue.run('athlete', async () => {
    order.push('first');
    enterFirst();
    await blocked;
    throw new Error('broken write');
  });
  await entered;
  const second = queue.run('athlete', async () => { order.push('second'); return 'ok'; });
  assert.equal(await queue.run('other-athlete', async () => { order.push('other'); return 'other-ok'; }), 'other-ok');
  await Promise.resolve();
  assert.deepEqual(order, ['first', 'other']);
  assert.equal(queue.size, 1);

  releaseFirst();
  await assert.rejects(first, /broken write/);
  assert.equal(await second, 'ok');
  assert.deepEqual(order, ['first', 'other', 'second']);
  assert.equal(queue.size, 0);
});
