/**
 * Vite plugin that proxies POST /api/analyze to the Pangram V3 API.
 * Injects the API key from process.env so it never reaches the browser.
 */
export default function pangramProxy(apiKey) {
  return {
    name: 'pangram-proxy',
    configureServer(server) {
      server.middlewares.use('/api/analyze', async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!apiKey || apiKey === 'your-api-key-here') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'PANGRAM_API_KEY not configured. Please ensure it is set in your .env file and restart the server.'
          }));
          return;
        }

        // Read the request body
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }

        try {
          const parsed = JSON.parse(body);

          const pangramRes = await fetch('https://text.api.pangram.com/v3', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
            },
            body: JSON.stringify({
              text: parsed.text,
              public_dashboard_link: true,
            }),
          });

          const data = await pangramRes.json();

          res.writeHead(pangramRes.status, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify(data));
        } catch (err) {
          console.error('[pangram-proxy] Error:', err.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to reach Pangram API: ' + err.message }));
        }
      });
    },
  };
}
