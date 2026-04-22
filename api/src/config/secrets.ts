import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// AES-256-GCM ile şifreleme
// Her iki taraf (Node.js API + Java Collector) aynı PBKDF2 parametreleri kullanır
const ALGORITHM = 'aes-256-gcm';
const SECRETS_DIR = process.env.PGSTAT_SECRETS_DIR || join(process.cwd(), 'data', 'secrets');
const SALT = 'pgstat-salt';
const ITERATIONS = 65536;
const KEY_LENGTH = 32;

function getKey(): Buffer {
    const passphrase = process.env.PGSTAT_SECRET_KEY || 'pgstat-default-key-change-in-production';
    return pbkdf2Sync(passphrase, SALT, ITERATIONS, KEY_LENGTH, 'sha256');
}

/** Şifreyi encrypt edip dosyaya yazar, secret_ref döner */
export function saveSecret(instanceId: string, password: string): string {
    const key = getKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    // Format: iv:authTag:encrypted
    const payload = `${iv.toString('hex')}:${authTag}:${encrypted}`;

    if (!existsSync(SECRETS_DIR)) {
        mkdirSync(SECRETS_DIR, { recursive: true });
    }

    const filePath = join(SECRETS_DIR, `${instanceId}.pass`);
    writeFileSync(filePath, payload, { mode: 0o600 });

    return `file:${filePath}`;
}

/** Encrypt edilmiş dosyadan şifreyi okur ve decrypt eder */
export function readSecret(filePath: string): string {
    if (!existsSync(filePath)) {
        throw new Error(`Secret dosyası bulunamadı: ${filePath}`);
    }

    const payload = readFileSync(filePath, 'utf8').trim();
    const parts = payload.split(':');

    if (parts.length !== 3) {
        return payload; // düz metin uyumluluğu
    }

    const [ivHex, authTagHex, encrypted] = parts;
    const key = getKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

/** Bir instance için secret dosyası var mı kontrol eder */
export function hasSecret(instanceId: string): boolean {
    return existsSync(join(SECRETS_DIR, `${instanceId}.pass`));
}
