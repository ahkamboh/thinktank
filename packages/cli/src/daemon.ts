import { homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cliEntryPath, resolveNodeCommand, type NodeResolveOptions } from './setup.js';

/**
 * `thinktank setup --daemon` (macOS): a per-user LaunchAgent that keeps
 * `thinktank serve --http` running, so the browser extension's localhost
 * /ingest endpoint is up whenever you're logged in - not only while some IDE
 * happens to have thinktank spawned. Opt-in, and removed by
 * `thinktank setup --uninstall-daemon`.
 */

export const DAEMON_LABEL = 'sh.thinktank.http';

/**
 * Non-secret settings the daemon should inherit from the shell that installed
 * it (launchd starts agents with an almost empty environment). Secrets such as
 * THINKTANK_KEY or API keys are never written into the plist.
 */
const PASSTHROUGH_ENV = ['THINKTANK_DB', 'THINKTANK_ENCRYPT', 'THINKTANK_KEY_FILE'] as const;

/** Runs a command and reports its exit status (injected by tests). */
export type CommandRunner = (cmd: string, args: string[]) => { status: number; stderr: string };

const runCommand: CommandRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stderr: (r.stderr || r.error?.message || '').trim() };
};

export interface DaemonOptions {
  home?: string;
  /** Port for `serve --http`. Default: the server's own default (4319). */
  port?: number;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  run?: CommandRunner;
  node?: NodeResolveOptions;
}

export function launchAgentPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
}

export function daemonLogPath(home: string = homedir()): string {
  return join(home, 'Library', 'Logs', 'thinktank', 'http.log');
}

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface LaunchAgentSpec {
  programArguments: string[];
  logPath: string;
  env?: Record<string, string>;
}

/** The LaunchAgent plist: start at login, restart if it exits. */
export function launchAgentPlist(spec: LaunchAgentSpec): string {
  const args = spec.programArguments.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const envEntries = Object.entries(spec.env ?? {});
  const env = envEntries.length
    ? '  <key>EnvironmentVariables</key>\n  <dict>\n' +
      envEntries
        .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
        .join('\n') +
      '\n  </dict>\n'
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

export interface DaemonInstallResult {
  plistPath: string;
  logPath: string;
  programArguments: string[];
}

function uidOf(opts: DaemonOptions): number {
  return opts.uid ?? userInfo().uid;
}

/** Write the LaunchAgent and (re)load it so the server starts now. */
export function installDaemon(opts: DaemonOptions = {}): DaemonInstallResult {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const run = opts.run ?? runCommand;
  const plistPath = launchAgentPath(home);
  const logPath = daemonLogPath(home);

  const programArguments = [
    resolveNodeCommand(opts.node),
    '--no-warnings=ExperimentalWarning',
    cliEntryPath(),
    'serve',
    '--http',
    ...(opts.port ? [`--port=${opts.port}`] : []),
  ];
  const passEnv: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const v = env[key]?.trim();
    if (v) passEnv[key] = v;
  }

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(plistPath, launchAgentPlist({ programArguments, logPath, env: passEnv }), {
    encoding: 'utf8',
    mode: 0o644,
  });

  const domain = `gui/${uidOf(opts)}`;
  const service = `${domain}/${DAEMON_LABEL}`;
  // Unload any previous copy so a re-run picks up the new plist; it is fine
  // for this to fail when nothing is loaded yet.
  run('launchctl', ['bootout', service]);
  run('launchctl', ['enable', service]);
  let loaded = run('launchctl', ['bootstrap', domain, plistPath]);
  // bootout finishes asynchronously; bootstrap right after it can fail with
  // "Input/output error" until the old instance is gone. Retry briefly.
  for (let i = 0; loaded.status !== 0 && i < 5; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    loaded = run('launchctl', ['bootstrap', domain, plistPath]);
  }
  if (loaded.status !== 0) {
    throw new Error(
      `wrote ${plistPath} but launchctl could not load it: ${loaded.stderr || 'unknown error'}`,
    );
  }
  return { plistPath, logPath, programArguments };
}

export interface DaemonUninstallResult {
  plistPath: string;
  /** Whether a plist file was found and deleted. */
  removed: boolean;
}

/** Stop the LaunchAgent and delete its plist. Safe to run when not installed. */
export function uninstallDaemon(opts: DaemonOptions = {}): DaemonUninstallResult {
  const run = opts.run ?? runCommand;
  const plistPath = launchAgentPath(opts.home ?? homedir());
  run('launchctl', ['bootout', `gui/${uidOf(opts)}/${DAEMON_LABEL}`]);
  const removed = existsSync(plistPath);
  if (removed) rmSync(plistPath);
  return { plistPath, removed };
}
