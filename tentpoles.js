// Once-a-year (or once-in-a-while) broadcasts that rank above everything else on TV, whatever their show type.
// [pattern, label, score]. Matched against the show name, the episode name and guide titles.
const TENTPOLES = [
    [/\b(?:oscars|academy awards)\b/i, 'Oscars', 70],
    [/\belection (?:night|day|results|coverage|center|headquarters)\b|\b(?:america|decision) (?:decides|20\d\d)\b|\belection night in america\b/i, 'Election night', 70],
    [/\bpresidential debate\b|\bvice[- ]presidential debate\b/i, 'Presidential debate', 65],
    [/\bstate of the union\b/i, 'State of the Union', 60],
    [/\binaugurat(?:ion|al)\b/i, 'Inauguration', 65],
    [/(?<!\b(?:youth|special)\s)\bolympics?\b.*\b(?:opening|closing) ceremon/i, 'Olympics ceremony', 70],
    // Not the Youth or Special Olympics, which are far smaller.
    [/(?<!\b(?:youth|special)\s)\bolympics?\b(?! trials)|(?<!\b(?:youth|special)\s)\bolympic games\b/i, 'Olympics', 45],
    [/\bemmy awards\b|\bemmys\b/i, 'Emmys', 55],
    [/\bgrammy awards\b|\bgrammys\b/i, 'Grammys', 55],
    [/\bgolden globe/i, 'Golden Globes', 55],
    [/\btony awards\b/i, 'Tony Awards', 40],
    [/\b(?:mtv )?video music awards\b|\bvmas\b/i, 'VMAs', 40],
    [/\bamerican music awards\b/i, 'American Music Awards', 40],
    [/\bcma awards\b|\bcountry music association awards\b|\bacm awards\b|\bacademy of country music awards\b/i, 'Country music awards', 40],
    [/\bbet awards\b|\bbillboard music awards\b|\bpeople'?s choice awards\b|\bcritics'? choice awards\b|\bsag awards\b|\bactor awards\b|\bkennedy center honors\b/i, 'Awards', 35],
    [/\bmacy'?s (?:thanksgiving day )?parade\b/i, "Macy's Thanksgiving Parade", 50],
    [/\brose parade\b|\btournament of roses parade\b/i, 'Rose Parade', 35],
    [/\bnew year'?s rockin'? eve\b|\bnew year'?s eve live\b|\bnew year'?s eve (?:with|countdown)\b|\btimes square ball drop\b/i, "New Year's Eve", 55],
    [/\bchristmas in rockefeller center\b|\brockefeller center christmas tree\b/i, 'Rockefeller tree lighting', 35],
    [/\bsuper bowl halftime\b/i, 'Super Bowl halftime', 60],
    [/\bmet gala\b/i, 'Met Gala', 35],
    [/\beurovision\b/i, 'Eurovision', 40],
    [/\bmiss (?:universe|america)\b/i, 'Pageant', 30],
    [/\bcoronation\b|\broyal wedding\b|\bpapal (?:inauguration|conclave)\b|\bconclave\b/i, 'Royal or papal event', 55]
];

function tentpoleOf(...texts) {
    const text = texts.filter(Boolean).join(' | ');
    if (!text) return null;
    const hit = TENTPOLES.find(([re]) => re.test(text));
    return hit ? { label: hit[1], score: hit[2] } : null;
}

module.exports = { tentpoleOf, TENTPOLES };
