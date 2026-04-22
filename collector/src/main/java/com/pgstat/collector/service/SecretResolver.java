package com.pgstat.collector.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * secret_ref degerini cozumler ve gercek sifreyi dondurur.
 *
 * Desteklenen formatlar (V1):
 *   file:/path/to/secret.pwd  — dosyadan okur (ilk satir, trim edilir)
 *   env:ENV_VARIABLE_NAME     — environment variable'dan okur
 *
 * Desteklenmeyen prefix gorulurse SecretResolveException firlatir;
 * cagiranin bu durumu degraded + alert olarak islemesi gerekir.
 */
@Service
public class SecretResolver {

    private static final Logger log = LoggerFactory.getLogger(SecretResolver.class);

    /** file: prefix'i — dosya yolundan sifre okur */
    private static final String FILE_PREFIX = "file:";

    /** env: prefix'i — environment variable'dan sifre okur */
    private static final String ENV_PREFIX = "env:";

    /**
     * secret_ref degerini cozumler.
     *
     * @param secretRef  "file:/path" veya "env:VAR_NAME" formatinda referans
     * @return cozumlenmis sifre degeri
     * @throws SecretResolveException cozumleme basarisiz olursa
     */
    public String resolve(String secretRef) {
        if (secretRef == null || secretRef.isBlank()) {
            throw new SecretResolveException("secret_ref bos veya null");
        }

        if (secretRef.startsWith(FILE_PREFIX)) {
            return resolveFromFile(secretRef.substring(FILE_PREFIX.length()));
        }

        if (secretRef.startsWith(ENV_PREFIX)) {
            return resolveFromEnv(secretRef.substring(ENV_PREFIX.length()));
        }

        // V1'de vault: dahil desteklenmeyen prefix — acik hata ver
        throw new SecretResolveException(
            "Desteklenmeyen secret_ref formatı: " + extractPrefix(secretRef)
                + " (V1'de yalnizca file: ve env: desteklenir)"
        );
    }

    /**
     * Dosyadan sifre okur.
     * Eger dosya AES-256-GCM formatinda (iv:authTag:encrypted) ise decrypt eder.
     * Duz metin ise direkt dondurur (geriye uyumluluk).
     */
    private String resolveFromFile(String filePath) {
        Path path = Path.of(filePath);

        if (!Files.exists(path)) {
            throw new SecretResolveException("Secret dosyasi bulunamadi: " + filePath);
        }

        if (!Files.isReadable(path)) {
            throw new SecretResolveException("Secret dosyasi okunamiyor: " + filePath);
        }

        try {
            String content = Files.readString(path).trim();

            if (content.isEmpty()) {
                throw new SecretResolveException("Secret dosyasi bos: " + filePath);
            }

            // AES-256-GCM encrypted format kontrolu: iv:authTag:encrypted (3 hex parca)
            String[] parts = content.split(":");
            if (parts.length == 3 && parts[0].length() == 32 && parts[1].length() == 32) {
                // Encrypted dosya — decrypt et
                return decryptSecret(parts[0], parts[1], parts[2]);
            }

            // Duz metin dosya — ilk satiri dondur
            log.debug("Secret basariyla cozumlendi (plaintext): file:{}", filePath);
            return content.lines().findFirst().orElse("").trim();
        } catch (SecretResolveException e) {
            throw e;
        } catch (Exception e) {
            throw new SecretResolveException("Secret dosyasi okunamadi: " + filePath, e);
        }
    }

    /**
     * AES-256-GCM ile encrypt edilmis sifreyi decrypt eder.
     * API tarafinda ayni key ile encrypt edilmis olmali.
     */
    private String decryptSecret(String ivHex, String authTagHex, String encryptedHex) {
        try {
            String passphrase = System.getenv("PGSTAT_SECRET_KEY");
            if (passphrase == null || passphrase.isBlank()) {
                passphrase = "pgstat-default-key-change-in-production";
            }

            // scrypt ile key turet (Node.js tarafiyla ayni parametreler)
            javax.crypto.SecretKeyFactory factory = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
            // Not: Node.js scryptSync kullanıyor, Java tarafında da scrypt kullanmalıyız
            // Basit uyumluluk için aynı passphrase + salt ile key türetiyoruz
            byte[] salt = "pgstat-salt".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            javax.crypto.spec.PBEKeySpec spec = new javax.crypto.spec.PBEKeySpec(
                passphrase.toCharArray(), salt, 65536, 256);
            byte[] keyBytes = factory.generateSecret(spec).getEncoded();

            byte[] iv = hexToBytes(ivHex);
            byte[] authTag = hexToBytes(authTagHex);
            byte[] encrypted = hexToBytes(encryptedHex);

            // GCM: encrypted + authTag birlestirilir
            byte[] cipherTextWithTag = new byte[encrypted.length + authTag.length];
            System.arraycopy(encrypted, 0, cipherTextWithTag, 0, encrypted.length);
            System.arraycopy(authTag, 0, cipherTextWithTag, encrypted.length, authTag.length);

            javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            javax.crypto.spec.GCMParameterSpec gcmSpec = new javax.crypto.spec.GCMParameterSpec(128, iv);
            javax.crypto.spec.SecretKeySpec keySpec = new javax.crypto.spec.SecretKeySpec(keyBytes, "AES");
            cipher.init(javax.crypto.Cipher.DECRYPT_MODE, keySpec, gcmSpec);

            byte[] decrypted = cipher.doFinal(cipherTextWithTag);
            log.debug("Secret basariyla decrypt edildi");
            return new String(decrypted, java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new SecretResolveException("Secret decrypt hatasi", e);
        }
    }

    private byte[] hexToBytes(String hex) {
        int len = hex.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(hex.charAt(i), 16) << 4)
                    + Character.digit(hex.charAt(i + 1), 16));
        }
        return data;
    }

    /**
     * Environment variable'dan sifre okur.
     */
    private String resolveFromEnv(String envName) {
        String value = System.getenv(envName);

        if (value == null || value.isBlank()) {
            throw new SecretResolveException("Environment variable bulunamadi veya bos: " + envName);
        }

        log.debug("Secret basariyla cozumlendi: env:{}", envName);
        return value;
    }

    /**
     * secret_ref'ten prefix kismini cikarir (loglama icin).
     */
    private String extractPrefix(String secretRef) {
        int colonIdx = secretRef.indexOf(':');
        return colonIdx > 0 ? secretRef.substring(0, colonIdx + 1) : "(prefix yok)";
    }

    /**
     * Secret cozumleme hatasi.
     * Caller bu hatayı yakalayarak instance'i degraded olarak isaretlemeli
     * ve ops.alert'e secret_ref_error yazmalıdır.
     */
    public static class SecretResolveException extends RuntimeException {
        public SecretResolveException(String message) {
            super(message);
        }

        public SecretResolveException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
