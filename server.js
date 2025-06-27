import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: true });

fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.post('/scrape-latest-travel-news', async (request, reply) => {
  const { max_articles = 20, debug = false } = request.body || {};
  const results = [];

  const sources = [
    {
      name: "Travel + Leisure",
      url: "https://www.travelandleisure.com/",
      selectors: ['article h2 a', 'article h3 a', '.card-title a', 'h2 a', 'h3 a']
    },
    {
      name: "BBC Travel",
      url: "https://www.bbc.com/travel",
      selectors: ['article h2 a', 'article h3 a', '.media__title a', 'h2 a', 'h3 a']
    },
    {
      name: "AFAR Magazine",
      url: "https://www.afar.com/",
      selectors: ['h2 a', 'h3 a', '.title a', '.headline a', 'article a']
    }
  ];

  for (const source of sources) {
    try {
      const response = await axios.get(source.url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      const articles = [];
      const debugInfo = [];

      // Try each selector and see what we find
      for (const selector of source.selectors) {
        const found = $(selector);
        debugInfo.push(`${selector}: ${found.length} elements`);

        found.each((i, elem) => {
          if (i >= 10) return false; // Limit per selector
          
          const $elem = $(elem);
          const title = $elem.text().trim();
          let link = $elem.attr('href');

          if (title && link && title.length > 5) {
            // Fix relative URLs
            if (link.startsWith('/')) {
              link = new URL(link, source.url).href;
            }

            // Very basic filtering - just avoid obvious navigation
            const isNav = ['home', 'about', 'contact', 'search', 'menu'].some(nav =>
              title.toLowerCase() === nav.toLowerCase()
            );

            if (!isNav && link.startsWith('http')) {
              articles.push({
                title: title.substring(0, 200),
                url: link,
                source: source.name,
                selector_used: selector,
                scraped_at: new Date().toISOString()
              });
            }
          }
        });
      }

      // Remove duplicates by title
      const uniqueArticles = articles.filter((article, index, self) =>
        index === self.findIndex(a => a.title === article.title)
      );

      results.push({
        source: source.name,
        articles: uniqueArticles.slice(0, 8), // Top 8 from each source
        debug_info: debug ? debugInfo : undefined,
        page_title: $('title').text(),
        total_found: uniqueArticles.length,
        success: true
      });

    } catch (error) {
      results.push({
        source: source.name,
        error: error.message,
        success: false,
        articles: []
      });
    }
  }

  const allArticles = results
    .filter(r => r.success)
    .flatMap(r => r.articles)
    .slice(0, max_articles);

  return {
    latest_travel_news: allArticles,
    summary: {
      total_articles: allArticles.length,
      sources_checked: sources.length,
      successful_sources: results.filter(r => r.success).length,
      scan_timestamp: new Date().toISOString()
    },
    debug_results: debug ? results : undefined
  };
});

const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Travel News Server running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
