import { defineConfig, loadEnv } from 'vite';
import pangramProxy from './plugins/pangram-proxy.js';

export default defineConfig(({ mode }) => {
    // Load .env into process.env so the proxy plugin can read PANGRAM_API_KEY
    const env = loadEnv(mode, process.cwd(), '');
    console.log('[vite.config] Loaded PANGRAM_API_KEY:', env.PANGRAM_API_KEY ? 'Present (First 4 chars: ' + env.PANGRAM_API_KEY.slice(0, 4) + '...)' : 'Missing');
    Object.assign(process.env, env);

    return {
        plugins: [pangramProxy(env.PANGRAM_API_KEY)],
        server: {
            port: 5173,
            open: true,
        },
    };
});
