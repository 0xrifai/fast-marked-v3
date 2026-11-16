# fast-marked-v3

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![make.fun bounty](https://img.shields.io/badge/make.fun-markdown--render--speed--02-blueviolet.svg)](https://make.fun/bounty/markdown-render-speed-02)

A faster drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3:
`parse(markdown)` returns exactly the HTML that `marked.parse(markdown)` returns
with marked's default options (GFM on, breaks off, pedantic off), with no
dependencies — just quicker at it.

## Use

```js
import { parse } from './parse.js';
parse('# Hello'); // '<h1>Hello</h1>\n'
```

## Bounty

Built for the [make.fun bounty "Make Markdown rendering faster"](https://make.fun/bounty/markdown-render-speed-02)
— referral code `6twtfdad`.

## License

MIT — see [LICENSE](./LICENSE).
