const { spawnSync } = require('child_process');

if (process.platform !== 'linux') {
  console.log('Skipping sqlite3 source rebuild on non-Linux platform.');
  process.exit(0);
}

console.log('Rebuilding sqlite3 from source for Linux deployment.');

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['rebuild', 'sqlite3', '--build-from-source'],
  { stdio: 'inherit' }
);

process.exit(result.status ?? 1);
