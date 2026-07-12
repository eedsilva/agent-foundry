import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRulesetPayload,
  mergeSelectOptions,
  selectOptionsEqual,
  shouldUpdateProjectValue,
} from './governance.mjs';

test('reconciliação preserva campos operacionais humanos', () => {
  assert.equal(shouldUpdateProjectValue('Status', 'In Progress', 'Inbox'), false);
  assert.equal(shouldUpdateProjectValue('Evidence', 'https://example.test/run', ''), false);
  assert.equal(shouldUpdateProjectValue('Target', 'Hosted v2', 'Personal v1'), true);
  assert.equal(shouldUpdateProjectValue('Status', '', 'Inbox'), true);
});

test('merge de opções preserva opções externas por padrão', () => {
  const merged = mergeSelectOptions(
    [
      { id: '1', name: { raw: 'Now' }, color: 'RED' },
      { id: 'x', name: { raw: 'Manual' }, color: 'GRAY' },
    ],
    [{ name: 'Now', color: 'YELLOW', description: 'desired' }],
  );
  assert.deepEqual(
    merged.map((item) => item.name),
    ['Now', 'Manual'],
  );
  assert.equal(merged[0].id, '1');
});

test('ruleset nasce disabled até ativação explícita', () => {
  const config = {
    name: 'main',
    target: 'branch',
    include: ['~DEFAULT_BRANCH'],
    blockDeletion: true,
    blockForcePush: true,
    requiredLinearHistory: true,
    requiredStatusChecks: ['test'],
    pullRequest: {
      dismissStaleReviewsOnPush: false,
      requireCodeOwnerReview: false,
      requireLastPushApproval: false,
      requiredApprovingReviewCount: 0,
      requiredReviewThreadResolution: true,
      allowedMergeMethods: ['squash'],
    },
  };
  assert.equal(buildRulesetPayload(config).enforcement, 'disabled');
  assert.equal(buildRulesetPayload(config, { activate: true }).enforcement, 'active');
});

test('comparação de opções entende a forma REST e preserva identidade', () => {
  const current = [
    {
      id: 'option-1',
      name: { raw: 'Inbox', html: 'Inbox' },
      color: 'GRAY',
      description: { raw: 'Not triaged', html: 'Not triaged' },
    },
  ];
  const desired = [{ id: 'option-1', name: 'Inbox', color: 'GRAY', description: 'Not triaged' }];
  assert.equal(selectOptionsEqual(current, desired), true);
  assert.equal(
    selectOptionsEqual(current, [
      { id: 'option-1', name: 'Inbox', color: 'BLUE', description: 'Not triaged' },
    ]),
    false,
  );
});
