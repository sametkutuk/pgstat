import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join, parse, resolve } from 'path';

// AES-256-GCM ile şifreleme
// Her iki taraf (Node.js API + Java Collector) aynı PBKDF2 parametreleri kullanır
const ALGORITHM = 'aes-256-gcm';
const SECRETS_DIR = process.env.PGSTAT_SECRETS_DIR || join(process.cwd(), 'data', 'secrets');
const LEGACY_SALT = 'pgstat-salt';
const ITERATIONS = 65536;
const KEY_LENGTH = 32;

function getPassphrase(): string {
    const passphrase = process.env.PGSTAT_SECRET_KEY;
    if (!passphrase) {
        throw new Error('PGSTAT_SECRET_KEY zorunlu - ./pgstat setup ile uretin');
    }
    return passphrase;
}

function getSalt(): string {
    const salt = process.env.PGSTAT_SECRET_SALT;
    if (salt) {
        return salt;
    }
    console.warn('PGSTAT_SECRET_SALT yok; eski pgstat-salt fallback kullaniliyor. ./pgstat setup ile salt uretin.');
    return LEGACY_SALT;
}

function getKey(): Buffer {
    return pbkdf2Sync(getPassphrase(), getSalt(), ITERATIONS, KEY_LENGTH, 'sha256');
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
    chmodSync(filePath, 0o600);

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

function safeSecretSegment(value: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) {
        throw new Error('Gecersiz secret adi');
    }
    return value.toLowerCase();
}

/** API/AI gibi collector disi secret'lari ayri ve cakismayan ad alaninda saklar. */
export function saveNamedSecret(namespace: string, name: string, value: string): string {
    const safeNamespace = safeSecretSegment(namespace);
    const safeName = safeSecretSegment(name);
    const key = getKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const payload = `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
    if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true });
    // Versioned file: DB update fails after this write, the currently referenced
    // credential is not silently overwritten. Orphans can be cleaned separately.
    const version = randomBytes(8).toString('hex');
    const filePath = join(SECRETS_DIR, `${safeNamespace}-${safeName}-${version}.secret`);
    writeFileSync(filePath, payload, { mode: 0o600 });
    chmodSync(filePath, 0o600);
    return `file:${filePath}`;
}

export function readSecretRef(secretRef: string): string {
    if (!secretRef.startsWith('file:')) throw new Error('Desteklenmeyen secret_ref');
    return readSecret(secretRef.slice('file:'.length));
}

/** AI anahtarları için eski düz-metin uyumluluğu kabul edilmez. */
export function readAgentSecretRef(secretRef: string): string {
    if (!secretRef.startsWith('file:')) throw new Error('AI_SECRET_REF_INVALID');
    const filePath = secretRef.slice(5);
    const parsed = parse(filePath);
    if (resolve(parsed.dir) !== resolve(SECRETS_DIR) || !/^ai-provider-[a-z0-9_-]+-[a-f0-9]{16}\.secret$/.test(parsed.base)) {
        throw new Error('AI_SECRET_REF_INVALID');
    }
    const payload = readFileSync(filePath, 'utf8').trim();
    if (!/^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i.test(payload)) throw new Error('AI_SECRET_FORMAT_INVALID');
    return readSecret(filePath);
}
