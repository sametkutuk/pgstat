package com.pgstat.collector;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * pgstat Collector ana uygulama sınıfı.
 * Spring Boot daemon olarak çalışır — web sunucusu yok.
 * @Scheduled metotlar ile periyodik istatistik toplama yapar.
 */
@SpringBootApplication
@EnableScheduling
public class PgstatCollectorApplication {

    public static void main(String[] args) {
        SpringApplication.run(PgstatCollectorApplication.class, args);
    }
}
