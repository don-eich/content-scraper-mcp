import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: true });

fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.post('/scrape-latest-travel-news', async (request, reply) => {
  const { max_articles = 20 } = request.body || {};
  const results = [];

  const sources = [
    {
      name: "Travel + Leisure",
      url: "https://www.travelandleisure.com/"
    },
    {
      name: "BBC Travel",
      url: "https://www.bbc.com/travel"
    },
    {
      name: "AFAR Magazine",
      url: "https://www.afar.com/"
    }
  ];

  for (const source of sources) {
    try {
      // Create Browserbase session
      const sessionResponse = await axios.post('https://api.browserbase.com/v1/sessions', {
        projectId: process.env.BROWSERBASE_PROJECT_ID
      }, {
        headers: {
          'X-BB-API-Key': process.env.BROWSERBASE_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const sessionId = sessionResponse.data.id;
      console.log(`Created session ${sessionId} for ${source.name}`);

      // Navigate to page
      await axios.post(`https://api.browserbase.com/v1/sessions/${sessionId}/actions`, {
        action: 'goto',
        url: source.url
      }, {
        headers: {
          'X-BB-API-Key': process.env.BROWSERBASE_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      // Wait for page to load
      await new Promise(resolve => setTimeout(resolve, 4000));

      // Get page content
      const contentResponse = await axios.post(`https://api.browserbase.com/v1/sessions/${sessionId}/actions`, {
        action: 'content'
      }, {
        headers: {
          'X-BB-API-Key': process.env.BROWSERBASE_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      const html = contentResponse.data.content;

      // End session
      await axios.delete(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
        headers: {
          'X-BB-API-Key': process.env.BROWSERBASE_API_KEY
        }
      });

      // Parse with Cheerio
      const $ = cheerio.load(html);
      const articles = [];

      // Debug: count elements
      const debugInfo = {
        total_links: $('a').length,
        h2_links: $('h2 a').length,
        h3_links: $('h3 a').length,
        articles: $('article').length
      };

      console.log(`${source.name} debug:`, debugInfo);

      // Try multiple selectors
      const selectors = ['h2 a', 'h3 a', 'article h2 a', 'article h3 a', '.title a', '.headline a'];

      for (const selector of selectors) {
        $(selector).each((i, elem) => {
          if (articles.length >= 8) return false;

          const $elem = $(elem);
          const title = $elem.text().trim();
          let link = $elem.attr('href');

          if (title && link && title.length > 15 && title.length < 250) {
            // Fix relative URLs
            if (link.startsWith('/')) {
              link = new URL(link, source.url).href;
            }

            // Travel content filtering
            const travelKeywords = ['travel', 'destination', 'hotel', 'trip', 'vacation', 'visit', 'guide', 'best', 'places', 'where', 'tips'];
            const isTravel = travelKeywords.some(keyword =>
              title.toLowerCase().includes(keyword) || link.toLowerCase().includes(keyword)
            );

            // Avoid navigation
            const isNav = ['home', 'about', 'contact', 'search', 'menu', 'newsletter', 'subscribe', 'sign in'].some(nav =>
              title.toLowerCase().includes(nav)
            );

            if (link.startsWith('http') && !isNav && (isTravel || articles.length < 3)) {
              articles.push({
                title: title,
                url: link,
                source: source.name,
                selector_used: selector,
                scraped_at: new Date().toISOString()
              });
            }
          }
        });

        if (articles.length >= 3) break;
      }

      // Remove duplicates
      const uniqueArticles = articles.filter((article, index, self) =>
        index === self.findIndex(a => a.title === article.title)
      );

      results.push({
        source: source.name,
        articles: uniqueArticles.slice(0, 6),
        total_found: uniqueArticles.length,
        debug_info: debugInfo,
        success: true,
        method: 'browserbase'
      });

    } catch (error) {
      console.error(`Error scraping ${source.name}:`, error.message);
      
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
    source_breakdown: results
  };
});

const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Browserbase Travel Scraper running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
