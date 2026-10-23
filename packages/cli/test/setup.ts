/**
 * setup test: generated client configs must survive a node upgrade.
 *   - the node path written is version-stable (Homebrew's bin/node symlink,
 *     not the Cellar directory `brew upgrade` deletes)
 *   - Claude Desktop is wired without clobbering its other servers/settings
 *   - --repair rewrites only entries whose node/script path is gone
 *   - --daemon writes a valid LaunchAgent and drives launchctl correctly
 *
 * Everything runs against fake node layouts and a temp HOME; launchctl is a
 * stub, so nothing on the real machine is read or changed.
 *
 * Run: pnpm --filter @thinktank/cli test
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  claudeDesktopConfigPath,
  isVersionPinnedNode,
  mcpConfigPath,
  repairAgent,
  resolveNodeCommand,
  setupAgent,
} from '../src/setup.js';
import {
  installDaemon,
  launchAgentPath,
  launchAgentPlist,
  uninstallDaemon,
  type CommandRunner,
} from '../src/daemon.js';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ok   - ${msg}`);
  else {
    failures++;
    console.error(`  FAIL - ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'thinktank-setup-'));

function fakeNode(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** A Homebrew prefix with node 26.8.1 installed and linked. */
function homebrew(name: string): { prefix: string; cellarNode: string } {
  const prefix = join(root, name, 'opt', 'homebrew');
  const cellarNode = fakeNode(join(prefix, 'Cellar', 'node', '26.8.1', 'bin', 'node'));
  link('../Cellar/node/26.8.1/bin/node', join(prefix, 'bin', 'node'));
  link('../Cellar/node/26.8.1', join(prefix, 'opt', 'node'));
  return { prefix, cellarNode };
}

async function main() {
  console.log('\nthinktank setup test\n');

  // ------------------------------------------------ stable node path
  console.log('Scenario 1: version-stable node path');
  const brew = homebrew('brew');
  assert(
    resolveNodeCommand({ execPath: brew.cellarNode, pathEnv: '' }) ===
      join(brew.prefix, 'bin', 'node'),
    'Homebrew Cellar node -> <prefix>/bin/node',
  );

  // Keg not linked into bin/ (or bin/node is another formula): use opt/<formula>.
  const unlinked = homebrew('unlinked');
  rmSync(join(unlinked.prefix, 'bin', 'node'));
  fakeNode(join(unlinked.prefix, 'Cellar', 'node@22', '22.11.0', 'bin', 'node'));
  link('../Cellar/node@22/22.11.0/bin/node', join(unlinked.prefix, 'bin', 'node'));
  assert(
    resolveNodeCommand({ execPath: unlinked.cellarNode, pathEnv: '' }) ===
      join(unlinked.prefix, 'opt', 'node', 'bin', 'node'),
    'bin/node is a different node -> <prefix>/opt/node/bin/node (same binary)',
  );

  // A PATH entry that resolves to the running binary is used unresolved.
  const sysNode = fakeNode(join(root, 'sys', 'usr', 'lib', 'node', 'bin', 'node'));
  link(sysNode, join(root, 'sys', 'usr', 'bin', 'node'));
  const otherDir = join(root, 'sys', 'other', 'bin');
  fakeNode(join(otherDir, 'node'));
  assert(
    resolveNodeCommand({
      execPath: sysNode,
      pathEnv: [otherDir, join(root, 'sys', 'usr', 'bin')].join(delimiter),
    }) === join(root, 'sys', 'usr', 'bin', 'node'),
    'PATH node resolving to the running binary wins; a different node is skipped',
  );

  // fnm's per-shell symlink dirs vanish with the shell: never write them.
  const fnmNode = fakeNode(join(root, 'fnm', 'node-versions', 'v22.11.0', 'installation', 'bin', 'node'));
  link(fnmNode, join(root, 'fnm_multishells', '123_456', 'bin', 'node'));
  const fnmResolved = resolveNodeCommand({
    execPath: fnmNode,
    pathEnv: join(root, 'fnm_multishells', '123_456', 'bin'),
  });
  assert(fnmResolved === fnmNode, 'fnm multishell symlink is skipped');
  assert(isVersionPinnedNode(fnmResolved), 'fnm install path is flagged as version-pinned');
  assert(isVersionPinnedNode(brew.cellarNode), 'Cellar path is flagged as version-pinned');
  assert(!isVersionPinnedNode(join(brew.prefix, 'bin', 'node')), 'Homebrew bin/node is not pinned');

  const missing = join(root, 'nope', 'node');
  assert(resolveNodeCommand({ execPath: missing, pathEnv: '' }) === missing, 'unknown execPath is returned as-is');

  if (/[\\/]Cellar[\\/]/.test(process.execPath)) {
    assert(
      !isVersionPinnedNode(resolveNodeCommand()),
      `this machine's Homebrew node resolves to a stable path (${resolveNodeCommand()})`,
    );
  }

  // ------------------------------------------------ Claude Desktop target
  console.log('\nScenario 2: setup --claude-desktop merges without clobbering');
  const node = { execPath: brew.cellarNode, pathEnv: '' };
  const stable = join(brew.prefix, 'bin', 'node');
  const home = join(root, 'home');
  const desktopPath = mcpConfigPath('claude-desktop', home);
  assert(
    desktopPath === claudeDesktopConfigPath(home, process.platform),
    'Claude Desktop path follows the platform',
  );
  assert(
    claudeDesktopConfigPath('/Users/a', 'darwin') ===
      '/Users/a/Library/Application Support/Claude/claude_desktop_config.json',
    'macOS path is ~/Library/Application Support/Claude/claude_desktop_config.json',
  );
  mkdirSync(dirname(desktopPath), { recursive: true });
  writeFileSync(
    desktopPath,
    JSON.stringify({
      mcpServers: {
        other: { command: '/usr/bin/other', args: ['x'] },
        thinktank: { command: brew.cellarNode, args: ['old'], env: { THINKTANK_DB: '/tmp/x.db' } },
      },
      preferences: { menuBarEnabled: true },
    }),
  );
  const desktop = setupAgent('claude-desktop', { home, node });
  const desktopCfg = readJson(desktopPath);
  assert(desktop.path === desktopPath, 'reports the Claude Desktop config path');
  assert(desktopCfg.mcpServers.thinktank.command === stable, 'thinktank entry uses the stable node path');
  assert(
    desktopCfg.mcpServers.thinktank.args.at(-1) === 'serve' &&
      String(desktopCfg.mcpServers.thinktank.args[1]).endsWith('cli.js'),
    'thinktank entry runs <cli.js> serve',
  );
  assert(desktopCfg.mcpServers.thinktank.env?.THINKTANK_DB === '/tmp/x.db', 'existing env on the entry is kept');
  assert(desktopCfg.mcpServers.other?.command === '/usr/bin/other', 'other MCP servers are kept');
  assert(desktopCfg.preferences?.menuBarEnabled === true, 'other top-level settings are kept');
  assert(!desktop.rule && Boolean(desktop.manualRule), 'no rules file; points at the manual auto-use step');
  assert(!desktop.warning, 'no version-pinned warning for a stable path');

  const freshHome = join(root, 'fresh-home');
  setupAgent('claude-desktop', { home: freshHome, node, installRules: false });
  assert(
    readJson(mcpConfigPath('claude-desktop', freshHome)).mcpServers.thinktank.command === stable,
    'creates the Claude Desktop config when missing',
  );

  const pinned = setupAgent('cursor', {
    home,
    installRules: false,
    node: { execPath: fnmNode, pathEnv: '' },
  });
  assert(Boolean(pinned.warning?.includes('setup --repair')), 'version-pinned node path comes with a --repair hint');

  // ------------------------------------------------ Codex re-run updates in place
  console.log('\nScenario 3: setup --codex updates a stale entry in place');
  const codexPath = mcpConfigPath('codex', home);
  mkdirSync(dirname(codexPath), { recursive: true });
  const codexBefore = [
    'model = "o4"',
    '',
    '[mcp_servers.thinktank]',
    `command = ${JSON.stringify(brew.cellarNode)}`,
    'args = ["--no-warnings=ExperimentalWarning", "/old/cli.js", "serve"]',
    'env = { THINKTANK_DB = "/tmp/x.db" }',
    '',
    '[mcp_servers.other]',
    'command = "/usr/bin/other"',
    '',
  ].join('\n');
  writeFileSync(codexPath, codexBefore);
  setupAgent('codex', { home, node, installRules: false });
  const codexAfter = readFileSync(codexPath, 'utf8');
  assert(codexAfter.includes(`command = ${JSON.stringify(stable)}`), 'command line rewritten to the stable path');
  assert(!codexAfter.includes('/old/cli.js'), 'args line rewritten');
  assert(codexAfter.includes('env = { THINKTANK_DB = "/tmp/x.db" }'), 'other keys in the table are kept');
  assert(
    codexAfter.includes('[mcp_servers.other]\ncommand = "/usr/bin/other"') && codexAfter.startsWith('model = "o4"'),
    'other tables and settings are kept',
  );
  assert(codexAfter.split('[mcp_servers.thinktank]').length === 2, 'no duplicate thinktank table');
  setupAgent('codex', { home, node, installRules: false });
  assert(readFileSync(codexPath, 'utf8') === codexAfter, 're-running setup is a no-op');

  // ------------------------------------------------ --repair
  console.log('\nScenario 4: setup --repair fixes only broken entries');
  const rhome = join(root, 'repair-home');
  const goneNode = '/opt/homebrew/Cellar/node/26.7.0/bin/node-that-was-deleted';
  const liveScript = fakeNode(join(root, 'repo', 'packages', 'cli', 'dist', 'cli.js'));
  const write = (path: string, data: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };
  write(mcpConfigPath('cursor', rhome), {
    mcpServers: { thinktank: { command: goneNode, args: ['--no-warnings=ExperimentalWarning', liveScript, 'serve'] } },
  });
  const claudeOk = JSON.stringify({
    mcpServers: { thinktank: { type: 'stdio', command: process.execPath, args: [liveScript, 'serve'] } },
    numStartups: 3,
  });
  write(mcpConfigPath('claude', rhome), claudeOk);
  write(mcpConfigPath('claude-desktop', rhome), {
    mcpServers: {
      thinktank: { command: process.execPath, args: ['/moved/thinktank/packages/cli/dist/cli.js', 'serve'] },
      other: { command: 'npx', args: ['-y', 'x'] },
    },
  });
  write(
    mcpConfigPath('codex', rhome),
    `[mcp_servers.thinktank]\ncommand = ${JSON.stringify(goneNode)}\nargs = [${JSON.stringify(liveScript)}, "serve"]\nenv = { A = "1" }\n`,
  );

  const results = Object.fromEntries(
    (['cursor', 'claude', 'claude-desktop', 'codex'] as const).map((a) => [a, repairAgent(a, { home: rhome, node })]),
  );
  assert(
    results.cursor?.status === 'repaired' && Boolean(results.cursor.reason?.startsWith('command not found')),
    'cursor: missing node -> repaired',
  );
  assert(readJson(mcpConfigPath('cursor', rhome)).mcpServers.thinktank.command === stable, 'cursor: now points at the stable node');
  assert(results.claude?.status === 'ok', 'claude: working entry reported ok');
  assert(readFileSync(mcpConfigPath('claude', rhome), 'utf8') === claudeOk, 'claude: working config left byte-identical');
  assert(
    results['claude-desktop']?.status === 'repaired' &&
      Boolean(results['claude-desktop'].reason?.startsWith('script not found')),
    'claude-desktop: missing CLI script -> repaired',
  );
  assert(
    readJson(mcpConfigPath('claude-desktop', rhome)).mcpServers.other?.command === 'npx',
    'claude-desktop: other servers kept',
  );
  const codexRepaired = readFileSync(mcpConfigPath('codex', rhome), 'utf8');
  assert(results.codex?.status === 'repaired', 'codex: missing node -> repaired');
  assert(
    codexRepaired.includes(`command = ${JSON.stringify(stable)}`) && codexRepaired.includes('env = { A = "1" }'),
    'codex: command rewritten, env kept',
  );

  const emptyHome = join(root, 'empty-home');
  const noEntryPath = mcpConfigPath('cursor', emptyHome);
  write(noEntryPath, { mcpServers: { other: { command: '/gone/node' } } });
  const noEntryBefore = readFileSync(noEntryPath, 'utf8');
  assert(repairAgent('cursor', { home: emptyHome, node }).status === 'not-configured', 'no thinktank entry -> not-configured');
  assert(readFileSync(noEntryPath, 'utf8') === noEntryBefore, 'config without a thinktank entry is untouched');
  assert(repairAgent('codex', { home: emptyHome, node }).status === 'not-configured', 'no config file -> not-configured');
  assert(!existsSync(mcpConfigPath('codex', emptyHome)), 'repair never creates a config file');

  // ------------------------------------------------ --daemon (launchctl stubbed)
  console.log('\nScenario 5: setup --daemon / --uninstall-daemon');
  const plist = launchAgentPlist({ programArguments: ['/a&b/<node>'], logPath: '/l', env: {} });
  assert(plist.includes('<string>/a&amp;b/&lt;node&gt;</string>'), 'plist values are XML-escaped');

  const dhome = join(root, 'daemon-home');
  const calls: string[][] = [];
  let bootstrapFailures = 1;
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'bootstrap' && bootstrapFailures-- > 0) {
      return { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
    }
    return { status: 0, stderr: '' };
  };
  const installed = installDaemon({
    home: dhome,
    uid: 501,
    port: 5001,
    run,
    node,
    env: { THINKTANK_DB: '/tmp/x.db', THINKTANK_KEY: 'hunter2-passphrase', ANTHROPIC_API_KEY: 'sk-ant-secret' },
  });
  const plistText = readFileSync(installed.plistPath, 'utf8');
  assert(installed.plistPath === launchAgentPath(dhome), 'plist written to ~/Library/LaunchAgents');
  assert(installed.programArguments[0] === stable, 'daemon runs the stable node path');
  assert(
    installed.programArguments.slice(-3).join(' ') === 'serve --http --port=5001' &&
      String(installed.programArguments[2]).endsWith('cli.js'),
    'daemon runs <cli.js> serve --http --port=N',
  );
  assert(plistText.includes('<key>KeepAlive</key>\n  <true/>') && plistText.includes('<key>RunAtLoad</key>'), 'plist keeps it alive and starts at login');
  assert(plistText.includes('<key>THINKTANK_DB</key>'), 'non-secret THINKTANK_DB is passed through');
  assert(!plistText.includes('hunter2') && !plistText.includes('sk-ant'), 'secrets are never written to the plist');
  assert(
    JSON.stringify(calls.map((c) => c.slice(1, 2)[0])) === JSON.stringify(['bootout', 'enable', 'bootstrap', 'bootstrap']),
    'launchctl: bootout old copy, enable, bootstrap (retried once after an I/O error)',
  );
  assert(calls[2]?.[2] === 'gui/501' && calls[2]?.[3] === installed.plistPath, 'bootstrap targets the gui/<uid> domain');
  if (process.platform === 'darwin') {
    const lint = spawnSync('plutil', ['-lint', installed.plistPath], { encoding: 'utf8' });
    assert(lint.status === 0, `plutil -lint accepts the plist (${lint.stdout.trim()})`);
  }

  let threw = false;
  try {
    installDaemon({ home: dhome, uid: 501, node, run: (_c, a) => ({ status: a[0] === 'bootstrap' ? 5 : 0, stderr: 'nope' }) });
  } catch (err) {
    threw = String(err).includes('could not load');
  }
  assert(threw, 'a bootstrap that never succeeds is reported, not swallowed');

  calls.length = 0;
  const removed = uninstallDaemon({ home: dhome, uid: 501, run });
  assert(removed.removed && !existsSync(installed.plistPath), 'uninstall deletes the plist');
  assert(calls[0]?.join(' ') === 'launchctl bootout gui/501/sh.thinktank.http', 'uninstall boots the service out');
  assert(!uninstallDaemon({ home: dhome, uid: 501, run }).removed, 'uninstall is safe to re-run');

  rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
