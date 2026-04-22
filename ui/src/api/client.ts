// API istemcisi — tüm backend çağrıları buradan yapılır
const BASE_URL = '/api';

// Token yönetimi
let accessToken: string | null = sessionStorage.getItem('pgstat_token');

export function setToken(token: string) {
    accessToken = token;
    sessionStorage.setItem('pgstat_token', token);
}

export function clearToken() {
    accessToken = null;
    sessionStorage.removeItem('pgstat_token');
}

export function getToken(): string | null {
    return accessToken;
}

function authHeaders(): Record<string, string> {
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

// 401 gelince login sayfasına yönlendir
function handleUnauthorized() {
    clearToken();
    window.location.href = '/login';
}

// Generic GET isteği
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  if (res.status === 401) { handleUnauthorized(); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

// Generic POST isteği
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { handleUnauthorized(); throw new Error('Unauthorized'); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).error || `API Error: ${res.status}`);
  }
  return res.json();
}

// Generic PUT isteği
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { handleUnauthorized(); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

// Generic DELETE isteği
export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE', headers: authHeaders() });
  if (res.status === 401) { handleUnauthorized(); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
}

// Generic PATCH isteği
export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { handleUnauthorized(); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

// Login
export async function apiLogin(password: string): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Giriş başarısız');
  return data;
}

// Logout
export async function apiLogout(): Promise<void> {
  await fetch(`${BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
  clearToken();
}

// Token yenile
export async function apiRefreshToken(): Promise<string | null> {
  const res = await fetch(`${BASE_URL}/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (!res.ok) return null;
  const data = await res.json();
  return data.token;
}
