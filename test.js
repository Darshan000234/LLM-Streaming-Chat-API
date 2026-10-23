import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEST_API_KEY = 'test-openrouter-key-0123456789';
const TEST_MODEL = 'test/mock-model';

const providerRequests = [];
const appChildren = [];

let providerServer;
let appBaseUrl;
let mockProviderBaseUrl;
let appOutputReader = null;

const wait = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();

      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return JSON.parse(
    Buffer.concat(chunks).toString('utf8') || '{}'
  );
}

function writeProviderSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleMockOpenRouter(req, res) {
  if (
    req.method !== 'POST' ||
    req.url !== '/api/chat/completions'
  ) {
    res.writeHead(404, {
      'content-type': 'application/json'
    });

    res.end(
      JSON.stringify({
        error: { message: 'Mock endpoint not found' }
      })
    );

    return;
  }

  let payload;

  try {
    payload = await readJsonBody(req);
  } catch {
    res.writeHead(400, {
      'content-type': 'application/json'
    });

    res.end(
      JSON.stringify({
        error: { message: 'Invalid JSON' }
      })
    );

    return;
  }

  const lastUserMessage =
    [...(payload.messages || [])]
      .reverse()
      .find((item) => item.role === 'user')?.content || '';

  providerRequests.push({
    headers: req.headers,
    body: payload,
    userMessage: lastUserMessage
  });

  if (lastUserMessage.includes('[[TEST_401]]')) {
    res.writeHead(401, {
      'content-type': 'application/json'
    });

    res.end(
      JSON.stringify({
        error: { message: 'Simulated invalid API key' }
      })
    );

    return;
  }

  if (lastUserMessage.includes('[[TEST_404]]')) {
    res.writeHead(404, {
      'content-type': 'application/json'
    });

    res.end(
      JSON.stringify({
        error: { message: 'Simulated unknown model' }
      })
    );

    return;
  }

  if (payload.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });

    if (lastUserMessage.includes('[[TEST_STREAM_ERROR]]')) {
      writeProviderSse(res, {
        error: {
          message: 'Simulated streaming provider error'
        }
      });

      res.end();
      return;
    }

    const chunks = lastUserMessage.includes('[[TEST_EMPTY]]')
      ? []
      : ['This ', 'is ', 'a ', 'streamed ', 'test response.'];

    for (const content of chunks) {
      if (res.destroyed) return;

      writeProviderSse(res, {
        choices: [{ delta: { content } }]
      });

      await wait(15);
    }

    if (!res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }

    return;
  }

  const reply = lastUserMessage.includes('[[TEST_EMPTY]]')
    ? ''
    : `Mock reply: ${lastUserMessage}`;

  res.writeHead(200, {
    'content-type': 'application/json'
  });

  res.end(
    JSON.stringify({
      id: 'test-completion',
      model: TEST_MODEL,
      choices: [
        {
          message: {
            role: 'assistant',
            content: reply
          },
          finish_reason: 'stop'
        }
      ]
    })
  );
}

async function startMockProvider() {
  providerServer = createServer((req, res) => {
    handleMockOpenRouter(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, {
          'content-type': 'application/json'
        });
      }

      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            error: { message: error.message }
          })
        );
      }
    });
  });

  await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', resolve);
  });

  mockProviderBaseUrl =
    `http://127.0.0.1:${providerServer.address().port}`;
}

async function startApp({ apiKey = TEST_API_KEY } = {}) {
  const port = await getFreePort();

  const child = spawn(
    process.execPath,
    [path.join(ROOT_DIR, 'server.js')],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        OPENROUTER_API_KEY: apiKey,
        OPENROUTER_MODEL: TEST_MODEL,
        OPENROUTER_API_URL:
          `${mockProviderBaseUrl}/api/chat/completions`,

        // Prevent inherited proxy configuration from intercepting
        // requests to the local mock provider.
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  appChildren.push(child);

  let childOutput = '';

  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    childOutput += chunk;
  });

  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    childOutput += chunk;
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `Test server exited before it was ready.\n${childOutput}`
      );
    }

    try {
      const response = await fetch(
        `${baseUrl}/api/health`,
        { signal: AbortSignal.timeout(500) }
      );

      if (response.ok) {
        return {
          child,
          baseUrl,
          output: () => childOutput
        };
      }
    } catch {
      // Retry while the server is starting.
    }

    await wait(50);
  }

  child.kill();

  throw new Error(
    `Test server did not become ready.\n${childOutput}`
  );
}

async function stopChild(child) {
  if (
    !child ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }

  const exited = once(child, 'exit');

  child.kill();

  await Promise.race([exited, wait(1500)]);
}

function makeSessionId(prefix = 'test-session') {
  return `${prefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function assertStatus(
  response,
  expectedStatus,
  context = ''
) {
  if (response.status === expectedStatus) return;

  const body = await response
    .clone()
    .text()
    .catch(() => '<unable to read response body>');

  const logs = appOutputReader
    ? appOutputReader()
    : '<server logs unavailable>';

  assert.equal(
    response.status,
    expectedStatus,
    `${context}\nResponse body: ${body}\nApp server logs:\n${logs}`
  );
}

async function postChat(
  message,
  sessionId,
  endpoint = '/api/chat'
) {
  return fetch(`${appBaseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ message, sessionId })
  });
}

function parseEvents(sseText) {
  const events = [];
  const blocks = sseText.split(/\n\n/);

  for (const block of blocks) {
    const eventLine = block
      .split('\n')
      .find((line) => line.startsWith('event: '));

    const dataLine = block
      .split('\n')
      .find((line) => line.startsWith('data: '));

    if (!eventLine || !dataLine) continue;

    try {
      events.push({
        event: eventLine.slice(7).trim(),
        data: JSON.parse(dataLine.slice(6))
      });
    } catch {
      // Invalid event frames are ignored.
    }
  }

  return events;
}

before(async () => {
  await startMockProvider();

  const started = await startApp();

  appBaseUrl = started.baseUrl;
  appOutputReader = started.output;
});

after(async () => {
  for (const child of appChildren) {
    await stopChild(child);
  }

  if (providerServer?.listening) {
    await new Promise((resolve) => {
      providerServer.close(resolve);
    });
  }
});

test(
  'serves the frontend and reports healthy backend status',
  async () => {
    const [
      pageResponse,
      healthResponse,
      jsResponse,
      cssResponse
    ] = await Promise.all([
      fetch(`${appBaseUrl}/`),
      fetch(`${appBaseUrl}/api/health`),
      fetch(`${appBaseUrl}/app.js`),
      fetch(`${appBaseUrl}/styles.css`)
    ]);

    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /Nova AI/);

    assert.equal(jsResponse.status, 200);
    assert.match(
      jsResponse.headers.get('content-type') || '',
      /javascript|text\/plain/i
    );

    assert.equal(cssResponse.status, 200);
    assert.match(
      cssResponse.headers.get('content-type') || '',
      /css/i
    );

    assert.equal(healthResponse.status, 200);

    const health = await healthResponse.json();

    assert.equal(health.status, 'ok');
    assert.equal(health.provider, 'OpenRouter');
    assert.equal(health.model, TEST_MODEL);
    assert.equal(health.streaming, true);
    assert.equal(health.apiKeyConfigured, true);
    assert.equal('apiKey' in health, false);
  }
);

test(
  'validates bad chat input and rejects messages above the length limit',
  async () => {
    const badSession = await postChat('Hello', 'short');

    assert.equal(badSession.status, 400);
    assert.match(
      (await badSession.json()).error,
      /invalid session/i
    );

    const emptyMessage = await postChat(
      '   ',
      makeSessionId()
    );

    assert.equal(emptyMessage.status, 400);
    assert.match(
      (await emptyMessage.json()).error,
      /enter a message/i
    );

    const longMessage = await postChat(
      'x'.repeat(6001),
      makeSessionId()
    );

    assert.equal(longMessage.status, 413);
    assert.match(
      (await longMessage.json()).error,
      /too long/i
    );
  }
);

test(
  'sends non-streaming requests to the provider and retains same-session context',
  async () => {
    const sessionId = makeSessionId('context-session');
    const beforeCount = providerRequests.length;

    const firstResponse = await postChat(
      'Remember my preferred language is C++.',
      sessionId
    );

    await assertStatus(
      firstResponse,
      200,
      'First non-streaming chat request failed'
    );

    const first = await firstResponse.json();

    assert.equal(
      first.reply,
      'Mock reply: Remember my preferred language is C++.'
    );

    assert.equal(first.model, TEST_MODEL);

    const secondResponse = await postChat(
      'Which language did I mention?',
      sessionId
    );

    await assertStatus(
      secondResponse,
      200,
      'Follow-up non-streaming chat request failed'
    );

    assert.equal(
      (await secondResponse.json()).reply,
      'Mock reply: Which language did I mention?'
    );

    const requests = providerRequests.slice(beforeCount);

    assert.equal(requests.length, 2);
    assert.equal(
      requests[0].headers.authorization,
      `Bearer ${TEST_API_KEY}`
    );

    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[0].body.model, TEST_MODEL);

    assert.equal(
      requests[0].body.messages[0].role,
      'system'
    );

    assert.match(
      requests[0].body.messages[0].content,
      /general-purpose AI assistant/i
    );

    assert.equal(
      requests[1].body.messages.some(
        (item) =>
          item.role === 'assistant' &&
          item.content === first.reply
      ),
      true
    );

    assert.equal(
      requests[1].body.messages.at(-1).content,
      'Which language did I mention?'
    );
  }
);

test(
  'streams multiple incremental chunks and emits meta, delta, and done events',
  async () => {
    const sessionId = makeSessionId('stream-session');

    const response = await postChat(
      'Please stream a test response.',
      sessionId,
      '/api/chat/stream'
    );

    await assertStatus(
      response,
      200,
      'Streaming chat request failed'
    );

    assert.match(
      response.headers.get('content-type') || '',
      /text\/event-stream/i
    );

    const rawStream = await response.text();
    const events = parseEvents(rawStream);

    assert.equal(events[0]?.event, 'meta');
    assert.equal(events[0]?.data.model, TEST_MODEL);

    const deltas = events.filter(
      (event) => event.event === 'delta'
    );

    assert.ok(
      deltas.length >= 3,
      `Expected multiple incremental deltas, received ${deltas.length}`
    );

    assert.equal(
      deltas.map((event) => event.data.content).join(''),
      'This is a streamed test response.'
    );

    assert.equal(events.at(-1)?.event, 'done');
    assert.equal(events.at(-1)?.data.model, TEST_MODEL);

    const lastProviderRequest = providerRequests.at(-1);

    assert.equal(lastProviderRequest.body.stream, true);
    assert.equal(
      lastProviderRequest.userMessage,
      'Please stream a test response.'
    );
  }
);

test(
  'returns readable provider authentication and model errors',
  async () => {
    const authResponse = await postChat(
      '[[TEST_401]]',
      makeSessionId('auth-error')
    );

    await assertStatus(
      authResponse,
      401,
      'Simulated provider authentication error was not propagated'
    );

    assert.match(
      (await authResponse.json()).error,
      /rejected the API key/i
    );

    const modelResponse = await postChat(
      '[[TEST_404]]',
      makeSessionId('model-error')
    );

    await assertStatus(
      modelResponse,
      404,
      'Simulated provider model error was not propagated'
    );

    assert.match(
      (await modelResponse.json()).error,
      /model was not found/i
    );
  }
);

test(
  'reports empty model responses and streaming provider errors',
  async () => {
    const emptyResponse = await postChat(
      '[[TEST_EMPTY]]',
      makeSessionId('empty-error')
    );

    await assertStatus(
      emptyResponse,
      502,
      'Empty model response was not handled'
    );

    assert.match(
      (await emptyResponse.json()).error,
      /empty response/i
    );

    const streamResponse = await postChat(
      '[[TEST_STREAM_ERROR]]',
      makeSessionId('stream-error'),
      '/api/chat/stream'
    );

    assert.equal(streamResponse.status, 200);

    const events = parseEvents(await streamResponse.text());

    const errorEvent = events.find(
      (event) => event.event === 'error'
    );

    assert.ok(errorEvent, 'Expected an SSE error event');

    assert.match(
      errorEvent.data.error,
      /simulated streaming provider error/i
    );
  }
);

test(
  'clears server-side conversation history and validates clear-session IDs',
  async () => {
    const sessionId = makeSessionId('clear-session');

    const first = await postChat(
      'Save this context for this test.',
      sessionId
    );

    await assertStatus(
      first,
      200,
      'Pre-clear chat request failed'
    );

    const clearResponse = await fetch(
      `${appBaseUrl}/api/chat/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' }
    );

    assert.equal(clearResponse.status, 204);

    const beforeCount = providerRequests.length;

    const afterClear = await postChat(
      'What did I ask before?',
      sessionId
    );

    await assertStatus(
      afterClear,
      200,
      'Chat request after clear failed'
    );

    const requestAfterClear = providerRequests[beforeCount];

    assert.deepEqual(
      requestAfterClear.body.messages.map((item) => item.role),
      ['system', 'user']
    );

    assert.equal(
      requestAfterClear.body.messages.at(-1).content,
      'What did I ask before?'
    );

    const invalidClear = await fetch(
      `${appBaseUrl}/api/chat/invalid`,
      { method: 'DELETE' }
    );

    assert.equal(invalidClear.status, 400);
  }
);

test(
  'returns a clear configuration error when the OpenRouter key is missing',
  async () => {
    const missingKeyApp = await startApp({ apiKey: '' });

    try {
      const healthResponse = await fetch(
        `${missingKeyApp.baseUrl}/api/health`
      );

      assert.equal(healthResponse.status, 200);

      assert.equal(
        (await healthResponse.json()).apiKeyConfigured,
        false
      );

      const response = await fetch(
        `${missingKeyApp.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            message: 'Hello',
            sessionId: makeSessionId('missing-key')
          })
        }
      );

      assert.equal(response.status, 503);

      assert.match(
        (await response.json()).error,
        /openrouter is not configured/i
      );
    } finally {
      await stopChild(missingKeyApp.child);
    }
  }
);