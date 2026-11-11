// Copy pdf.js (UMD build, fonts, and CMaps) into media/pdfjs for the webview.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const dst = path.join(root, 'media', 'pdfjs');
fs.mkdirSync(dst, { recursive: true });
for (const f of ['build/pdf.min.js', 'build/pdf.worker.min.js']) {
  fs.copyFileSync(path.join(src, f), path.join(dst, path.basename(f)));
}
for (const d of ['cmaps', 'standard_fonts']) {
  fs.cpSync(path.join(src, d), path.join(dst, d), { recursive: true });
}
console.log('Copied pdf.js into media/pdfjs');
