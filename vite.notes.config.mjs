import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    base: './',
    plugins: [react()],
    resolve: {
        dedupe: ['yjs'],
    },
    build: {
        outDir: path.resolve(rootDir, 'static/js/notes/dist'),
        emptyOutDir: true,
        rollupOptions: {
            input: path.resolve(rootDir, 'static/js/notes/editor-entry.js'),
            output: {
                entryFileNames: 'notes-editor-bundle-15.js',
                chunkFileNames: 'notes-editor-[name].js',
                assetFileNames: (assetInfo) => (
                    assetInfo.name?.endsWith('.css')
                        ? 'notes-editor.css'
                        : 'notes-editor-[name][extname]'
                ),
            },
        },
        sourcemap: false,
        minify: 'esbuild',
    },
});
