import fs from 'fs-extra';
import path from 'path';
const src = path.resolve('node_modules/@fortawesome/fontawesome-free');
const dst = path.resolve('assets/fa');
await fs.ensureDir(dst);
await fs.copy(path.join(src, 'css'), path.join(dst, 'css'));
await fs.copy(path.join(src, 'webfonts'), path.join(dst, 'webfonts'));
console.log('[prepare] Font Awesome copied to assets/fa');
