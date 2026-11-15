# Project rules for EdgeBoard

These rules come from the project owner and apply to every session.

## Wordmark

- The product name is the wordmark **EdgeBoard**: capital E, capital B,
  one word. Never alter it in any way, anywhere: not in pages, titles,
  messages, docs, commit messages, or chat replies. No lowercasing, no
  uppercasing, no spacing, no restyling, no CSS that transforms it.
- Lowercase `edgeboard` exists only as a technical identifier that must
  match exactly to work: the folder and GitHub repository name, the npm
  package name (npm forbids capitals), and the database file name. Always
  show those in code formatting so they read as identifiers, not the name.
- A build guard in `eleventy.config.js` fails the build if any page shows
  the name in another form. Do not weaken or remove it.

## Decisions

- Always ask before choosing or changing the tech stack, a framework, or a
  major library. Present options and a recommendation, then wait.

## Accessibility

- WCAG 2.2 level A and AA are mandatory for every change. Verify with
  axe-core in light and dark schemes, and check reflow with no horizontal
  scrolling at 320px (Success Criterion 1.4.10).
- Convey every signal in text, never by color alone.

## Security

- The server listens on 127.0.0.1 and ::1 by default. Never change the
  default to listen on all interfaces.
- Keep the Host check, the same-origin check on every POST, and the
  security headers in `server.mjs`. New form endpoints get the same
  checks automatically; do not add routes that bypass `handleRequest`.
- The pages run no JavaScript, and the Content-Security-Policy forbids
  it. Do not add scripts or inline styles without discussing it first.

## Testing

- Run `npm test` before every commit; all tests must pass. In a cloud
  container, prefix it with the proxy settings from the README.
- New behavior gets a test in `test/`. Tests run against throwaway
  sandboxes from `test/harness.mjs`; never point a test at the real
  `data/` folder.
- Before trusting a new test, break the thing it guards once and watch it
  fail.

## Data

- `data/` holds the owner's predictions and is gitignored. Never commit it.
