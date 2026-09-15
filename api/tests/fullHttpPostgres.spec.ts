import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { AgentServiceClient } from '../../agent-runtime/src/serviceClient.js';
import { runClaimedInvestigation } from '../../agent-runtime/src/worker.js';

test('HTTP service, scoped MCP, worker and local model persist one conversation', async () => {
  const dbUrl = process.env.PGSTAT_FULL_AI_TEST_URL;
  assert.ok(dbUrl, 'PGSTAT_FULL_AI_TEST_URL must be a fresh disposable PostgreSQL database');
  const realEvidence = process.env.PGSTAT_FULL_AI_REAL_EVIDENCE === 'true';
  const parsed = new URL(dbUrl);
  Object.assign(process.env, {
    PGSTAT_DB_HOST: parsed.hostname, PGSTAT_DB_PORT: parsed.port,
    PGSTAT_DB_NAME: parsed.pathname.slice(1), PGSTAT_DB_USER: parsed.username,
    PGSTAT_DB_PASSWORD: parsed.password,
    PGSTAT_AGENT_SERVICE_SECRET: 'disposable-service-secret-12345678901234567890',
    PGSTAT_JWT_SECRET: 'disposable-admin-jwt-secret-123456789012345',
  });
  const database = new Pool({ connectionString: dbUrl });
  const priorCwd = process.cwd();
  let apiServer: ReturnType<express.Express['listen']> | undefined;
  let apiPool: Pool | undefined;
  let modelCalls = 0;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(request.url, '/api/chat');
    assert.equal(input.stream, false);
    modelCalls++;
    const cited = [...String(input.messages?.[1]?.content ?? '').matchAll(/evidence_id=(\d+)/g)]
      .map(match => match[1]).at(-1) ?? '1';
    const content = modelCalls === 1
      ? { tools: [{ name: 'get_autovacuum_overview', arguments: {} }],
          reason: 'Sayaç ve kapsamı görmek gerekir.', unavailable_capabilities: [] }
      : { conclusion: 'Autovacuum kanıtı okundu; neden bilinmiyor.', confidence: 'low',
          confidence_reason: 'Kapsam tek pencereyle sınırlı.',
          observed_facts: [{ text: 'Autovacuum overview yanıtı kaydedildi.', evidence_id: cited }],
          interpretations: ['Kapsam yorumlanmalı.'], hypotheses: [],
          limitations: ['Sayaç nedensellik kanıtı değildir.'] };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ message: { content: JSON.stringify(content) },
      prompt_eval_count: 100, eval_count: 50 }));
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelAddress = model.address();
  assert.ok(modelAddress && typeof modelAddress !== 'string');
  try {
    if (!realEvidence) {
      await database.query('create schema control');
      await database.query('create table control.instance_inventory (instance_pk bigint primary key)');
      for (const name of ['V120__ai_investigation_and_telemetry_improvement.sql',
        'V121__ai_provider_connection.sql', 'V123__investigation_worker_claim.sql',
        'V124__agent_evidence_snapshot_and_result_reason.sql']) {
        await database.query(await readFile(`../db/migrations/${name}`, 'utf8'));
      }
      await database.query('insert into control.instance_inventory values (1)');
    }
    await database.query(`insert into agent.provider_connection (provider, model_name, base_url)
      values ('ollama', 'fixture-model', $1)
      on conflict (provider) do update set model_name=excluded.model_name,
        base_url=excluded.base_url, is_enabled=true`, [`http://127.0.0.1:${modelAddress.port}`]);
    const from = realEvidence ? '2026-03-10T00:00:00.000Z' : '2026-09-14T00:00:00.000Z';
    const to = realEvidence ? '2026-03-11T00:00:00.000Z' : '2026-09-15T00:00:00.000Z';
    const investigationId = (await database.query(`insert into agent.investigation
      (question, instance_pk, time_from, time_to, model_provider, status)
      values ('Autovacuum çalıştı mı?', 1, $1, $2, 'ollama', 'queued')
      returning investigation_id`, [from, to])).rows[0].investigation_id;
    const [{ default: serviceRouter }, { requireEvidenceAccess }, { pool },
      { default: actualEvidenceRouter }] = await Promise.all([
      import('../src/routes/agent-service.ts'),
      import('../src/config/agentServiceAuth.ts'),
      import('../src/config/database.ts'),
      import('../src/routes/agent-evidence.ts'),
    ]);
    apiPool = pool;
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.use('/api/agent-service', serviceRouter);
    const evidence = express.Router();
    evidence.get('/instances', (_req, res) => res.json({ schema_version: '1.0.0',
      capability: 'find_instance', data: [{ instance_pk: '1', display_name: 'Fixture' }] }));
    const reply = (capability: string) => (req: express.Request, res: express.Response) =>
      res.json({ schema_version: '1.0.0', capability, status: 'ok',
        target: { instance_pk: '1' }, requested_range: { from: req.query.from, to: req.query.to },
        data: { activity: { autovacuum_count: '2' } }, coverage: [], limitations: [], gap_candidates: [] });
    evidence.get('/:instance/telemetry-coverage', reply('telemetry_coverage'));
    evidence.get('/:instance/autovacuum-overview', reply('autovacuum_overview'));
    app.use('/api/agent-evidence', requireEvidenceAccess,
      realEvidence ? actualEvidenceRouter : evidence);
    apiServer = app.listen(0, '127.0.0.1');
    if (!apiServer.listening) await new Promise<void>((resolve, reject) => {
      apiServer!.once('listening', resolve); apiServer!.once('error', reject);
    });
    const address = apiServer.address();
    assert.ok(address && typeof address !== 'string');
    process.env.PGSTAT_AGENT_API_URL = `http://127.0.0.1:${address.port}`;
    const service = new AgentServiceClient(process.env.PGSTAT_AGENT_API_URL,
      process.env.PGSTAT_AGENT_SERVICE_SECRET, 'worker-full-test');
    const claim = await service.claim();
    assert.ok(claim);
    assert.equal(claim.investigation.investigation_id, investigationId);
    process.chdir('../agent-runtime');
    assert.deepEqual(await runClaimedInvestigation(service, claim),
      { outcome: 'completed', status: 'completed' });
    assert.equal(modelCalls, 2);
    const rows = await database.query(`select i.status, r.conclusion,
      (select count(*)::int from agent.investigation_evidence e
       where e.investigation_id=i.investigation_id) as evidence_count,
      (select count(*)::int from agent.investigation_message m
       where m.investigation_id=i.investigation_id and m.role='assistant') as assistant_count
      from agent.investigation i join agent.investigation_result r using (investigation_id)
      where i.investigation_id=$1`, [investigationId]);
    assert.equal(rows.rows[0].status, 'completed');
    assert.equal(rows.rows[0].evidence_count, 2);
    assert.equal(rows.rows[0].assistant_count, 1);
    assert.match(rows.rows[0].conclusion, /Autovacuum kanıtı/);
  } finally {
    process.chdir(priorCwd);
    if (apiServer?.listening) await new Promise<void>(resolve => apiServer!.close(() => resolve()));
    if (apiPool) await apiPool.end();
    await database.end();
    await new Promise<void>(resolve => model.close(() => resolve()));
  }
});
