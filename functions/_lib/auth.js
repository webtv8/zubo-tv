/**
 * 认证：密码来自 Cloudflare 环境变量 ADMIN_PASSWORD，无「修改密码」功能。
 * 会话使用 HMAC-SHA256 签名的无状态 Cookie，不占用额外存储。
 */

export const COOKIE_NAME = 'mrs_session';
const enc = new TextEncoder();

const DEFAULT_TTL_HOURS = 24 * 7;

function secretOf(env) {
  const secret = (env?.SESSION_SECRET || env?.ADMIN_PASSWORD || '').trim();
  return secret;
}

export function adminPassword(env) {
  const pwd = env?.ADMIN_PASSWORD;
  return typeof pwd === 'string' ? pwd : '';
}

/** 用 SHA-256 摘要后再逐字节比较，避免长度与逐字符比较带来的时序泄漏。 */
async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(value))));
}

export async function verifyPassword(input, expected) {
  const [a, b] = await Promise.all([digest(input ?? ''), digest(expected ?? '')]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0 && String(input ?? '').length === String(expected ?? '').length;
}

function b64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function ttlSeconds(env) {
  const hours = Number(env?.SESSION_TTL_HOURS);
  if (Number.isFinite(hours) && hours > 0) return Math.round(hours * 3600);
  return DEFAULT_TTL_HOURS * 3600;
}

export async function issueSession(env) {
  const secret = secretOf(env);
  if (!secret) throw new Error('缺少 ADMIN_PASSWORD / SESSION_SECRET 环境变量');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds(env);
  const body = `v1.${b64url(enc.encode(String(exp)))}`;
  const sig = b64url(await hmac(secret, body));
  return {
    token: `${body}.${sig}`,
    maxAge: ttlSeconds(env),
    expires: exp,
  };
}

export async function verifySessionToken(env, token) {
  const secret = secretOf(env);
  if (!secret || !token) return false;

  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;

  const body = `${parts[0]}.${parts[1]}`;
  const expected = b64url(await hmac(secret, body));
  if (expected.length !== parts[2].length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  }
  if (diff !== 0) return false;

  let exp = 0;
  try {
    exp = Number(new TextDecoder().decode(unb64url(parts[1])));
  } catch {
    return false;
  }
  return Number.isFinite(exp) && exp > Math.floor(Date.now() / 1000);
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    if (!key) continue;
    out[key] = pair.slice(idx + 1).trim();
  }
  return out;
}

export async function isAuthenticated(request, env) {
  if (!adminPassword(env)) return false;
  const cookies = parseCookies(request);
  return verifySessionToken(env, cookies[COOKIE_NAME]);
}

export function sessionCookie({ token, maxAge }, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
