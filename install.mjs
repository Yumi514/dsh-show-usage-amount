// Install (or refresh) this plugin into a DSH profile.
// usage: node install.mjs [profileDir]
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'dsh-show-usage-amount';
const here = dirname(fileURLToPath(import.meta.url));
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh');
const profileDir = resolve(process.argv[2] ?? join(dshHome, 'profiles', 'desktop'));

if (!existsSync(join(profileDir, 'package.json')) || !existsSync(join(profileDir, 'cordis.patch.yml'))) {
  throw new Error(`not a DSH profile directory: ${profileDir}`);
}

const target = join(profileDir, 'node_modules', PACKAGE);
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
cpSync(here, target, {
  recursive: true,
  // Tests, the installer itself and the scratch probes are development-only;
  // `src/` holds the icon sources the docs reference, not runtime code.
  filter: (source) => !/[\\/](install|test-[^\\/]+)\.mjs$/u.test(source) && !/[\\/]scratch([\\/]|$)/u.test(source),
});

const manifestPath = join(profileDir, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dependencies ??= {};
manifest.dependencies[PACKAGE] = `file:./node_modules/${PACKAGE}`;
manifest.dsh.profile.bundles ??= [];
if (!manifest.dsh.profile.bundles.includes(PACKAGE)) manifest.dsh.profile.bundles.push(PACKAGE);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`installed into ${target}`);
console.log(`bundles: ${manifest.dsh.profile.bundles.join(', ')}`);
console.log('restart DSH to load the new row (manifest edits are read at row start).');
