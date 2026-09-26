const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');
const { replaceStackImage, secretForProject, validateDeployment, verifySignature } = require('./lib');

const target = {
  repository: 'TristanBomans/degiro-portfolio',
  image: 'ghcr.io/tristanbomans/degiro-portfolio',
  imageAliases: ['ghcr.io/tristanbomans/degiro-portfolio', 'localhost:5011/tristanbomans/degiro-portfolio'],
};

test('verifies signed, fresh payloads', () => {
  const body = '{"project":"degiro-portfolio"}';
  const timestamp = '1800000000';
  const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(`${timestamp}.${body}`).digest('hex')}`;
  assert.equal(verifySignature('secret', timestamp, body, signature, 1800000000), true);
  assert.equal(verifySignature('secret', timestamp, `${body}x`, signature, 1800000000), false);
  assert.equal(verifySignature('secret', timestamp, body, signature, 1800000600), false);
});

test('derives an immutable image from an allowlisted target', () => {
  const commit = 'a'.repeat(40);
  assert.equal(validateDeployment(target, { repository: target.repository, commit }), `${target.image}:sha-${commit}`);
  assert.throws(() => validateDeployment(target, { repository: 'other/repo', commit }), /Repository/);
});

test('replaces only the allowlisted application image', () => {
  const source = 'services:\n  app:\n    image: localhost:5011/tristanbomans/degiro-portfolio:0.5.21\n  auth:\n    image: oauth2-proxy:latest\n';
  const image = `${target.image}:sha-${'b'.repeat(40)}`;
  const updated = replaceStackImage(source, target, image);
  assert.match(updated, new RegExp(image));
  assert.match(updated, /oauth2-proxy:latest/);
  assert.throws(() => replaceStackImage('image: unrelated/app:latest', target, image), /found 0/);
});

test('picks the per-project secret when a target names one', () => {
  const targets = { shared: {}, own: { secretEnv: 'OWN_SECRET' } };
  const env = { OWN_SECRET: 'own' };
  assert.equal(secretForProject(targets, '{"project":"shared"}', env, 'shared'), 'shared');
  assert.equal(secretForProject(targets, '{"project":"own"}', env, 'shared'), 'own');
  assert.equal(secretForProject(targets, '{"project":"own"}', {}, 'shared'), '');
  assert.equal(secretForProject(targets, '{"project":"toString"}', env, 'shared'), '');
  assert.equal(secretForProject(targets, 'not json', env, 'shared'), '');
});
