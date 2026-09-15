import type { Pool } from 'pg';

/** One concrete occurrence supplies all four summary fields: never mix research contexts. */
export async function listImprovements(database: Pool, status: string | null, limit: number, offset: number) {
  const result = await database.query(
    `select ti.*,
            counts.affected_investigations, counts.affected_instances,
            latest.investigation_id as latest_investigation_id,
            latest.requested_text, latest.available_text, latest.missing_text, latest.reason_text
     from (
       select * from agent.telemetry_improvement
       where ($1::text is null or status = $1)
       order by case status when 'review_required' then 1 when 'accepted' then 2
                  when 'in_progress' then 3 when 'resolved' then 4 else 5 end,
                last_detected_at desc, improvement_id desc
       limit $2 offset $3
     ) ti
     left join lateral (
       select count(distinct investigation_id)::int as affected_investigations,
              count(distinct instance_pk)::int as affected_instances
       from agent.telemetry_improvement_occurrence where improvement_id = ti.improvement_id
     ) counts on true
     left join lateral (
       select investigation_id, requested_text, available_text, missing_text, reason_text
       from agent.telemetry_improvement_occurrence where improvement_id = ti.improvement_id
       order by detected_at desc, occurrence_id desc limit 1
     ) latest on true
     order by case ti.status when 'review_required' then 1 when 'accepted' then 2
                when 'in_progress' then 3 when 'resolved' then 4 else 5 end,
              ti.last_detected_at desc, ti.improvement_id desc`, [status, limit, offset]);
  return result.rows;
}
