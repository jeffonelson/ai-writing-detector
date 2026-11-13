import { defineConfig, loadEnv } from 'vite';
import pangramProxy from './plugins/pangram-proxy.js';

export default defineConfig(({ mode }) => {
    // Read PANGRAM_API_KEY from .env for the proxy only; it is never exposed to client code.
    const { PANGRAM_API_KEY } = loadEnv(mode, process.cwd(), 'PANGRAM_');

    return {
        plugins: [pangramProxy(PANGRAM_API_KEY)],
        server: {
            port: 5173,
            open: true,
        },
    };
});
