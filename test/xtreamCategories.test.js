const test = require("node:test");
const assert = require("node:assert");
const { categoryFor } = require("../xtream/categories");

test("providers' spellings of one group land in one category", () => {
  for (const g of ["AM | USA | NBC", "AM | USA NBC", "|NA| USA NBC", "USA | LOCAL - NBC"]) assert.strictEqual(categoryFor([g], "x"), "Local NBC", g);
  for (const g of ["News", "USA | News", "US| NEWS ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ", "AM | USA | NEWS"]) assert.strictEqual(categoryFor([g], "x"), "News", g);
});

test("event slots, loops and Spanish channels are filed before the leagues and sports they mention", () => {
  assert.strictEqual(categoryFor(["US| NBA PPV"], "NBA 01"), "PPV & Events");
  assert.strictEqual(categoryFor(["AM | USA | ESPN PLUS"], "ESPN+ 101"), "PPV & Events");
  assert.strictEqual(categoryFor(["US| 24/7 CRIME ᴿᴬᵂ ⁶⁰ᶠᵖˢ"], "Cops 24/7"), "24/7");
  assert.strictEqual(categoryFor(["→ USA DEPORTES ←"], "TUDN"), "Español");
  assert.strictEqual(categoryFor(["USA | NHL Replay"], "NHL Replay 1"), "Replays");
  assert.strictEqual(categoryFor(["UK FORMULA 1 - NBA"], "F1 Timing Screen"), "Sports");
});

test("the first provider group that says something wins, then the channel's own name, then Other", () => {
  assert.strictEqual(categoryFor(["→ USA ←", "AM | USA | KIDS"], "Nick Jr"), "Kids");
  assert.strictEqual(categoryFor(["→ USA ←"], "US: ABC Denver"), "Local ABC");
  assert.strictEqual(categoryFor(["→ USA II ←"], "USA**:AL | BIRMINGHAM | CBS WIAT"), "Local CBS");
  assert.strictEqual(categoryFor(["US| LOCALS"], "ABC 7 (WABC)"), "Local ABC");
  assert.strictEqual(categoryFor(["UK VIP NEW"], "UK: Christian Bale"), "Other", "a name alone never files a channel as Religious");
  assert.strictEqual(categoryFor([], "US: TLC Pacific"), "Other");
});

test("outside the home country leagues and local networks fold into Sports and Entertainment", () => {
  assert.strictEqual(categoryFor(["UK | ENGLAND VIP"], "UK: VIP Sky Sports NFL", false), "Sports");
  assert.strictEqual(categoryFor(["UK | ENGLAND VIP"], "UK: VIP FOX", false), "Entertainment");
  assert.strictEqual(categoryFor(["EU | UK | NEWS"], "Sky News", false), "News");
});
