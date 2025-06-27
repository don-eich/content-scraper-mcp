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

  const siteConfigs = {
    'travelandleisure.com': ['h2 a', 'h3 a', '.card-title a', 'article h2 a'],
    'cntraveler.com': ['h2 a', 'h3 a', '.summary-item__hed a', 'article h2 a'],
    'afar.com': ['h2 a', 'h3 a', '.card__title a', '.article-title a'],
    'wallpaper.com': ['h2 a', 'h3 a', '.article-card__title a'],
    'bbc.com': ['h2 a', 'h3 a', '.media__link', 'article h2 a'],
    'nytimes.com': ['h2 a', 'h3 a', '.story-wrapper h2 a'],
    'budgettravel.com': ['h2 a', 'h3 a', '.article-title a'],
    'cnn.com': ['h3 a', '.card-title a', '.cd__headline a'],
    'nationalgeographic.com': ['h2 a', 'h3 a', '.card-title a']
  };

  for (const site of websites) {
    try {
      const response = await axios.get(site.url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      const articles = [];
      
      const domain = new URL(site.url).hostname.replace('www.', '');
      const selectors = siteConfigs[domain] || ['h2 a', 'h3 a'];
      
      for (const selector of selectors) {
        $(selector).each((i, elem) => {
          if (articles.length >= 10) return false;
          
          const $elem = $(elem);
          const title = $elem.text().trim();
          let link = $elem.attr('href');
          
          if (title && link && title.length > 10) {
            if (link.startsWith('/')) {
              link = new URL(link, site.url).href;
            }
            
            if (!articles.some(a => a.title === title)) {
              articles.push({
                title: title.substring(0, 200),
                url: link,
                source: site.name,
                scraped_at: new Date().toISOString()
              });
            }
          }
        });
        
        if (articles.length > 0) break;
      }

      results.push({
        site: site.name,
        articles,
        success: true,
        articles_found: articles.length
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
    console.log(`Enhanced MCP Server running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
