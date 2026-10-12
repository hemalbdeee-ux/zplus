// Node's built-in fetch ignores HTTPS_PROXY unless the process starts with NODE_USE_ENV_PROXY=1
// (Node 22.21 and later). Behind a proxy every archive request would then go out directly and be
// refused, so the processes that talk to the archive are started with it set.

import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
/** Before the proxy was used these were always reached directly (the tests' and the demo's fake archive). */
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];
const RELAUNCHED = 'WBD_PROXY_RELAUNCHED';

/** True when a proxy is set but this process's fetch would not use it, and Node can be told to. */
export function needsProxyRelaunch(env: NodeJS.ProcessEnv = process.env, version = process.versions.node): boolean {
  if (env.NODE_USE_ENV_PROXY) return false;
  if (!PROXY_VARS.some((v) => env[v])) return false;
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 21);
}

/**
 * The environment for a child process that fetches from the archive: the proxy turned on, loopback
 * kept off it, and Node's "experimental" notice about it silenced.
 */
export function proxyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!needsProxyRelaunch(env)) return env;
  const out: NodeJS.ProcessEnv = { ...env, NODE_USE_ENV_PROXY: '1' };
  // undici reads no_proxy before NO_PROXY, so both get the same list or one would hide the other.
  const list = [...new Set([env.no_proxy, env.NO_PROXY].flatMap((v) => (v ?? '').split(',')).map((s) => s.trim()).filter(Boolean))];
  if (!list.includes('*')) out.NO_PROXY = out.no_proxy = [...list, ...LOOPBACK.filter((h) => !list.includes(h))].join(',');
  out.NODE_OPTIONS = [env.NODE_OPTIONS, '--disable-warning=UNDICI-EHPA'].filter(Boolean).join(' ');
  return out;
}

/**
 * Runs this script again with the proxy turned on and the same arguments, and ends the way the
 * child ended (same exit code, or killed by the same signal). Returns false (and does nothing) when
 * no relaunch is needed; in the relaunched process it makes sure that process stops if the first
 * one is killed.
 */
export function relaunchWithProxy(): boolean {
  if (process.env[RELAUNCHED]) {
    delete process.env[RELAUNCHED];
    if (process.channel) {
      process.channel.unref();
      process.on('disconnect', () => process.kill(process.pid, 'SIGHUP'));
    }
    return false;
  }
  if (!needsProxyRelaunch()) return false;
  // A debugger port is already taken by this process; the child would fail to open it.
  const execArgv = process.execArgv.filter((a) => !/^--(inspect|debug-port)/.test(a));
  const child = spawn(process.execPath, [...execArgv, ...process.argv.slice(1)], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...proxyEnv(), [RELAUNCHED]: '1' },
  });
  // A Ctrl-C reaches the child from the terminal too; a second SIGINT to a CLI without a handler is harmless.
  const forwards = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => {
    const forward = () => child.kill(sig);
    process.on(sig, forward);
    return [sig, forward] as const;
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      for (const [sig, forward] of forwards) process.off(sig, forward);
      process.kill(process.pid, signal);
      // Not every signal ends a process by default; fall back to the shell's convention.
      setTimeout(() => process.exit(128 + (constants.signals[signal] ?? 0)), 100);
      return;
    }
    process.exit(code ?? 0);
  });
  return true;
}
