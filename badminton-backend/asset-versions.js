const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const assets = ['app.js', 'app.css', 'player-analytics.js', 'tournament-draw.js', 'tailwind-config.js'];

function getAssetVersions() {
  return Object.fromEntries(assets.map(name => [
    name,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(publicDir, name))).digest('hex').slice(0, 16)
  ]));
}

module.exports = { assets, getAssetVersions, publicDir };
