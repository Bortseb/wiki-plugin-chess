/**
 * Build the wiki plugin's browser artifacts:
 *   - client/cm-modules-bundle.js  chess-console + wiki glue
 *   - client/chess.js              wiki shell (bundled)
 *   - client/chess-app.js          iframe/popup app (bundled)
 *
 * Both app entry points share pure modules in src/ (inlined into each bundle).
 * client/cm-modules-bundle.js is loaded at runtime by the app, so it stays external.
 *
 * Stockfish worker JS + WASM are copied from node_modules at build time (not committed).
 * cm-modules.scss is compiled to cm-modules.css on each build.
 * server/puzzle-server.js imports puzzle helpers from src/chess-core.js.
 */
import { execSync } from 'node:child_process'
import * as esbuild from 'esbuild'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import packJSON from '../package.json' with { type: 'json' }

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(scriptsDir)
const clientDir = path.join(root, 'client')
const srcDir = path.join(root, 'src')

const bundleDepsMarker = path.join(root, 'node_modules/chess-console/package.json')

function ensureBundleDeps() {
  if (fs.existsSync(bundleDepsMarker)) return
  console.log('  Installing chess library dependencies (npm)…')
  execSync('npm install', { cwd: root, stdio: 'inherit' })
}

function buildCmModulesCss() {
  ensureBundleDeps()
  const scss = path.join(clientDir, 'assets/styles/cm-modules.scss')
  const outCss = path.join(clientDir, 'assets/styles/cm-modules.css')
  execSync(
    `npx sass "${scss}" "${outCss}" --no-source-map --quiet-deps` +
      ' --silence-deprecation=import --silence-deprecation=if-function' +
      ' --silence-deprecation=global-builtin --silence-deprecation=color-functions' +
      ' --silence-deprecation=slash-div',
    {
      cwd: root,
      stdio: 'inherit',
    },
  )
  console.log('  Built client/assets/styles/cm-modules.css')
}

async function buildCmBundle() {
  ensureBundleDeps()
  const outfile = path.join(clientDir, 'cm-modules-bundle.js')
  await esbuild.build({
    entryPoints: [path.join(srcDir, 'cm-modules-bundle.js')],
    absWorkingDir: srcDir,
    bundle: true,
    minify: true,
    legalComments: 'inline',
    sourcemap: true,
    format: 'esm',
    logLevel: 'info',
    outfile,
    nodePaths: [path.join(root, 'node_modules')],
  })
  console.log('\n  Built client/cm-modules-bundle.js')
}

const cmBundleOnly = process.argv.includes('--cm-bundle-only')

const CM_BUNDLE_IMPORT_RE = /import\{[^}]+\}from"\.\/cm-modules-bundle\.js";/g

// esbuild leaves duplicate external imports mid-bundle; hoist them for browser loaders.
export function hoistCmBundleImports(code) {
  const bannerMatch = code.match(/^\/\*[\s\S]*?\*\/\n?/)
  const banner = bannerMatch ? bannerMatch[0] : ''
  let body = banner ? code.slice(banner.length) : code
  const imports = []
  body = body.replace(CM_BUNDLE_IMPORT_RE, match => {
    imports.push(match)
    return ''
  })
  if (imports.length <= 1) return code

  const specs = []
  const seen = new Set()
  for (const imp of imports) {
    const inner = imp.match(/import\{(.+)\}from/)?.[1] || ''
    for (const part of inner.split(',')) {
      const trimmed = part.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      specs.push(trimmed)
    }
  }
  const merged = `import{${specs.join(',')}}from"./cm-modules-bundle.js";`
  return banner + merged + body
}

// Stamp ?v= on the external cm-modules import so embeds/SW do not keep a stale board bundle.
export function stampCmBundleImport(code, stamp) {
  return String(code).replace(
    /from"\.\/cm-modules-bundle\.js(?:\?v=[^"]*)?"/g,
    `from"./cm-modules-bundle.js?v=${stamp}"`,
  )
}

async function buildClientBundles() {
  buildCmModulesCss()
  await buildCmBundle()
  if (cmBundleOnly) return

  const version = packJSON.version
  const now = new Date()
  const buildId = `${version}+${now.getTime()}`

  const externalCmBundle = {
    name: 'external-cm-modules-bundle',
    setup(build) {
      build.onResolve({ filter: /cm-modules-bundle\.js$/ }, () => ({
        path: './cm-modules-bundle.js',
        external: true,
      }))
    },
  }

  function stampIndexHtmlCacheBust(html, stamp) {
    let out = String(html)
    out = out.replace(/src="\.\/chess-app\.js(?:\?v=[^"]*)?"/, `src="./chess-app.js?v=${stamp}"`)
    out = out.replace(
      /href="\.\/assets\/styles\/wiki-chess\.css(?:\?v=[^"]*)?"/,
      `href="./assets/styles/wiki-chess.css?v=${stamp}"`,
    )
    out = out.replace(
      /href="\.\/assets\/styles\/cm-modules\.css(?:\?v=[^"]*)?"/,
      `href="./assets/styles/cm-modules.css?v=${stamp}"`,
    )
    out = out.replaceAll('__PLUGIN_VERSION__', stamp)
    return out
  }

  const shared = {
    bundle: true,
    minify: true,
    legalComments: 'inline',
    sourcemap: true,
    logLevel: 'info',
    define: {
      __PLUGIN_BUILD_ID__: JSON.stringify(buildId),
    },
    banner: {
      js: `/* Federated Wiki Chess (wiki-plugin-chess) - ${version} - ${now.toUTCString()} */`,
    },
  }

  const shellResult = await esbuild.build({
    ...shared,
    entryPoints: [path.join(srcDir, 'chess.js')],
    metafile: true,
    outdir: clientDir,
  })

  const chessShellPath = path.join(clientDir, 'chess.js')
  const chessShellJs = await fsPromises.readFile(chessShellPath, 'utf8')
  if (/bootstrap\.Modal/.test(chessShellJs) || /cm-modules-bundle/.test(chessShellJs)) {
    throw new Error(
      'client/chess.js (wiki shell) must not bundle chess-console/cm-modules — ' +
        'keep puzzle.js out of the static import graph (see board-layout.js).',
    )
  }

  await esbuild.build({
    ...shared,
    entryPoints: [path.join(srcDir, 'chess-app.js')],
    format: 'esm',
    plugins: [externalCmBundle],
    outfile: path.join(clientDir, 'chess-app.js'),
  })

  await esbuild.build({
    ...shared,
    entryPoints: [path.join(srcDir, 'glicko-worker.js')],
    format: 'esm',
    outfile: path.join(clientDir, 'glicko-worker.js'),
  })

  const chessAppPath = path.join(clientDir, 'chess-app.js')
  let chessAppJs = await fsPromises.readFile(chessAppPath, 'utf8')
  chessAppJs = stampCmBundleImport(hoistCmBundleImports(chessAppJs), buildId)
  await fsPromises.writeFile(chessAppPath, chessAppJs)

  const stockfishBinDir = path.join(root, 'node_modules/stockfish/bin')
  const stockfishAssetsDir = path.join(clientDir, 'assets/js')
  for (const name of ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm']) {
    const src = path.join(stockfishBinDir, name)
    const dest = path.join(stockfishAssetsDir, name)
    try {
      await fsPromises.copyFile(src, dest)
    } catch (err) {
      throw new Error(
        `Could not copy Stockfish asset from ${src}. ` +
          `Run "npm install" so the "stockfish" dependency is present.\n${err.message}`,
      )
    }
  }

  const indexHtmlPath = path.join(clientDir, 'index.html')
  let indexHtml = await fsPromises.readFile(indexHtmlPath, 'utf8')
  indexHtml = stampIndexHtmlCacheBust(indexHtml, buildId)
  await fsPromises.writeFile(indexHtmlPath, indexHtml)

  await fsPromises.writeFile(path.join(root, 'meta-client.json'), JSON.stringify(shellResult.metafile))
  console.log('\n  Built client/chess.js')
  console.log('  Built client/chess-app.js')
  console.log('  Built client/glicko-worker.js')
  console.log('  Copied client/assets/js/stockfish-18-lite-single.js + .wasm (from node_modules)')
  console.log("  esbuild metadata written to 'meta-client.json'.")
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMainModule) {
  await buildClientBundles()
  if (cmBundleOnly) process.exit(0)
}
