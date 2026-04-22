package com.pgstat.collector.repository;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * ops.job_run ve ops.job_run_instance islemleri.
 * Job baslatma, bitirme ve instance bazli sonuc kaydi.
 * Mimari dok: satir 3207-3245
 */
@Repository
public class OpsRepository {

    private final JdbcTemplate jdbc;

    public OpsRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // -------------------------------------------------------------------------
    // job_run
    // -------------------------------------------------------------------------

    /**
     * Yeni job_run kaydı olusturur (status = 'running').
     * @return olusturulan job_run_id
     */
    public long startJobRun(String jobType, String workerHostname) {
        return jdbc.queryForObject("""
            insert into ops.job_run (job_type, started_at, status, worker_hostname)
            values (?, now(), 'running', ?)
            returning job_run_id
            """,
            Long.class,
            jobType, workerHostname
        );
    }

    /**
     * Job_run kaydini gunceller (bitis bilgileri).
     *
     * @param jobRunId            job_run PK
     * @param status              sonuc: 'success' | 'failed' | 'partial'
     * @param rowsWritten         yazilan toplam satir sayisi
     * @param instancesSucceeded  basarili instance sayisi
     * @param instancesFailed     basarisiz instance sayisi
     * @param errorText           hata mesaji (null olabilir)
     */
    public void finishJobRun(long jobRunId, String status, long rowsWritten,
                             int instancesSucceeded, int instancesFailed,
                             String errorText) {
        jdbc.update("""
            update ops.job_run
            set finished_at         = now(),
                status              = ?,
                rows_written        = ?,
                instances_succeeded = ?,
                instances_failed    = ?,
                error_text          = ?
            where job_run_id = ?
            """,
            status, rowsWritten, instancesSucceeded, instancesFailed,
            errorText, jobRunId
        );
    }

    // -------------------------------------------------------------------------
    // job_run_instance
    // -------------------------------------------------------------------------

    /**
     * Instance bazli job_run kaydı olusturur (status = 'running').
     * @return olusturulan job_run_instance_id
     */
    public long startJobRunInstance(long jobRunId, long instancePk, String jobType) {
        return jdbc.queryForObject("""
            insert into ops.job_run_instance (
              job_run_id, instance_pk, job_type, started_at, status
            )
            values (?, ?, ?, now(), 'running')
            returning job_run_instance_id
            """,
            Long.class,
            jobRunId, instancePk, jobType
        );
    }

    /**
     * Instance bazli job_run kaydini gunceller.
     *
     * @param jobRunInstanceId     PK
     * @param status               sonuc: 'success' | 'failed' | 'partial' | 'skipped'
     * @param rowsWritten          yazilan satir sayisi
     * @param newSeriesCount       yeni statement_series sayisi
     * @param newQueryTextCount    yeni query_text sayisi
     * @param errorText            hata mesaji (null olabilir)
     */
    public void finishJobRunInstance(long jobRunInstanceId, String status,
                                     long rowsWritten, int newSeriesCount,
                                     int newQueryTextCount, String errorText) {
        jdbc.update("""
            update ops.job_run_instance
            set finished_at          = now(),
                status               = ?,
                rows_written         = ?,
                new_series_count     = ?,
                new_query_text_count = ?,
                error_text           = ?
            where job_run_instance_id = ?
            """,
            status, rowsWritten, newSeriesCount, newQueryTextCount,
            errorText, jobRunInstanceId
        );
    }
}
