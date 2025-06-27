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
        name: 'scrape_latest_travel_news',
        description: 'Get the latest travel news, discoveries, and breaking stories'
      },
      {
        name: 'get_trending_destinations',
        description: 'Find trending and newly discovered destinations'
      },
      {
        name: 'find_breaking_travel_news',
        description: 'Get breaking travel news from the last 24-48 hours'
      }
    ]
  };
});

// Main tool for latest travel content
fastify.post('/execute/scrape_latest_travel_news', async (request, reply) => {
  const results = [];
  
  // Focus on RSS feeds and latest sections for real-time content
  const latestSources = [
    {
      name: "Travel + Leisure Latest",
      url: "https://www.travelandleisure.com/news",
      type: "latest_section"
    },
    {
      name: "CNN Travel Breaking", 
      url: "https://www.cnn.com/travel",
      type: "latest_section"
    },
    {
      name: "BBC Travel Latest",
      url: "https://www.bbc.com/travel",
      type: "latest_section"
    },
    {
      name: "AFAR News",
      url: "https://www.afar.com/magazine",
      type: "latest_section"
    },
    {
      name: "Condé Nast Traveler News",
      url: "https://www.cntraveler.com/story",
      type: "latest_section"
    }
  ];

  for (const source of latestSources) {
    try {
      const response = await axios.get(source.url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      const articles = [];

      // Look for time indicators (today, hours ago, yesterday)
      const timeSelectors = [
        '[class*="time"]',
        '[class*="date"]', 
        '[data-time]',
        'time',
        '.publish-date',
        '.article-date'
      ];

      // Find articles with recent timestamps
      $('article, .story, .card, .item').each((i, container) => {
        const $container = $(container);
        
        // Look for time indicators in this container
        let isRecent = false;
        let timeText = '';
        
        timeSelectors.forEach(selector => {
          const timeEl = $container.find(selector).first();
          if (timeEl.length) {
            timeText = timeEl.text().toLowerCase();
            // Check if it's recent (today, hours ago, yesterday, etc.)
            if (timeText.includes('hour') || 
                timeText.includes('today') || 
                timeText.includes('yesterday') ||
                timeText.includes('mins') ||
                timeText.includes('ago')) {
              isRecent = true;
            }
          }
        });

        // Also check for articles in first 10 positions (usually latest)
        if (i < 10 || isRecent) {
          const titleEl = $container.find('h1, h2, h3, h4, .title, .headline').first();
          const linkEl = $container.find('a').first();
          
          if (titleEl.length && linkEl.length) {
            const title = titleEl.text().trim();
            let link = linkEl.attr('href');
            
            if (title && link && title.length > 20) {
              if (link.startsWith('/')) {
                link = new URL(link, source.url).href;
              }
              
              // Filter for travel-related keywords
              const travelKeywords = [
                'travel', 'destination', 'hotel', 'flight', 'tourism', 'vacation',
                'trip', 'airline', 'airport', 'cruise', 'resort', 'visit', 
                'discovery', 'opened', 'new', 'breaking', 'alert', 'update'
              ];
              
              const isTravel = travelKeywords.some(keyword => 
                title.toLowerCase().includes(keyword) || 
                link.toLowerCase().includes(keyword)
              );
              
              if (isTravel) {
                articles.push({
                  title: title,
                  url: link,
                  source: source.name,
                  timestamp: timeText || 'recent',
                  freshness_score: isRecent ? 1.0 : 0.7,
                  position: i + 1,
                  scraped_at: new Date().toISOString()
                });
              }
            }
          }
        }
      });

      // Sort by freshness and position
      articles.sort((a, b) => {
        if (a.freshness_score !== b.freshness_score) {
          return b.freshness_score - a.freshness_score;
        }
        return a.position - b.position;
      });

      results.push({
        source: source.name,
        articles: articles.slice(0, 5), // Top 5 latest from each source
        total_found: articles.length,
        success: true
      });

    } catch (error) {
      results.push({
        source: source.name,
        error: error.message,
        success: false
      });
    }
  }

  // Combine and rank all articles by freshness
  const allArticles = results
    .filter(r => r.success)
    .flatMap(r => r.articles)
    .sort((a, b) => b.freshness_score - a.freshness_score)
    .slice(0, 20); // Top 20 freshest articles

  return {
    latest_articles: allArticles,
    sources_checked: results.length,
    successful_sources: results.filter(r => r.success).length,
    total_fresh_content: allArticles.length,
    last_updated: new Date().toISOString(),
    next_update_recommended: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // 2 hours
  };
});

// Tool for breaking news (last 24 hours)
fastify.post('/execute/find_breaking_travel_news', async (request, reply) => {
  // This would use RSS feeds and news APIs for real breaking news
  const breakingNews = [];
  
  const newsSources = [
    "https://feeds.skift.com/",
    "https://www.travelandleisure.com/syndication/feed",
    "https://www.cntraveler.com/feed"
  ];

  // RSS parsing for time-sensitive content would go here
  
  return {
    breaking_news: breakingNews,
    alert_level: "normal", // low, normal, high
    last_breaking_update: new Date().toISOString()
  };
});

const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Smart Travel News MCP Server running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
