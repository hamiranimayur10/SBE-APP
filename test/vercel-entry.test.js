const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { getAssetVersions } = require('../badminton-backend/asset-versions');

const root = path.join(__dirname, '..');

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

test('Vercel Express entry serves the frontend at the root path', { timeout: 30000 }, async () => {
  const databasePath = path.join(__dirname, `vercel-entry-${process.pid}.db`);
  const databaseUrl = `file:${databasePath.replace(/\\/g, '/')}`;
  const port = await getAvailablePort();
  const entryPath = path.join(root, 'index.js');
  const script = `const app = require(${JSON.stringify(entryPath)}); app.listen(Number(process.env.PORT), '127.0.0.1');`;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SBE_TURSO_DATABASE_URL_Direct: databaseUrl,
      SBE_TURSO_AUTH_TOKEN_Direct: '',
      TURSO_DATABASE_URL: 'libsql://invalid-test-database.invalid',
      TURSO_AUTH_TOKEN: '',
      ADMIN_SYNC_KEY: '',
      ADMIN_PASSWORD: '',
      NODE_ENV: 'production',
      VERCEL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Vercel entry exited early:\n${output}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch (_err) {}
      await delay(100);
    }
    assert.equal(healthy, true, `Vercel entry did not become ready:\n${output}`);

    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /SBE Light Vs Dark Side Tournament/);
    const versions = getAssetVersions();
    assert.ok(html.includes(`app.js?v=${versions['app.js']}`));
    const asset = await fetch(`${baseUrl}/app.js?v=${versions['app.js']}`);
    assert.match(asset.headers.get('cache-control'), /max-age=31536000.*immutable/);
    const unversioned = await fetch(`${baseUrl}/app.js`);
    assert.doesNotMatch(unversioned.headers.get('cache-control'), /immutable/);
    const incorrectVersion = await fetch(`${baseUrl}/app.js?v=wrong`);
    assert.doesNotMatch(incorrectVersion.headers.get('cache-control'), /immutable/);
    const versionCheck = spawnSync(process.execPath, [path.join(root, 'scripts', 'version-assets.js'), '--check'], { cwd: root });
    assert.equal(versionCheck.status, 0, versionCheck.stderr.toString());

    const write = await fetch(`${baseUrl}/api/tournaments/test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { name: 'Test' }, groups: [] })
    });
    assert.equal(write.status, 401);
    const login = await fetch(`${baseUrl}/api/admin-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sbe-admin-request': '1' },
      body: JSON.stringify({ password: 'a-test-admin-password' })
    });
    assert.equal(login.status, 503);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    for (const suffix of ['', '-shm', '-wal']) {
      try { await fs.unlink(`${databasePath}${suffix}`); } catch (_err) {}
    }
  }
});
