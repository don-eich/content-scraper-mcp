import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: true });

await fastify.register(import('@fastify/cors'), {
  origin: true
});

fastify.get('/tools', async (request, reply) => {
  return {
    tools: [
      {
        name: 'scrape_websites',
        description: 'Scrape multiple websites for latest articles'
      }
    ]
  };
});

fastify.post('/execute/scrape_websites', async (request, reply) => {
  const { websites } = request.body;
  const results = [];
  
  for (const site of websites.slice(0, 5)) {
    try {
      const response = await axios.get(site.url, { timeout: 10000 });
      const $ = cheerio.load(response.data);
      
      const articles = [];
      $('h2 a, h3 a, .title a').each((i, elem) => {
        if (i < 3) {
          const title = $(elem).text().trim();
          const link = $(elem).attr('href');
          if (title && link) {
            articles.push({ title, url: link, source: site.name });
          }
        }
      });
      
      results.push({ site: site.name, articles, success: true });
    } catch (error) {
      results.push({ site: site.name, error: error.message, success: false });
    }
  }
  
  return { results };
});

fastify.get('/health', async () => ({ status: 'ok' }));

const start = async () => {
  const port = process.env.PORT || 3000;
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`MCP Server running on port ${port}`);
};

start().catch(console.error);
