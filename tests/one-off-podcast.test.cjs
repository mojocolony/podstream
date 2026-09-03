const test = require('node:test');
const assert = require('node:assert/strict');
const addMode = require('../podcast-add-mode.js');

test('Open mode stays one-off while Subscribe mode creates a subscription', () => {
  assert.equal(addMode.normalizeMode('open'), 'open');
  assert.equal(addMode.normalizeMode('subscribe'), 'subscribe');
  assert.equal(addMode.normalizeMode('anything-else'), 'subscribe');
});

test('transient one-off episodes are omitted from the persistent cache until retained', () => {
  const episodes = {
    a: { id: 'a', transient: true },
    b: { id: 'b', transient: false },
    c: { id: 'c' },
  };
  assert.deepEqual(Object.keys(addMode.persistentEpisodes(episodes)).sort(), ['b', 'c']);
});

test('retaining a one-off episode clears its transient flag', () => {
  const original = { id: 'a', transient: true, title: 'Episode' };
  const retained = addMode.retainEpisode(original);
  assert.equal(retained.transient, false);
  assert.equal(retained.title, 'Episode');
  assert.equal(original.transient, true);
});
