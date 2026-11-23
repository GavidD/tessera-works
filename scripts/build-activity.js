'use strict';
// Bundles the Discord Activity client into activity/dist (deployed to GitHub Pages).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(root, 'activity/dist');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'activity/config.json'), 'utf8'));
const clientId = process.env.DISCORD_CLIENT_ID || cfg.clientId;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(root, 'activity/src/main.js')],
  bundle: true, minify: true, format: 'esm', target: 'es2020', sourcemap: false,
  outfile: path.join(out, 'app.js'),
  define: { __CLIENT_ID__: JSON.stringify(clientId) },
  logLevel: 'warning',
});
for (const f of ['index.html', 'style.css']) fs.copyFileSync(path.join(root, 'activity', f), path.join(out, f));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`Built activity/dist (client id ${clientId}).`);
