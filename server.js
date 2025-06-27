import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: true });

fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.post('/scrape-latest-travel-news', async (request, reply) => {
  const { max_articles = 25 } = request.body || {};
  const results = [];

  // ALL 9 WEBSITES YOU REQUESTED
  const sources = [
    {
      name: "Travel + Leisure",
      url: "https://www.travelandleisure.com/"
    },
    {
      name: "Condé Nast Traveler", 
      url: "https://www.cntraveler.com/"
    },
    {
      name: "AFAR",
      url: "https://www.afar.com/"
    },
    {
      name: "Wallpaper Travel",
      url: "https://www.wallpaper.com/travel"
    },
    {
      name: "BBC Travel",
      url: "https://www.bbc.com/travel"
    },
    {
      name: "NY Times Travel",
      url: "https://www.nytimes.com/section/travel"
    },
    {
      name: "Budget Travel",
      url: "https://www.budgettravel.com/"
    },
    {
      name: "CNN Travel",
      url: "https://www.cnn.com/travel"
    },
    {
      name: "National Geographic Travel",
      url: "https://www.nationalgeographic.com/travel"
    }
  ];

  for (const source of sources) {
    try {
      // CORRECT Browserbase API format
      const sessionResponse = await axios.post('https://api.browserbase.com/v1/sessions', {
        projectId: process.env.BROWSERBASE_PROJECT_ID
      }, {
        headers: {
          'x-bb-api-key': process.env.BROWSERBASE_API_KEY, // Correct header format
          'Content-Type': 'application/json'
        },
        timeout: 20000
      });

      const sessionId = sessionResponse.data.id;
      console.log(`Created session ${sessionId} for ${source.name}`);

      // Use Connect API to navigate
      const connectResponse = await axios.get(`https://api.browserbase.com/v1/sessions/${sessionId}/connect`, {
        headers: {
          'x-bb-api-key': process.env.BROWSERBASE_API_KEY
        }
      });

      const { connectUrl } = connectResponse.data;

      // Navigate using Playwright-like commands
      await axios.post(`${connectUrl}/page/goto`, {
        url: source.url,
        options: { waitUntil: 'networkidle' }
      }, {
        timeout: 15000
      });

      // Wait for content to load
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Get page content
      const contentResponse = await axios.get(`${connectUrl}/page/content`, {
        timeout: 10000
      });

      const html = contentResponse.data.content;

      // Clean up session
      await axios.delete(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
        headers: {
          'x-bb-api-key': process.env.BROWSERBASE_API_KEY
        }
      });

      // Parse with Cheerio
      const $ = cheerio.load(html);
      const articles = [];

      // Multiple selectors for different site structures
      const selectors = [
        'h2 a', 'h3 a', 'h4 a',
        'article h2 a', 'article h3 a',
        '.title a', '.headline a', '.hed a',
        '.card-title a', '.story-title a',
        '[class*="title"] a', '[class*="headline"] a'
      ];

      for (const selector of selectors) {
        $(selector).each((i, elem) => {
          if (articles.length >= 5) return false; // Limit per selector

          const $elem = $(elem);
          const title = $elem.text().trim();
          let link = $elem.attr('href');

          if (title && link && title.length > 10 && title.length < 300) {
            // Fix relative URLs
            if (link.startsWith('/')) {
              link = new URL(link, source.url).href;
            }

            // Travel content filtering
            const travelKeywords = [
              'travel', 'destination', 'hotel', 'trip', 'vacation', 'visit', 
              'guide', 'best', 'places', 'where', 'tips', 'journey', 'explore',
              'adventure', 'getaway', 'tourism', 'discover', 'experience'
            ];

            const isTravel = travelKeywords.some(keyword =>
              title.toLowerCase().includes(keyword) || 
              link.toLowerCase().includes(keyword)
            );

            // Avoid navigation/menu items
            const isNav = [
              'home', 'about', 'contact', 'search', 'menu', 'newsletter', 
              'subscribe', 'sign in', 'log in', 'account', 'shop'
            ].some(nav => title.toLowerCase().includes(nav));

            if (link.startsWith('http') && !isNav && (isTravel || articles.length < 2)) {
              articles.push({
                title: title,
                url: link,
                source: source.name,
                scraped_at: new Date().toISOString()
              });
            }
          }
        });

        if (articles.length >= 3) break; // Found enough articles
      }

      // Remove duplicates
      const uniqueArticles = articles.filter((article, index, self) =>
        index === self.findIndex(a => a.title.toLowerCase() === article.title.toLowerCase())
      );

      results.push({
        source: source.name,
        articles: uniqueArticles.slice(0, 4), // Top 4 per source
        total_found: uniqueArticles.length,
        success: true,
        method: 'browserbase'
      });

    } catch (error) {
      console.error(`Error scraping ${source.name}:`, error.message);
      
      results.push({
        source: source.name,
        error: error.message.substring(0, 100), // Truncate long errors
        success: false,
        articles: []
      });
    }

    // Small delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
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
    source_breakdown: results.map(r => ({
      source: r.source,
      articles_found: r.articles?.length || 0,
      success: r.success,
      error: r.error || null
    }))
  };
});

const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`All 9 Travel Sites Scraper running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
