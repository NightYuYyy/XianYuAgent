import { hostname } from 'node:os';
import { join } from 'node:path';
import { open, readFile, stat, unlink } from 'node:fs/promises';

const LOCK_FILE = '.xianyu-verification.lock';
const LOCK_POLL_MS = 100;
const LOCK_INITIALIZING_GRACE_MS = 5_000;

export async function acquireXianyuVerificationProfileLock(profileDir: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lockPath = join(profileDir, LOCK_FILE);
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }), 'utf8');
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EEXIST') throw error;
      if (await isStaleProfileLock(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error('XIANYU_VERIFICATION_PROFILE_BUSY');
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

async function isStaleProfileLock(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return true;
  }
  if (!raw.trim()) return isMalformedLockOld(lockPath);
  let owner: { pid?: unknown; host?: unknown };
  try {
    owner = JSON.parse(raw) as { pid?: unknown; host?: unknown };
  } catch {
    return isMalformedLockOld(lockPath);
  }
  const pid = typeof owner.pid === 'number' ? owner.pid : Number(owner.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (typeof owner.host === 'string' && owner.host && owner.host.toLowerCase() !== hostname().toLowerCase()) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as { code?: string }).code !== 'EPERM';
  }
}

async function isMalformedLockOld(lockPath: string): Promise<boolean> {
  try {
    const file = await stat(lockPath);
    return Date.now() - file.mtimeMs > LOCK_INITIALIZING_GRACE_MS;
  } catch {
    return false;
  }
}
