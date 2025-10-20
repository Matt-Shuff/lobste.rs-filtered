import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../src';

// Mock fetch to avoid external API calls during testing
global.fetch = vi.fn();

describe('Lobsters RSS worker', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Mock RSS feed response
		const mockRssFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Lobsters</title>
<link>https://lobste.rs</link>
<description></description>
<item>
<title>Test Article</title>
<author>testuser</author>
<link>https://lobste.rs/s/test/test-article</link>
<comments>https://lobste.rs/s/test/test-article</comments>
<pubDate>Sat, 18 Oct 2025 08:29:22 -0500</pubDate>
<guid>test-guid</guid>
</item>
</channel>
</rss>`;

		// Mock article score response
		const mockScoreResponse = JSON.stringify({ score: 15 });

		// Mock RSS feed fetch
		global.fetch.mockImplementation((url) => {
			if (url === 'https://lobste.rs/rss') {
				return Promise.resolve({
					text: () => Promise.resolve(mockRssFeed),
				});
			}
			// Mock article score fetch
			if (url.includes('.json')) {
				return Promise.resolve({
					text: () => Promise.resolve(mockScoreResponse),
				});
			}
			return Promise.reject(new Error('Unexpected URL'));
		});
	});

	it('responds with RSS feed (unit style)', async () => {
		const request = new Request('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		const responseText = await response.text();
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/rss+xml; charset=utf-8');
		expect(responseText).toContain('<?xml version="1.0" encoding="UTF-8"?>');
		expect(responseText).toContain('<rss version="2.0"');
		expect(responseText).toContain('xmlns:wfw="http://wellformedweb.org/CommentAPI/"');
		expect(responseText).toContain('xmlns:slash="http://purl.org/rss/1.0/modules/slash/"');
		expect(responseText).toContain('<title>Lobsters</title>');
		expect(responseText).toContain('<item>');
		expect(responseText).toContain('Test Article');
		expect(responseText).toContain('<comments>https://lobste.rs/s/test/test-article</comments>');
		expect(responseText).toContain('<wfw:commentRss>https://lobste.rs/s/test/test-article</wfw:commentRss>');
	}, 10000);

	it('responds with RSS feed (integration style)', async () => {
		const response = await SELF.fetch('http://example.com');

		const responseText = await response.text();
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/rss+xml; charset=utf-8');
		expect(responseText).toContain('<?xml version="1.0" encoding="UTF-8"?>');
		expect(responseText).toContain('<rss version="2.0"');
		expect(responseText).toContain('xmlns:wfw="http://wellformedweb.org/CommentAPI/"');
		expect(responseText).toContain('xmlns:slash="http://purl.org/rss/1.0/modules/slash/"');
		expect(responseText).toContain('<title>Lobsters</title>');
		expect(responseText).toContain('<item>');
		expect(responseText).toContain('Test Article');
		expect(responseText).toContain('<comments>https://lobste.rs/s/test/test-article</comments>');
		expect(responseText).toContain('<wfw:commentRss>https://lobste.rs/s/test/test-article</wfw:commentRss>');
	}, 10000);

	it('redirects /index.xml to root', async () => {
		const request = new Request('http://example.com/index.xml');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toBe('http://example.com/');
	}, 10000);
});
