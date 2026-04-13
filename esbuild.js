const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
  });

  if (watch) {
    console.log('[claude-io] esbuild: watching for changes...');
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('[claude-io] esbuild: build complete');
  }
}

main().catch((err) => {
  console.error('[claude-io] esbuild failed:', err);
  process.exit(1);
});
