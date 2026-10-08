const { buildSync } = require('esbuild');
const vm = require('node:vm');
const path = require('node:path');

const bundles = new Map();

// Execute the real module graph with its public exports and browser ports.
function loadFeatureModule(relativePath, context = {}) {
  if (!bundles.has(relativePath)) {
    const result = buildSync({
      entryPoints: [path.resolve(__dirname, '../../../static/js', relativePath)],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      globalName: 'FeatureModule',
    });
    bundles.set(relativePath, result.outputFiles[0].text);
  }
  if (!vm.isContext(context)) vm.createContext(context);
  vm.runInContext(bundles.get(relativePath), context);
  return context.FeatureModule;
}

module.exports = { loadFeatureModule };
