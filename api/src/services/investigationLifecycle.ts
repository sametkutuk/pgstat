import type { Pool } from 'pg';

// needs_clarification dahildir: kullaniciya soru sorulmus ama cevaplanmamis
// bir arastirma da iptal edilebilmelidir, aksi halde konusmada asili kalir.
export const ACTIVE_INVESTIGATION_STATES = [
  'needs_clarification', 'queued', 'planning', 'collecting_evidence', 'interpreting',
];

// Serialize cancellation with other writers. Worker transitions must also guard
// their expected state; this does not abort an already dispatched provider request.
export async function cancelInvestigation(database: Pool, id: string) {
  const client = await database.connect();
  try {
    await client.query('begin');
    const existing = await client.query(
      'select investigation_id, status, completed_at from agent.investigation where investigation_id = $1 for update', [id]);
    const row = existing.rows[0];
    if (!row || row.status === 'cancelled' || !ACTIVE_INVESTIGATION_STATES.includes(row.status)) {
      await client.query('commit');
      return { outcome: !row ? 'not_found' : row.status === 'cancelled' ? 'cancelled' : 'terminal', investigation: row };
    }
    const updated = await client.query(
      `update agent.investigation set status = 'cancelled', completed_at = now(), updated_at = now()
       where investigation_id = $1 returning investigation_id, status, completed_at`, [id]);
    await client.query(
      `insert into agent.investigation_message (investigation_id, role, content)
       values ($1, 'system', 'Araştırma kullanıcı tarafından iptal edildi.')`, [id]);
    await client.query('commit');
    return { outcome: 'cancelled', investigation: updated.rows[0] };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
