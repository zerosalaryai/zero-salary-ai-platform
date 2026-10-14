/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preload must execute before ESM/tsx imports. */
'use strict';
// Next trata este marcador no bundler. O worker é um processo Node de servidor;
// somente seu entrypoint instala esta resolução. Os imports compartilhados
// continuam intactos e o build Next continua rejeitando imports pelo cliente.
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
if (typeof registerHooks !== 'function') {
  throw new Error('worker_requires_node_22_15_or_newer');
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: pathToFileURL(path.join(__dirname, 'server-only.cjs')).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
