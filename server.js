#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema 
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as cheerio from 'cheerio';

class TravelNewsMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'travel-news-scraper',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'scrape_latest_travel_news',
          description: 'Scrape the latest travel news from 9 major travel websites',
          inputSchema: {
            type: 'object',
            properties: {
              max_articles: {
                type: 'number',
                description: 'Maximum number of articles to return',
                default: 25
              },
              use_browserbase: {
                type: 'boolean',
                description: 'Use Browserbase for JavaScript rendering',
                default: true
              },
              sources: {
                type: 'array',
                items: { type: 'string' },
                description: 'Specific sources to scrape',
                default: ['all']
              }
            }
          }
        },
        {
          name: 'get_trending_destinations',
          description: 'Find trending and newly discovered travel destinations',
          inputSchema: {
            type: 'object',
            properties: {
              region: {
                type: 'string',
                description: 'Geographic region to focus on',
                default: 'global'
              }
            }
          }
        },
        {
          name: 'analyze_travel_content',
          description: 'Analyze scraped content for trends and insights',
          inputSchema: {
            type: 'object',
            properties: {
              articles: {
                type: 'array',
                description: 'Articles to analyze'
              }
            }
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'scrape_latest_travel_news':
          return await this.scrapeLatestTravelNews(args);
        case 'get_trending_destinations':
          return await this.getTrendingDestinations(args);
        case 'analyze_travel_content':
          return await this.analyzeTravelContent(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  async scrapeLatestTravelNews(args = {}) {
    const { max_articles = 25, use_browserbase = true } = args;
    const results = [];

    const sources = [
      {
        name: "Travel + Leisure",
        url: "https://www.travelandleisure.com/",
        selectors: ['article h2 a', 'h2 a', '.card-title a']
      },
      {
        name: "Condé Nast Traveler", 
        url: "https://www.cntraveler.com/",
        selectors: ['h2 a', 'h3 a', '.summary-item__hed a']
      },
      {
        name: "AFAR",
        url: "https://www.afar.com/",
        selectors: ['h2 a', '[class*="title"] a', '.title a']
      },
      {
        name: "Wallpaper Travel",
        url: "https://www.wallpaper.com/travel",
        selectors: ['h2 a', 'h3 a', '.article-card__title a']
      },
      {
        name: "BBC Travel",
        url: "https://www.bbc.com/travel",
        selectors: ['article h2 a', 'h3 a', '.media__title a']
      },
      {
        name: "NY Times Travel",
        url: "https://www.nytimes.com/section/travel",
        selectors: ['h2 a', 'h3 a', '.story-wrapper h2 a']
      },
      {
        name: "Budget Travel",
        url: "https://www.budgettravel.com/",
        selectors: ['h2 a', 'h3 a', '.article-title a']
      },
      {
        name: "CNN Travel",
        url: "https://www.cnn.com/travel",
        selectors: ['h3 a', '.card-title a', '.cd__headline a']
      },
      {
        name: "National Geographic Travel",
        url: "https://www.nationalgeographic.com/travel",
        selectors: ['h2 a', 'h3 a', '.card-title a']
      }
    ];

    // Process sources in batches
    const batchSize = 3;
    for (let i = 0; i < sources.length; i += batchSize) {
      const batch = sources.slice(i, i + batchSize);
      
      for (const source of batch) {
        try {
          const articles = await this.scrapeSource(source, use_browserbase);
          results.push({
            source: source.name,
            articles,
            success: true,
            total_found: articles.length
          });
        } catch (error) {
          results.push({
            source: source.name,
            error: error.message,
            success: false,
            articles: []
          });
        }

        // Delay between sources
        await new Promise(resolve => setTimeout(resolve, 800));
      }

      // Delay between batches  
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const allArticles = results
      .filter(r => r.success)
      .flatMap(r => r.articles)
      .slice(0, max_articles);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            latest_travel_news: allArticles,
            summary: {
              total_articles: allArticles.length,
              sources_checked: sources.length,
              successful_sources: results.filter(r => r.success).length,
              scan_timestamp: new Date().toISOString(),
              method: use_browserbase ? 'browserbase_hybrid' : 'http_only'
            },
            source_breakdown: results.map(r => ({
              source: r.source,
              articles_found: r.articles?.length || 0,
              success: r.success
            })),
            trends: this.extractTrends(allArticles)
          }, null, 2)
        }
      ]
    };
  }

  async scrapeSource(source, useBrowserbase) {
    let html = '';

    if (useBrowserbase) {
      try {
        // Try Browserbase first
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
        
        await axios.post(`https://api.browserbase.com/v1/sessions/${sessionId}/goto`, {
          url: source.url
        }, {
          headers: {
            'x-bb-api-key': process.env.BROWSERBASE_API_KEY
          }
        });

        await new Promise(resolve => setTimeout(resolve, 3000));

        const contentResponse = await axios.get(`https://api.browserbase.com/v1/sessions/${sessionId}/content`, {
          headers: {
            'x-bb-api-key': process.env.BROWSERBASE_API_KEY
          }
        });

        html = contentResponse.data;

        await axios.delete(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
          headers: {
            'x-bb-api-key': process.env.BROWSERBASE_API_KEY
          }
        });

      } catch (browserbaseError) {
        // Fallback to HTTP
        console.error(`Browserbase failed for ${source.name}, using HTTP fallback`);
      }
    }

    // HTTP fallback
    if (!html) {
      const response = await axios.get(source.url, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      html = response.data;
    }

    return this.parseArticles(html, source);
  }

  parseArticles(html, source) {
    const $ = cheerio.load(html);
    const articles = [];

    for (const selector of source.selectors) {
      $(selector).each((i, elem) => {
        if (articles.length >= 4) return false;

        const $elem = $(elem);
        const title = $elem.text().trim();
        let link = $elem.attr('href');

        if (title && link && title.length > 10 && title.length < 300) {
          if (link.startsWith('/')) {
            link = new URL(link, source.url).href;
          }

          const travelKeywords = [
            'travel', 'destination', 'hotel', 'trip', 'vacation', 'visit',
            'guide', 'best', 'places', 'tips', 'journey', 'explore'
          ];

          const isTravel = travelKeywords.some(keyword =>
            title.toLowerCase().includes(keyword) || 
            link.toLowerCase().includes(keyword)
          );

          const isNotNav = !['home', 'about', 'contact', 'search', 'menu'].some(nav =>
            title.toLowerCase().includes(nav)
          );

          if (link.startsWith('http') && isNotNav && (isTravel || articles.length < 2)) {
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

    return articles.slice(0, 3);
  }

  extractTrends(articles) {
    const destinations = {};
    const topics = {};

    articles.forEach(article => {
      const title = article.title.toLowerCase();
      
      // Extract potential destinations
      const locations = title.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g) || [];
      locations.forEach(loc => {
        destinations[loc] = (destinations[loc] || 0) + 1;
      });

      // Extract topics
      const trendWords = ['new', 'best', 'top', 'trending', 'discover', 'hidden', 'secret'];
      trendWords.forEach(word => {
        if (title.includes(word)) {
          topics[word] = (topics[word] || 0) + 1;
        }
      });
    });

    return {
      popular_destinations: Object.entries(destinations)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([dest, count]) => ({ destination: dest, mentions: count })),
      trending_topics: Object.entries(topics)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3)
        .map(([topic, count]) => ({ topic, mentions: count }))
    };
  }

  async getTrendingDestinations(args = {}) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            message: 'Trending destinations analysis - coming soon',
            timestamp: new Date().toISOString()
          }, null, 2)
        }
      ]
    };
  }

  async analyzeTravelContent(args = {}) {
    const { articles = [] } = args;
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            analysis: this.extractTrends(articles),
            article_count: articles.length,
            timestamp: new Date().toISOString()
          }, null, 2)
        }
      ]
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Travel News MCP Server running on stdio');
  }
}

const server = new TravelNewsMCPServer();
server.run().catch(console.error);
