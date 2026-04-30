package com.pgstat.collector.scheduler;

import org.junit.jupiter.api.Test;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class AdvisoryLockManagerTest {

    @Test
    void keepsSameConnectionUntilUnlock() throws Exception {
        DataSource dataSource = mock(DataSource.class);
        Connection connection = mock(Connection.class);
        PreparedStatement lockStatement = mock(PreparedStatement.class);
        PreparedStatement unlockStatement = mock(PreparedStatement.class);
        ResultSet resultSet = mock(ResultSet.class);

        when(dataSource.getConnection()).thenReturn(connection);
        when(connection.prepareStatement(anyString()))
            .thenReturn(lockStatement)
            .thenReturn(unlockStatement);
        when(lockStatement.executeQuery()).thenReturn(resultSet);
        when(resultSet.next()).thenReturn(true);
        when(resultSet.getBoolean(1)).thenReturn(true);

        AdvisoryLockManager manager = new AdvisoryLockManager(dataSource);

        try (AdvisoryLockManager.LockHandle lock = manager.tryAcquire("rollup")) {
            assertThat(lock).isNotNull();
        }

        verify(lockStatement).setString(1, "pgstats_job_rollup");
        verify(unlockStatement).setString(1, "pgstats_job_rollup");
        verify(unlockStatement).execute();
        verify(connection).close();
    }

    @Test
    void closesConnectionWhenLockIsNotAcquired() throws Exception {
        DataSource dataSource = mock(DataSource.class);
        Connection connection = mock(Connection.class);
        PreparedStatement lockStatement = mock(PreparedStatement.class);
        ResultSet resultSet = mock(ResultSet.class);

        when(dataSource.getConnection()).thenReturn(connection);
        when(connection.prepareStatement(anyString())).thenReturn(lockStatement);
        when(lockStatement.executeQuery()).thenReturn(resultSet);
        when(resultSet.next()).thenReturn(true);
        when(resultSet.getBoolean(1)).thenReturn(false);

        AdvisoryLockManager manager = new AdvisoryLockManager(dataSource);

        AdvisoryLockManager.LockHandle lock = manager.tryAcquire("rollup");

        assertThat(lock).isNull();
        verify(lockStatement).setString(1, "pgstats_job_rollup");
        verify(connection).close();
    }

    @Test
    void closeIsIdempotent() throws Exception {
        DataSource dataSource = mock(DataSource.class);
        Connection connection = mock(Connection.class);
        PreparedStatement lockStatement = mock(PreparedStatement.class);
        PreparedStatement unlockStatement = mock(PreparedStatement.class);
        PreparedStatement unexpectedStatement = mock(PreparedStatement.class);
        ResultSet resultSet = mock(ResultSet.class);

        when(dataSource.getConnection()).thenReturn(connection);
        when(connection.prepareStatement(anyString()))
            .thenReturn(lockStatement)
            .thenReturn(unlockStatement)
            .thenReturn(unexpectedStatement);
        when(lockStatement.executeQuery()).thenReturn(resultSet);
        when(resultSet.next()).thenReturn(true);
        when(resultSet.getBoolean(1)).thenReturn(true);

        AdvisoryLockManager manager = new AdvisoryLockManager(dataSource);
        AdvisoryLockManager.LockHandle lock = manager.tryAcquire("cluster");

        lock.close();
        lock.close();

        verify(unlockStatement).setString(1, "pgstats_job_cluster");
        verify(unlockStatement).execute();
        verify(connection).close();
        verifyNoInteractions(unexpectedStatement);
    }
}
