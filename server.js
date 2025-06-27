import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: true });

fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.get('/tools', async (request, reply) => {
  return {
    tools: [
      {
        name: 'scrape_websites',
        description: 'Scrape multiple travel websites for latest articles'
      }
    ]
  };
});

fastify.post('/execute/scrape_websites', async (request, reply) => {
  const { websites } = request.body;
  const results = [];

  for (const site of websites) {
    try {
      const response = await axios.get(site.url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      const articles = [];
      const debug = [];

      // Try multiple generic selectors and log what we find
      const selectors = [
        'h1 a', 'h2 a', 'h3 a', 'h4 a',
        '.headline a', '.title a', '.card-title a',
        'article a', '.article a', '.story a',
        '[class*="title"] a', '[class*="headline"] a',
        'a[href*="/"]'
      ];

      for (const selector of selectors) {
        const found = $(selector).length;
        if (found > 0) {
          debug.push(`${selector}: ${found} elements`);
          
          // Get first few matches
          $(selector).slice(0, 20).each((i, elem) => {
            const $elem = $(elem);
            const title = $elem.text().trim();
            let link = $elem.attr('href');
            
            if (title && link && title.length > 5 && title.length < 300) {
              if (link.startsWith('/')) {
                link = new URL(link, site.url).href;
              }
              
              // Only add if it looks like an article (has reasonable title)
              if (!articles.some(a => a.title === title) && 
                  !title.match(/^(Home|About|Contact|Search|Menu|Login|Subscribe)$/i)) {
                articles.push({
                  title: title,
                  url: link,
                  source: site.name,
                  selector_used: selector,
                  scraped_at: new Date().toISOString()
                });
              }
            }
          });
        }
      }

      // Take only first 10 articles
      const finalArticles = articles.slice(0, 10);

      results.push({
        site: site.name,
        articles: finalArticles,
        success: true,
        articles_found: finalArticles.length,
        debug_info: debug.slice(0, 10), // Show what selectors found elements
        page_title: $('title').text() || 'No title found'
      });

    } catch (error) {
      results.push({
        site: site.name,
        error: error.message,
        success: false,
        articles_found: 0
      });
    }
  }

  return {
    results,
    total_sites: websites.length,
    successful_sites: results.filter(r => r.success).length,
    total_articles: results.reduce((sum, r) => sum + (r.articles_found || 0), 0)
  };
});

const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Debug MCP Server running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
