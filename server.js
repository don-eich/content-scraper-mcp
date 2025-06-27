import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: true });

// Health check
fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// MCP tools endpoint
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

// Enhanced scraping with site-specific selectors
fastify.post('/execute/scrape_websites', async (request, reply) => {
  const { websites } = request.body;
  const results = [];

  // Site-specific configurations
  const siteConfigs = {
    'travelandleisure.com': {
      selectors: [
        'h2 a[href*="/travel/"]',
        'h3 a[href*="/travel/"]', 
        '.card-title a',
        'article h2 a',
        '.tout__headline a'
      ]
    },
    'cntraveler.com': {
      selectors: [
        'h2 a[href*="/story/"]',
        'h3 a[href*="/story/"]',
        '.summary-item__hed a',
        '.grid-item__hed a',
        'article h2 a'
      ]
    },
    'afar.com': {
      selectors: [
        'h2 a[href*="/articles/"]',
        'h3 a[href*="/articles/"]',
        '.card__title a',
        '.article-title a',
        '.story-block h3 a'
      ]
    },
    'wallpaper.com': {
      selectors: [
        'h2 a[href*="/travel/"]',
        'h3 a[href*="/travel/"]',
        '.article-card__title a',
        '.summary-title a'
      ]
    },
    'bbc.com': {
      selectors: [
        'h2 a[href*="/travel/"]',
        'h3 a[href*="/travel/"]',
        '.media__link',
        '.story-body__link',
        'article h2 a'
      ]
    },
    'nytimes.com': {
      selectors: [
        'h2 a[href*="/travel/"]',
        'h3 a[href*="/travel/"]',
        '.story-wrapper h2 a',
        'article h3 a'
      ]
    },
    'budgettravel.com': {
      selectors: [
        'h2 a',
        'h3 a',
        '.article-title a',
        '.headline a'
      ]
    },
    'cnn.com': {
      selectors: [
        'h3 a[href*="/travel/"]',
        '.card-title a',
        '.cd__headline a'
      ]
    },
    'nationalgeographic.com': {
      selectors: [
        'h2 a[href*="/travel/"]',
        'h3 a[href*="/travel/"]',
        '.card-title a',
        'article h3 a'
      ]
    }
  };

  for (const site of websites) {
    try {
      const response = await axios.get(site.url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }
      });

      const $ = cheerio.load(response.data);
      const articles = [];
      
      // Get domain for site-specific config
      const domain = new URL(site.url).hostname.replace('www.', '');
      const config = siteConfigs[domain];
      
      if (config) {
        // Try each selector until we find articles
        for (const selector of config.selectors) {
          $(selector).each((i, elem) => {
            if (articles.length >= 10) return false; // Stop at 10 articles
            
            const $elem = $(elem);
            const title = $elem.text().trim();
            let link = $elem.attr('href');
            
            if (title && link && title.length > 10) {
              // Handle relative URLs
              if (link.startsWith('/')) {
                link = new URL(link, site.url).href;
              }
              
              // Avoid duplicates
              if (!articles.some(a => a.title === title || a.url === link)) {
                articles.push({
                  title: title.substring(0, 200), // Limit title length
                  url: link,
                  source: site.name,
                  scraped_at: new Date().toISOString()
                });
              }
            }
          });
          
          // If we found articles with this selector, stop trying others
          if (articles.length > 0) break;
        }
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
