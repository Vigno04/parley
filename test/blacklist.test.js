// test/blacklist.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlacklist, isUserBlacklisted } from '../src/voice/blacklist.js';

test('parseBlacklist normalizes array, string, and JSON inputs', () => {
  assert.deepEqual(parseBlacklist(null), []);
  assert.deepEqual(parseBlacklist(undefined), []);
  assert.deepEqual(parseBlacklist(''), []);
  assert.deepEqual(parseBlacklist([]), []);

  // String array
  assert.deepEqual(parseBlacklist(['123', '456']), ['123', '456']);
  // Strips mention wrappers
  assert.deepEqual(parseBlacklist(['<@!123>', '<@456>']), ['123', '456']);

  // Comma/whitespace separated string
  assert.deepEqual(parseBlacklist('123, 456, 789'), ['123', '456', '789']);
  assert.deepEqual(parseBlacklist('123\n456 789'), ['123', '456', '789']);

  // JSON string
  assert.deepEqual(parseBlacklist('["123", "456"]'), ['123', '456']);
});

test('isUserBlacklisted matches by userId directly', () => {
  const blacklist = ['12345', '67890'];
  assert.equal(isUserBlacklisted(blacklist, '12345'), true);
  assert.equal(isUserBlacklisted(blacklist, '<@12345>'), true);
  assert.equal(isUserBlacklisted(blacklist, '67890'), true);
  assert.equal(isUserBlacklisted(blacklist, '99999'), false);
  assert.equal(isUserBlacklisted([], '12345'), false);
});

test('isUserBlacklisted matches by member username, tag, and displayName', () => {
  const blacklist = ['fredboat', 'lofi_bot', '111222'];

  const memberBot = {
    id: '999000',
    displayName: 'FredBoat Music',
    user: { id: '999000', username: 'FredBoat', tag: 'FredBoat#0001' },
  };

  const memberHuman = {
    id: '123456',
    displayName: 'Alice',
    user: { id: '123456', username: 'AliceW', tag: 'AliceW#1234' },
  };

  assert.equal(isUserBlacklisted(blacklist, '999000', memberBot), true); // matches username 'FredBoat'
  assert.equal(isUserBlacklisted(blacklist, '123456', memberHuman), false);

  const memberById = {
    id: '111222',
    displayName: 'SomeBot',
    user: { id: '111222', username: 'other', tag: 'other#1234' },
  };
  assert.equal(isUserBlacklisted(blacklist, '111222', memberById), true);
});
