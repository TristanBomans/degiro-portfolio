const fs = require('fs');
const http = require('http');
const { replaceStackImage, validateDeployment, verifySignature } = require('./lib');

const port = Number(process.env.PORT || 8080);
const portainerUrl = process.env.PORTAINER_URL || 'http://portainer:9000';
const portainerEndpointId = Number(process.env.PORTAINER_ENDPOINT_ID || 3);
const sharedSecret = process.env.DEPLOY_SHARED_SECRET || '';
const targetsPath = process.env.DEPLOY_TARGETS_FILE || '/config/targets.json';
const targets = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
const activeProjects = new Set();
const recentDeliveries = new Map();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function checkedFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`Portainer ${response.status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}

async function portainerToken() {
  const result = await checkedFetch(`${portainerUrl}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.PORTAINER_USERNAME,
      password: process.env.PORTAINER_PASSWORD,
    }),
  });
  if (!result?.jwt) throw new Error('Portainer did not return a token');
  return result.jwt;
}

async function pullImage(token, image, registryUsername, registryToken) {
  const separator = image.lastIndexOf(':');
  const fromImage = image.slice(0, separator);
  const tag = image.slice(separator + 1);
  const registryAuth = Buffer.from(JSON.stringify({
    username: registryUsername,
    password: registryToken,
    serveraddress: 'ghcr.io',
  })).toString('base64');
  const query = new URLSearchParams({ fromImage, tag });
  const response = await fetch(`${portainerUrl}/api/endpoints/${portainerEndpointId}/docker/images/create?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Registry-Auth': registryAuth },
  });
  const output = await response.text();
  if (!response.ok || output.split('\n').some((line) => line.includes('"error"') || line.includes('"errorDetail"'))) {
    throw new Error(`Image pull failed (${response.status}): ${output.slice(-300)}`);
  }
}

async function stackState(token, expected) {
  const headers = { Authorization: `Bearer ${token}` };
  const [stack, file] = await Promise.all([
    checkedFetch(`${portainerUrl}/api/stacks/${expected.id}`, { headers }),
    checkedFetch(`${portainerUrl}/api/stacks/${expected.id}/file`, { headers }),
  ]);
  if (stack.Name !== expected.name) throw new Error(`Stack ${expected.id} is ${stack.Name}, expected ${expected.name}`);
  return { stack, content: file.StackFileContent };
}

async function updateStack(token, state, content) {
  await checkedFetch(`${portainerUrl}/api/stacks/${state.stack.Id}?endpointId=${portainerEndpointId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ StackFileContent: content, Env: state.stack.Env || [], Prune: false, PullImage: false }),
  });
}

async function deploy(payload, registryUsername, registryToken) {
  const target = targets[payload.project];
  const image = validateDeployment(target, payload);
  if (registryUsername !== target.registryUsername || !registryToken) throw new Error('Registry credentials are missing or invalid');
  if (activeProjects.has(payload.project)) throw new Error('A deployment for this project is already running');
  activeProjects.add(payload.project);
  try {
    const token = await portainerToken();
    const states = await Promise.all(target.stacks.map((stack) => stackState(token, stack)));
    const updates = states.map((state) => replaceStackImage(state.content, target, image));
    await pullImage(token, image, registryUsername, registryToken);
    const completed = [];
    try {
      for (let index = 0; index < states.length; index += 1) {
        await updateStack(token, states[index], updates[index]);
        completed.push(index);
      }
    } catch (error) {
      for (const index of completed.reverse()) {
        try { await updateStack(token, states[index], states[index].content); } catch (rollbackError) {
          console.error(JSON.stringify({ level: 'error', event: 'rollback_failed', stack: states[index].stack.Id, message: rollbackError.message }));
        }
      }
      throw error;
    }
    return { project: payload.project, commit: payload.commit, image, stacks: target.stacks.map((stack) => stack.name) };
  } finally {
    activeProjects.delete(payload.project);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok' });
  if (req.method !== 'POST' || req.url !== '/deploy') return json(res, 404, { error: 'Not found' });
  try {
    const rawBody = await readBody(req);
    const timestamp = req.headers['x-deploy-timestamp'];
    const signature = req.headers['x-deploy-signature'];
    const delivery = req.headers['x-deploy-delivery'];
    if (!verifySignature(sharedSecret, timestamp, rawBody, signature)) return json(res, 401, { error: 'Invalid signature' });
    if (!/^[0-9a-f-]{16,64}$/i.test(delivery || '') || recentDeliveries.has(delivery)) return json(res, 409, { error: 'Invalid or replayed delivery' });
    recentDeliveries.set(delivery, Date.now());
    for (const [id, seenAt] of recentDeliveries) if (Date.now() - seenAt > 600000) recentDeliveries.delete(id);
    const payload = JSON.parse(rawBody);
    const result = await deploy(payload, req.headers['x-registry-username'], req.headers['x-registry-token']);
    console.log(JSON.stringify({ level: 'info', event: 'deployed', ...result }));
    return json(res, 200, { success: true, ...result });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'deploy_failed', message: error.message }));
    return json(res, 500, { error: error.message });
  }
});

server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', event: 'listening', port })));
