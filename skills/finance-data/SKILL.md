---
name: finance-data
description: Get stock quotes, company info, market data, and crypto prices. No API key needed.
metadata: { "bitterbot": { "emoji": "\uD83D\uDCC8" } }
---

# Finance Data

Real-time and historical financial data via Yahoo Finance (free, no API key).

## Stock Quote (current price + 5-day chart)

```bash
curl -s "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d" \
  -H "User-Agent: Mozilla/5.0"
```

Replace `AAPL` with any ticker symbol. Response is JSON:

- `chart.result[0].meta.regularMarketPrice` — current price
- `chart.result[0].meta.previousClose` — previous close
- `chart.result[0].meta.currency` — currency
- `chart.result[0].indicators.quote[0].close` — closing prices array

## Company Profile & Financials

```bash
curl -s "https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=assetProfile,financialData,defaultKeyStatistics" \
  -H "User-Agent: Mozilla/5.0"
```

Useful modules (comma-separated):

- `assetProfile` — sector, industry, employees, description
- `financialData` — revenue, margins, EPS, recommendation
- `defaultKeyStatistics` — P/E, market cap, beta, float
- `incomeStatementHistory` — income statements
- `balanceSheetHistory` — balance sheet
- `cashflowStatementHistory` — cash flows

## Market Movers

```bash
curl -s "https://query1.finance.yahoo.com/v1/finance/trending/US" \
  -H "User-Agent: Mozilla/5.0"
```

## Multi-Quote (batch)

```bash
curl -s "https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,GOOGL,MSFT" \
  -H "User-Agent: Mozilla/5.0"
```

Returns an array under `quoteResponse.result[]` with price, change, volume, marketCap for each symbol.

## Historical Data (longer range)

```bash
curl -s "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1wk&range=1y" \
  -H "User-Agent: Mozilla/5.0"
```

Interval options: `1m`, `5m`, `15m`, `1d`, `1wk`, `1mo`
Range options: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `5y`, `max`

## Crypto

Same API, use crypto ticker format:

```bash
curl -s "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1d&range=5d" \
  -H "User-Agent: Mozilla/5.0"
```

Common crypto tickers: `BTC-USD`, `ETH-USD`, `SOL-USD`, `DOGE-USD`

## Forex

```bash
curl -s "https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1d&range=1mo" \
  -H "User-Agent: Mozilla/5.0"
```

Format: `{FROM}{TO}=X` (e.g., `GBPUSD=X`, `USDJPY=X`)

## Response Parsing Tips

- All responses are JSON. Use `exec` to run `curl` and parse with `JSON.parse()`.
- Always include the `User-Agent` header to avoid 403 errors.
- Yahoo Finance rate limits are generous for individual use.
- If a quote endpoint returns empty, try the chart endpoint instead.
- For crypto and forex, always include `=X` or `-USD` suffix.
