import type { TechnicianCategory } from './categories';

/**
 * Transparent keyword-baseline fault classifier (V0.2).
 *
 * This is a deterministic keyword baseline, not a trained model. It returns a
 * canonical category suggestion that the user must confirm in the UI.
 *
 * The confidence score is a deterministic heuristic based on keyword evidence.
 * It is NOT AI confidence, model confidence, or probability. It answers:
 * "How strongly does the keyword evidence support this category assignment?"
 *
 * The scoring weights are prototype design values that require future validation
 * using real user descriptions.
 */

type KeywordSpecificity = 'word-boundary' | 'multi-word' | 'substring';

interface KeywordRule {
  /** Human-readable keyword label for evidence display. */
  label: string;
  /** Regex fragment used for matching. */
  pattern: string;
  /** Specificity level of this keyword. */
  specificity: KeywordSpecificity;
}

interface CategoryRule {
  category: TechnicianCategory;
  keywords: KeywordRule[];
}

/**
 * Single source of truth for classification keywords/rules.
 * Order matters: first-match-wins is preserved by this array order.
 */
const categoryRules: ReadonlyArray<CategoryRule> = [
  {
    category: 'Plumbing',
    keywords: [
      { label: 'leak', pattern: 'leak', specificity: 'substring' },
      { label: 'tap', pattern: 'tap', specificity: 'substring' },
      { label: 'pipe', pattern: 'pipe', specificity: 'substring' },
      { label: 'toilet', pattern: 'toilet', specificity: 'substring' },
      { label: 'drain', pattern: 'drain', specificity: 'substring' },
    ],
  },
  {
    category: 'Electrical',
    keywords: [
      { label: 'wire', pattern: 'wire', specificity: 'substring' },
      { label: 'socket', pattern: 'socket', specificity: 'substring' },
      { label: 'power', pattern: 'power', specificity: 'substring' },
      { label: 'light', pattern: 'light', specificity: 'substring' },
      { label: 'breaker', pattern: 'breaker', specificity: 'substring' },
      { label: 'electric', pattern: 'electric', specificity: 'substring' },
    ],
  },
  {
    category: 'Automotive',
    keywords: [
      { label: 'car', pattern: 'car', specificity: 'substring' },
      { label: 'engine', pattern: 'engine', specificity: 'substring' },
      { label: 'brake', pattern: 'brake', specificity: 'substring' },
      { label: 'tyre', pattern: 'tyre', specificity: 'substring' },
      { label: 'vehicle', pattern: 'vehicle', specificity: 'substring' },
      { label: 'mechanic', pattern: 'mechanic', specificity: 'substring' },
    ],
  },
  {
    category: 'Refrigeration',
    keywords: [
      { label: 'fridge', pattern: 'fridge', specificity: 'substring' },
      { label: 'freezer', pattern: 'freezer', specificity: 'substring' },
      { label: 'cooler', pattern: 'cooler', specificity: 'substring' },
    ],
  },
  {
    category: 'Appliance Repair',
    keywords: [
      { label: 'oven', pattern: 'oven', specificity: 'substring' },
      { label: 'stove', pattern: 'stove', specificity: 'substring' },
      { label: 'washing machine', pattern: 'washing\\s+machine', specificity: 'multi-word' },
      { label: 'appliance', pattern: 'appliance', specificity: 'substring' },
      { label: 'microwave', pattern: 'microwave', specificity: 'substring' },
    ],
  },
  {
    category: 'HVAC',
    keywords: [
      { label: 'ac', pattern: '\\bac\\b', specificity: 'word-boundary' },
      { label: 'air conditioner', pattern: 'air\\s?conditioner', specificity: 'multi-word' },
      { label: 'aircon', pattern: 'aircon', specificity: 'substring' },
      { label: 'heating', pattern: 'heating', specificity: 'substring' },
      { label: 'ventilation', pattern: 'ventilation', specificity: 'substring' },
      { label: 'hvac', pattern: 'hvac', specificity: 'substring' },
    ],
  },
  {
    category: 'Electronics',
    keywords: [
      { label: 'tv', pattern: '\\btv\\b', specificity: 'word-boundary' },
      { label: 'television', pattern: 'television', specificity: 'substring' },
      { label: 'radio', pattern: 'radio', specificity: 'substring' },
      { label: 'stereo', pattern: 'stereo', specificity: 'substring' },
      { label: 'circuit', pattern: 'circuit', specificity: 'substring' },
      { label: 'electronic', pattern: 'electronic', specificity: 'substring' },
    ],
  },
  {
    category: 'ICT',
    keywords: [
      { label: 'laptop', pattern: 'laptop', specificity: 'substring' },
      { label: 'computer', pattern: 'computer', specificity: 'substring' },
      { label: 'wifi', pattern: 'wifi', specificity: 'substring' },
      { label: 'network', pattern: 'network', specificity: 'substring' },
      { label: 'software', pattern: 'software', specificity: 'substring' },
      { label: 'phone', pattern: 'phone', specificity: 'substring' },
      { label: 'printer', pattern: 'printer', specificity: 'substring' },
      { label: 'ict', pattern: '\\bict\\b', specificity: 'word-boundary' },
    ],
  },
  {
    category: 'Handyman',
    keywords: [
      { label: 'door', pattern: 'door', specificity: 'substring' },
      { label: 'paint', pattern: 'paint', specificity: 'substring' },
      { label: 'tile', pattern: 'tile', specificity: 'substring' },
      { label: 'plaster', pattern: 'plaster', specificity: 'substring' },
      { label: 'drill', pattern: 'drill', specificity: 'substring' },
      { label: 'shelf', pattern: 'shelf', specificity: 'substring' },
      { label: 'cabinet', pattern: 'cabinet', specificity: 'substring' },
      { label: 'furniture', pattern: 'furniture', specificity: 'substring' },
    ],
  },
];

/**
 * Build a combined regex for a category rule by joining keyword patterns.
 * This preserves the exact existing regex behaviour.
 */
function buildCategoryRegex(rule: CategoryRule): RegExp {
  const pattern = rule.keywords.map((k) => k.pattern).join('|');
  return new RegExp(pattern, 'i');
}

// Pre-build regexes for backward-compatible classifyFault
const compiledRules = categoryRules.map((rule) => ({
  category: rule.category,
  regex: buildCategoryRegex(rule),
}));

/**
 * Classify a fault description using the existing first-match-wins behaviour.
 * Returns the canonical category or empty string if no match.
 */
export function classifyFault(description: string): TechnicianCategory | '' {
  const text = description.toLowerCase();
  for (const rule of compiledRules) {
    if (rule.regex.test(text)) return rule.category;
  }
  return '';
}

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
 *
 * The scoring weights are prototype design values that require future
 * validation using real user descriptions.
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

/**
 * Classify a fault description and return full evidence including
 * matched keywords, competing categories, and confidence scores.
 *
 * Preserves the existing first-match-wins category selection.
 * The winning category is determined by rule order, not by confidence.
 */
export function classifyFaultWithEvidence(description: string): ClassificationEvidence {
  const text = description.toLowerCase();

  // Collect matches for every category
  const allMatches: Array<{
    category: TechnicianCategory;
    matchedKeywords: string[];
    hasWordBoundary: boolean;
    hasMultiWord: boolean;
  }> = [];

  for (const rule of categoryRules) {
    const matchedKeywords: string[] = [];
    let hasWordBoundary = false;
    let hasMultiWord = false;

    for (const keyword of rule.keywords) {
      const regex = new RegExp(keyword.pattern, 'i');
      if (regex.test(text)) {
        matchedKeywords.push(keyword.label);
        if (keyword.specificity === 'word-boundary') hasWordBoundary = true;
        if (keyword.specificity === 'multi-word') hasMultiWord = true;
      }
    }

    if (matchedKeywords.length > 0) {
      allMatches.push({
        category: rule.category,
        matchedKeywords,
        hasWordBoundary,
        hasMultiWord,
      });
    }
  }

  // No match case
  if (allMatches.length === 0) {
    return {
      category: '',
      confidence: 0,
      matchedKeywords: [],
      alternatives: [],
    };
  }

  // First-match-wins: the winning category is the first in rule order
  const winner = allMatches[0];
  const competingCount = allMatches.length - 1;

  const confidence = computeConfidence(
    winner.matchedKeywords.length,
    categoryRules.find((r) => r.category === winner.category)!.keywords.length,
    winner.hasWordBoundary,
    winner.hasMultiWord,
    competingCount,
  );

  // Build alternatives (all other matching categories)
  const alternatives = allMatches.slice(1).map((match) => {
    const altConfidence = computeConfidence(
      match.matchedKeywords.length,
      categoryRules.find((r) => r.category === match.category)!.keywords.length,
      match.hasWordBoundary,
      match.hasMultiWord,
      0, // alternatives don't get competition penalty
    );
    return {
      category: match.category,
      confidence: altConfidence,
    };
  });

  return {
    category: winner.category,
    confidence,
    matchedKeywords: winner.matchedKeywords,
    alternatives,
  };
}
