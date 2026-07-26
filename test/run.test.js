/** Ordered test entry — guards, libs, app, shell, server, devtools (matches three-runtimes model). */
globalThis.bootstrap = globalThis.bootstrap || {}
await import('./architecture-guards.test.js')
await import('./build-client.test.js')
await import('./chess-app.test.js')
await import('./chess-core.test.js')
await import('./scenarios.test.js')
await import('./federation.test.js')
await import('./board-layout.test.js')
await import('./modals.test.js')
await import('./chess-shell.test.js')
await import('./puzzle-server.test.js')
await import('./pwa-bridge.test.js')
await import('./league-seed.test.js')
