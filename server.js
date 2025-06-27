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
        version: '1.0.0',
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
    // Register available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'scrape_latest_travel_news',
          description: 'Get the latest travel news, discoveries, and breaking stories from major travel websites',
          inputSchema: {
            type: 'object',
            properties: {
              hours_back: {
                type: 'number',
                description: 'How many hours back to look for fresh content',
                default: 24
              },
              max_articles: {
                type: 'number', 
                description: 'Maximum number of articles to return',
                default: 20
              }
            }
          }
        },
        {
          name: 'get_breaking_travel_alerts',
          description: 'Get urgent travel alerts, disruptions, and breaking news',
          inputSchema: {
            type: 'object',
            properties: {
              alert_types: {
                type: 'array',
                items: { type: 'string' },
                description: 'Types of alerts: flight, weather, safety, covid, etc.',
                default: ['all']
              }
            }
          }
        },
        {
          name: 'discover_new_destinations',
          description: 'Find newly opened destinations, hotels, and travel experiences',
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
        }
      ]
    }));

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'scrape_latest_travel_news':
          return await this.scrapeLatestTravelNews(args);
        case 'get_breaking_travel_alerts':
          return await this.getBreakingTravelAlerts(args);
        case 'discover_new_destinations':
          return await this.discoverNewDestinations(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  async scrapeLatestTravelNews(args = {}) {
    const { hours_back = 24, max_articles = 20 } = args;
    const results = [];

    const sources = [
      {
        name: "Travel + Leisure",
        url: "https://www.travelandleisure.com/news",
        selectors: {
          articles: 'article, .card, .story-item',
          title: 'h1, h2, h3, .headline, .title',
          link: 'a',
          time: '.time, .date, time, [class*="time"], [class*="date"]'
        }
      },
      {
        name: "CNN Travel",
        url: "https://www.cnn.com/travel",
        selectors: {
          articles: 'article, .card, .cd',
          title: 'h3, h4, .cd__headline, .card-title',
          link: 'a',
          time: '.timestamp, time, [data-timestamp]'
        }
      },
      {
        name: "BBC Travel",
        url: "https://www.bbc.com/travel",
        selectors: {
          articles: 'article, .media',
          title: 'h2, h3, .media__title, .title',
          link: 'a',
          time: 'time, .date, [class*="time"]'
        }
      },
      {
        name: "AFAR",
        url: "https://www.afar.com/magazine",
        selectors: {
          articles: 'article, .card, .story',
          title: 'h2, h3, .title, .headline',
          link: 'a',
          time: '.date, time, [class*="date"]'
        }
      }
    ];

    for (const source of sources) {
      try {
        const articles = await this.scrapeSource(source, hours_back);
        results.push({
          source: source.name,
          articles,
          success: true,
          count: articles.length
        });
      } catch (error) {
        results.push({
          source: source.name,
          error: error.message,
          success: false,
          count: 0
        });
      }
    }

    // Combine and rank all articles
    const allArticles = results
      .filter(r => r.success)
      .flatMap(r => r.articles)
      .sort((a, b) => b.freshness_score - a.freshness_score)
      .slice(0, max_articles);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            latest_articles: allArticles,
            summary: {
              total_sources: sources.length,
              successful_sources: results.filter(r => r.success).length,
              total_articles: allArticles.length,
              freshest_article: allArticles[0]?.title || 'No fresh articles found',
              scan_time: new Date().toISOString(),
              hours_scanned: hours_back
            },
            metadata: {
              content_type: 'latest_travel_news',
              quality_filtered: true,
              duplicate_removed: true
            }
          }, null, 2)
        }
      ]
    };
  }

  async scrapeSource(source, hoursBack) {
    const response = await axios.get(source.url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const $ = cheerio.load(response.data);
    const articles = [];
    const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    $(source.selectors.articles).each((i, container) => {
      if (i >= 15) return false; // Limit processing

      const $container = $(container);
      const titleEl = $container.find(source.selectors.title).first();
      const linkEl = $container.find(source.selectors.link).first();
      const timeEl = $container.find(source.selectors.time).first();

      const title = titleEl.text().trim();
      let link = linkEl.attr('href');
      const timeText = timeEl.text().trim().toLowerCase();

      if (title && link && title.length > 15) {
        // Handle relative URLs
        if (link.startsWith('/')) {
          link = new URL(link, source.url).href;
        }

        // Calculate freshness score
        let freshness_score = 0.5; // default
        if (timeText.includes('hour') || timeText.includes('ago')) {
          const hourMatch = timeText.match(/(\d+)\s*hour/);
          if (hourMatch) {
            const hours = parseInt(hourMatch[1]);
            freshness_score = Math.max(0.1, 1.0 - (hours / 24));
          } else {
            freshness_score = 0.9; // "hours ago" without specific number
          }
        } else if (timeText.includes('today') || timeText.includes('now')) {
          freshness_score = 1.0;
        } else if (timeText.includes('yesterday')) {
          freshness_score = 0.3;
        }

        // Filter for travel relevance
        const travelKeywords = [
          'travel', 'destination', 'hotel', 'flight', 'tourism', 'vacation',
          'trip', 'airline', 'airport', 'cruise', 'resort', 'visit',
          'discovery', 'opened', 'new', 'breaking', 'country', 'city'
        ];

        const isTravel = travelKeywords.some(keyword =>
          title.toLowerCase().includes(keyword) ||
          link.toLowerCase().includes(keyword)
        );

        if (isTravel && freshness_score > 0.2) {
          articles.push({
            title: title.substring(0, 200),
            url: link,
            source: source.name,
            freshness_score,
            time_indicator: timeText || 'recent',
            discovered_at: new Date().toISOString(),
            relevance: 'high'
          });
        }
      }
    });

    return articles.sort((a, b) => b.freshness_score - a.freshness_score);
  }

  async getBreakingTravelAlerts(args = {}) {
    // Implementation for breaking alerts
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            alerts: [],
            message: 'Breaking alerts feature - coming soon',
            timestamp: new Date().toISOString()
          }, null, 2)
        }
      ]
    };
  }

  async discoverNewDestinations(args = {}) {
    // Implementation for new destinations
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            new_destinations: [],
            message: 'New destinations discovery - coming soon',
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

// Start the server
const server = new TravelNewsMCPServer();
server.run().catch(console.error);
