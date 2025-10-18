const CONFIG = {
	feedUrl: 'https://lobste.rs/rss',
	minimumScore: 10,
	cacheMaxAge: 1800, // 30 minutes
	cacheKey: 'lobsters-rss-feed',
	rateLimitDelay: 200,
	maxRetries: 3,
	retryDelay: 1000,
};

class RSSProcessor {
	constructor(config) {
		this.config = config;
	}

	extractTextContent(xml, tag) {
		const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
		const match = xml.match(regex);
		return match ? match[1].trim() : '';
	}

	sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	isThrottledResponse(text) {
		return text.includes('Throttled') || text.includes('Rate limit');
	}

	parseArticleFromXml(itemXml) {
		const title = this.extractTextContent(itemXml, 'title');
		const author = this.extractTextContent(itemXml, 'author').split('@')[0];
		const link = this.extractTextContent(itemXml, 'link');
		const comments = this.extractTextContent(itemXml, 'comments');
		const published = this.extractTextContent(itemXml, 'pubDate');
		const guid = this.extractTextContent(itemXml, 'guid');

		return { title, author, link, comments, published, guid };
	}

	escapeXml(str) {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	generateRssItem(article) {
		return `	<item>
		<title>${this.escapeXml(article.title)}</title>
		<author>${this.escapeXml(article.author)}</author>
		<link>${this.escapeXml(article.link)}</link>
		<comments>${this.escapeXml(article.comments)}</comments>
		<wfw:commentRss>${this.escapeXml(article.comments)}</wfw:commentRss>
		<guid isPermaLink="false">${this.escapeXml(article.guid)}</guid>
		<pubDate>${article.published}</pubDate>
	</item>`;
	}

	writeArticlesFeed(articles) {
		const filteredAndSorted = articles
			.filter((article) => article.score > this.config.minimumScore)
			.sort((a, b) => b.timestamp - a.timestamp);

		console.log(
			`[FILTERING] ${articles.length} total articles, ${filteredAndSorted.length} meet minimum score of ${this.config.minimumScore}`,
		);

		const rssItems = filteredAndSorted.map((article) => this.generateRssItem(article)).join('\n');

		return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:wfw="http://wellformedweb.org/CommentAPI/" xmlns:slash="http://purl.org/rss/1.0/modules/slash/">
	<channel>
		<title>Lobsters</title>
		<link>https://lobste.rs</link>
		<description></description>
${rssItems}
	</channel>
</rss>`;
	}

	// Core processing methods
	async fetchArticleScore(url, retryCount = 0) {
		try {
			console.log(`[CACHE MISS] Fetching article score from origin: ${url}.json${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
			const startTime = Date.now();

			const response = await fetch(`${url}.json`);
			const responseText = await response.text();

			if (this.isThrottledResponse(responseText)) {
				if (retryCount < this.config.maxRetries) {
					const delay = this.config.retryDelay * Math.pow(2, retryCount);
					console.log(`[THROTTLED] Rate limited, retrying in ${delay}ms (attempt ${retryCount + 1}/${this.config.maxRetries})`);
					await this.sleep(delay);
					return this.fetchArticleScore(url, retryCount + 1);
				} else {
					console.error(`[ERROR] Max retries exceeded for ${url}, returning score 0`);
					return 0;
				}
			}

			const data = JSON.parse(responseText);
			const { score } = data;

			const duration = Date.now() - startTime;
			console.log(`[ORIGIN FETCH] Article score fetched in ${duration}ms: ${score}`);

			return parseInt(score, 10);
		} catch (error) {
			if (retryCount < this.config.maxRetries && error.message.includes('Unexpected token')) {
				const delay = this.config.retryDelay * Math.pow(2, retryCount);
				console.log(`[RETRY] JSON parse error, retrying in ${delay}ms (attempt ${retryCount + 1}/${this.config.maxRetries})`);
				await this.sleep(delay);
				return this.fetchArticleScore(url, retryCount + 1);
			}

			console.error(`[ERROR] Failed to fetch article score for ${url}:`, error.message);
			return 0;
		}
	}

	async fetchAllArticles(url = this.config.feedUrl) {
		try {
			console.log(`[CACHE MISS] Fetching RSS feed from origin: ${url}`);
			const startTime = Date.now();

			const response = await fetch(url);
			const xmlText = await response.text();

			const feedDuration = Date.now() - startTime;
			console.log(`[ORIGIN FETCH] RSS feed fetched in ${feedDuration}ms`);

			const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
			const items = xmlText.match(itemRegex) || [];

			console.log(`[PARSING] Found ${items.length} RSS items to process`);

			const parsedArticles = items.map((itemXml) => this.parseArticleFromXml(itemXml)).filter((article) => article.comments);

			console.log(`[PARSING] ${parsedArticles.length} articles have comments and will be scored`);

			const scoreStartTime = Date.now();
			const articlesWithScores = [];

			for (let i = 0; i < parsedArticles.length; i++) {
				const article = parsedArticles[i];
				const score = await this.fetchArticleScore(article.comments);

				articlesWithScores.push({
					...article,
					timestamp: new Date(article.published).getTime(),
					score,
				});

				// Add delay between requests to avoid rate limiting
				if (i < parsedArticles.length - 1) {
					await this.sleep(this.config.rateLimitDelay);
				}
			}

			const scoreDuration = Date.now() - scoreStartTime;
			console.log(`[SCORING] All article scores fetched in ${scoreDuration}ms`);

			return articlesWithScores;
		} catch (error) {
			console.error(`[ERROR] Failed to fetch articles from ${url}:`, error.message);
			return [];
		}
	}

	async warmCache(env) {
		try {
			console.log(`[CACHE WARM] Starting scheduled cache warming`);
			const articles = await this.fetchAllArticles();
			const rssFeed = this.writeArticlesFeed(articles);

			await env.RSS_CACHE.put(this.config.cacheKey, rssFeed, {
				expirationTtl: this.config.cacheMaxAge,
			});

			console.log(`[CACHE WARM] Successfully warmed cache with ${rssFeed.length} characters`);
			return true;
		} catch (error) {
			console.error(`[CACHE WARM ERROR] Failed to warm cache:`, error.message);
			return false;
		}
	}
}

export default {
	async fetch(request, env, ctx) {
		const requestStartTime = Date.now();
		const processor = new RSSProcessor(CONFIG);
		const url = new URL(request.url);

		// Check for cache-busting parameter
		const forceRefresh = url.searchParams.has('force_refresh') || url.searchParams.has('clear_cache');
		
		// Handle cache clearing endpoint
		if (url.pathname === '/clear-cache') {
			await env.RSS_CACHE.delete(CONFIG.cacheKey);
			console.log(`[CACHE CLEAR] Cache cleared successfully`);
			return new Response('Cache cleared successfully', {
				headers: { 'Content-Type': 'text/plain' },
			});
		}

		// Handle index.xml endpoint
		if (url.pathname === '/index.xml') {
			// Redirect to root (same content, no cache busting)
			return Response.redirect(`${url.protocol}//${url.host}/`, 302);
		}

		try {
			// Skip cache if force refresh is requested
			if (!forceRefresh) {
				const cachedFeed = await env.RSS_CACHE.get(CONFIG.cacheKey);
				if (cachedFeed) {
					console.log(`[CACHE HIT] Serving cached RSS feed`);
					return new Response(cachedFeed, {
						headers: {
							'Content-Type': 'application/rss+xml; charset=utf-8',
							'Cache-Control': `public, max-age=${CONFIG.cacheMaxAge}`,
							'X-Cache': 'HIT',
						},
					});
				}
			} else {
				console.log(`[CACHE BUST] Force refresh requested, bypassing cache`);
			}

			console.log(`[CACHE MISS] Generating fresh RSS feed`);
			const articles = await processor.fetchAllArticles();
			const rssFeed = processor.writeArticlesFeed(articles);

			await env.RSS_CACHE.put(CONFIG.cacheKey, rssFeed, {
				expirationTtl: CONFIG.cacheMaxAge,
			});

			const totalDuration = Date.now() - requestStartTime;
			console.log(`[SUCCESS] RSS feed generated and cached in ${totalDuration}ms, ${rssFeed.length} characters`);

			return new Response(rssFeed, {
				headers: {
					'Content-Type': 'application/rss+xml; charset=utf-8',
					'Cache-Control': `public, max-age=${CONFIG.cacheMaxAge}`,
					'X-Cache': 'MISS',
				},
			});
		} catch (error) {
			const totalDuration = Date.now() - requestStartTime;
			console.error(`[ERROR] Failed to generate RSS feed after ${totalDuration}ms:`, error.message);
			return new Response('Error generating RSS feed', { status: 500 });
		}
	},

	async scheduled(event, env, ctx) {
		const processor = new RSSProcessor(CONFIG);
		await processor.warmCache(env);
	},
};
