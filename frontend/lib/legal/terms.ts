/**
 * Terms and Conditions content (Task 32).
 *
 * SINGLE SOURCE OF TRUTH for the /terms page, following the same pattern as
 * lib/privacy/notice.ts: the page renders from this module so the text cannot
 * drift between copies (there is only one copy).
 *
 * ---------------------------------------------------------------------------
 * Language rules applied throughout (deliberate, and reviewed)
 * ---------------------------------------------------------------------------
 *   * Only behaviour that actually exists in this codebase is described.
 *   * NO guarantee of technician availability, technician quality, completed
 *     work, payments, or dispute resolution — none of those capabilities is
 *     implemented (verified: no payment, escrow, or dispute code exists in
 *     backend/src; matching is best-effort dispatch to eligible technicians).
 *   * NO claim of legal compliance, regulatory registration, or executed
 *     agreements. None of those is established anywhere in this repository.
 *   * NO contact or reporting channel is named, because no verified channel
 *     exists — the gap is stated openly instead (see `report-misuse`).
 *   * This document is a DRAFT requiring legal review before production use.
 */
import type { NoticeSection } from '@/lib/privacy/notice';

/** Full terms sections, rendered in order on /terms. */
export const TERMS_SECTIONS: NoticeSection[] = [
  {
    id: 'purpose',
    heading: 'Purpose and scope',
    paragraphs: [
      'Umodzi Connect is an academic prototype that connects customers with local technicians in Kitwe and Ndola, Zambia. A customer describes a problem, and the platform dispatches the request to eligible technicians who may accept the work.',
      'These terms describe the service as it is built today. They cover customer accounts, technician accounts, service requests, technician matching, profiles, reviews, and account suspension. Anything not described here is not part of the service.',
    ],
  },
  {
    id: 'accounts',
    heading: 'Your account',
    items: [
      'To use the service you must register with your name, email address, and a password. You are responsible for keeping your password secret and for all activity under your account.',
      'You must provide accurate registration information. A technician must additionally choose a genuine service category and service area.',
      'Public registration creates customer or technician accounts only. Administrator accounts are provisioned separately and cannot be created through registration.',
      'You must not share your account, impersonate another person, or create an account for someone else without their knowledge.',
    ],
  },
  {
    id: 'requests-matching',
    heading: 'Service requests and technician matching',
    paragraphs: [
      'A service request consists of a written fault description of at least 8 characters, a service category, and a city. The platform checks that the request is valid and then dispatches it to technicians using the server-side matching engine.',
      'Matching is best-effort: the engine selects from technicians who are active, available, verified, and serve the request category and area. If no technician is eligible, the request is recorded as unmatched.',
      'Umodzi Connect does not guarantee that any technician will be available, that a request will be matched, that matched work will be completed, or any particular quality of workmanship. Arrangements for carrying out the work are made between the customer and the technician.',
    ],
  },
  {
    id: 'profiles-content',
    heading: 'Technician profiles and your content',
    paragraphs: [
      'A technician profile publicly displays the display name, service category, skills, service area, rating, number of completed jobs, verification badge, availability note, biography, and profile photo. By publishing this information you agree to it being visible to other users.',
      'Verification documents (for example identity documents) are different: they stay private and are visible only to you and to administrators reviewing a verification.',
      'You must only upload content you have the right to share, and it must be accurate. You must not upload unlawful, offensive, or misleading material.',
    ],
  },
  {
    id: 'reviews-conduct',
    heading: 'Ratings, reviews, and conduct',
    items: [
      'Customers may leave a star rating and a written comment about a completed service. Reviews must describe your genuine experience.',
      'You must not post false, misleading, or abusive reviews, and you must not attempt to manipulate ratings — your own or anyone else\u2019s.',
      'Treat other users with respect in all communication on the platform. Harassment, hate speech, threats, and spam are not acceptable.',
    ],
  },
  {
    id: 'misuse',
    heading: 'Prohibited misuse',
    items: [
      'Do not use the service for fraud, scams, impersonation, or any unlawful purpose.',
      'Do not attempt to gain unauthorised access to accounts, data, or the underlying systems, and do not interfere with the operation of the service.',
      'Do not misrepresent your identity, qualifications, or location.',
      'There is currently no dedicated abuse-reporting channel in the product. This is an identified gap that must be closed before launch; until then, misuse that comes to the project team\u2019s attention through the available project channels is handled under these terms.',
    ],
  },
  {
    id: 'suspension-termination',
    heading: 'Suspension and termination',
    paragraphs: [
      'Administrators may suspend or disable an account that breaches these terms or misuses the service. A suspended or disabled account cannot sign in until it is reactivated.',
      'You may permanently delete your own account at any time from your privacy settings by confirming with your password. Deletion removes your data rather than hiding it, with one narrow exception: minimised security and audit records (containing no name, email, request text, or document content) are kept so that a record of what happened to the account still exists.',
      'Deleting your account ends your use of the service. It does not undo actions already taken, such as verification decisions recorded while the account existed.',
    ],
  },
  {
    id: 'limitations',
    heading: 'Limitations, third parties, and availability',
    items: [
      'The service is a prototype provided as-is. No uptime, response-time, or availability commitment is made, and the service may be changed or taken down for maintenance at any time.',
      'No payments are processed through the platform. There is no escrow, no payment protection, and no dispute-resolution process. Any payment for work is a private matter between the customer and the technician.',
      'An SMS integration exists in the code but is inactive: no SMS is sent and no phone number is held for that purpose.',
      'Data is stored in a PostgreSQL database; where that database is physically hosted has not been established for this deployment. Browser push notifications, where enabled, are delivered through the push service operated by your browser vendor.',
      'To the extent permitted, the platform is not liable for work arranged between users, for unavailable or unmatched requests, or for loss arising from reliance on profiles, ratings, or matching results.',
    ],
  },
  {
    id: 'changes',
    heading: 'Changes to these terms',
    paragraphs: [
      'These terms may change as the service develops. The current version is always the one published on this page, with its version stamp and effective date below.',
      'There is currently no mechanism for notifying users of changes individually. You should check this page periodically. Continued use of the service after a change takes effect means you accept the updated terms.',
    ],
  },
  {
    id: 'status',
    heading: 'Status of this document',
    paragraphs: [
      'This is a draft prepared alongside the software. It is not a legal document, it has not been reviewed by a lawyer, and it does not claim that the system complies with any law.',
      'It must receive legal review — and the open items named above (abuse-reporting channel, notification of term changes, provider locations and agreements) must be resolved — before this system is used in a real deployment.',
    ],
  },
];

/** Flat document version stamp. Not a compliance claim. */
export const TERMS_VERSION = 'Draft 0.1 — prepared for Task 32 (academic prototype)';
