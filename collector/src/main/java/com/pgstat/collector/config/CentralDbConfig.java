package com.pgstat.collector.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

/**
 * Central PG17 veritabani yapilandirmasi.
 *
 * Spring Boot'un auto-configure ettigi HikariCP DataSource'u kullanir.
 * application.yml'deki spring.datasource.* ayarlari otomatik baglanir.
 *
 * Bu sinif ek olarak:
 * - JdbcTemplate bean'ini olusturur (repository'ler bunu inject eder)
 * - CollectorProperties'i aktif eder
 */
@Configuration
@EnableConfigurationProperties(CollectorProperties.class)
public class CentralDbConfig {

    /**
     * Central DB icin JdbcTemplate.
     * Tum repository siniflari bu bean'i kullanarak SQL calistirir.
     * DataSource, Spring Boot tarafindan HikariCP ile auto-configure edilir.
     */
    @Bean
    public JdbcTemplate jdbcTemplate(DataSource dataSource) {
        JdbcTemplate template = new JdbcTemplate(dataSource);
        // Buyuk result set'lerde memory tasmasini onlemek icin fetch size
        template.setFetchSize(500);
        return template;
    }
}
