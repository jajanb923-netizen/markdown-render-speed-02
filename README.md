[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/jajanb923-netizen/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/jajanb923-netizen/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02

A fast, dependency-free Markdown-to-HTML renderer written from scratch in
plain JavaScript, built to match [marked](https://github.com/markedjs/marked)
18.1.3 output exactly while running faster than it.

## What it does

`parse.js` renders a Markdown document to the same HTML marked 18.1.3
produces, covering the CommonMark 0.31.2 spec examples and the generated
documents in the bounty practice set (720/720 on the practice set). It is
stateless and deterministic: no caches across calls, no network, no clock
or environment reads, no dependencies.

`main.ts` is the bounty driver: it reads `/input/cases.json` (or
`$MAKEFUN_INPUT_DIR/cases.json`), renders each case's `markdown` with
`parse`, and writes the HTML strings in order to
`/output/html.json` (or `$MAKEFUN_OUTPUT_DIR/html.json`).

## Run it

```sh
node main.ts
```

Node 22 or later (type stripping, no build step).

## How it works

- A line lexer turns the document into blocks (headings, fences, lists,
  blockquotes, tables, HTML blocks, paragraphs) with CommonMark tab
  expansion and lazy continuation.
- Inline rendering handles emphasis and strong emphasis with marked's
  delimiter-run rules (including the rule of three and the link-mask
  interaction), links and images (inline, reference, autolinks), code
  spans with strict same-length pairing, entities, and raw HTML.
- The tricky parts are the places where marked's behaviour is not the
  textbook one: a document-wide `inLink` state set by a raw `<a ` tag
  that suppresses bare-URL and email autolinks until a raw `</a>`,
  and a blockSkip mask that hides `[...](...)` regions from emphasis
  scanning even when the link itself is rejected.

## Layout

- `parse.js` — the renderer (single file, no dependencies).
- `main.ts` — the bounty driver.
- `LICENSE` — MIT.
