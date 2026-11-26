# Options Terminal

A local, terminal-style web app for options. Load any US stock, ETF or index and get its option
chain, volatility, open interest, a strategy builder, a pricing calculator and an interactive
course on the Greeks. It runs on your own machine and needs no account or API key.

## What you need

- [uv](https://docs.astral.sh/uv/). Both ways of starting the app use it. On the first run it
  fetches Python and the one library the server needs (`yfinance`) by itself.
- An internet connection: for the market data, and for the chart library (Plotly), which the page
  loads from a CDN.
- Node 18 or newer, only if you want to run the tests.

## Start it

On a Mac, build the app icon once:

    python3 make_app.py

That creates `Options Terminal.app` in this folder. Double-click it, or drag it to the Dock. It
starts the server if it is not running and opens the terminal in your browser. The server stops by
itself 15 minutes after the last tab is closed. Build the app again if you move this folder.

Or start it from a terminal:

    uv run server.py

It opens http://127.0.0.1:8765. Use `--port 9000` for another port and `--no-browser` to skip
opening the browser. Stop it with Ctrl+C.

## Find your way around

Type a ticker in the command line at the top and press Enter (`AAPL`, `SPY`, `^SPX`). A company
name works too (`nvidia`): pick it from the list, or press Enter to open the best match. Add a
view after the ticker to land on it (`SPY CHAIN`).

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

Other keys: `/` jumps to the command line, `[` and `]` step through expiries, `r` reloads, `g`
opens the glossary and `?` lists every shortcut. On the Chain view the arrow keys move between
contracts and Enter opens the one under the cursor.

A few things worth knowing:

- **The address bar is a bookmark.** It holds the ticker, the view, the expiry, the selected
  contract, the legs of a strategy and the lesson. The browser's Back button steps back through
  the views and tickers you visited.
- **Everything else is remembered by this browser only**: your watch list, strategy legs, saved
  positions, lesson progress, calculator inputs, chart range and text size. Another browser, or
  clearing site data, starts empty.
- **The screen refreshes every minute** while auto-refresh is ticked. It pauses on the Learn,
  Calculator and Strategy views and while a slider has the focus.
- **Estimates are marked.** A volatility in italics is read off the curve rather than taken from
  that contract's own quote. Grey figures are borrowed from a neighbouring expiry or guessed from
  far-away strikes.
- The command bar hides while you scroll down and returns when you scroll up. The `A A A` buttons
  set the text size. On the Price view, drag across the chart to zoom into a stretch of dates.

## Where the numbers come from

Free sources, no key, about 15 minutes delayed:

- **Option chains**: Nasdaq's public feed first (the complete listing for stocks and ETFs), and
  Yahoo Finance when Nasdaq has none (most indexes). The status bar names the source in use.
- **Quotes, price history, ticker search and the risk-free rate**: Yahoo Finance, through
  `yfinance`.

Implied volatility and the Greeks are not downloaded. The browser computes them from bid and ask
prices with the Black-Scholes-Merton model. The limits of that are worth knowing:

- **Delayed prices.** Never time an order from this screen. Check your broker's live quote.
- **Closed market.** Quotes freeze at the close, so volatility and Greeks are worked out as of the
  close. The status bar says "Options as of ..." when that is the case.
- **Early exercise.** The model treats every option as exercisable only at expiry. Stock options
  can be exercised early, so deep in-the-money puts are worth a little more than shown. The
  Calculator's Binomial model shows the difference.
- **Thin chains.** With few usable quotes the inputs are rough and so are the outputs. The app
  says so instead of hiding it.
- **Chance of profit** assumes one bell-shaped spread of prices at the at-the-money volatility of
  the first expiry. It ignores skew, costs and selling early.

## How it works

    browser (static/)                          server.py                    the internet
    -----------------                          ---------                    ------------
    app.js    load("AAPL")  -- /api/quote   -->  get_quote    -- yfinance -->  Yahoo Finance
                            -- /api/chain   -->  get_chain    -- HTTPS    -->  Nasdaq, then Yahoo
                            -- /api/history -->  get_history  -- yfinance -->  Yahoo Finance
    model.js  buildChain(raw, quote)    turns the raw rows into expiries and contracts with
                                        implied volatility, Greeks and statistics
    views-*.js  render(root, ctx)       draws the current view from that model

The server only fetches, caches and repackages data. Every calculation happens in the browser,
in plain JavaScript modules with no build step: edit a file and reload the page.

The server listens on this machine only (127.0.0.1) and refuses requests that do not come from
its own page, so other web sites cannot use it.

## The code, file by file

Start with `static/js/app.js`, then `model.js`, then any one view.

| File | What is in it |
|---|---|
| `server.py` | The data server: endpoints, the two chain sources, the cache. Standard library plus `yfinance` |
| `make_app.py` | Builds the double-click macOS launcher |
| `static/index.html`, `static/app.css` | The page shell and every style |
| `static/js/app.js` | State, loading, the address bar, the command line, keys, the list of views |
| `static/js/model.js` | The chain model (its data shapes are listed at the top) and strategy maths |
| `static/js/quant.js` | Pricing maths. The units of every number are listed at the top |
| `static/js/explain.js` | The plain-English readings |
| `static/js/views-market.js` | Overview and Price views |
| `static/js/views-chain.js` | Chain view and the contract panel |
| `static/js/views-vol.js` | Volatility and Open interest views |
| `static/js/views-strategy.js` | Strategy builder and Calculator |
| `static/js/learn.js`, `learn-widgets.js` | The course: lesson text, and its interactive widgets |
| `static/js/glossary.js` | Every hover tip and glossary entry |
| `static/js/expiries.js`, `payoff.js` | The expiry picker and the profit-and-loss chart, shared by several views |
| `static/js/ui.js`, `fmt.js` | Page and chart helpers; number and date formatting |
| `tests.mjs`, `tests-model.mjs` | The checks (see below) |

To change things:

- **A new view**: write `render(root, ctx)` in a views file and add it to `VIEWS` in `app.js`.
- **A new lesson**: add an entry to `LESSONS` in `learn.js`.
- **A new term**: add it to `TERMS` in `glossary.js`.
- **Another data source** (a real-time one, say): write a `chain_<name>(symbol, kind)` in
  `server.py` that returns the same rows as `chain_nasdaq`, and put it first in `get_chain()`.

Many lines in the views are long, because each one builds a whole piece of the page. Turn on
soft wrap in your editor when reading them.

## Tests

    node tests.mjs

Eighteen checks run offline: the pricing formulas against textbook and reference values, the
chain model on made-up chains with known answers, strategy maths, and hostile input from links.
With the server running it also builds live chains for GEMI, SPY, SPX and VIX and checks that
every number is sane. Set `TERMINAL_URL` if the server is on another port.

`server.py` checks its own parsing rules each time it starts.

## If something goes wrong

- **"Cannot reach the local data server"**: the server has stopped. Open the app again, or run
  `uv run server.py`, then press RETRY.
- **The app icon does nothing**: it needs `uv` on this Mac. It always uses port 8765 and writes
  its log to `~/Library/Logs/OptionsTerminal.log`.
- **"REFRESH FAILED" in the status bar**: the latest update did not arrive, so the screen shows
  older numbers. It retries every minute; press `r` to try now.
- **No options for a ticker**: the free sources list none for crypto, futures, most funds and many
  foreign shares. The price views still work.
- **Charts are missing**: the chart library could not be fetched. Check the connection and reload.

## Not advice

This is a learning and analysis tool. The data is delayed and unofficial, nothing here is
investment advice, and it cannot place orders.
