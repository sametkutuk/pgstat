package com.pgstat.collector.repository;

import com.pgstat.collector.model.InstanceCapability;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.OffsetDateTime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CapabilityRepositoryTest {

    @Test
    void upsertPersistsPgssEvidenceAndClearsStaleErrorTimestampOnSuccess() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        CapabilityRepository repository = new CapabilityRepository(jdbc);
        OffsetDateTime verifiedAt = OffsetDateTime.parse("2026-09-14T12:00:00Z");
        InstanceCapability capability = new InstanceCapability(
                42L, 180000, 18, 123L, true, true,
                true, true, true, true,
                "available", "1.12", "postgres", true, 1, verifiedAt,
                "auto", "pg17_18", null, null, verifiedAt, null, null);

        repository.upsert(capability);

        ArgumentCaptor<String> sql = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<Object[]> args = ArgumentCaptor.forClass(Object[].class);
        verify(jdbc).update(sql.capture(), args.capture());

        assertThat(sql.getValue())
                .contains("pgss_extversion")
                .contains("pgss_collection_dbname")
                .contains("pgss_catalog_version")
                .contains("pgss_checked_at")
                .contains("last_error_at               = null");
        assertThat(args.getValue()).containsSubsequence(
                "available", "1.12", "postgres", true, 1, verifiedAt);
    }

    @Test
    void collectionDatabaseUsesDiscoveryEvidenceAndOnlyFallsBackForLegacyRows() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        CapabilityRepository repository = new CapabilityRepository(jdbc);
        when(jdbc.queryForObject(anyString(), eq(String.class), eq(7L)))
                .thenReturn("appdb", null);

        assertThat(repository.resolvePgssCollectionDbname(7L, "postgres")).isEqualTo("appdb");
        assertThat(repository.resolvePgssCollectionDbname(7L, "postgres")).isEqualTo("postgres");
    }
}
