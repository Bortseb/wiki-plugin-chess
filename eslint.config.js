import globals from 'globals'
import pluginJs from '@eslint/js'

export default [
  pluginJs.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  { ignores: ['client/*'] },
  {
    languageOptions: {
      globals: {
        wiki: 'readonly',
        // FedWiki injects these on the page that hosts the plugin shell (chess.js);
        // __PLUGIN_BUILD_ID__ is replaced by esbuild at build time.
        isOwner: 'readonly',
        isAuthenticated: 'readonly',
        ownerName: 'readonly',
        __PLUGIN_BUILD_ID__: 'readonly',
        // Global Bootstrap, extended with `.showModal()` by the bootstrap-show-modal
        // side-effect import (pulled in by chess-console's dialogs and our fork).
        bootstrap: 'readonly',
        ...globals.browser,
        ...globals.jquery,
        ...globals.mocha,
      },
    },
  },
  {
    // Build/dev tooling and the server-side puzzle plugin run under Node.
    files: ['scripts/**', 'test/**', 'server/**'],
    languageOptions: { globals: { ...globals.node } },
  },
]
