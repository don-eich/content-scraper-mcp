import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: true });

fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.post('/scrape-latest-travel-news', async (request, reply) => {
  const { max_articles = 25, use_browserbase = false } = request.body || {};
  const results = [];

  // ALL 9 WEBSITES
  const sources = [
    {
      name: "Travel + Leisure",
      url: "https://www.travelandleisure.com/",
      fallback_selectors: ['article h2 a', 'h2 a', '.card-title a']
    },
    {
      name: "Condé Nast Traveler", 
      url: "https://www.cntraveler.com/",
      fallback_selectors: ['h2 a', 'h3 a', '.summary-item__hed a']
    },
    {
      name: "AFAR",
      url: "https://www.afar.com/",
      fallback_selectors: ['h2 a', '[class*="title"] a', '.title a']
    },
    {
      name: "Wallpaper Travel",
      url: "https://www.wallpaper.com/travel",
      fallback_selectors: ['h2 a', 'h3 a', '.article-card__title a']
    },
    {
      name: "BBC Travel",
      url: "https://www.bbc.com/travel",
      fallback_selectors: ['article h2 a', 'h3 a', '.media__title a']
    },
    {
      name: "NY Times Travel",
      url: "https://www.nytimes.com/section/travel",
      fallback_selectors: ['h2 a', 'h3 a', '.story-wrapper h2 a']
    },
    {
      name: "Budget Travel",
      url: "https://www.budgettravel.com/",
      fallback_selectors: ['h2 a', 'h3 a', '.article-title a']
    },
    {
      name: "CNN Travel",
      url: "https://www.cnn.com/travel",
      fallback_selectors: ['h3 a', '.card-title a', '.cd__headline a']
    },
    {
      name: "National Geographic Travel",
      url: "https://www.nationalgeographic.com/travel",
      fallback_selectors: ['h2 a', 'h3 a', '.card-title a']
    }
  ];

  // Process in batches to avoid overwhelming Browserbase
  const batchSize = 3;
  const batches = [];
  for (let i = 0; i < sources.length; i += batchSize) {
    batches.push(sources.slice(i, i + batchSize));
  }

  for (const [batchIndex, batch] of batches.entries()) {
    console.log(`Processing batch ${batchIndex + 1}/${batches.length}`);

    for (const source of batch) {
      try {
        let html = '';
        let method = 'fallback';

        // Try Browserbase only for first batch or if explicitly requested
        if (use_browserbase && batchIndex === 0) {
          try {
            const sessionResponse = await axios.post('https://api.browserbase.com/v1/sessions', {
              projectId: process.env.BROWSERBASE_PROJECT_ID
            }, {
              headers: {
                'x-bb-api-key': process.env.BROWSERBASE_API_KEY,
                'Content-Type': 'application/json'
              },
              timeout: 10000
            });

            const sessionId = sessionResponse.data.id;
            
            // Simple navigation
            await axios.post(`https://api.browserbase.com/v1/sessions/${sessionId}/goto`, {
              url: source.url
            }, {
              headers: {
                'x-bb-api-key': process.env.BROWSERBASE_API_KEY
              },
              timeout: 8000
            });

            await new Promise(resolve => setTimeout(resolve, 2000));

            const contentResponse = await axios.get(`https://api.browserbase.com/v1/sessions/${sessionId}/content`, {
              headers: {
                'x-bb-api-key': process.env.BROWSERBASE_API_KEY
              },
              timeout: 5000
            });

            html = contentResponse.data;
            method = 'browserbase';

            await axios.delete(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
              headers: {
                'x-bb-api-key': process.env.BROWSERBASE_API_KEY
              }
            });

          } catch (browserbaseError) {
            console.log(`Browserbase failed for ${source.name}, using fallback`);
            // Fall through to HTTP method
          }
        }

        // Fallback to direct HTTP (faster and more reliable)
        if (!html) {
          const response = await axios.get(source.url, {
            timeout: 8000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'no-cache'
            }
          });
          html = response.data;
        }

        // Parse with Cheerio
        const $ = cheerio.load(html);
        const articles = [];

        // Use site-specific selectors
        const selectors = source.fallback_selectors;

        for (const selector of selectors) {
          $(selector).each((i, elem) => {
            if (articles.length >= 4) return false;

            const $elem = $(elem);
            const title = $elem.text().trim();
            let link = $elem.attr('href');

            if (title && link && title.length > 10 && title.length < 250) {
              // Fix relative URLs
              if (link.startsWith('/')) {
                link = new URL(link, source.url).href;
              }

              // Simple travel filtering
              const travelKeywords = [
                'travel', 'destination', 'hotel', 'trip', 'vacation', 'visit',
                'guide', 'best', 'places', 'tips', 'journey', 'explore'
              ];

              const isTravel = travelKeywords.some(keyword =>
                title.toLowerCase().includes(keyword) || 
                link.toLowerCase().includes(keyword)
              );

              // Avoid obvious navigation
              const isNav = ['home', 'about', 'contact', 'search', 'menu'].some(nav =>
                title.toLowerCase().includes(nav)
              );

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

          if (articles.length >= 2) break;
        }

        results.push({
          source: source.name,
          articles: articles.slice(0, 3),
          total_found: articles.length,
          success: true,
          method
        });

      } catch (error) {
        results.push({
          source: source.name,
          error: error.message.substring(0, 50),
          success: false,
          articles: []
        });
      }

      // Delay between sources
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Delay between batches
    if (batchIndex < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
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
      browserbase_used: results.filter(r => r.method === 'browserbase').length,
      scan_timestamp: new Date().toISOString()
    },
    source_breakdown: results.map(r => ({
      source: r.source,
      articles_found: r.articles?.length || 0,
      success: r.success,
      method: r.method || 'failed'
    }))
  };
});

const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Smart Travel Scraper (9 sites) running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
