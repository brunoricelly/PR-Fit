import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StateWriteQueue,
  StateWriteQueueFullError,
  StateWriteQueueReentrancyError,
} from '../state-write-queue.js';

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
  assert.equal(queue.pending, 0);
});

test('StateWriteQueue bounds each key and rejects excess work without executing it', async () => {
  const queue = new StateWriteQueue({ perKeyLimit: 2, globalLimit: 10 });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let executed = 0;
  const first = queue.run('athlete', async () => { executed++; await blocked; });
  const second = queue.run('athlete', async () => { executed++; });
  const excess = queue.run('athlete', async () => { executed++; });

  await assert.rejects(excess, error => error instanceof StateWriteQueueFullError && error.scope === 'key');
  assert.equal(queue.pending, 2);
  assert.equal(executed, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(executed, 2);
  assert.equal(queue.size, 0);
  assert.equal(queue.pending, 0);
});

test('StateWriteQueue enforces its global limit across keys', async () => {
  const queue = new StateWriteQueue({ perKeyLimit: 3, globalLimit: 2 });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let excessRan = false;
  const first = queue.run('one', () => blocked);
  const second = queue.run('two', () => blocked);

  await assert.rejects(queue.run('three', async () => { excessRan = true; }), error =>
    error instanceof StateWriteQueueFullError && error.scope === 'global');
  assert.equal(excessRan, false);
  assert.equal(queue.pending, 2);
  release();
  await Promise.all([first, second]);
  assert.equal(queue.size, 0);
  assert.equal(queue.pending, 0);
});

test('StateWriteQueue releases cancelled queued work and does not leak keys', async () => {
  const queue = new StateWriteQueue({ perKeyLimit: 2, globalLimit: 2 });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  let cancelledRan = false;
  const first = queue.run('athlete', () => blocked);
  const cancelled = queue.run('athlete', async () => { cancelledRan = true; }, { signal: controller.signal });
  controller.abort(new Error('client disconnected'));

  await assert.rejects(cancelled, /client disconnected/);
  assert.equal(cancelledRan, false);
  assert.equal(queue.pending, 1);
  release();
  await first;
  assert.equal(queue.size, 0);
  assert.equal(queue.pending, 0);
});

test('StateWriteQueue fails explicit same-key reentrancy instead of deadlocking', async () => {
  const queue = new StateWriteQueue();
  await assert.rejects(queue.run('athlete', () => queue.run('athlete', async () => {})), error =>
    error instanceof StateWriteQueueReentrancyError);
  assert.equal(queue.size, 0);
  assert.equal(queue.pending, 0);
});
