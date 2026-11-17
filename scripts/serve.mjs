import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + pathname, pathname.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(root + sep) || pathname.split('/').some(part => part.startsWith('.')) || !['.html','.css','.js','.svg','.json'].includes(extname(file))) {
      res.writeHead(403); res.end('Acceso no permitido'); return;
    }
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, {'Content-Type':types[extname(file)], 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('No encontrado'); }
});
server.listen(port, '127.0.0.1', () => console.log(`SpaceE disponible en http://localhost:${port}`));
