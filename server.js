import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: true });

// Health check
fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Latest travel news endpoint
fastify.post('/scrape-latest-travel-news', async (request, reply) => {
  const { max_articles = 20 } = request.body || {};
  const results = [];

  const sources = [
    {
      name: "Travel + Leisure Latest",
      url: "https://www.travelandleisure.com/news",
      focus: "breaking_news"
    },
    {
      name: "CNN Travel",
      url: "https://www.cnn.com/travel",
      focus: "current_events"
    },
    {
      name: "BBC Travel",
      url: "https://www.bbc.com/travel",
      focus: "discoveries"
    },
    {
      name: "AFAR Magazine",
      url: "https://www.afar.com/magazine",
      focus: "new_destinations"
    },
    {
      name: "Condé Nast Traveler",
      url: "https://www.cntraveler.com/",
      focus: "luxury_travel"
    }
  ];

  for (const source of sources) {
    try {
      const response = await axios.get(source.url, {
        timeout: 12000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      const $ = cheerio.load(response.data);
      const articles = [];

      // Look for fresh content indicators
      $('article, .card, .story, .item').each((i, container) => {
        if (i >= 12) return false; // Limit processing
        
        const $container = $(container);
        
        // Find title
        const titleEl = $container.find('h1, h2, h3, h4, .title, .headline, .hed').first();
        const title = titleEl.text().trim();
        
        // Find link
        let link = $container.find('a').first().attr('href');
        
        // Find time indicators
        const timeEl = $container.find('time, .time, .date, [class*="time"], [class*="date"]').first();
        const timeText = timeEl.text().trim().toLowerCase();
        
        if (title && link && title.length > 15 && title.length < 300) {
          // Handle relative URLs
          if (link.startsWith('/')) {
            link = new URL(link, source.url).href;
          }
          
          // Calculate freshness score
          let freshness_score = 0.5;
          if (timeText.includes('hour') || timeText.includes('ago') || timeText.includes('today')) {
            freshness_score = 0.9;
          } else if (timeText.includes('yesterday')) {
            freshness_score = 0.6;
          } else if (i < 5) {
            freshness_score = 0.7; // Top positions are usually fresh
          }
          
          // Filter for travel content
          const travelKeywords = [
            'travel', 'destination', 'hotel', 'flight', 'tourism', 'vacation',
            'trip', 'airline', 'airport', 'cruise', 'resort', 'visit',
            'discovery', 'opened', 'new', 'breaking', 'country', 'city',
            'adventure', 'explore', 'journey', 'getaway'
          ];
          
          const isTravel = travelKeywords.some(keyword =>
            title.toLowerCase().includes(keyword) ||
            link.toLowerCase().includes(keyword)
          );
          
          // Avoid navigation/menu items
          const isNavigation = ['home', 'about', 'contact', 'search', 'menu', 'login', 'subscribe', 'newsletter'].some(nav =>
            title.toLowerCase() === nav
          );
          
          if (isTravel && !isNavigation && freshness_score > 0.3) {
            articles.push({
              title: title,
              url: link,
              source: source.name,
              focus_area: source.focus,
              freshness_score,
              time_indicator: timeText || 'recent',
              discovered_at: new Date().toISOString()
            });
          }
        }
      });

      // Sort by freshness and take top articles
      articles.sort((a, b) => b.freshness_score - a.freshness_score);

      results.push({
        source: source.name,
        articles: articles.slice(0, 4), // Top 4 from each source
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

  // Combine all articles and rank by freshness
  const allArticles = results
    .filter(r => r.success)
    .flatMap(r => r.articles)
    .sort((a, b) => b.freshness_score - a.freshness_score)
    .slice(0, max_articles);

  return {
    latest_travel_news: allArticles,
    summary: {
      total_articles: allArticles.length,
      sources_checked: sources.length,
      successful_sources: results.filter(r => r.success).length,
      freshest_article: allArticles[0]?.title || 'No articles found',
      scan_timestamp: new Date().toISOString()
    },
    source_breakdown: results.map(r => ({
      source: r.source,
      articles_found: r.articles?.length || 0,
      success: r.success
    }))
  };
});

const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Travel News API Server running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
