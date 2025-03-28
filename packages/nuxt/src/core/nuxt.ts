import { dirname, join, normalize, relative, resolve } from 'pathe'
import { createDebugger, createHooks } from 'hookable'
import type { LoadNuxtOptions } from '@nuxt/kit'
import { addBuildPlugin, addComponent, addPlugin, addRouteMiddleware, addServerPlugin, addVitePlugin, addWebpackPlugin, installModule, loadNuxtConfig, logger, nuxtCtx, resolveAlias, resolveFiles, resolvePath, tryResolveModule, useNitro } from '@nuxt/kit'
import { resolvePath as _resolvePath } from 'mlly'
import type { Nuxt, NuxtHooks, NuxtOptions } from 'nuxt/schema'
import { resolvePackageJSON } from 'pkg-types'

import escapeRE from 'escape-string-regexp'
import fse from 'fs-extra'
import { withoutLeadingSlash } from 'ufo'
/* eslint-disable import/no-restricted-paths */
import defu from 'defu'
import pagesModule from '../pages/module'
import metaModule from '../head/module'
import componentsModule from '../components/module'
import importsModule from '../imports/module'
/* eslint-enable */
import { distDir, pkgDir } from '../dirs'
import { version } from '../../package.json'
import { ImportProtectionPlugin, nuxtImportProtections } from './plugins/import-protection'
import type { UnctxTransformPluginOptions } from './plugins/unctx'
import { UnctxTransformPlugin } from './plugins/unctx'
import type { TreeShakeComposablesPluginOptions } from './plugins/tree-shake'
import { TreeShakeComposablesPlugin } from './plugins/tree-shake'
import { DevOnlyPlugin } from './plugins/dev-only'
import { LayerAliasingPlugin } from './plugins/layer-aliasing'
import { addModuleTranspiles } from './modules'
import { initNitro } from './nitro'
import schemaModule from './schema'
import { RemovePluginMetadataPlugin } from './plugins/plugin-metadata'
import { AsyncContextInjectionPlugin } from './plugins/async-context'
import { resolveDeepImportsPlugin } from './plugins/resolve-deep-imports'

export function createNuxt (options: NuxtOptions): Nuxt {
  const hooks = createHooks<NuxtHooks>()

  const nuxt: Nuxt = {
    _version: version,
    options,
    hooks,
    callHook: hooks.callHook,
    addHooks: hooks.addHooks,
    hook: hooks.hook,
    ready: () => initNuxt(nuxt),
    close: () => Promise.resolve(hooks.callHook('close', nuxt)),
    vfs: {},
    apps: {}
  }

  return nuxt
}

async function initNuxt (nuxt: Nuxt) {
  // Register user hooks
  for (const config of nuxt.options._layers.map(layer => layer.config).reverse()) {
    if (config.hooks) {
      nuxt.hooks.addHooks(config.hooks)
    }
  }

  // Set nuxt instance for useNuxt
  nuxtCtx.set(nuxt)
  nuxt.hook('close', () => nuxtCtx.unset())

  const coreTypePackages = nuxt.options.typescript.hoist || []
  const paths = Object.fromEntries(await Promise.all(coreTypePackages.map(async (pkg) => {
    const path = await _resolvePath(pkg, { url: nuxt.options.modulesDir }).then(r => resolvePackageJSON(r)).catch(() => null)
    if (!path) { return }
    return [pkg, [dirname(path)]]
  })).then(r => r.filter(Boolean) as [string, [string]][]))

  // Set nitro resolutions for types that might be obscured with shamefully-hoist=false
  nuxt.options.nitro.typescript = defu(nuxt.options.nitro.typescript, {
    tsConfig: { compilerOptions: { paths: { ...paths } } }
  })

  // Add nuxt types
  nuxt.hook('prepare:types', (opts) => {
    opts.references.push({ types: 'nuxt' })
    opts.references.push({ path: resolve(nuxt.options.buildDir, 'types/plugins.d.ts') })
    // Add vue shim
    if (nuxt.options.typescript.shim) {
      opts.references.push({ path: resolve(nuxt.options.buildDir, 'types/vue-shim.d.ts') })
    }
    // Add module augmentations directly to NuxtConfig
    opts.references.push({ path: resolve(nuxt.options.buildDir, 'types/schema.d.ts') })
    opts.references.push({ path: resolve(nuxt.options.buildDir, 'types/app.config.d.ts') })

    // Set Nuxt resolutions for types that might be obscured with shamefully-hoist=false
    opts.tsConfig.compilerOptions = defu(opts.tsConfig.compilerOptions, { paths: { ...paths } })

    for (const layer of nuxt.options._layers) {
      const declaration = join(layer.cwd, 'index.d.ts')
      if (fse.existsSync(declaration)) {
        opts.references.push({ path: declaration })
      }
    }
  })

  // Add plugin normalization plugin
  addBuildPlugin(RemovePluginMetadataPlugin(nuxt))

  // Add import protection
  const config = {
    rootDir: nuxt.options.rootDir,
    // Exclude top-level resolutions by plugins
    exclude: [join(nuxt.options.rootDir, 'index.html')],
    patterns: nuxtImportProtections(nuxt)
  }
  addVitePlugin(() => ImportProtectionPlugin.vite(config))
  addWebpackPlugin(() => ImportProtectionPlugin.webpack(config))

  // add resolver for modules used in virtual files
  addVitePlugin(() => resolveDeepImportsPlugin(nuxt))

  if (nuxt.options.experimental.localLayerAliases) {
    // Add layer aliasing support for ~, ~~, @ and @@ aliases
    addVitePlugin(() => LayerAliasingPlugin.vite({
      sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client,
      dev: nuxt.options.dev,
      root: nuxt.options.srcDir,
      // skip top-level layer (user's project) as the aliases will already be correctly resolved
      layers: nuxt.options._layers.slice(1)
    }))
    addWebpackPlugin(() => LayerAliasingPlugin.webpack({
      sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client,
      dev: nuxt.options.dev,
      root: nuxt.options.srcDir,
      // skip top-level layer (user's project) as the aliases will already be correctly resolved
      layers: nuxt.options._layers.slice(1),
      transform: true
    }))
  }

  nuxt.hook('modules:done', async () => {
    // Add unctx transform
    const options = {
      sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client,
      transformerOptions: {
        ...nuxt.options.optimization.asyncTransforms,
        helperModule: await tryResolveModule('unctx', nuxt.options.modulesDir) ?? 'unctx'
      }
    } satisfies UnctxTransformPluginOptions
    addVitePlugin(() => UnctxTransformPlugin.vite(options))
    addWebpackPlugin(() => UnctxTransformPlugin.webpack(options))

    // Add composable tree-shaking optimisations
    const serverTreeShakeOptions: TreeShakeComposablesPluginOptions = {
      sourcemap: !!nuxt.options.sourcemap.server,
      composables: nuxt.options.optimization.treeShake.composables.server
    }
    if (Object.keys(serverTreeShakeOptions.composables).length) {
      addVitePlugin(() => TreeShakeComposablesPlugin.vite(serverTreeShakeOptions), { client: false })
      addWebpackPlugin(() => TreeShakeComposablesPlugin.webpack(serverTreeShakeOptions), { client: false })
    }
    const clientTreeShakeOptions: TreeShakeComposablesPluginOptions = {
      sourcemap: !!nuxt.options.sourcemap.client,
      composables: nuxt.options.optimization.treeShake.composables.client
    }
    if (Object.keys(clientTreeShakeOptions.composables).length) {
      addVitePlugin(() => TreeShakeComposablesPlugin.vite(clientTreeShakeOptions), { server: false })
      addWebpackPlugin(() => TreeShakeComposablesPlugin.webpack(clientTreeShakeOptions), { server: false })
    }
  })

  if (!nuxt.options.dev) {
    // DevOnly component tree-shaking - build time only
    addVitePlugin(() => DevOnlyPlugin.vite({ sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client }))
    addWebpackPlugin(() => DevOnlyPlugin.webpack({ sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client }))
  }

  if (nuxt.options.dev) {
    // Add plugin to check if layouts are defined without NuxtLayout being instantiated
    addPlugin(resolve(nuxt.options.appDir, 'plugins/check-if-layout-used'))
  }

  if (nuxt.options.dev && nuxt.options.features.devLogs) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/dev-server-logs.client'))
    addServerPlugin(resolve(distDir, 'core/runtime/nitro/dev-server-logs'))
    nuxt.options.nitro = defu(nuxt.options.nitro, {
      externals: {
        inline: [/#internal\/dev-server-logs-options/]
      },
      virtual: {
        '#internal/dev-server-logs-options': () => `export const rootDir = ${JSON.stringify(nuxt.options.rootDir)};`
      }
    })
  }

  // Transform initial composable call within `<script setup>` to preserve context
  if (nuxt.options.experimental.asyncContext) {
    addBuildPlugin(AsyncContextInjectionPlugin(nuxt))
  }

  // TODO: [Experimental] Avoid emitting assets when flag is enabled
  if (nuxt.options.features.noScripts && !nuxt.options.dev) {
    nuxt.hook('build:manifest', async (manifest) => {
      for (const file in manifest) {
        if (manifest[file].resourceType === 'script') {
          await fse.rm(resolve(nuxt.options.buildDir, 'dist/client', withoutLeadingSlash(nuxt.options.app.buildAssetsDir), manifest[file].file), { force: true })
          manifest[file].file = ''
        }
      }
    })
  }

  // Transpile #app if it is imported directly from subpath export
  nuxt.options.build.transpile.push('nuxt/app')

  // Transpile layers within node_modules
  nuxt.options.build.transpile.push(
    ...nuxt.options._layers.filter(i => i.cwd.includes('node_modules')).map(i => i.cwd as string)
  )

  // Init user modules
  await nuxt.callHook('modules:before')
  const modulesToInstall = []

  const watchedPaths = new Set<string>()
  const specifiedModules = new Set<string>()

  for (const _mod of nuxt.options.modules) {
    const mod = Array.isArray(_mod) ? _mod[0] : _mod
    if (typeof mod !== 'string') { continue }
    const modPath = await resolvePath(resolveAlias(mod))
    specifiedModules.add(modPath)
  }

  // Automatically register user modules
  for (const config of nuxt.options._layers.map(layer => layer.config).reverse()) {
    const modulesDir = (config.rootDir === nuxt.options.rootDir ? nuxt.options : config).dir?.modules || 'modules'
    const layerModules = await resolveFiles(config.srcDir, [
      `${modulesDir}/*{${nuxt.options.extensions.join(',')}}`,
      `${modulesDir}/*/index{${nuxt.options.extensions.join(',')}}`
    ])
    for (const mod of layerModules) {
      watchedPaths.add(mod)
      if (specifiedModules.has(mod)) { continue }
      specifiedModules.add(mod)
      modulesToInstall.push(mod)
    }
  }

  // Register user and then ad-hoc modules
  modulesToInstall.push(...nuxt.options.modules, ...nuxt.options._modules)

  // Add <NuxtWelcome>
  addComponent({
    name: 'NuxtWelcome',
    priority: 10, // built-in that we do not expect the user to override
    filePath: (await tryResolveModule('@nuxt/ui-templates/templates/welcome.vue', nuxt.options.modulesDir))!
  })

  addComponent({
    name: 'NuxtLayout',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/nuxt-layout')
  })

  // Add <NuxtErrorBoundary>
  addComponent({
    name: 'NuxtErrorBoundary',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/nuxt-error-boundary')
  })

  // Add <ClientOnly>
  addComponent({
    name: 'ClientOnly',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/client-only')
  })

  // Add <DevOnly>
  addComponent({
    name: 'DevOnly',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/dev-only')
  })

  // Add <ServerPlaceholder>
  addComponent({
    name: 'ServerPlaceholder',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/server-placeholder')
  })

  // Add <NuxtLink>
  addComponent({
    name: 'NuxtLink',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/nuxt-link')
  })

  // Add <NuxtLoadingIndicator>
  addComponent({
    name: 'NuxtLoadingIndicator',
    priority: 10, // built-in that we do not expect the user to override
    filePath: resolve(nuxt.options.appDir, 'components/nuxt-loading-indicator')
  })

  // Add <NuxtClientFallback>
  if (nuxt.options.experimental.clientFallback) {
    addComponent({
      name: 'NuxtClientFallback',
      _raw: true,
      priority: 10, // built-in that we do not expect the user to override
      filePath: resolve(nuxt.options.appDir, 'components/client-fallback.client'),
      mode: 'client'
    })

    addComponent({
      name: 'NuxtClientFallback',
      _raw: true,
      priority: 10, // built-in that we do not expect the user to override
      filePath: resolve(nuxt.options.appDir, 'components/client-fallback.server'),
      mode: 'server'
    })
  }

  // Add <NuxtIsland>
  if (nuxt.options.experimental.componentIslands) {
    addComponent({
      name: 'NuxtIsland',
      priority: 10, // built-in that we do not expect the user to override
      filePath: resolve(nuxt.options.appDir, 'components/nuxt-island')
    })

    if (!nuxt.options.ssr && nuxt.options.experimental.componentIslands !== 'auto') {
      nuxt.options.ssr = true
      nuxt.options.nitro.routeRules ||= {}
      nuxt.options.nitro.routeRules['/**'] = defu(nuxt.options.nitro.routeRules['/**'], { ssr: false })
    }
  }

  // Add stubs for <NuxtImg> and <NuxtPicture>
  for (const name of ['NuxtImg', 'NuxtPicture']) {
    addComponent({
      name,
      export: name,
      priority: -1,
      filePath: resolve(nuxt.options.appDir, 'components/nuxt-stubs'),
      // @ts-expect-error TODO: refactor to nuxi
      _internal_install: '@nuxt/image'
    })
  }

  // Add prerender payload support
  if (!nuxt.options.dev && nuxt.options.experimental.payloadExtraction) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/payload.client'))
  }

  // Add experimental cross-origin prefetch support using Speculation Rules API
  if (nuxt.options.experimental.crossOriginPrefetch) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/cross-origin-prefetch.client'))
  }

  // Add experimental page reload support
  if (nuxt.options.experimental.emitRouteChunkError === 'automatic') {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/chunk-reload.client'))
  }
  // Add experimental session restoration support
  if (nuxt.options.experimental.restoreState) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/restore-state.client'))
  }

  // Add experimental automatic view transition api support
  if (nuxt.options.experimental.viewTransition) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/view-transitions.client'))
  }

  // Add experimental support for custom types in JSON payload
  if (nuxt.options.experimental.renderJsonPayloads) {
    nuxt.hooks.hook('modules:done', () => {
      addPlugin(resolve(nuxt.options.appDir, 'plugins/revive-payload.client'))
      addPlugin(resolve(nuxt.options.appDir, 'plugins/revive-payload.server'))
    })
  }

  // Track components used to render for webpack
  if (nuxt.options.builder === '@nuxt/webpack-builder') {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/preload.server'))
  }

  const envMap = {
    // defaults from `builder` based on package name
    '@nuxt/vite-builder': 'vite/client',
    '@nuxt/webpack-builder': 'webpack/module',
    // simpler overrides from `typescript.builder` for better DX
    vite: 'vite/client',
    webpack: 'webpack/module',
    // default 'merged' builder environment for module authors
    shared: '@nuxt/schema/builder-env'
  }

  nuxt.hook('prepare:types', ({ references }) => {
    // Disable entirely if `typescript.builder` is false
    if (nuxt.options.typescript.builder === false) { return }

    const overrideEnv = nuxt.options.typescript.builder && envMap[nuxt.options.typescript.builder]
    // If there's no override, infer based on builder. If a custom builder is provided, we disable shared types
    const defaultEnv = typeof nuxt.options.builder === 'string' ? envMap[nuxt.options.builder] : false
    const types = overrideEnv || defaultEnv

    if (types) { references.push({ types }) }
  })

  // Add nuxt app debugger
  if (nuxt.options.debug) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/debug'))
  }

  for (const m of modulesToInstall) {
    if (Array.isArray(m)) {
      await installModule(m[0], m[1])
    } else {
      await installModule(m, {})
    }
  }

  await nuxt.callHook('modules:done')

  if (nuxt.options.experimental.appManifest) {
    addRouteMiddleware({
      name: 'manifest-route-rule',
      path: resolve(nuxt.options.appDir, 'middleware/manifest-route-rule'),
      global: true
    })

    addPlugin(resolve(nuxt.options.appDir, 'plugins/check-outdated-build.client'))
  }

  nuxt.hooks.hook('builder:watch', (event, relativePath) => {
    const path = resolve(nuxt.options.srcDir, relativePath)
    // Local module patterns
    if (watchedPaths.has(path)) {
      return nuxt.callHook('restart', { hard: true })
    }

    // User provided patterns
    const layerRelativePaths = nuxt.options._layers.map(l => relative(l.config.srcDir || l.cwd, path))
    for (const pattern of nuxt.options.watch) {
      if (typeof pattern === 'string') {
        // Test (normalized) strings against absolute path and relative path to any layer `srcDir`
        if (pattern === path || layerRelativePaths.includes(pattern)) { return nuxt.callHook('restart') }
        continue
      }
      // Test regular expressions against path to _any_ layer `srcDir`
      if (layerRelativePaths.some(p => pattern.test(p))) {
        return nuxt.callHook('restart')
      }
    }

    // Core Nuxt files: app.vue, error.vue and app.config.ts
    const isFileChange = ['add', 'unlink'].includes(event)
    if (isFileChange && RESTART_RE.test(path)) {
      logger.info(`\`${path}\` ${event === 'add' ? 'created' : 'removed'}`)
      return nuxt.callHook('restart')
    }
  })

  // Normalize windows transpile paths added by modules
  nuxt.options.build.transpile = nuxt.options.build.transpile.map(t => typeof t === 'string' ? normalize(t) : t)

  addModuleTranspiles()

  // Init nitro
  await initNitro(nuxt)

  // TODO: remove when app manifest support is landed in https://github.com/nuxt/nuxt/pull/21641
  // Add prerender payload support
  const nitro = useNitro()
  if (nitro.options.static && nuxt.options.experimental.payloadExtraction === undefined) {
    logger.warn('Using experimental payload extraction for full-static output. You can opt-out by setting `experimental.payloadExtraction` to `false`.')
    nuxt.options.experimental.payloadExtraction = true
  }
  nitro.options.replace['process.env.NUXT_PAYLOAD_EXTRACTION'] = String(!!nuxt.options.experimental.payloadExtraction)
  nitro.options._config.replace!['process.env.NUXT_PAYLOAD_EXTRACTION'] = String(!!nuxt.options.experimental.payloadExtraction)

  if (!nuxt.options.dev && nuxt.options.experimental.payloadExtraction) {
    addPlugin(resolve(nuxt.options.appDir, 'plugins/payload.client'))
  }

  await nuxt.callHook('ready', nuxt)
}

export async function loadNuxt (opts: LoadNuxtOptions): Promise<Nuxt> {
  const options = await loadNuxtConfig(opts)

  // Temporary until finding better placement for each
  options.appDir = options.alias['#app'] = resolve(distDir, 'app')
  options._majorVersion = 3

  // Nuxt DevTools only works for Vite
  if (options.builder === '@nuxt/vite-builder') {
    const isDevToolsEnabled = typeof options.devtools === 'boolean'
      ? options.devtools
      : options.devtools?.enabled !== false // enabled by default unless explicitly disabled

    if (isDevToolsEnabled) {
      if (!options._modules.some(m => m === '@nuxt/devtools' || m === '@nuxt/devtools-edge')) {
        options._modules.push('@nuxt/devtools')
      }
    }
  }

  // Nuxt Webpack Builder is currently opt-in
  if (options.builder === '@nuxt/webpack-builder') {
    if (!await import('./features').then(r => r.ensurePackageInstalled('@nuxt/webpack-builder', {
      rootDir: options.rootDir,
      searchPaths: options.modulesDir
    }))) {
      logger.warn('Failed to install `@nuxt/webpack-builder`, please install it manually, or change the `builder` option to vite in `nuxt.config`')
    }
  }

  // Add core modules
  options._modules.push(pagesModule, metaModule, componentsModule)
  options._modules.push([importsModule, {
    transform: {
      include: options._layers
        .filter(i => i.cwd && i.cwd.includes('node_modules'))
        .map(i => new RegExp(`(^|\\/)${escapeRE(i.cwd!.split('node_modules/').pop()!)}(\\/|$)(?!node_modules\\/)`))
    }
  }])
  options._modules.push(schemaModule)
  options.modulesDir.push(resolve(options.workspaceDir, 'node_modules'))
  options.modulesDir.push(resolve(pkgDir, 'node_modules'))
  options.build.transpile.push(
    '@nuxt/ui-templates', // this exposes vue SFCs
    'std-env' // we need to statically replace process.env when used in runtime code
  )
  options.alias['vue-demi'] = resolve(options.appDir, 'compat/vue-demi')
  options.alias['@vue/composition-api'] = resolve(options.appDir, 'compat/capi')
  if (options.telemetry !== false && !process.env.NUXT_TELEMETRY_DISABLED) {
    options._modules.push('@nuxt/telemetry')
  }

  const nuxt = createNuxt(options)

  // We register hooks layer-by-layer so any overrides need to be registered separately
  if (opts.overrides?.hooks) {
    nuxt.hooks.addHooks(opts.overrides.hooks)
  }

  if (nuxt.options.debug) {
    createDebugger(nuxt.hooks, { tag: 'nuxt' })
  }

  if (opts.ready !== false) {
    await nuxt.ready()
  }

  return nuxt
}

const RESTART_RE = /^(app|error|app\.config)\.(js|ts|mjs|jsx|tsx|vue)$/i
