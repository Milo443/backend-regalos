import { Redis } from 'ioredis';
import { env } from '../config/env.js';

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

class MemoryStore {
  private readonly kv = new Map<string, MemoryEntry>();
  private readonly sets = new Map<string, Set<string>>();

  private pruneIfExpired(key: string): MemoryEntry | null {
    const entry = this.kv.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.kv.delete(key);
      return null;
    }
    return entry;
  }

  get(key: string): string | null {
    return this.pruneIfExpired(key)?.value ?? null;
  }

  set(key: string, value: string, ttlSeconds?: number): void {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this.kv.set(key, { value, expiresAt });
  }

  setNx(key: string, value: string, ttlSeconds: number): boolean {
    if (this.pruneIfExpired(key) !== null) {
      return false;
    }
    this.set(key, value, ttlSeconds);
    return true;
  }

  del(...keys: string[]): void {
    for (const k of keys) {
      this.kv.delete(k);
      this.sets.delete(k);
    }
  }

  incr(key: string, ttlSeconds: number): number {
    const current = this.pruneIfExpired(key);
    const next = current ? Number(current.value) + 1 : 1;
    const expiresAt = current ? current.expiresAt : Date.now() + ttlSeconds * 1000;
    this.kv.set(key, { value: String(next), expiresAt });
    return next;
  }

  sadd(key: string, member: string): void {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set<string>();
      this.sets.set(key, set);
    }
    set.add(member);
  }

  srem(key: string, member: string): void {
    this.sets.get(key)?.delete(member);
  }

  smembers(key: string): string[] {
    return Array.from(this.sets.get(key) ?? []);
  }
}

export interface SessionData {
  usuario_id: number;
  rol: 'SUPER_ADMIN' | 'ADMINISTRADOR' | 'REPARTIDOR';
  debe_cambiar_clave: boolean;
  refresh_jti: string;
}

class CacheService {
  private readonly redis: Redis | null;
  private readonly memory = new MemoryStore();

  constructor() {
    if (env.REDIS_URL) {
      this.redis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
        tls: env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
      });
      this.redis.on('error', (err) => {
        console.error('[Redis] Error de conexión:', err.message);
      });
    } else {
      this.redis = null;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.redis) return this.memory.get(key);
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.redis) {
      this.memory.set(key, value, ttlSeconds);
      return;
    }
    if (ttlSeconds) {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, value);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    if (!this.redis) {
      this.memory.del(...keys);
      return;
    }
    await this.redis.del(...keys);
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    if (!this.redis) {
      return this.memory.setNx(key, '1', ttlSeconds);
    }
    const res = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    await this.del(key);
  }

  async incrementRateLimit(key: string, windowSeconds: number): Promise<number> {
    if (!this.redis) {
      return this.memory.incr(key, windowSeconds);
    }
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, windowSeconds);
    }
    return count;
  }

  // --- Gestión O(1) de sesiones con Set user_sessions:{usuario_id} ---

  async saveSession(jti: string, data: SessionData, ttlSeconds: number): Promise<void> {
    const sessionKey = `session:${jti}`;
    const userSetKey = `user_sessions:${data.usuario_id}`;
    const payload = JSON.stringify(data);

    if (!this.redis) {
      this.memory.set(sessionKey, payload, ttlSeconds);
      this.memory.sadd(userSetKey, jti);
      return;
    }

    const pipeline = this.redis.pipeline();
    pipeline.set(sessionKey, payload, 'EX', ttlSeconds);
    pipeline.sadd(userSetKey, jti);
    pipeline.expire(userSetKey, ttlSeconds);
    await pipeline.exec();
  }

  async getSession(jti: string): Promise<SessionData | null> {
    const raw = await this.get(`session:${jti}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  async removeSession(jti: string, usuarioId: number): Promise<void> {
    const sessionKey = `session:${jti}`;
    const userSetKey = `user_sessions:${usuarioId}`;
    if (!this.redis) {
      this.memory.del(sessionKey);
      this.memory.srem(userSetKey, jti);
      return;
    }
    const pipeline = this.redis.pipeline();
    pipeline.del(sessionKey);
    pipeline.srem(userSetKey, jti);
    await pipeline.exec();
  }

  async revokeAllUserSessions(usuarioId: number): Promise<void> {
    const userSetKey = `user_sessions:${usuarioId}`;
    if (!this.redis) {
      const jtis = this.memory.smembers(userSetKey);
      for (const jti of jtis) {
        this.memory.del(`session:${jti}`);
      }
      this.memory.del(userSetKey);
      return;
    }

    const jtis = await this.redis.smembers(userSetKey);
    const pipeline = this.redis.pipeline();
    for (const jti of jtis) {
      pipeline.del(`session:${jti}`);
    }
    pipeline.del(userSetKey);
    await pipeline.exec();
  }

  // --- Ventana de gracia 10s para Refresh Token multi-pestaña ---

  async setRefreshGrace(oldRefreshJti: string, responsePayload: Record<string, unknown>): Promise<void> {
    await this.set(`refresh_grace:${oldRefreshJti}`, JSON.stringify(responsePayload), 10);
  }

  async getRefreshGrace<T>(oldRefreshJti: string): Promise<T | null> {
    const raw = await this.get(`refresh_grace:${oldRefreshJti}`);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  // --- Idempotencia ---

  async getIdempotency<T>(key: string): Promise<T | null> {
    const raw = await this.get(`idemp:${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async setIdempotency(key: string, payload: unknown, ttlSeconds = 300): Promise<void> {
    await this.set(`idemp:${key}`, JSON.stringify(payload), ttlSeconds);
  }

  // --- Estado de Jobs de Reportes ---

  async setReportJob(jobId: string, state: Record<string, unknown>): Promise<void> {
    await this.set(`report:${jobId}`, JSON.stringify(state), 3600);
  }

  async getReportJob<T>(jobId: string): Promise<T | null> {
    const raw = await this.get(`report:${jobId}`);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async checkHealth(): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }
}

export const cacheService = new CacheService();

