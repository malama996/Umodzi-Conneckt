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

export const SERVICE_AREAS = ['Kitwe', 'Ndola', 'Other'] as const;
export type ServiceArea = (typeof SERVICE_AREAS)[number];

export const AVAILABILITY_STATES = ['Available now', 'Available today', 'Unavailable'] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

export type AvailabilityStatus = 'available' | 'unavailable';

export type AccountStatus = 'active' | 'inactive' | 'suspended';

export interface Technician {
  id: string;
  name: string;
  category: SkillCategory;
  skills: string[];
  serviceArea: string;
  city: string;
  rating: number;
  jobs: number;
  verified: boolean;
  availability: string;
  availabilityStatus: AvailabilityStatus;
  accountStatus: AccountStatus;
  bio: string | null;
  hasPhoto: boolean;
  /**
   * Precise coordinates are deliberately not mapped to the public UI.
   * These fields exist only so tests can assert they are undefined.
   * The mapper intentionally drops any server-provided coordinates.
   */
  latitude?: undefined;
  longitude?: undefined;
}

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

export interface EligibleTechnicianResult {
  technician: Technician;
  matchedCategory: SkillCategory;
}

export type SmartDispatchStatus = 'matched' | 'no_match';

export interface SmartDispatchResult {
  requestId: string;
  status: SmartDispatchStatus;
  candidates: RankedTechnician[];
}

export type DispatchOfferStatus = 'pending' | 'accepted' | 'rejected' | 'timed_out';

export interface DispatchOffer {
  requestId: string;
  technicianId: string;
  candidateIndex: number;
  status: DispatchOfferStatus;
}

export type CascadingOfferStatus = 'offering' | 'accepted' | 'exhausted';

export interface CascadingOfferResult {
  status: CascadingOfferStatus;
  offer: DispatchOffer | null;
}

export type ServiceRequestStatus =
  'pending' | 'matching' | 'matched' | 'no_match' | 'in_progress' | 'completed' | 'cancelled';

export interface ServiceRequest {
  id: string;
  description: string;
  category: SkillCategory;
  city: string;
  status: ServiceRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceRequestCreateInput {
  description: string;
  category: SkillCategory;
  city: string;
  /**
   * Browser-generated idempotency key. The
   * SAME key submitted twice by the SAME customer returns the SAME request
   * (idempotent replay) instead of creating a duplicate — the backstop for
   * double taps and network retries. Optional; legacy calls omit it.
   */
  clientRequestId?: string;
}

export interface TechnicianProfileDraft {
  name: string;
  bio?: string;
  experienceYears?: number;
  serviceArea: ServiceArea;
  serviceRadiusKm: number;
  availability: AvailabilityState;
  skills: SkillCategory[];
  photoDataUrl?: string;
  verified: boolean;
  rating: number;
  jobs: number;
}

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

export interface TechnicianProfileEdit {
  name?: string;
  category?: SkillCategory;
  skills?: string[];
  availability?: string;
  notes?: string;
}

export interface DispatchScoreWeights {
  proximity: number;
  trust: number;
  availability: number;
  fairness: number;
}

export interface LandingPageConfig {
  hero: {
    title: string;
    description: string;
    backgroundImage: string;
    backgroundPosition: string;
    overlayOpacity: number;
  };
}
