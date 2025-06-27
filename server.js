import Fastify from 'fastify';
import { Browserbase } from '@browserbasehq/sdk';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: true });

// Initialize Browserbase
const bb = new Browserbase({
  apiKey: process.env.bb_live_Z8KE-bGrA4AaQL0hWF6jh5h7njk,
});

fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.post('/scrape-latest-travel-news', async (request, reply) => {
  const { max_articles = 20 } = request.body || {};
  const results = [];

  const sources = [
    {
      name: "Travel + Leisure",
      url: "https://www.travelandleisure.com/",
      selectors: ['article h2 a', 'h2 a', 'h3 a', '.card-title a']
    },
    {
      name: "BBC Travel",
      url: "https://www.bbc.com/travel",
      selectors: ['article h2 a', 'h3 a', '.media__title a']
    },
    {
      name: "AFAR Magazine",
      url: "https://www.afar.com/",
      selectors: ['h2 a', 'h3 a', '[class*="title"] a']
    }
  ];

  for (const source of sources) {
    try {
      // Create a new browser session
      const session = await bb.sessions.create({
        projectId: process.env.45e4602f-ce33-41a1-ad53-94435f24176e, // We'll set this up
      });

      // Navigate to the page
      const page = await bb.pages.create(session.id);
      await bb.pages.goto(page.id, { url: source.url });
      
      // Wait for content to load
      await bb.pages.waitFor(page.id, { timeout: 5000 });
      
      // Get the HTML content
      const html = await bb.pages.getHTML(page.id);
      
      // Clean up
      await bb.sessions.end(session.id);

      // Parse with Cheerio (same as before)
      const $ = cheerio.load(html);
      const articles = [];

      for (const selector of source.selectors) {
        $(selector).each((i, elem) => {
          if (articles.length >= 10) return false;

          const $elem = $(elem);
          const title = $elem.text().trim();
          let link = $elem.attr('href');

          if (title && link && title.length > 15 && title.length < 200) {
            if (link.startsWith('/')) {
              link = new URL(link, source.url).href;
            }

            // Filter for travel content
            const travelKeywords = ['travel', 'destination', 'hotel', 'trip', 'vacation', 'visit', 'guide', 'best', 'new'];
            const isTravel = travelKeywords.some(keyword =>
              title.toLowerCase().includes(keyword) || link.toLowerCase().includes(keyword)
            );

            if (isTravel && link.startsWith('http')) {
              articles.push({
                title: title,
                url: link,
                source: source.name,
                scraped_at: new Date().toISOString()
              });
            }
          }
        });
        
        if (articles.length > 0) break; // Found articles with this selector
      }

      results.push({
        source: source.name,
        articles: articles.slice(0, 8),
        total_found: articles.length,
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
