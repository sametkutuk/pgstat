package com.pgstat.collector.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;

/**
 * Async islem yapilandirmasi.
 *
 * @Scheduled metotlar Spring'in scheduling pool'unda calisir
 * (spring.task.scheduling.pool.size = 4, application.yml'de tanimli).
 *
 * Bu sinif, collector'larin paralel host islemesi icin
 * ayri bir ThreadPoolTaskExecutor tanimlar.
 */
@Configuration
public class SchedulerConfig {

    /**
     * Collector is parcaciklari icin thread pool.
     * JobOrchestrator, due instance'lari bu executor uzerinde paralel calistirir.
     * maxHostConcurrency limiti CompletableFuture ile enforce edilir.
     */
    @Bean(name = "collectorExecutor")
    public Executor collectorExecutor(CollectorProperties props) {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(props.getMaxConcurrentHosts());
        executor.setMaxPoolSize(props.getMaxConcurrentHosts() * 2);
        executor.setQueueCapacity(100);
        executor.setThreadNamePrefix("collector-");
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(30);
        executor.initialize();
        return executor;
    }
}
