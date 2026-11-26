# Options Terminal

A local, terminal-style web app for options. Load any US stock, ETF or index and get its option
chain, volatility, open interest, a strategy builder, a pricing calculator and an interactive
course on the Greeks.

## Run

    uv run server.py

It opens http://127.0.0.1:8765. You need [uv](https://docs.astral.sh/uv/) and an internet
connection. Use `--port 9000` for another port and `--no-browser` to skip opening the browser.

## Using it

Type a ticker or company name in the command line at the top (`AAPL`, `SPY`, `^SPX`, `nvidia`).
Add a view to land on it (`SPY CHAIN`). Keys `1` to `8` switch views and `?` lists the shortcuts.

| Key | View | What it shows |
|---|---|---|
| 1 | Overview | A plain-English reading of the whole chain, and every expiry at a glance |
| 2 | Price | Candles, moving averages and the range options imply for each expiry |
| 3 | Chain | Calls, strikes and puts; click a contract for an explanation and what-if sliders |
| 4 | Volatility | Skew by strike, term structure and a 3D surface |
| 5 | Open interest | Positions and volume by strike, max pain, estimated dealer gamma |
| 6 | Strategy | Multi-leg positions with payoff, break-evens, odds and net Greeks |
| 7 | Calculator | Price any option, solve for implied volatility |
| 8 | Learn | Thirteen lessons with live examples, sliders and quizzes |

## Data

Free, no key, about 15 minutes delayed:

- Option chains for stocks and ETFs: Nasdaq's public feed
- Index chains, quotes, price history and search: Yahoo Finance, through `yfinance`

Implied volatility and the Greeks are computed in the browser from bid and ask prices. To add
another source, write a `chain_<name>()` in `server.py` and put it first in `get_chain()`.

## Code

- `server.py`: the data server (Python standard library plus `yfinance`)
- `static/js/quant.js`: pricing maths
- `static/js/model.js`: chain analysis and strategy maths
- `static/js/views-*.js`: the views
- `static/js/learn.js`, `learn-widgets.js`: the course
- `tests.mjs`: run `node tests.mjs` for the maths checks; with the server running it also
  checks live chains

## Not advice

This is a learning and analysis tool. The data is delayed and unofficial, nothing here is
investment advice, and it cannot place orders.
