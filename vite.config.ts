import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import solid from '@solidjs/vite-plugin';
import { readExtensionManifest, zipExtension } from './scripts/extension-zip.ts';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

// Written by scripts/sign-firefox.ts when AMO credentials are available.
const signedXpi = `.firefox/push-it-firefox-${readExtensionManifest().version}.xpi`;
const hasSignedXpi = existsSync(signedXpi);

// Serves the extension from the site: /push-it-extension.zip (unsigned, any browser) and,
// when signing succeeded, /push-it-firefox.xpi (permanent install in Firefox).
function extensionDownloads(): Plugin {
  return {
    name: 'push-it-extension-downloads',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'push-it-extension.zip', source: zipExtension() });
      if (hasSignedXpi) {
        this.emitFile({
          type: 'asset',
          fileName: 'push-it-firefox.xpi',
          source: readFileSync(signedXpi),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [solid(), extensionDownloads()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __FIREFOX_XPI__: JSON.stringify(hasSignedXpi),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
