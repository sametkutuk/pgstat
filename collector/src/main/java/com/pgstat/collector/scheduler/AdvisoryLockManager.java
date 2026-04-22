package com.pgstat.collector.scheduler;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Merkezi PostgreSQL uzerinde advisory lock yonetimi.
 *
 * Her job type icin pg_try_advisory_lock(hashtext('pgstats_job_' + jobType)) ile
 * session-level lock alinir. Lock alinamazsa ayni job'in baska bir kopyasi calisiyor demektir.
 *
 * Lock session kapandiginda otomatik serbest kalir; crash durumunda da PG temizler.
 * AutoCloseable ile try-with-resources kullanimi desteklenir.
 */
@Component
public class AdvisoryLockManager {

    private static final Logger log = LoggerFactory.getLogger(AdvisoryLockManager.class);

    private final JdbcTemplate jdbc;

    public AdvisoryLockManager(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Belirtilen job type icin advisory lock almaya calisir.
     * Lock alinirsa AutoCloseable handle doner; alinamazsa null doner.
     *
     * @param jobType job tipi (cluster, statements, db_objects, rollup)
     * @return lock handle (AutoCloseable) veya null (lock alinamadiysa)
     */
    public LockHandle tryAcquire(String jobType) {
        String lockName = "pgstats_job_" + jobType;

        Boolean acquired = jdbc.queryForObject(
            "select pg_try_advisory_lock(hashtext(?))",
            Boolean.class,
            lockName
        );

        if (Boolean.TRUE.equals(acquired)) {
            log.debug("Advisory lock alindi: {}", lockName);
            return new LockHandle(jdbc, lockName);
        }

        log.info("Advisory lock alinamadi (baska kopya calisiyor): {}", lockName);
        return null;
    }

    /**
     * AutoCloseable lock handle — try-with-resources ile kullanilir.
     * close() cagirildiginda advisory lock serbest birakilir.
     */
    public static class LockHandle implements AutoCloseable {

        private final JdbcTemplate jdbc;
        private final String lockName;
        private volatile boolean released = false;

        LockHandle(JdbcTemplate jdbc, String lockName) {
            this.jdbc = jdbc;
            this.lockName = lockName;
        }

        @Override
        public void close() {
            if (!released) {
                released = true;
                try {
                    jdbc.execute("select pg_advisory_unlock(hashtext('" + lockName + "'))");
                    log.debug("Advisory lock serbest birakildi: {}", lockName);
                } catch (Exception e) {
                    // Session kapanirsa PG zaten temizler — loglayip devam et
                    log.warn("Advisory lock serbest birakma hatasi: {} — {}", lockName, e.getMessage());
                }
            }
        }

        private static final Logger log = LoggerFactory.getLogger(LockHandle.class);
    }
}
