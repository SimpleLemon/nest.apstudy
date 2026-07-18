import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    base: "./",
    resolve: {
        dedupe: ["react", "react-dom"],
    },
    build: {
        outDir: path.resolve(rootDir, "static/js/tasks/dist"),
        emptyOutDir: true,
        target: "es2020",
        sourcemap: false,
        minify: "esbuild",
        rollupOptions: {
            input: path.resolve(rootDir, "static/js/tasks/task.js"),
            output: {
                entryFileNames: "task-app.js",
                inlineDynamicImports: true,
            },
        },
    },
});
