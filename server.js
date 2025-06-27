import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema 
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { createServer } from 'http';

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
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'scrape_latest_travel_news',
          description: 'Get the latest travel news and discoveries',
          inputSchema: {
            type: 'object',
            properties: {
              max_articles: {
                type: 'number',
                default: 15
              }
            }
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === 'scrape_latest_travel_news') {
        return await this.scrapeLatestTravelNews(args);
      }
      
      throw new Error(`Unknown tool: ${name}`);
    });
  }

  async scrapeLatestTravelNews(args = {}) {
    const { max_articles = 15 } = args;
    const results = [];

    const sources = [
      {
        name: "Travel + Leisure",
        url: "https://www.travelandleisure.com/"
      },
      {
        name: "CNN Travel", 
        url: "https://www.cnn.com/travel"
      },
      {
        name: "BBC Travel",
        url: "https://www.bbc.com/travel"
      }
    ];

    for (const source of sources) {
      try {
        const response = await axios.get(source.url, {
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        const $ = cheerio.load(response.data);
        const articles = [];

        $('article, .card, .story, h2, h3').slice(0, 8).each((i, element) => {
          const $element = $(element);
          
          let title, link;
          
          if ($element.is('article, .card, .story')) {
            title = $element.find('h1, h2, h3, .title, .headline').first().text().trim();
            link = $element.find('a').first().attr('href');
          } else {
            const $link = $element.find('a').first();
            title = $link.text().trim() || $element.text().trim();
            link = $link.attr('href');
          }

          if (title && link && title.length > 10 && title.length < 200) {
            if (link.startsWith('/')) {
              link = new URL(link, source.url).href;
            }

            if (link.startsWith('http')) {
              articles.push({
                title: title,
                url: link,
                source: source.name,
                scraped_at: new Date().toISOString()
              });
            }
          }
        });

        results.push({
          source: source.name,
          articles: articles.slice(0, 5),
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

    const allArticles = results
      .filter(r => r.success)
      .flatMap(r => r.articles)
      .slice(0, max_articles);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            latest_articles: allArticles,
            total_found: allArticles.length,
            sources_checked: sources.length,
            successful_sources: results.filter(r => r.success).length,
            timestamp: new Date().toISOString()
          }, null, 2)
        }
      ]
    };
  }

  async start() {
    const port = process.env.PORT || 3000;
    
    const httpServer = createServer();
    
    const transport = new SSEServerTransport('/message', httpServer);
    await this.server.connect(transport);
    
    httpServer.listen(port, '0.0.0.0', () => {
      console.log(`MCP Server running on port ${port}`);
    });
  }
}

const server = new TravelNewsMCPServer();
server.start().catch(console.error);
