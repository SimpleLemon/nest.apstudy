import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [react()],
    build: {
        outDir: path.resolve(rootDir, 'static/js/notes/dist'),
        emptyOutDir: false,
        rollupOptions: {
            input: path.resolve(rootDir, 'static/js/notes/editor-entry.js'),
            output: {
                entryFileNames: 'notes-editor.js',
                chunkFileNames: 'notes-editor-[name].js',
                assetFileNames: 'notes-editor[extname]',
            },
        },
        sourcemap: false,
        minify: 'esbuild',
    },
});
