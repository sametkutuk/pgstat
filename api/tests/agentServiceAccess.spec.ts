import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';

test('scoped service evidence access over real HTTP and disposable PostgreSQL', async () => {
  const url = process.env.PGSTAT_AGENT_SERVICE_TEST_URL;
  assert.ok(url, 'PGSTAT_AGENT_SERVICE_TEST_URL must point to a new disposable database');
  const parsed = new URL(url);
  process.env.PGSTAT_DB_HOST = parsed.hostname;
  process.env.PGSTAT_DB_PORT = parsed.port;
  process.env.PGSTAT_DB_NAME = parsed.pathname.slice(1);
  process.env.PGSTAT_DB_USER = decodeURIComponent(parsed.username);
  process.env.PGSTAT_DB_PASSWORD = decodeURIComponent(parsed.password);
  process.env.PGSTAT_AGENT_SERVICE_SECRET = 'disposable-service-secret-12345678901234567890';
  process.env.PGSTAT_JWT_SECRET = 'disposable-admin-jwt-secret-123456789012345';

  const fixture = new Pool({ connectionString: url });
  let server: ReturnType<express.Express['listen']> | undefined;
  let applicationPool: Pool | undefined;
  try {
    await fixture.query('create schema control');
    await fixture.query(`create table control.instance_inventory
      (instance_pk bigint primary key, instance_id text, display_name text, environment text, is_active boolean)`);
    await fixture.query(`create table control.instance_capability
      (instance_pk bigint primary key, pg_major int, server_version_num int, pgss_status text)`);
    await fixture.query(await readFile('../db/migrations/V120__ai_investigation_and_telemetry_improvement.sql', 'utf8'));
    await fixture.query(await readFile('../db/migrations/V123__investigation_worker_claim.sql', 'utf8'));
    await fixture.query(`insert into control.instance_inventory values
      (1,'one','One','test',true),(2,'two','Two','test',true),
      (9007199254740993,'large','Large','test',true)`);
    const from = '2026-09-14T00:00:00.000Z';
    const to = '2026-09-15T00:00:00.000Z';
    const id = (await fixture.query(`insert into agent.investigation
      (question, instance_pk, time_from, time_to) values ('Test', 1, $1, $2)
      returning investigation_id`, [from, to])).rows[0].investigation_id;

    const [{ default: serviceRoutes }, { default: evidenceRoutes }, { requireEvidenceAccess }, { pool }] =
      await Promise.all([import('../src/routes/agent-service'), import('../src/routes/agent-evidence'),
        import('../src/config/agentServiceAuth'), import('../src/config/database')]);
    applicationPool = pool;
    const app = express();
    app.use(express.json());
    app.use('/api/agent-service', serviceRoutes);
    app.use('/api/agent-evidence', requireEvidenceAccess, evidenceRoutes);
    server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>((resolve, reject) => {
      server!.once('listening', resolve);
      server!.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const root = `http://127.0.0.1:${address.port}`;
    const call = (path: string, token: string, options: RequestInit = {}) =>
      fetch(root + path, { ...options, headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json', ...options.headers } });

    const denied = await call('/api/agent-service/claim', 'wrong',
      { method: 'POST', body: JSON.stringify({ worker_id: 'worker-test-1' }) });
    assert.equal(denied.status, 401);
    const claimed = await call('/api/agent-service/claim', process.env.PGSTAT_AGENT_SERVICE_SECRET,
      { method: 'POST', body: JSON.stringify({ worker_id: 'worker-test-1' }) });
    assert.equal(claimed.status, 200);
    const job = await claimed.json() as { evidence_token: string; investigation: { investigation_id: string } };
    assert.equal(job.investigation.investigation_id, id);
    assert.ok(job.evidence_token);

    const instances = await call('/api/agent-evidence/instances', job.evidence_token);
    assert.equal(instances.status, 200);
    assert.deepEqual((await instances.json() as { data: { instance_pk: string }[] }).data.map(x => x.instance_pk), ['1']);
    const proper = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    assert.equal((await call('/api/agent-evidence/2/autovacuum-overview' + proper, job.evidence_token)).status, 403);
    assert.equal((await call('/api/agent-evidence/1/autovacuum-overview' +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent('2026-09-15T01:00:00.000Z')}`,
      job.evidence_token)).status, 403);
    assert.equal((await call('/api/agent-evidence/1/not-a-tool' + proper, job.evidence_token)).status, 403);
    assert.equal((await call('/api/agent-evidence/instances', process.env.PGSTAT_AGENT_SERVICE_SECRET)).status, 401);
    await fixture.query("update agent.investigation set status = 'cancelled' where investigation_id = $1", [id]);
    assert.equal((await call('/api/agent-evidence/instances', job.evidence_token)).status, 403);
    const timeoutId = (await fixture.query(`insert into agent.investigation
      (question, instance_pk, time_from, time_to) values ('Slow model', 1, $1, $2)
      returning investigation_id`, [from, to])).rows[0].investigation_id;
    const timeoutClaim = await call('/api/agent-service/claim', process.env.PGSTAT_AGENT_SERVICE_SECRET,
      { method: 'POST', body: JSON.stringify({ worker_id: 'worker-test-1' }) });
    assert.equal(timeoutClaim.status, 200);
    const timeout = await call(`/api/agent-service/investigations/${timeoutId}/fail`,
      process.env.PGSTAT_AGENT_SERVICE_SECRET,
      { method: 'POST', body: JSON.stringify({ worker_id: 'worker-test-1', code: 'JOB_DEADLINE',
        detail: 'Disposable deadline test' }) });
    assert.equal(timeout.status, 200);
    assert.equal((await fixture.query('select status from agent.investigation where investigation_id=$1',
      [timeoutId])).rows[0].status, 'timed_out');
    const largeId = (await fixture.query(`insert into agent.investigation
      (question, instance_pk, time_from, time_to) values ('Bigint target', 9007199254740993, $1, $2)
      returning investigation_id`, [from, to])).rows[0].investigation_id;
    const largeClaim = await call('/api/agent-service/claim', process.env.PGSTAT_AGENT_SERVICE_SECRET,
      { method: 'POST', body: JSON.stringify({ worker_id: 'worker-test-1' }) });
    assert.equal(largeClaim.status, 200);
    const largeToken = (await largeClaim.json() as { evidence_token: string;
      investigation: { investigation_id: string } }).evidence_token;
    assert.equal((await call('/api/agent-evidence/instances', largeToken).then(response => response.json()) as
      { data: { instance_pk: string }[] }).data[0].instance_pk, '9007199254740993');
    assert.equal((await call('/api/agent-evidence/9007199254740992/autovacuum-overview' + proper,
      largeToken)).status, 403);
  } finally {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    if (applicationPool) await applicationPool.end();
    await fixture.end();
  }
});
