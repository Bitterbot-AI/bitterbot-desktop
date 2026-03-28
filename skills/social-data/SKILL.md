---
name: social-data
description: Search and fetch social media data from Twitter/X, Reddit, and Hacker News.
metadata: { "bitterbot": { "emoji": "\uD83D\uDCF1" } }
---

# Social Data

Access social media content from multiple platforms. Some require API keys, some are free.

## Hacker News (free, no key)

### Top Stories

```bash
curl -s "https://hacker-news.firebaseio.com/v0/topstories.json" | head -c 200
```

Returns array of item IDs. Fetch individual items:

```bash
curl -s "https://hacker-news.firebaseio.com/v0/item/12345678.json"
```

### Search (via Algolia, free)

```bash
curl -s "https://hn.algolia.com/api/v1/search?query=rust+programming&tags=story&hitsPerPage=10"
```

- `tags`: `story`, `comment`, `ask_hn`, `show_hn`, `poll`
- `numericFilters`: `created_at_i>1700000000` (Unix timestamp)
- Response: `hits[]` array with `title`, `url`, `author`, `points`, `num_comments`

### Front Page

```bash
curl -s "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30"
```

## Reddit (free, no key for public data)

### Subreddit Posts

```bash
curl -s "https://www.reddit.com/r/programming/hot.json?limit=10" \
  -H "User-Agent: bitterbot/1.0"
```

Sort options: `hot`, `new`, `top`, `rising`
For `top`: add `?t=hour|day|week|month|year|all`

### Search Reddit

```bash
curl -s "https://www.reddit.com/search.json?q=rust+async&sort=relevance&limit=10" \
  -H "User-Agent: bitterbot/1.0"
```

### Post Comments

```bash
curl -s "https://www.reddit.com/r/programming/comments/POST_ID.json" \
  -H "User-Agent: bitterbot/1.0"
```

Response is array of two listings: `[0]` = post, `[1]` = comments tree.

### User Profile (public)

```bash
curl -s "https://www.reddit.com/user/USERNAME/submitted.json?limit=10" \
  -H "User-Agent: bitterbot/1.0"
```

## Twitter/X (requires API key)

Requires `TWITTER_BEARER_TOKEN` env var (from X Developer Portal).

### Search Recent Tweets

```bash
curl -s "https://api.twitter.com/2/tweets/search/recent?query=from:elonmusk&max_results=10&tweet.fields=created_at,public_metrics" \
  -H "Authorization: Bearer $TWITTER_BEARER_TOKEN"
```

Query operators:
- `from:username` — tweets by user
- `to:username` — replies to user
- `#hashtag` — hashtag search
- `"exact phrase"` — exact match
- `-is:retweet` — exclude retweets
- `lang:en` — language filter
- `has:media` — tweets with media

### User Lookup

```bash
curl -s "https://api.twitter.com/2/users/by/username/elonmusk?user.fields=public_metrics,description,created_at" \
  -H "Authorization: Bearer $TWITTER_BEARER_TOKEN"
```

### User Timeline

```bash
curl -s "https://api.twitter.com/2/users/USER_ID/tweets?max_results=10&tweet.fields=created_at,public_metrics" \
  -H "Authorization: Bearer $TWITTER_BEARER_TOKEN"
```

## Tips

- Always include `User-Agent` header for Reddit (they block default agents).
- Reddit JSON endpoints append `.json` to any Reddit URL.
- HN Algolia API is the most reliable for search; Firebase API for real-time data.
- Twitter free tier allows 500K tweets/month read access.
- For rate-limited APIs, cache results and avoid repeated identical queries.
- Use `web_fetch` for HTML pages, `exec` + `curl` for JSON APIs.
