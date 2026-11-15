import type { TechnicianCategory } from './categories';

/**
 * Transparent keyword-baseline fault classifier (V0.3).
 *
 * This is a deterministic keyword baseline, not a trained model. It returns a
 * canonical category suggestion that the user must confirm in the UI.
 *
 * The confidence score is a deterministic heuristic based on keyword evidence.
 * It is NOT AI confidence, model confidence, or probability. It answers:
 * "How strongly does the keyword evidence support this category assignment?"
 *
 * Selection is evidence-weighted: object and trade nouns (fridge, geyser,
 * washing machine) count for more than generic symptom words (leak, light),
 * so "fridge leaking water" resolves to Refrigeration rather than to whichever
 * rule happens to be listed first. Measured accuracy on a held-out corpus is
 * reported in docs/evaluation/classification-results.md.
 */

type KeywordSpecificity = 'word-boundary' | 'multi-word' | 'substring';

interface KeywordRule {
  /** Human-readable keyword label for evidence display. */
  label: string;
  /** Regex fragment used for matching. */
  pattern: string;
  /** Specificity level of this keyword. */
  specificity: KeywordSpecificity;
  /**
   * Evidence weight used to rank categories against each other.
   * Defaults to 1 when omitted.
   */
  weight?: number;
}

interface CategoryRule {
  category: TechnicianCategory;
  keywords: KeywordRule[];
}

/** Object nouns weigh 3, domain terms 2, generic symptom words 1. */
const OBJECT = 3;
const TERM = 2;
const SYMPTOM = 1;

const kw = (
  label: string,
  pattern: string,
  specificity: KeywordSpecificity,
  weight: number,
): KeywordRule => ({ label, pattern, specificity, weight });

/**
 * Single source of truth for classification keywords/rules.
 *
 * Categories are scored by the summed weight of their matching keywords; the
 * highest score wins and rule order only breaks ties.
 */
const categoryRules: ReadonlyArray<CategoryRule> = [
  {
    category: 'Plumbing',
    keywords: [
      kw('tap', 'tap', 'substring', OBJECT),
      kw('pipe', 'pipe', 'substring', OBJECT),
      kw('toilet', 'toilet', 'substring', OBJECT),
      kw('sink', 'sink', 'substring', OBJECT),
      kw('basin', 'basin', 'substring', OBJECT),
      kw('shower', 'shower', 'substring', OBJECT),
      kw('geyser', 'geyser', 'substring', OBJECT),
      kw('drain', 'drain', 'substring', OBJECT),
      kw('sewage', 'sewage', 'substring', OBJECT),
      kw('sewer', 'sewer', 'substring', OBJECT),
      kw('plumbing', 'plumb', 'substring', OBJECT),
      kw('bath', '\\bbath\\b', 'word-boundary', TERM),
      kw('water pressure', 'water\\s+pressure', 'multi-word', TERM),
      kw('water tank', 'water\\s+tank', 'multi-word', TERM),
      kw('leak', 'leak', 'substring', SYMPTOM),
      kw('drip', 'drip', 'substring', SYMPTOM),
      kw('flood', 'flood', 'substring', SYMPTOM),
    ],
  },
  {
    category: 'Electrical',
    keywords: [
      kw('socket', 'socket', 'substring', OBJECT),
      kw('breaker', 'breaker', 'substring', OBJECT),
      kw('plug', 'plug', 'substring', OBJECT),
      kw('meter', 'meter', 'substring', OBJECT),
      kw('wiring', 'wiring', 'substring', OBJECT),
      kw('wire', 'wire', 'substring', OBJECT),
      kw('cable', 'cable', 'substring', OBJECT),
      kw('fuse', 'fuse', 'substring', OBJECT),
      kw('distribution board', 'distribution\\s+board', 'multi-word', OBJECT),
      kw('electricity', 'electricity', 'substring', TERM),
      kw('electric', 'electric', 'substring', TERM),
      kw('switch', 'switch', 'substring', TERM),
      kw('voltage', 'voltage', 'substring', TERM),
      kw('tripping', 'tripping', 'substring', TERM),
      kw('shock', 'shock', 'substring', TERM),
      kw('power', 'power', 'substring', SYMPTOM),
      kw('light', 'light', 'substring', SYMPTOM),
    ],
  },
  {
    category: 'Automotive',
    keywords: [
      kw('car', 'car', 'substring', OBJECT),
      kw('vehicle', 'vehicle', 'substring', OBJECT),
      kw('engine', 'engine', 'substring', OBJECT),
      kw('brake', 'brake', 'substring', OBJECT),
      kw('tyre', 'tyre', 'substring', OBJECT),
      kw('tire', 'tire', 'substring', OBJECT),
      kw('gearbox', 'gearbox', 'substring', OBJECT),
      kw('clutch', 'clutch', 'substring', OBJECT),
      kw('suspension', 'suspension', 'substring', OBJECT),
      kw('alternator', 'alternator', 'substring', OBJECT),
      kw('windscreen', 'windscreen', 'substring', OBJECT),
      kw('mechanic', 'mechanic', 'substring', OBJECT),
      kw('exhaust', 'exhaust', 'substring', OBJECT),
      kw('radiator', 'radiator', 'substring', OBJECT),
      kw('bonnet', 'bonnet', 'substring', OBJECT),
      kw('battery', 'battery', 'substring', TERM),
      kw('puncture', 'puncture', 'substring', TERM),
    ],
  },
  {
    category: 'Refrigeration',
    keywords: [
      kw('fridge', 'fridge', 'substring', OBJECT),
      kw('freezer', 'freezer', 'substring', OBJECT),
      kw('cooler', 'cooler', 'substring', OBJECT),
      kw('chiller', 'chiller', 'substring', OBJECT),
      kw('cold room', 'cold\\s+room', 'multi-word', OBJECT),
      kw('deep freeze', 'deep\\s+freeze', 'multi-word', OBJECT),
      kw('refrigeration', 'refrigeration', 'substring', OBJECT),
      kw('cold', '\\bcold\\b', 'word-boundary', SYMPTOM),
    ],
  },
  {
    category: 'Appliance Repair',
    keywords: [
      kw('washing machine', 'washing\\s+machine', 'multi-word', OBJECT),
      kw('microwave', 'microwave', 'substring', OBJECT),
      kw('oven', 'oven', 'substring', OBJECT),
      kw('stove', 'stove', 'substring', OBJECT),
      kw('dishwasher', 'dishwasher', 'substring', OBJECT),
      kw('kettle', 'kettle', 'substring', OBJECT),
      kw('iron', '\\biron\\b', 'word-boundary', OBJECT),
      kw('blender', 'blender', 'substring', OBJECT),
      kw('vacuum', 'vacuum', 'substring', OBJECT),
      kw('dryer', 'dryer', 'substring', OBJECT),
      kw('cooker', 'cooker', 'substring', OBJECT),
      kw('hob', '\\bhob\\b', 'word-boundary', OBJECT),
      kw('toaster', 'toaster', 'substring', OBJECT),
      kw('appliance', 'appliance', 'substring', OBJECT),
    ],
  },
  {
    category: 'HVAC',
    keywords: [
      kw('air conditioner', 'air\\s?condition', 'multi-word', OBJECT),
      kw('aircon', 'aircon', 'substring', OBJECT),
      kw('ac', '\\bac\\b', 'word-boundary', OBJECT),
      kw('thermostat', 'thermostat', 'substring', OBJECT),
      kw('duct', 'duct', 'substring', OBJECT),
      kw('split unit', 'split\\s+unit', 'multi-word', OBJECT),
      kw('extractor fan', 'extractor\\s+fan', 'multi-word', OBJECT),
      kw('hvac', 'hvac', 'substring', OBJECT),
      kw('heating', 'heating', 'substring', TERM),
      kw('ventilation', 'ventilation', 'substring', TERM),
    ],
  },
  {
    category: 'Electronics',
    keywords: [
      kw('television', 'television', 'substring', OBJECT),
      kw('tv', '\\btv\\b', 'word-boundary', OBJECT),
      kw('radio', 'radio', 'substring', OBJECT),
      kw('speaker', 'speaker', 'substring', OBJECT),
      kw('amplifier', 'amplifier', 'substring', OBJECT),
      kw('soundbar', 'soundbar', 'substring', OBJECT),
      kw('console', 'console', 'substring', OBJECT),
      kw('dvd', 'dvd', 'substring', OBJECT),
      kw('camera', 'camera', 'substring', OBJECT),
      kw('cctv', 'cctv', 'substring', OBJECT),
      kw('home theatre', 'home\\s+theatre', 'multi-word', OBJECT),
      kw('stereo', 'stereo', 'substring', OBJECT),
      kw('remote', 'remote', 'substring', TERM),
      kw('screen', 'screen', 'substring', SYMPTOM),
      kw('circuit', 'circuit', 'substring', TERM),
    ],
  },
  {
    category: 'ICT',
    keywords: [
      kw('laptop', 'laptop', 'substring', OBJECT),
      kw('computer', 'computer', 'substring', OBJECT),
      kw('desktop', 'desktop', 'substring', OBJECT),
      kw('wifi', 'wifi', 'substring', OBJECT),
      kw('router', 'router', 'substring', OBJECT),
      kw('printer', 'printer', 'substring', OBJECT),
      kw('network', 'network', 'substring', OBJECT),
      kw('software', 'software', 'substring', OBJECT),
      kw('email', 'email', 'substring', OBJECT),
      kw('internet', 'internet', 'substring', OBJECT),
      kw('server', '\\bserver\\b', 'word-boundary', OBJECT),
      kw('hard drive', 'hard\\s+drive', 'multi-word', OBJECT),
      kw('ict', '\\bict\\b', 'word-boundary', OBJECT),
      kw('phone', 'phone', 'substring', TERM),
      kw('virus', 'virus', 'substring', TERM),
      kw('browser', 'browser', 'substring', TERM),
    ],
  },
  {
    category: 'Handyman',
    keywords: [
      kw('door', 'door', 'substring', OBJECT),
      kw('paint', 'paint', 'substring', OBJECT),
      kw('tile', 'tile', 'substring', OBJECT),
      kw('plaster', 'plaster', 'substring', OBJECT),
      kw('drill', 'drill', 'substring', OBJECT),
      kw('shelf', 'shelf', 'substring', OBJECT),
      kw('cabinet', 'cabinet', 'substring', OBJECT),
      kw('furniture', 'furniture', 'substring', OBJECT),
      kw('wardrobe', 'wardrobe', 'substring', OBJECT),
      kw('curtain', 'curtain', 'substring', OBJECT),
      kw('fence', 'fence', 'substring', OBJECT),
      kw('gate', 'gate', 'substring', OBJECT),
      kw('burglar bar', 'burglar\\s+bar', 'multi-word', OBJECT),
      kw('hinge', 'hinge', 'substring', OBJECT),
      kw('roof', 'roof', 'substring', OBJECT),
      kw('welding', 'weld', 'substring', OBJECT),
      kw('assemble', 'assembl', 'substring', TERM),
      kw('mount', 'mount', 'substring', TERM),
    ],
  },
];

export interface ClassificationEvidence {
  category: TechnicianCategory | '';
  confidence: number;
  matchedKeywords: string[];
  alternatives: Array<{
    category: TechnicianCategory;
    confidence: number;
  }>;
}

/**
 * Compute keyword classification confidence for a single category.
 *
 * This is a deterministic heuristic based on keyword evidence.
 * It is NOT AI confidence, model confidence, or probability.
 *
 * Formula:
 *   confidence = matchRatio + specificityBonus - competitionPenalty
 *
 * Where:
 *   matchRatio = (matchedKeywords / totalKeywords) * 0.5
 *   specificityBonus = 0.2 (word-boundary) | 0.1 (multi-word) | 0.0 (substring)
 *   competitionPenalty = min(0.3, 0.1 * competingCategoryCount)
 */
function computeConfidence(
  matchedCount: number,
  totalCount: number,
  hasWordBoundary: boolean,
  hasMultiWord: boolean,
  competingCount: number,
): number {
  const matchRatio = totalCount > 0 ? (matchedCount / totalCount) * 0.5 : 0;
  const specificityBonus = hasWordBoundary ? 0.2 : hasMultiWord ? 0.1 : 0;
  const competitionPenalty = Math.min(0.3, 0.1 * competingCount);
  const raw = matchRatio + specificityBonus - competitionPenalty;
  return Math.max(0, Math.min(1, raw));
}

/** One category's evidence for a description. */
interface CategoryMatch {
  category: TechnicianCategory;
  matchedKeywords: string[];
  hasWordBoundary: boolean;
  hasMultiWord: boolean;
  score: number;
}

function matchCategories(text: string): CategoryMatch[] {
  const matches: CategoryMatch[] = [];

  for (const rule of categoryRules) {
    const matchedKeywords: string[] = [];
    let hasWordBoundary = false;
    let hasMultiWord = false;
    let score = 0;

    for (const keyword of rule.keywords) {
      const regex = new RegExp(keyword.pattern, 'i');
      if (!regex.test(text)) continue;
      matchedKeywords.push(keyword.label);
      score += keyword.weight ?? 1;
      if (keyword.specificity === 'word-boundary') hasWordBoundary = true;
      if (keyword.specificity === 'multi-word') hasMultiWord = true;
    }

    if (matchedKeywords.length > 0) {
      matches.push({
        category: rule.category,
        matchedKeywords,
        hasWordBoundary,
        hasMultiWord,
        score,
      });
    }
  }

  // Highest evidence wins; rule order breaks ties deterministically.
  return matches.sort((a, b) => b.score - a.score);
}

/**
 * Classify a fault description and return the winning canonical category.
 * Returns an empty string when no keyword matches; the UI treats that as
 * "no suggestion" and the customer picks a category manually.
 */
export function classifyFault(description: string): TechnicianCategory | '' {
  return classifyFaultWithEvidence(description).category;
}

/**
 * Classify a fault description and return full evidence including matched
 * keywords, competing categories, and confidence scores.
 *
 * The winner is the category with the greatest summed keyword weight;
 * confidence is reported alongside it but does not itself pick the winner.
 */
export function classifyFaultWithEvidence(
  description: string,
): ClassificationEvidence {
  const text = description.toLowerCase();
  const matches = matchCategories(text);

  if (matches.length === 0) {
    return {
      category: '',
      confidence: 0,
      matchedKeywords: [],
      alternatives: [],
    };
  }

  const [winner, ...rest] = matches;
  const confidence = computeConfidence(
    winner.matchedKeywords.length,
    categoryRules.find((r) => r.category === winner.category)!.keywords.length,
    winner.hasWordBoundary,
    winner.hasMultiWord,
    rest.length,
  );

  return {
    category: winner.category,
    confidence,
    matchedKeywords: winner.matchedKeywords,
    alternatives: rest.map((match) => ({
      category: match.category,
      confidence: computeConfidence(
        match.matchedKeywords.length,
        categoryRules.find((r) => r.category === match.category)!.keywords.length,
        match.hasWordBoundary,
        match.hasMultiWord,
        0,
      ),
    })),
  };
}
