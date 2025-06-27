import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pg from 'pg';

const fastify = Fastify({ logger: true });

// Database connection
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Health check
fastify.get('/health', async () => ({ status: 'ok' }));

// Add new source
fastify.post('/api/sources', async (request, reply) => {
  const { user_id, website_name, website_url, selectors } = request.body;
  
  const result = await pool.query(
    'INSERT INTO user_sources (user_id, website_name, website_url, selectors) VALUES ($1, $2, $3, $4) RETURNING *',
    [user_id, website_name, website_url, JSON.stringify(selectors)]
  );
  
  return { source: result.rows[0] };
});

// Get user sources
fastify.get('/api/sources/:user_id', async (request, reply) => {
  const { user_id } = request.params;
  
  const result = await pool.query(
    'SELECT * FROM user_sources WHERE user_id = $1 AND active = true',
    [user_id]
  );
  
  return { sources: result.rows };
});

// Scrape user's sources
fastify.post('/api/scrape-user-sources', async (request, reply) => {
  const { user_id, max_articles = 25 } = request.body;
  
  // Get user's sources
  const sourcesResult = await pool.query(
    'SELECT * FROM user_sources WHERE user_id = $1 AND active = true',
    [user_id]
  );
  
  const sources = sourcesResult.rows;
  const results = [];
  
  for (const source of sources) {
    try {
      const articles = await scrapeSource({
        name: source.website_name,
        url: source.website_url,
        selectors: source.selectors
      });
      
      results.push({
        source_id: source.id,
        source_name: source.website_name,
        articles,
        success: true
      });
      
    } catch (error) {
      results.push({
        source_id: source.id,
        source_name: source.website_name,
        error: error.message,
        success: false,
        articles: []
      });
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  const allArticles = results
    .filter(r => r.success)
    .flatMap(r => r.articles)
    .slice(0, max_articles);
  
  return {
    articles: allArticles,
    source_breakdown: results,
    total_articles: allArticles.length
  };
});

async function scrapeSource(source) {
  const response = await axios.get(source.url, {
    timeout: 8000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  
  const $ = cheerio.load(response.data);
  const articles = [];
  
  for (const selector of source.selectors) {
    $(selector).each((i, elem) => {
      if (articles.length >= 3) return false;
      
      const $elem = $(elem);
      const title = $elem.text().trim();
      let link = $elem.attr('href');
      
      if (title && link && title.length > 10) {
        if (link.startsWith('/')) {
          link = new URL(link, source.url).href;
        }
        
        if (link.startsWith('http')) {
          articles.push({
            title,
            url: link,
            source: source.name,
            scraped_at: new Date().toISOString()
          });
        }
      }
    });
    
    if (articles.length >= 1) break;
  }
  
  return articles;
}

fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
