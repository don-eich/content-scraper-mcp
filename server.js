import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pg from 'pg';

const fastify = Fastify({ logger: true });

// Database connection (updated)
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false // Railway internal connections don't need SSL
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
        ('default', 'NY Times Travel', 'https://www.nytimes.com/section/travel', '["h2 a", "h3 a", ".story-wrapper h2 a"]'),
        ('default', 'CNN Travel', 'https://www.cnn.com/travel', '["h3 a", ".card-title a", ".cd__headline a"]'),
        ('default', 'Condé Nast Traveler', 'https://www.cntraveler.com/', '["h2 a", "h3 a", ".summary-item__hed a"]')
      `);
      console.log('Default sources inserted');
    }
    
  } catch (error) {
    console.error('Database initialization failed:', error.message);
  }
}

// Health check
fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Add new source
fastify.post('/api/sources', async (request, reply) => {
  const { user_id, website_name, website_url, selectors } = request.body;
  
  try {
    const result = await pool.query(
      'INSERT INTO user_sources (user_id, website_name, website_url, selectors) VALUES ($1, $2, $3, $4) RETURNING *',
      [user_id, website_name, website_url, JSON.stringify(selectors)]
    );
    
    return { source: result.rows[0] };
  } catch (error) {
    reply.code(500).send({ error: error.message });
  }
});

// Get user sources
fastify.get('/api/sources/:user_id', async (request, reply) => {
  const { user_id } = request.params;
  
  try {
    const result = await pool.query(
      'SELECT * FROM user_sources WHERE user_id = $1 AND active = true',
      [user_id]
    );
    
    return { sources: result.rows };
  } catch (error) {
    reply.code(500).send({ error: error.message });
  }
});

// Update source
fastify.put('/api/sources/:source_id', async (request, reply) => {
  const { source_id } = request.params;
  const { website_name, website_url, selectors, active } = request.body;
  
  try {
    const result = await pool.query(
      'UPDATE user_sources SET website_name = $1, website_url = $2, selectors = $3, active = $4 WHERE id = $5 RETURNING *',
      [website_name, website_url, JSON.stringify(selectors), active, source_id]
    );
    
    return { source: result.rows[0] };
  } catch (error) {
    reply.code(500).send({ error: error.message });
  }
});

// Delete source
fastify.delete('/api/sources/:source_id', async (request, reply) => {
  const { source_id } = request.params;
  
  try {
    await pool.query('UPDATE user_sources SET active = false WHERE id = $1', [source_id]);
    return { success: true };
  } catch (error) {
    reply.code(500).send({ error: error.message });
  }
});

// Scrape user's sources
fastify.post('/api/scrape-user-sources', async (request, reply) => {
  const { user_id, max_articles = 25 } = request.body;
  
  try {
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
          selectors: typeof source.selectors === 'string' ? JSON.parse(source.selectors) : source.selectors
        });
        
        results.push({
          source_id: source.id,
          source_name: source.website_name,
          articles,
          success: true,
          total_found: articles.length
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
      
      // Delay between sources to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const allArticles = results
      .filter(r => r.success)
      .flatMap(r => r.articles)
      .slice(0, max_articles);
    
    return {
      articles: allArticles,
      summary: {
        total_articles: allArticles.length,
        sources_checked: sources.length,
        successful_sources: results.filter(r => r.success).length,
        scan_timestamp: new Date().toISOString()
      },
      source_breakdown: results
    };
    
  } catch (error) {
    reply.code(500).send({ error: error.message });
  }
});

// Scraping function
async function scrapeSource(source) {
  try {
    const response = await axios.get(source.url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    const $ = cheerio.load(response.data);
    const articles = [];
    
    for (const selector of source.selectors) {
      $(selector).each((i, elem) => {
        if (articles.length >= 4) return false;
        
        const $elem = $(elem);
        const title = $elem.text().trim();
        let link = $elem.attr('href');
        
        if (title && link && title.length > 10 && title.length < 300) {
          // Fix relative URLs
          if (link.startsWith('/')) {
            link = new URL(link, source.url).href;
          }
          
          // Basic filtering
          const travelKeywords = [
            'travel', 'destination', 'hotel', 'trip', 'vacation', 'visit',
            'guide', 'best', 'places', 'tips', 'journey', 'explore'
          ];
          
          const isTravel = travelKeywords.some(keyword =>
            title.toLowerCase().includes(keyword) || 
            link.toLowerCase().includes(keyword)
          );
          
          const isNotNav = !['home', 'about', 'contact', 'search', 'menu', 'newsletter', 'subscribe'].some(nav =>
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
    
  } catch (error) {
    console.error(`Error scraping ${source.name}:`, error.message);
    return [];
  }
}

// Test endpoint for single source
fastify.post('/api/test-source', async (request, reply) => {
  const { website_url, selectors } = request.body;
  
  try {
    const articles = await scrapeSource({
      name: 'Test Source',
      url: website_url,
      selectors: Array.isArray(selectors) ? selectors : [selectors]
    });
    
    return {
      success: true,
      articles,
      total_found: articles.length
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

// Start server
const start = async () => {
  try {
    // Initialize database first
    await initDatabase();
    
    // Then start server
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Dynamic Sources API Server running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

fastify.post('/api/extract-full-content', async (request, reply) => {
  const { url, article_id } = request.body;
  
  try {
    let fullContent = '';
    let title = '';
    let excerpt = '';
    let extractionMethod = 'http';
    
    // Fetch the webpage
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    const $ = cheerio.load(response.data);
    
    // Remove unwanted elements completely
    $(`.ad, .advertisement, .ads, .sidebar, .nav, .navigation, .menu, .header, .footer, 
       .comments, .comment, .social, .share, .newsletter, .subscription, .popup, .modal,
       .related, .recommended, .trending, .popular, script, style, noscript, iframe,
       .breadcrumb, .tag, .category, .author-bio, .author-info, .meta, .byline,
       [class*="ad-"], [class*="advertisement"], [id*="ad-"], [id*="advertisement"],
       .cookie, .gdpr, .consent, .alert, .notification, .banner`).remove();
    
    // Extract title from multiple sources
    title = $('h1').first().text().trim() || 
            $('title').text().trim() || 
            $('[property="og:title"]').attr('content') || 
            $('meta[name="title"]').attr('content') || '';
    
    // Clean title
    title = title.replace(/\s+/g, ' ').replace(/[\|\-–—].+$/, '').trim();
    
    // Smart content extraction - try multiple strategies
    const contentExtractionStrategies = [
      // Strategy 1: Semantic article tags
      () => {
        const article = $('article');
        if (article.length > 0) {
          return article.first().text().trim();
        }
        return '';
      },
      
      // Strategy 2: Common CMS patterns
      () => {
        const selectors = [
          '.article-content', '.story-content', '.entry-content', '.post-content',
          '.article-body', '.story-body', '.entry-body', '.post-body',
          '.content-area', '.main-content', '.primary-content',
          '[class*="article"]', '[class*="story"]', '[class*="content"]'
        ];
        
        for (const selector of selectors) {
          const content = $(selector).text().trim();
          if (content.length > 500) {
            return content;
          }
        }
        return '';
      },
      
      // Strategy 3: Largest paragraph-rich container
      () => {
        let bestContent = '';
        let bestScore = 0;
        
        $('div, section, main').each((i, elem) => {
          const $elem = $(elem);
          const text = $elem.text();
          const paragraphCount = $elem.find('p').length;
          const textLength = text.length;
          
          // Score based on text length and paragraph count
          const score = textLength + (paragraphCount * 100);
          
          if (score > bestScore && textLength > 200 && paragraphCount > 2) {
            bestScore = score;
            bestContent = text.trim();
          }
        });
        
        return bestContent;
      },
      
      // Strategy 4: Paragraph-based extraction
      () => {
        const paragraphs = $('p').map((i, p) => $(p).text().trim()).get();
        const meaningfulParas = paragraphs.filter(p => p.length > 50);
        
        if (meaningfulParas.length > 3) {
          return meaningfulParas.join('\n\n');
        }
        return '';
      },
      
      // Strategy 5: Main tag fallback
      () => {
        const main = $('main');
        if (main.length > 0) {
          return main.first().text().trim();
        }
        return '';
      }
    ];
    
    // Try each strategy until we get good content
    for (const strategy of contentExtractionStrategies) {
      const content = strategy();
      if (content.length > fullContent.length && content.length > 300) {
        fullContent = content;
      }
    }
    
    // If still no good content, try body but filter out navigation
    if (fullContent.length < 300) {
      $('nav, .nav, .navigation, .menu, header, footer').remove();
      fullContent = $('body').text().trim();
    }
    
    // Clean the extracted content
    fullContent = fullContent
      .replace(/\s+/g, ' ')                    // Multiple spaces to single
      .replace(/\n\s*\n\s*\n/g, '\n\n')       // Multiple newlines to double
      .replace(/[^\S\n]+/g, ' ')              // Clean whitespace but preserve newlines
      .replace(/\t+/g, ' ')                   // Tabs to spaces
      .replace(/[\r\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '') // Control chars
      .trim();
    
    // Extract excerpt (first meaningful paragraph or first 300 chars)
    const sentences = fullContent.split(/[.!?]+/);
    const meaningfulSentences = sentences.filter(s => s.trim().length > 20);
    
    if (meaningfulSentences.length > 0) {
      excerpt = meaningfulSentences.slice(0, 2).join('. ').trim() + '.';
      if (excerpt.length > 300) {
        excerpt = excerpt.substring(0, 300) + '...';
      }
    } else {
      excerpt = fullContent.substring(0, 300) + (fullContent.length > 300 ? '...' : '');
    }
    
    // Calculate actual word count
    const actualWordCount = fullContent.split(/\s+/).filter(word => word.length > 0).length;
    
    // Quality checks
    const isQualityContent = fullContent.length > 500 && 
                           actualWordCount > 100 && 
                           !fullContent.includes('JavaScript is disabled') &&
                           !fullContent.includes('Please enable cookies');
    
    return {
      article_id,
      url,
      title: title,
      full_content: fullContent,
      excerpt: excerpt,
      actual_word_count: actualWordCount,
      extraction_method: extractionMethod,
      extraction_success: isQualityContent,
      content_quality_score: calculateQualityScore(fullContent, title),
      extracted_at: new Date().toISOString()
    };
    
  } catch (error) {
    return {
      article_id,
      url,
      title: '',
      full_content: '',
      excerpt: '',
      error: error.message,
      extraction_success: false,
      extracted_at: new Date().toISOString()
    };
  }
});

// Helper function to calculate content quality score
function calculateQualityScore(content, title) {
  let score = 0;
  
  // Length scoring
  if (content.length > 1000) score += 30;
  else if (content.length > 500) score += 20;
  else if (content.length > 200) score += 10;
  
  // Word count scoring
  const wordCount = content.split(/\s+/).length;
  if (wordCount > 300) score += 25;
  else if (wordCount > 150) score += 15;
  else if (wordCount > 75) score += 10;
  
  // Structure scoring
  const sentences = content.split(/[.!?]+/).length;
  if (sentences > 10) score += 15;
  else if (sentences > 5) score += 10;
  
  // Title presence
  if (title && title.length > 10) score += 10;
  
  // Quality indicators
  const qualityIndicators = ['travel', 'destination', 'hotel', 'trip', 'vacation', 'visit', 'experience'];
  const qualityMatches = qualityIndicators.filter(indicator => 
    content.toLowerCase().includes(indicator)
  ).length;
  score += qualityMatches * 5;
  
  // Negative indicators
  const negativeIndicators = ['cookie', 'javascript', 'enable', 'subscribe', 'newsletter', 'sign up'];
  const negativeMatches = negativeIndicators.filter(indicator => 
    content.toLowerCase().includes(indicator)
  ).length;
  score -= negativeMatches * 10;
  
  return Math.max(0, Math.min(100, score));
}
