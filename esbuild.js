const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Plugin that emits machine-parseable build-start and build-end markers.
 * VSCode's background-task problem matcher uses these to know when a
 * watch-mode rebuild has started and finished, which is what makes F5
 * "Run Extension" wait for the first successful build before launching.
 */
const buildPhaseLoggerPlugin = {
  name: 'build-phase-logger',
  setup(build) {
    build.onStart(() => {
      console.log('[claude-io] esbuild: build started');
    });
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        console.log(
          `[claude-io] esbuild: build finished with ${result.errors.length} error(s)`,
        );
      } else {
        console.log('[claude-io] esbuild: build finished');
      }
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
    logOverride: {
      'direct-eval': 'silent',
    },
    plugins: [buildPhaseLoggerPlugin],
  });

  if (watch) {
    console.log('[claude-io] esbuild: watching for changes...');
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error('[claude-io] esbuild failed:', err);
  process.exit(1);
});
