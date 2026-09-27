const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src', 'modules', 'notifications', 'templates');
const dest = path.join(__dirname, '..', 'dist', 'modules', 'notifications', 'templates');

fs.mkdirSync(dest, { recursive: true });
for (const file of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
