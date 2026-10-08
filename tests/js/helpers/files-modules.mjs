import { buildSync } from 'esbuild';
import vm from 'node:vm';

const bundles = new Map();

// Resolve the actual browser module graph, preserving its public exports. This
// avoids rewriting imports, closures, or private feature state in fixtures.
export function loadFilesModule(relativePath, context) {
    if (!bundles.has(relativePath)) {
        const result = buildSync({
            entryPoints: [`static/js/${relativePath}`],
            bundle: true,
            write: false,
            platform: 'browser',
            format: 'iife',
            globalName: 'FilesModule',
        });
        bundles.set(relativePath, result.outputFiles[0].text);
    }
    if (!vm.isContext(context)) vm.createContext(context);
    vm.runInContext(bundles.get(relativePath), context);
    return context.FilesModule;
}
