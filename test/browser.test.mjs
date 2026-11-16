// Real-browser checks: the pick flow, accessibility (WCAG 2.2 A and AA via
// axe-core) in light and dark schemes, and reflow at 320px.
//
// First run on a new computer: npx playwright install chromium

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import pw from "playwright";
import Database from "better-sqlite3";
import { makeSandbox, startServer, slatePaths, findOpenGame, request, postForm } from "./harness.mjs";

const require = createRequire(import.meta.url);
const AXE = require.resolve("axe-core/axe.min.js");
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
// A slate page for a date long gone, left over as if from an earlier run.
const OLD_SLATE = "20000101";

let sandbox;
let server;
let browser;

before(async () => {
  try {
    browser = await pw.chromium.launch({ executablePath: process.env.EDGEBOARD_CHROMIUM_PATH || undefined });
  } catch (e) {
    throw new Error(
      `Could not start the test browser. On a new computer, run this once:\n\n  npx playwright install chromium\n\n(${e.message.split("\n")[0]})`,
    );
  }
  sandbox = await makeSandbox();
  await fs.mkdir(path.join(sandbox.out, "slate", OLD_SLATE), { recursive: true });
  await fs.writeFile(path.join(sandbox.out, "slate", OLD_SLATE, "index.html"), "<p>Old data</p>");
  server = await startServer(sandbox);
});

after(async () => {
  await browser?.close();
  await server?.stop();
  await sandbox?.cleanup();
});

/** Pages to check: every slate day, plus Review and Insights. */
async function pages() {
  return [...(await slatePaths(server)), "/review/", "/insights/"];
}

test("a pick is saved in place, updated, and changes since it are flagged", async (t) => {
  const game = await findOpenGame(server);
  if (!game) return t.skip("no games open for picks on the current slates");
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const securityErrors = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) securityErrors.push(m.text());
  });

  await page.goto(server.base + game.path, { waitUntil: "networkidle" });
  const form = page.locator(`form.predict-form:has(input[name=gameId][value="${game.gameId}"])`);
  await form.locator("input[value=home]").check();
  await form.locator("input[name=predictedMargin]").fill("6");
  await form.locator("textarea").fill("Test: home team has the rest edge");
  await form.locator("button[type=submit]").click();
  await page.waitForLoadState("networkidle");

  const url = new URL(page.url());
  assert.equal(url.pathname, game.path, "stays on the slate");
  assert.equal(url.hash, `#pick-${game.gameId}`, "returns to the game's card");
  const pick = page.locator(`#pick-${game.gameId}`);
  assert.match(await pick.locator("p").first().textContent(), /^Your pick: .+ by 6 because Test: home team has the rest edge\.$/);
  const details = page.locator(`#game-${game.gameId} details.game-details`);
  assert.equal(await details.evaluate((d) => d.open), false, "details start collapsed");

  // Update through the form inside the disclosure, opened by keyboard.
  await details.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  const update = details.locator('form[action="/predict/update"]');
  await update.locator("input[value=away]").check();
  await update.locator("input[name=predictedMargin]").fill("");
  await update.locator("textarea").fill("Test update: road team is healthier");
  await update.locator("button[type=submit]").click();
  await page.waitForLoadState("networkidle");
  assert.match(await pick.locator("p").first().textContent(), /because Test update: road team is healthier\.$/);
  assert.doesNotMatch(await pick.locator("p").first().textContent(), / by \d+ because/, "margin cleared");

  // Simulate the line moving after the pick, then refresh.
  const db = new Database(path.join(sandbox.data, "edgeboard.db"));
  const row = db.prepare("SELECT id, snapshot_json FROM predictions WHERE game_id = ?").get(game.gameId);
  const snap = JSON.parse(row.snapshot_json);
  if (snap.odds) snap.odds.details = "XYZ -1.5";
  else snap.odds = { details: "XYZ -1.5" };
  db.prepare("UPDATE predictions SET snapshot_json = ? WHERE id = ?").run(JSON.stringify(snap), row.id);
  db.close();
  await page.locator("footer button").click();
  await page.waitForLoadState("networkidle");
  await page.goto(server.base + game.path, { waitUntil: "networkidle" });
  const summary = await page.locator(`#game-${game.gameId} details.game-details > summary`).textContent();
  assert.match(summary, /View game details \(\d+ changes? since your pick\)/);

  assert.deepEqual(securityErrors, [], "the browser safety rules must not break the page");
  await page.close();
});

test("finished games: one heading with both scores, the winner bold and named in words", async (t) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let checked = 0;
  for (const p of await slatePaths(server)) {
    await page.goto(server.base + p, { waitUntil: "networkidle" });
    const headings = await page.locator("h2.final-score").evaluateAll((els) =>
      els.map((h) => ({
        text: h.textContent,
        visible: h.innerText,
        bold: [...h.querySelectorAll("strong")].map((s) => ({
          text: s.textContent,
          weight: getComputedStyle(s).fontWeight,
          background: getComputedStyle(s).backgroundColor,
        })),
        weight: getComputedStyle(h).fontWeight,
        next: h.nextElementSibling?.textContent ?? "",
      })),
    );
    for (const h of headings) {
      checked++;
      const m = /^(.+) (\d+) at (.+) (\d+)$/.exec(h.text.replace(" (winner)", ""));
      assert.ok(m, `heading reads "Team score at Team score": ${h.text}`);
      const [away, home] = [Number(m[2]), Number(m[4])];
      const winner = away > home ? `${m[1]} ${away}` : `${m[3]} ${home}`;
      assert.equal(h.bold.length, 1, `exactly one side is bold: ${h.text}`);
      assert.equal(h.bold[0].text, `${winner} (winner)`, "the bold side is the higher score and says so in words");
      assert.equal(h.weight, "400", "the rest of the heading is regular weight");
      assert.equal(h.bold[0].weight, "700", "the winner is bold");
      assert.equal(h.bold[0].background, "rgb(234, 88, 12)", "the winner is highlighted in orange");
      assert.doesNotMatch(h.next, /^Final —/, "the score is not repeated on a second line");
    }
  }
  await page.close();
  if (checked === 0) t.skip("no finished games on the current slates");
});

test("finished games you picked: a check for a correct pick, an X for a wrong one", async (t) => {
  // Finished games, and which side won, read from the pages themselves.
  const finals = [];
  for (const p of await slatePaths(server)) {
    const { body } = await request(server, p);
    for (const m of body.matchAll(/<h2 id="game-(\d+)-heading" class="final-score">(.*?)<\/h2>/g)) {
      finals.push({ gameId: m[1], ymd: p.match(/\d{8}/)[0], path: p, homeWon: m[2].indexOf("<strong>") > m[2].indexOf(" at ") });
    }
  }
  if (finals.length < 2) return t.skip("fewer than two finished games on the current slates");
  const [right, wrong] = finals;
  const db = new Database(path.join(sandbox.data, "edgeboard.db"));
  const insert = db.prepare(`INSERT INTO predictions (game_id, game_date_et, game_label, pick, pick_team,
    confidence, reasoning, snapshot_json, created_at_utc) VALUES (?, ?, ?, ?, 'TST', 3, 'Icon test', '{}', ?)`);
  const etDate = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
  const side = (homeWon, correct) => (homeWon === correct ? "home" : "away");
  insert.run(right.gameId, etDate(right.ymd), "Icon test right", side(right.homeWon, true), new Date().toISOString());
  insert.run(wrong.gameId, etDate(wrong.ymd), "Icon test wrong", side(wrong.homeWon, false), new Date().toISOString());
  db.close();
  assert.equal((await postForm(server, "/refresh", {})).status, 303);

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pickLine = async (g) => {
    await page.goto(server.base + g.path, { waitUntil: "networkidle" });
    return page.locator(`#pick-${g.gameId} p`).first().evaluate((p) => ({
      text: p.textContent.replace(/\s+/g, " ").trim(),
      icons: [...p.querySelectorAll(".result-icon")].map((i) => i.className),
      hidden: [...p.querySelectorAll(".result-icon svg")].every((s) => s.getAttribute("aria-hidden") === "true"),
    }));
  };
  const r = await pickLine(right);
  assert.match(r.text, /^Your pick: Correct, /, "screen readers hear the result");
  assert.deepEqual(r.icons, ["result-icon correct"], "a check mark, and only one");
  assert.ok(r.hidden, "the drawing itself is hidden from screen readers");
  const w = await pickLine(wrong);
  assert.match(w.text, /^Your pick: Incorrect, /);
  assert.deepEqual(w.icons, ["result-icon incorrect"], "an X, and only one");

  // The Review page shows the same marks next to each graded pick.
  await page.goto(server.base + "/review/", { waitUntil: "networkidle" });
  const reviewIcon = (label) =>
    page.locator(`article:has(h2:text-is("${label}, ${label === "Icon test right" ? etDate(right.ymd) : etDate(wrong.ymd)}"))`).locator("p", { hasText: "Pick:" }).locator(".result-icon").getAttribute("class");
  assert.equal(await reviewIcon("Icon test right"), "result-icon correct");
  assert.equal(await reviewIcon("Icon test wrong"), "result-icon incorrect");
  await page.close();
});

test("slate pages for dates outside the window are removed after a build", async () => {
  const paths = await slatePaths(server);
  assert.ok(paths.length > 0);
  for (const p of paths) {
    await assert.doesNotReject(fs.access(path.join(sandbox.out, p, "index.html")), `${p} was built`);
  }
  await assert.rejects(fs.access(path.join(sandbox.out, "slate", OLD_SLATE)), "the old slate folder is gone");
});

for (const scheme of ["light", "dark"]) {
  test(`accessibility: no WCAG 2.2 A or AA violations (${scheme})`, async () => {
    // The page forbids scripts, so the checker needs that rule set aside.
    const context = await browser.newContext({ bypassCSP: true, colorScheme: scheme, viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const problems = [];
    for (const p of await pages()) {
      await page.goto(server.base + p, { waitUntil: "networkidle" });
      await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
      await page.addScriptTag({ path: AXE });
      const result = await page.evaluate((tags) => axe.run(document, { runOnly: { type: "tag", values: tags } }), WCAG_TAGS);
      for (const v of result.violations) {
        problems.push(`${p}: ${v.id} (${v.nodes.length}) ${v.help}\n    e.g. ${v.nodes[0]?.target?.join(" ")}`);
      }
    }
    await context.close();
    assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
  });
}

test("reflow: no sideways scrolling at 320px (WCAG 1.4.10)", async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
  const overflowing = [];
  for (const p of await pages()) {
    await page.goto(server.base + p, { waitUntil: "networkidle" });
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    if (scroll > client) overflowing.push(`${p}: ${scroll}px wide in a ${client}px window`);
  }
  await page.close();
  assert.deepEqual(overflowing, []);
});
