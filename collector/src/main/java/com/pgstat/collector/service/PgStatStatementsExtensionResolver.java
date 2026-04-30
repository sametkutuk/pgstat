package com.pgstat.collector.service;

import org.springframework.stereotype.Service;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Resolves pg_stat_statements objects without relying on the session search_path.
 */
@Service
public class PgStatStatementsExtensionResolver {

    public PgStatStatementsExtension resolve(Connection conn) throws SQLException {
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery("""
                 select n.nspname as schema_name, e.extversion
                 from pg_extension e
                 join pg_namespace n on n.oid = e.extnamespace
                 where e.extname = 'pg_stat_statements'
                 """)) {
            if (!rs.next()) {
                return null;
            }
            return new PgStatStatementsExtension(
                rs.getString("schema_name"),
                rs.getString("extversion")
            );
        }
    }

    public static String quoteIdentifier(String identifier) {
        if (identifier == null || identifier.isBlank()) {
            throw new IllegalArgumentException("Identifier cannot be blank");
        }
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    public record PgStatStatementsExtension(String schemaName, String extVersion) {
        public String qualify(String objectName) {
            return quoteIdentifier(schemaName) + "." + quoteIdentifier(objectName);
        }
    }
}
