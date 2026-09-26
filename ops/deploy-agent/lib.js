const crypto = require('crypto');

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function verifySignature(secret, timestamp, rawBody, suppliedSignature, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parsedTimestamp = Number(timestamp);
  if (!secret || !Number.isInteger(parsedTimestamp) || Math.abs(nowSeconds - parsedTimestamp) > 300) return false;
  if (!/^sha256=[0-9a-f]{64}$/i.test(suppliedSignature || '')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(suppliedSignature));
}

// A target may name its own secret (secretEnv) so one leaked repository secret
// cannot sign deploys for another project. Targets without it use the shared one.
function secretForProject(targets, rawBody, env, sharedSecret) {
  let project;
  try {
    project = JSON.parse(rawBody).project;
  } catch (_error) {
    return '';
  }
  const target = typeof project === 'string' && Object.hasOwn(targets, project) ? targets[project] : null;
  if (!target) return '';
  return target.secretEnv ? env[target.secretEnv] || '' : sharedSecret;
}

function validateDeployment(target, payload) {
  if (!target) throw new Error('Unknown deployment project');
  if (payload.repository !== target.repository) throw new Error('Repository does not match deployment target');
  if (!/^[0-9a-f]{40}$/.test(payload.commit || '')) throw new Error('Commit must be a full Git SHA');
  return `${target.image}:sha-${payload.commit}`;
}

function replaceStackImage(stackFile, target, newImage) {
  const aliases = target.imageAliases || [target.image];
  const matcher = new RegExp(`^(\\s*image:\\s*)(?:${aliases.map(escapeRegex).join('|')}):[^\\s#]+(\\s*(?:#.*)?)$`, 'gm');
  let replacements = 0;
  const updated = stackFile.replace(matcher, (_line, prefix, suffix) => {
    replacements += 1;
    return `${prefix}${newImage}${suffix}`;
  });
  if (replacements !== 1) throw new Error(`Expected one deployable image in stack, found ${replacements}`);
  return updated;
}

module.exports = { replaceStackImage, secretForProject, validateDeployment, verifySignature };
