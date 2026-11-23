const fs = require('node:fs');
const path = require('node:path');
const { assets, getAssetVersions, publicDir } = require('../badminton-backend/asset-versions');

const versions = getAssetVersions();
const check = process.argv.includes('--check');
let outdated = false;
for (const name of fs.readdirSync(publicDir).filter(file => file.endsWith('.html'))) {
  const file = path.join(publicDir, name);
  const original = fs.readFileSync(file, 'utf8');
  let updated = original;
  for (const asset of assets) {
    const escaped = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    updated = updated.replace(new RegExp(`(["'])${escaped}(?:\\?v=[a-f0-9]+)?\\1`, 'g'), `$1${asset}?v=${versions[asset]}$1`);
  }
  if (updated !== original) {
    outdated = true;
    if (check) console.error(`${name} has outdated asset versions`);
    else fs.writeFileSync(file, updated);
  }
}
if (check && outdated) process.exitCode = 1;
