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

// Auto-create table on startup
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_sources (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        website_name VARCHAR(255) NOT NULL,
        website_url TEXT NOT NULL,
        selectors JSON NOT NULL,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    console.log('Database table ready');
    
    // Insert default sources if table is empty
    const count = await pool.query('SELECT COUNT(*) FROM user_sources');
    if (parseInt(count.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO user_sources (user_id, website_name, website_url, selectors) VALUES
        ('default', 'Travel + Leisure', 'https://www.travelandleisure.com/', '["article h2 a", "h2 a", ".card-title a"]'),
        ('default', 'AFAR', 'https://www.afar.com/', '["h2 a", "[class*=\\"title\\"] a", ".title a"]'),
        ('default', 'National Geographic Travel', 'https://www.nationalgeographic.com/travel', '["h2 a", "h3 a", ".card-title a"]'),
        ('default', 'BBC Travel', 'https://www.bbc.com/travel', '["article h2 a", "h3 a", ".media__title a"]'),
        ('default', 'NY Times Travel', 'https://www.nytimes.com/section/travel', '["h2 a", "h3 a", ".story-wrapper h2 a"]')
      `);
      console.log('Default sources inserted');
    }
    
  } catch (error) {
    console.error('Database initialization failed:', error.message);
  }
}

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
