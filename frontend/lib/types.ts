/**
 * Single source of truth for all Umodzi Connect domain types.
 * Mocks today, real Fastify API tomorrow must swap without breaking UI.
 */

// ---------------------------------------------------------------------------
// Canonical skill categories (FIXED list — 9 items)
// ---------------------------------------------------------------------------
export const SKILL_CATEGORIES = [
  'Plumbing',
  'Electrical',
  'Automotive',
  'HVAC',
  'Appliance Repair',
  'Refrigeration',
  'Electronics',
  'ICT',
  'Handyman',
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Service areas
// ---------------------------------------------------------------------------
export const SERVICE_AREAS = ['Kitwe', 'Ndola', 'Other'] as const;
export type ServiceArea = (typeof SERVICE_AREAS)[number];

// ---------------------------------------------------------------------------
// Availability states (display strings)
// ---------------------------------------------------------------------------
export const AVAILABILITY_STATES = ['Available now', 'Available today', 'Unavailable'] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

// ---------------------------------------------------------------------------
// Availability status (backend enum — used by dispatch/mapper)
// ---------------------------------------------------------------------------
export type AvailabilityStatus = 'available' | 'unavailable';

// ---------------------------------------------------------------------------
// Account status (backend enum — used by dispatch/mapper)
// ---------------------------------------------------------------------------
export type AccountStatus = 'active' | 'inactive' | 'suspended';

// ---------------------------------------------------------------------------
// Technician (read-only view shape — what the UI displays)
// ---------------------------------------------------------------------------
export interface Technician {
  id: string;
  name: string;
  category: SkillCategory;
  skills: string[];
  serviceArea: string;
  city: string; // derived from serviceArea in pilot data
  rating: number; // 0–5
  jobs: number;
  verified: boolean;
  availability: string; // display string e.g. "Available now"
  availabilityStatus: AvailabilityStatus;
  accountStatus: AccountStatus;
  bio: string | null;
  hasPhoto: boolean;
  /**
   * Task 28.3A.1 (G-01): precise coordinates are deliberately NOT mapped.
   * These fields exist only so tests can assert they are undefined.
   * The mapper intentionally drops any server-provided coordinates.
   */
  latitude?: undefined;
  longitude?: undefined;
}

// ---------------------------------------------------------------------------
// Ranked technician (dispatch scoring result)
// ---------------------------------------------------------------------------
export interface DispatchScoreBreakdown {
  proximity: number;
  trust: number;
  availability: number;
  fairness: number;
  finalScore: number;
}

export interface RankedTechnician {
  technician: Technician;
  matchedCategory: SkillCategory;
  score: DispatchScoreBreakdown;
}

// ---------------------------------------------------------------------------
// Eligible technician result (pre-ranking filter output)
// ---------------------------------------------------------------------------
export interface EligibleTechnicianResult {
  technician: Technician;
  matchedCategory: SkillCategory;
}

// ---------------------------------------------------------------------------
// Smart dispatch result
// ---------------------------------------------------------------------------
export type SmartDispatchStatus = 'matched' | 'no_match';

export interface SmartDispatchResult {
  requestId: string;
  status: SmartDispatchStatus;
  candidates: RankedTechnician[];
}

// ---------------------------------------------------------------------------
// Dispatch offer (cascading offer state)
// ---------------------------------------------------------------------------
export type DispatchOfferStatus = 'pending' | 'accepted' | 'rejected' | 'timed_out';

export interface DispatchOffer {
  requestId: string;
  technicianId: string;
  candidateIndex: number;
  status: DispatchOfferStatus;
}

// ---------------------------------------------------------------------------
// Cascading offer result
// ---------------------------------------------------------------------------
export type CascadingOfferStatus = 'offering' | 'accepted' | 'exhausted';

export interface CascadingOfferResult {
  status: CascadingOfferStatus;
  offer: DispatchOffer | null;
}

// ---------------------------------------------------------------------------
// Service request lifecycle statuses
// ---------------------------------------------------------------------------
export type ServiceRequestStatus =
  'pending' | 'matching' | 'matched' | 'no_match' | 'in_progress' | 'completed' | 'cancelled';

// ---------------------------------------------------------------------------
// Service request (core entity)
// ---------------------------------------------------------------------------
export interface ServiceRequest {
  id: string;
  description: string;
  category: SkillCategory;
  city: string;
  status: ServiceRequestStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Service request create input (client → API)
// ---------------------------------------------------------------------------
export interface ServiceRequestCreateInput {
  description: string;
  category: SkillCategory;
  city: string;
}

// ---------------------------------------------------------------------------
// Technician profile draft (editable fields — R-PROF-02)
// ---------------------------------------------------------------------------
export interface TechnicianProfileDraft {
  name: string;
  bio?: string;
  experienceYears?: number;
  serviceArea: ServiceArea;
  serviceRadiusKm: number; // 1–25
  availability: AvailabilityState;
  skills: SkillCategory[];
  photoDataUrl?: string; // compressed client-side, ≤150 KB
  verified: boolean;
  rating: number;
  jobs: number;
}

// ---------------------------------------------------------------------------
// Fault classification (R-CLASS-01 / R-CLASS-02)
// ---------------------------------------------------------------------------
export interface ClassificationRequest {
  description: string;
}

/** Keyword-fallback classification evidence (from lib/classification.ts). */
export type ClassificationMethod = 'mock-ai' | 'keyword-fallback' | 'keyword';

export interface ClassificationEvidence {
  category: SkillCategory | '';
  confidence: number;
  matchedKeywords: string[];
  alternatives: Array<{
    category: SkillCategory;
    confidence: number;
  }>;
}

/** Full classification result returned by the service layer. */
export interface ClassificationResult {
  category: SkillCategory | '';
  confidence: number;
  method: ClassificationMethod;
  latencyMs?: number;
  matchedKeywords?: string[];
  alternatives?: Array<{
    category: SkillCategory;
    confidence: number;
  }>;
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Technician profile edit (used by ProfileEditor + mock persistence)
// ---------------------------------------------------------------------------
export interface TechnicianProfileEdit {
  name?: string;
  category?: SkillCategory;
  skills?: string[];
  availability?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Dispatch scoring weights (V0.3 placeholder — typed now, unused this sprint)
// ---------------------------------------------------------------------------
export interface DispatchScoreWeights {
  proximity: number;
  trust: number;
  availability: number;
  fairness: number;
}

// ---------------------------------------------------------------------------
// Landing page config (preserved from existing lib/data.ts shape)
// ---------------------------------------------------------------------------
export interface LandingPageConfig {
  hero: {
    title: string;
    description: string;
    backgroundImage: string;
    backgroundPosition: string;
    overlayOpacity: number;
  };
}
