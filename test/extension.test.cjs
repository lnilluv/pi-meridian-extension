const assert = require('node:assert/strict');
const test = require('node:test');
const { createJiti } = require('@mariozechner/jiti');

const jiti = createJiti(__filename);

async function loadExtension() {
  const mod = await jiti.import('../extensions/index.ts');
  return mod.default;
}

function createMockPi() {
  const pi = {
    providers: new Map(),
    commands: new Map(),
    handlers: new Map(),
    registerProvider(name, config) {
      this.providers.set(name, config);
    },
    registerCommand(name, config) {
      this.commands.set(name, config);
    },
    on(event, handler) {
      this.handlers.set(event, handler);
    },
  };
  return pi;
}

async function registerWithEnv(env = {}) {
  const previous = {
    MERIDIAN_API_KEY: process.env.MERIDIAN_API_KEY,
    MERIDIAN_PROFILE: process.env.MERIDIAN_PROFILE,
    MERIDIAN_BASE_URL: process.env.MERIDIAN_BASE_URL,
  };
  for (const key of Object.keys(previous)) delete process.env[key];
  Object.assign(process.env, env);
  try {
    const extension = await loadExtension();
    const pi = createMockPi();
    extension(pi);
    return pi;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('provider uses MERIDIAN_API_KEY and MERIDIAN_PROFILE when configured', async () => {
  const pi = await registerWithEnv({
    MERIDIAN_API_KEY: 'secret-key',
    MERIDIAN_PROFILE: 'work',
  });

  const provider = pi.providers.get('meridian');
  assert.equal(provider.apiKey, 'secret-key');
  assert.equal(provider.authHeader, true);
  assert.deepEqual(provider.headers, {
    'x-meridian-agent': 'pi',
    'x-meridian-profile': 'work',
  });
});

test('provider defaults to placeholder api key and omits blank profile', async () => {
  const pi = await registerWithEnv({ MERIDIAN_PROFILE: '   ' });

  const provider = pi.providers.get('meridian');
  assert.equal(provider.apiKey, 'meridian');
  assert.deepEqual(provider.headers, { 'x-meridian-agent': 'pi' });
});

test('provider model catalog matches current upstream Meridian models', async () => {
  const pi = await registerWithEnv();
  const provider = pi.providers.get('meridian');

  assert.deepEqual(provider.models.map((model) => model.id), [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-haiku-4-5',
  ]);

  const opus47 = provider.models.find((model) => model.id === 'claude-opus-4-7');
  assert.equal(opus47.name, 'Claude Opus 4.7 (Meridian)');
  assert.equal(opus47.contextWindow, 1_000_000);
  assert.equal(opus47.maxTokens, 32768);

  const opus48 = provider.models.find((model) => model.id === 'claude-opus-4-8');
  assert.equal(opus48.name, 'Claude Opus 4.8 (Meridian)');
  assert.equal(opus48.contextWindow, 1_000_000);
  assert.equal(opus48.maxTokens, 32768);
});

test('/meridian health sends configured auth and profile headers', async (t) => {
  const originalFetch = global.fetch;
  const requests = [];
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        status: 'healthy',
        mode: 'sdk',
        auth: { loggedIn: false },
      }),
    };
  };

  const pi = await registerWithEnv({
    MERIDIAN_API_KEY: 'secret-key',
    MERIDIAN_PROFILE: 'work',
  });
  const command = pi.commands.get('meridian');
  await command.handler('', {
    signal: new AbortController().signal,
    ui: { notify() {} },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret-key');
  assert.equal(requests[0].init.headers['x-meridian-agent'], 'pi');
  assert.equal(requests[0].init.headers['x-meridian-profile'], 'work');
});

test('/meridian health displays runtime version even when not logged in', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status: 'healthy',
      version: '1.41.1',
      mode: 'sdk',
      auth: { loggedIn: false },
    }),
  });

  const pi = await registerWithEnv();
  const command = pi.commands.get('meridian');
  const notifications = [];
  await command.handler('', {
    signal: new AbortController().signal,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, 'warning');
  assert.match(notifications[0].message, /Version: 1\.41\.1/);
  assert.match(notifications[0].message, /Mode: sdk/);
});

test('/meridian health displays runtime version when available', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status: 'healthy',
      version: '1.41.1',
      mode: 'sdk',
      auth: {
        loggedIn: true,
        email: 'user@example.com',
        subscriptionType: 'max',
      },
    }),
  });

  const pi = await registerWithEnv();
  const command = pi.commands.get('meridian');
  const notifications = [];
  await command.handler('', {
    signal: new AbortController().signal,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, 'info');
  assert.match(notifications[0].message, /Version: 1\.41\.1/);
});
