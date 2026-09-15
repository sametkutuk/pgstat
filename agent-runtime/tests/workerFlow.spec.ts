import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { AgentServiceClient } from '../src/serviceClient.js';
import { runClaimedInvestigation } from '../src/worker.js';

test('worker calls real MCP transport, local model, records evidence and a referenced answer', async () => {
  const operations: string[] = [];
  const modelPrompts: string[] = [];
  const from = '2026-09-14T00:00:00.000Z';
  const to = '2026-09-15T00:00:00.000Z';
  let port = 0;
  let modelStage = 0;
  let evidenceCount = 0;
  let completed: Record<string, unknown> | null = null;
  const api = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const path = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    operations.push(path.pathname);
    res.setHeader('content-type', 'application/json');
    const send = (status: number, value: unknown) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (path.pathname.endsWith('/provider')) {
      send(200, { provider: 'ollama', model: 'fixture-model',
        base_url: `http://127.0.0.1:${port}`, api_key: null }); return;
    }
    if (path.pathname.endsWith('/advance')) { send(200, { outcome: 'advanced' }); return; }
    if (path.pathname.endsWith('/heartbeat')) { send(200, { outcome: { outcome: 'advanced' }, evidence_token: 'token' }); return; }
    if (path.pathname.endsWith('/evidence')) {
      evidenceCount++;
      assert.equal(body.worker_id, 'worker-test-1');
      assert.equal(body.envelope.target.instance_pk, 12);
      send(201, { evidence_id: String(evidenceCount), tool_call_id: String(evidenceCount) }); return;
    }
    if (path.pathname.endsWith('/complete')) { completed = body; send(200, { outcome: 'completed', status: 'completed' }); return; }
    if (path.pathname.endsWith('/fail')) { send(200, { outcome: 'advanced' }); return; }
    if (path.pathname === '/api/chat') {
      modelStage++;
      assert.equal(body.format, 'json');
      assert.equal(body.stream, false);
      modelPrompts.push(body.messages[1].content);
      const text = modelStage === 1
        ? JSON.stringify({ tools: [{ name: 'get_autovacuum_overview', arguments: {} },
          { name: 'find_tables_needing_vacuum_attention', arguments: {} }], reason: 'Overview ve adaylar gerekli.',
          unavailable_capabilities: [] })
        : modelStage === 2 ? JSON.stringify({ table: null, reason: 'Ek tablo kanıtı gerekmedi.' })
          : JSON.stringify({ conclusion: 'Sayaç artışı var; neden belirsiz.', confidence: 'low',
            confidence_reason: 'Örnekleme sınırlı.',
            observed_facts: [{ text: 'İki autovacuum', evidence_id: '2' }],
            interpretations: ['Aktivite görüldü.'], hypotheses: ['Eşik etkisi olabilir.'],
            limitations: ['Worker gözlemi nedensellik kanıtı değildir.'] });
      send(200, { message: { content: text }, prompt_eval_count: 100, eval_count: 50 }); return;
    }
    if (path.pathname.startsWith('/api/agent-evidence')) {
      assert.equal(req.headers.authorization, 'Bearer disposable-scoped-evidence-token');
      if (path.pathname.endsWith('/instances')) {
        send(200, { schema_version: '1.0.0', capability: 'find_instance',
          data: [{ instance_pk: 12, display_name: 'Fixture' }] }); return;
      }
      assert.equal(path.searchParams.get('from'), from);
      assert.equal(path.searchParams.get('to'), to);
      const capability = path.pathname.endsWith('/telemetry-coverage') ? 'telemetry_coverage'
        : path.pathname.endsWith('/autovacuum-overview') ? 'autovacuum_overview' : 'vacuum_candidates';
      send(200, { schema_version: '1.0.0', capability, status: 'ok', target: { instance_pk: 12 },
        requested_range: { from, to }, data: capability === 'vacuum_candidates' ? { candidates: [] }
          : { activity: { autovacuum_count: '2' } }, coverage: [], limitations: [], gap_candidates: [] }); return;
    }
    send(404, { error: 'unknown fixture endpoint' });
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  port = address.port;
  const priorUrl = process.env.PGSTAT_AGENT_API_URL;
  process.env.PGSTAT_AGENT_API_URL = `http://127.0.0.1:${port}`;
  try {
    const service = new AgentServiceClient(process.env.PGSTAT_AGENT_API_URL,
      'disposable-service-secret-12345678901234567890', 'worker-test-1');
    const result = await runClaimedInvestigation(service, {
      investigation: { investigation_id: '9', question: 'Son 24 saatte autovacuum var mı? password=supersecret',
        instance_pk: '12', dbid: null, time_from: from, time_to: to, status: 'planning' },
      evidence_token: 'disposable-scoped-evidence-token',
    });
    assert.deepEqual(result, { outcome: 'completed', status: 'completed' });
    assert.equal(modelStage, 3);
    assert.equal(evidenceCount, 3);
    assert.ok(completed);
    const answer = (completed as Record<string, any>).result;
    assert.equal(answer.observed_facts[0].evidence_id, '2');
    assert.equal((completed as Record<string, any>).input_tokens, 300);
    assert.equal((completed as Record<string, any>).output_tokens, 150);
    assert.ok(modelPrompts.every(prompt => !prompt.includes('supersecret')));
    assert.ok(operations.includes('/api/agent-evidence/12/vacuum-candidates'));
    assert.ok(!operations.includes('/api/agent-service/investigations/9/fail'));
  } finally {
    if (priorUrl === undefined) delete process.env.PGSTAT_AGENT_API_URL;
    else process.env.PGSTAT_AGENT_API_URL = priorUrl;
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  }
});
