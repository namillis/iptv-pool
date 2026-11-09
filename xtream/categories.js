/**
 * The pool's own short category list. Providers each name their groups their own way ("AM | USA | NBC",
 * "|NA| USA NBC", "US| NEWS ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ"), so passing them through gives hundreds of categories that repeat each
 * other. Instead each channel is filed under one category from this fixed list, picked from its providers' group
 * names in provider order, then from its own name. Every channel still has a category, so none is lost.
 */

// [category, test on a cleaned group or channel name]. The first match wins, so specific rules come first: an
// "NBA PPV" group is an event slot, and "USA DEPORTES" is Spanish, not general sports.
const RULES = [
  ["Replays", /\bREPLAYS?\b/],
  ["PPV & Events", /\bPPV\b|\bEVENTS?\b|ESPN ?(?:\+|PLUS|PLAY)|\bDAZN\b|TRILLER|\bFLO ?SPORTS?\b|PEACOCK|PARAMOUNT|\bPRIME\b|APPLE TV|\bMAX\b|NETFLIX|FANATIZ|\bFUBO\b|VICTORY|GAME ?PASS|SEASON TICKET|LEAGUE PASS|IN ARENA|\bUFC\b|\bMMA\b|BOXING|\bWWE\b|\bAEW\b|DIRTVISION|\bTEAMS?\b/],
  ["24/7", /24 ?\/ ?7|CINEMANIA|\bVOD\b/],
  ["Free Streaming", /PLUTO|SAMSUNG|\bTUBI\b|\bPLEX\b|XUMO|\bROKU\b|STIRR|LOCAL NOW|STREAMED|\bFAST\b|VIZIO|LG CHANNELS|DISTRO|RAKUTEN/],
  ["Español", /ESPA[NÑ]OL|LATIN|SPANISH|HISPAN|UNIVISION|UNIMAS|TELEMUNDO|GALAVISI|DEPORTES|MEXICO|\bMX\b/],
  ["Local ABC", /^(?:LOCAL )?ABC$|LOCAL\W+ABC\b/],
  ["Local CBS", /^(?:LOCAL )?CBS$|LOCAL\W+CBS\b/],
  ["Local NBC", /^(?:LOCAL )?NBC$|LOCAL\W+NBC\b/],
  ["Local FOX", /^(?:LOCAL )?FOX$|LOCAL\W+FOX\b/],
  ["Local PBS", /^(?:LOCAL )?PBS$|LOCAL\W+PBS\b/],
  ["Local CW & MY", /^(?:LOCAL )?(?:CW|MY)\b|\bCW (?:&|AND) MY\b/],
  ["Local", /\bLOCALS?\b|REGIONAL|SPECTRUM|AFFILIATES?|\bMIAMI\b/],
  // One provider files its F1 feeds under "UK FORMULA 1 - NBA".
  ["Sports", /FORMULA ?1|\bF1\b/],
  ["NFL", /\bNFL\b/],
  ["NBA", /\bW?NBA\b/],
  ["NHL", /\bNHL\b|\bAHL\b/],
  ["MLB", /\bMLB\b|\bMILB\b/],
  ["College", /\bNCAA\b|COLLEGE|\bBTN\b|SEC NETWORK|\bACC\b/],
  ["Soccer", /\bMLS\b|SOCCER|FOOTBALL|PREMIER LEAGUE|LA ?LIGA|\bUEFA\b|\bEFL\b|\bSPFL\b|NATIONAL LEAGUE|SERIE A|BUNDESLIGA/],
  ["Sports", /SPORT|\bESPN\b|GOLF|TENNIS|RACING|\bF1\b|FORMULA|MOTOR|CRICKET|RUGBY|DARTS|SOFTBALL|\bNLL\b|LACROSSE|WRESTLING|FIGHT|\bBEIN\b|SETANTA|\bTSN\b|\bNBCSN?\b|\bMSG\b|\bTVG\b|STADIUM|OLYMPIC|COWBOY|BARCA TV|BENFICA/],
  ["News", /\bNEWS\b/],
  ["Kids", /\bKIDS?\b|FAMILY|FAMLIY|CHILD|CARTOON|DISNEY JR|NICK/],
  ["Movies", /MOVIES?|CINEMA|\bFILMS?\b|PREMIUM|\bHBO\b|SHOWTIME|STARZ|CINEMAX|\bMGM\b/],
  ["Music", /MUSIC|RADIO|\bVH1\b|\bMTV (?:ROCKS|BASE|CLASSIC|CLUB|DANCE|HITS|LIVE|OMG|80S|90S|00S)\b|KERRANG|\bVEVO\b|BANDAMAX/],
  ["Documentary", /DOCU|\bDOC\b|HISTORY|NATURE|SCIENCE/],
  ["Religious", /RELIGI|FAITH|CHRISTIAN|GOSPEL/],
  ["Entertainment", /ENTERTAIN|GENERAL|VARIETY|LIFESTYLE|REALITY|COMEDY|DRAMA|\bMETV\b|\bION\b|\bAT ?& ?T\b|NETWORKS?|DISNEY|ORIGINALS|ULTRA HD|\bUHD\b|\b4K\b/],
];
// A channel whose groups say nothing ("→ USA ←") is filed by its own name, with fewer rules: a name like
// "Christian Bale" or "Bradford City" says nothing about religion or local TV. A local station's name starts
// with its network ("ABC Denver").
const NAME_RULES = [
  // ...or has its network next to a call sign ("AL BIRMINGHAM CBS WIAT").
  ...[["ABC"], ["CBS"], ["NBC"], ["FOX"], ["PBS"], ["CW", "CW & MY"]].map(([net, label]) => [`Local ${label || net}`,
    new RegExp(`^${net}\\b(?! (?:NEWS|SPORTS?|BUSINESS))|\\b${net} [KW][A-Z]{2,3}\\b`)]),
  ...RULES.filter(([name]) => !["Religious", "Local"].includes(name)),
];
// Outside the home country the leagues and local networks are only a handful of channels each, so they fold into
// broader categories.
const ABROAD = { "Local ABC": "Entertainment", "Local CBS": "Entertainment", "Local NBC": "Entertainment", "Local FOX": "Entertainment",
  "Local PBS": "Entertainment", "Local CW & MY": "Entertainment", Local: "Entertainment", NFL: "Sports", NBA: "Sports", NHL: "Sports",
  MLB: "Sports", College: "Sports", Religious: "Entertainment", "Español": "Entertainment" };
const OTHER = "Other";
// The order the app lists them in, separate from the rule order: channels people browse first, the long lists of
// loops and event slots last.
const ORDER = ["Local", "Local ABC", "Local CBS", "Local NBC", "Local FOX", "Local PBS", "Local CW & MY", "News", "Sports", "NFL", "NBA",
  "NHL", "MLB", "College", "Soccer", "Entertainment", "Movies", "Kids", "Documentary", "Music", "Español", "Religious", "Free Streaming",
  "24/7", "PPV & Events", "Replays", OTHER];

// Superscript tags ("ᴴᴰ/ᴿᴬᵂ ⁶⁰ᶠᵖˢ", "ⱽᴵᴾ"), arrows, and the country and quality words providers put around a name.
const SUPERSCRIPTS = /[\u1D2C-\u1D6A\u02B0-\u02FF\u2070-\u209F\u2C7D\u00B2\u00B3\u00B9]+/g;
const NOISE_WORDS = /\b(?:AM|NA|USA?|UK|GB|EU|CA|ENGLAND|HD|FHD|SD|RAW|VIP|NEW|DIRECT|HEVC|BK|60 ?FPS)\b/g;

function clean(text) {
  return String(text || "").replace(SUPERSCRIPTS, " ").normalize("NFKC").toUpperCase()
    .replace(/[→←⁽⁾()[\]]/g, " ").replace(NOISE_WORDS, " ").replace(/[|:\-–_/]+(?! ?7)/g, " ").replace(/\s+/g, " ").trim();
}

function themeOf(text, rules) {
  const t = clean(text);
  if (!t) return null;
  const rule = rules.find(([, re]) => re.test(t));
  return rule ? rule[0] : null;
}

/**
 * The category for a channel: from its providers' group names in order, then its own name, then Other. Outside
 * the [home] country the leagues and local networks fold into Sports and Entertainment.
 */
function categoryFor(groups, channelName, home = true) {
  let theme = null;
  for (const g of groups || []) if ((theme = themeOf(g, RULES))) break;
  const ownName = String(channelName || "").replace(/^\s*[A-Z]{2,3}\**\s*[:|\-]+\s*/i, "");
  const byName = !theme || theme === "Local" ? themeOf(ownName, NAME_RULES) : null;
  // A station in a plain "Locals" group still goes under its network when its name gives one ("ABC 7 (WABC)").
  if (!theme || (byName && byName.startsWith("Local "))) theme = byName || theme || OTHER;
  return home ? theme : ABROAD[theme] || theme;
}

/** Sorts category names in list order: the home country's, then each other country's ("UK | News"). */
function categoryRank(theme) {
  const i = ORDER.indexOf(theme);
  return i < 0 ? ORDER.length : i;
}

module.exports = { categoryFor, categoryRank, clean, OTHER };
