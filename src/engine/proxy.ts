// Node's built-in fetch ignores HTTPS_PROXY unless the process starts with NODE_USE_ENV_PROXY=1
// (Node 22.21 and later). Behind a proxy every archive request would then go out directly and be
// refused, so the processes that talk to the archive are started with it set.

import { spawn } from 'node:child_process';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

/** True when a proxy is set but this process's fetch would not use it, and Node can be told to. */
export function needsProxyRelaunch(env: NodeJS.ProcessEnv = process.env, version = process.versions.node): boolean {
  if (env.NODE_USE_ENV_PROXY) return false;
  if (!PROXY_VARS.some((v) => env[v])) return false;
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 21);
}

/** The environment for a child process that fetches from the archive. */
export function proxyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return needsProxyRelaunch(env) ? { ...env, NODE_USE_ENV_PROXY: '1' } : env;
}

/**
 * Runs this script again with NODE_USE_ENV_PROXY=1 and the same arguments and exits with the
 * child's code. Returns false (and does nothing) when no relaunch is needed.
 */
export function relaunchWithProxy(): boolean {
  if (!needsProxyRelaunch()) return false;
  const child = spawn(process.execPath, ['--disable-warning=UNDICI-EHPA', ...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: proxyEnv(),
  });
  // Ctrl-C reaches the child from the terminal already; passing it on as well would be a second one.
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return true;
}
