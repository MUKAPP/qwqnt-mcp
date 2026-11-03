import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { builtinModules } from 'node:module'

const SRC_DIR = resolve(__dirname, './src')
const OUTPUT_DIR = resolve(__dirname, './dist')

const external = ['electron', ...builtinModules.flatMap((m) => [m, `node:${m}`])]

const BaseConfig = defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@': SRC_DIR,
    },
  },
})

const configs = {
  main: defineConfig({
    ...BaseConfig,
    build: {
      minify: true,
      emptyOutDir: false,
      outDir: resolve(OUTPUT_DIR, './main'),
      lib: {
        entry: resolve(SRC_DIR, './main/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.js',
      },
      rolldownOptions: {
        external,
      },
      target: 'node20',
    },
  }),
  preload: defineConfig({
    ...BaseConfig,
    build: {
      minify: true,
      emptyOutDir: false,
      outDir: resolve(OUTPUT_DIR, './preload'),
      lib: {
        entry: resolve(SRC_DIR, './preload/index.ts'),
        formats: ['cjs'],
        fileName: () => 'index.cjs',
      },
      rolldownOptions: {
        external,
      },
      target: 'node20',
    },
  }),
}

export default defineConfig(({ mode }) => configs[mode as keyof typeof configs])
