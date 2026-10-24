import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Two build targets:
 * - default: installable PWA (service worker, manifest, strict CSP with script-src 'self');
 * - "single": one self-contained HTML file (embedding / hosted preview). Inline scripts make
 *   a script-src 'self' CSP impossible there, so the hosting page's own CSP applies instead.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://tile.openstreetmap.org",
  "connect-src 'self' https://api.themeparks.wiki https://overpass-api.de",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Emits a service worker that precaches the hashed build output (offline app shell). */
function serviceWorker(): Plugin {
  const PUBLIC_FILES = ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
  return {
    name: 'parcpilote-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = ['./', './index.html', ...Object.keys(bundle).filter((f) => !f.endsWith('.map')).map((f) => `./${f}`), ...PUBLIC_FILES.map((f) => `./${f}`)];
      const unique = [...new Set(files)];
      let h = 2166136261;
      for (const ch of unique.join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
      const version = (h >>> 0).toString(36);
      const source = `/* ParcPilote service worker — generated at build. */
const CACHE = 'parcpilote-${version}';
const PRECACHE = ${JSON.stringify(unique)};
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('parcpilote-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Live data and any third party: straight to the network, never cached here.
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))));
    return;
  }
  event.respondWith(caches.match(req).then((r) => r || fetch(req)));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

function pwaHtml(isSingle: boolean): Plugin {
  return {
    name: 'parcpilote-html',
    transformIndexHtml(html) {
      if (isSingle) {
        return html.replace(/\s*<!--PWA-HEAD-->[\s\S]*?<!--\/PWA-HEAD-->/, '');
      }
      return html
        .replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`)
        .replace(/<!--\/?PWA-HEAD-->/g, '');
    },
  };
}

export default defineConfig(({ mode }) => {
  const isSingle = mode === 'single';
  return {
    base: './',
    // The single-file build cannot ship a separate worker file: plans are computed in place.
    resolve: isSingle ? { alias: [{ find: /^\.\/state\/workerPlanner$/, replacement: './state/workerPlanner.single' }] } : {},
    plugins: [preact(), pwaHtml(isSingle), ...(isSingle ? [viteSingleFile()] : [serviceWorker()])],
    define: {
      __PWA__: JSON.stringify(!isSingle),
    },
    // Static files copied as-is into the PWA build (kept out of "public/", a name some hosts reserve for their output).
    publicDir: isSingle ? false : 'static',
    worker: { format: 'es' },
    build: {
      outDir: isSingle ? 'dist-single' : 'dist',
      target: 'es2022',
      sourcemap: false,
      assetsInlineLimit: isSingle ? 100_000_000 : 4096,
    },
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
    },
  };
});
