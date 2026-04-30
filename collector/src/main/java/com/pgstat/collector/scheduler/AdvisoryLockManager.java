package com.pgstat.collector.scheduler;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.concurrent.atomic.AtomicBoolean;

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

    private final DataSource dataSource;

    public AdvisoryLockManager(DataSource dataSource) {
        this.dataSource = dataSource;
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
        Connection connection = null;

        try {
            connection = dataSource.getConnection();

            boolean acquired;
            try (PreparedStatement stmt = connection.prepareStatement(
                    "select pg_try_advisory_lock(hashtext(?))")) {
                stmt.setString(1, lockName);
                try (ResultSet rs = stmt.executeQuery()) {
                    acquired = rs.next() && rs.getBoolean(1);
                }
            }

            if (acquired) {
                log.debug("Advisory lock alindi: {}", lockName);
                return new LockHandle(connection, lockName);
            }

            log.info("Advisory lock alinamadi (baska kopya calisiyor): {}", lockName);
            closeQuietly(connection, lockName);
            return null;
        } catch (Exception e) {
            closeQuietly(connection, lockName);
            throw new IllegalStateException("Advisory lock alinirken hata: " + lockName, e);
        }
    }

    /**
     * AutoCloseable lock handle. Job bitene kadar lock'i alan connection elde tutulur.
     * close() cagirildiginda unlock ayni connection uzerinden yapilir.
     */
    public static class LockHandle implements AutoCloseable {

        private static final Logger log = LoggerFactory.getLogger(LockHandle.class);

        private final Connection connection;
        private final String lockName;
        private final AtomicBoolean released = new AtomicBoolean(false);

        LockHandle(Connection connection, String lockName) {
            this.connection = connection;
            this.lockName = lockName;
        }

        @Override
        public void close() {
            if (released.compareAndSet(false, true)) {
                try {
                    try (PreparedStatement stmt = connection.prepareStatement(
                            "select pg_advisory_unlock(hashtext(?))")) {
                        stmt.setString(1, lockName);
                        stmt.execute();
                    }
                    log.debug("Advisory lock serbest birakildi: {}", lockName);
                } catch (Exception e) {
                    // Session kapanirsa PG zaten temizler; loglayip connection'i kapatmaya devam et.
                    log.warn("Advisory lock serbest birakma hatasi: {} - {}", lockName, e.getMessage());
                } finally {
                    closeQuietly(connection, lockName);
                }
            }
        }
    }

    private static void closeQuietly(Connection connection, String lockName) {
        if (connection == null) return;
        try {
            connection.close();
        } catch (Exception e) {
            log.warn("Advisory lock connection kapatma hatasi: {} - {}", lockName, e.getMessage());
        }
    }
}
