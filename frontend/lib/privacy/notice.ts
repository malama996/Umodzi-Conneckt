/**
 * Privacy notice content (Task 28.3B).
 *
 * SINGLE SOURCE OF TRUTH. The registration disclosure and the full /privacy
 * page both render from this module, so the summary shown before someone
 * creates an account cannot drift away from the full notice.
 *
 * ---------------------------------------------------------------------------
 * Language rules applied throughout (deliberate, and reviewed)
 * ---------------------------------------------------------------------------
 *   * "designed to support", "implemented control", "identified requirement",
 *     "deployment requirement", "requires confirmation" — used deliberately.
 *   * NO claim of legal compliance, regulatory registration, a data
 *     protection officer, statutory certification, or an executed processor
 *     agreement. None of those is established anywhere in this repository.
 *   * Only behaviour that actually exists in this codebase is described. The
 *     provider locations, contractual bases and retention periods that are NOT
 *     yet settled are named as open items rather than stated as fact.
 */

export interface NoticeSection {
  id: string;
  heading: string;
  /** Prose paragraphs. Optional — a list-only section is valid. */
  paragraphs?: string[];
  /** Optional short list rendered under the paragraphs. */
  items?: string[];
}

/**
 * Short disclosure shown at registration. Deliberately concise — it states
 * what is collected and links to the full notice rather than duplicating it.
 */
export const REGISTRATION_NOTICE_POINTS: string[] = [
  'We store your name, email address and a securely hashed password to create and protect your account.',
  'If you register as a technician we also store your service category, service area and skills.',
  'Your service area (for example Kitwe or Ndola) is shown to other users. Your precise location is never published.',
  'Technicians may upload identity documents for verification. These are stored privately and are only visible to you and administrators.',
  'You can view a copy of your data, and permanently delete your account, at any time from your privacy settings.',
];

/** Full notice sections, rendered in order on /privacy. */
export const PRIVACY_NOTICE_SECTIONS: NoticeSection[] = [
  {
    id: 'who-we-are',
    heading: 'About this notice',
    paragraphs: [
      'Umodzi Connect is an academic prototype that connects customers with local technicians in Kitwe and Ndola, Zambia. This notice describes what the system actually does today, in plain language.',
      'It is written to be accurate and complete about the software. Where a decision still needs legal or organisational confirmation, that is said openly instead of being presented as settled.',
    ],
  },
  {
    id: 'what-we-collect',
    heading: 'What we collect',
    items: [
      'Account data — your full name, email address, and a password that is stored only as a strong one-way hash (Argon2id). We never store or log your actual password.',
      'Technician profile data — your display name, service category, skills, service area, availability, and any biography you write.',
      'Verification information — if you register as a technician you may upload identity documents (for example a national ID or a certificate). These are higher-risk data and are stored privately.',
      'Service request data — the description you write when you ask for a service, the category, and the city.',
      'Location information — the service area you choose. Precise coordinates are stored for the internal matching engine only and are never published through the public API (see "Your location" below).',
      'Dispatch and offer data — which technicians were matched to which request, in what order, and whether an offer was accepted, declined or timed out.',
      'Reviews and ratings — the star rating and comment a customer leaves for a completed service.',
      'Notifications — messages the system generates for you about your requests, offers and verification status.',
      'Push subscription data — if you allow browser notifications, the subscription details your browser provides so a message can reach your device.',
      'Security information — the security events recorded about your own account, such as a successful sign-in or a sign-in attempt that failed.',
      'Stored files — your profile photo, and any verification documents you upload.',
    ],
  },
  {
    id: 'required-optional',
    heading: 'What is required and what is optional',
    paragraphs: [
      'To create an account you must provide your name, email address and a password. Without these we cannot create or protect an account.',
      'If you register as a technician, a service category and service area are required so that customers can find you.',
      'Your biography, profile photo and verification documents are optional. Declining to provide them does not stop you using the service, although you will not appear as verified.',
      'Browser notifications are optional and can be turned off at any time. Declining does not affect the rest of the service.',
    ],
  },
  {
    id: 'location',
    heading: 'Your location',
    paragraphs: [
      'Precise coordinates are stored for technicians so that the matching engine can calculate distances and order nearby technicians. This is an internal, operational use.',
      'Precise coordinates are NOT published. The public API does not return a stored coordinate for any technician. Public information about a technician is limited to the service area they declared themselves.',
      'The distance shown by the "find nearby" search is rounded to the nearest 100 metres. It exists so you can judge roughly who is close by, and it does not reveal the exact position of any person.',
      'The system does not ask your browser for your GPS location and does not track you.',
    ],
  },
  {
    id: 'who-can-see',
    heading: 'Who can see your information',
    items: [
      'Publicly visible — the display name, service category, skills, service area, rating, number of completed jobs, verification badge, availability text and biography of a technician.',
      'Visible to the other party in a service — a customer and a technician can see the details of the request and offers connected to it, so the job can be arranged.',
      'Visible to you only — your sessions, your notification history, your verification documents, and your security event history.',
      'Visible to administrators — administrators can see account records (name, email, role, account status) and service requests, and can review technician verification. This privileged access is logged so it is accountable.',
      'Never disclosed — your password, the stored hash of your password, your session tokens, and the contents of your verification documents to anyone other than you and the administrators reviewing them.',
    ],
  },
  {
    id: 'documents',
    heading: 'Verification documents',
    paragraphs: [
      'Identity documents are the highest-risk data this system handles. They are stored privately and are never listed publicly or served directly from storage.',
      'They can be read only through a server route that checks who is asking: either you, for your own documents, or an administrator reviewing a pending verification. Any other request receives the same "not found" response as a document that does not exist, so the existence of a document is not disclosed to strangers.',
      'Replacing or withdrawing a document deletes the stored file. The responses are marked so browsers and intermediaries do not cache them.',
      'The system validates uploaded files: a size limit applies, the declared type is checked, and the actual file contents (magic bytes) are verified to match. Filenames supplied by you are sanitised before being used.',
    ],
  },
  {
    id: 'notifications',
    heading: 'Notifications, Web Push and SMS',
    paragraphs: [
      'Notifications are stored in the system so you have a history of messages about your requests, offers and verification status. You can read this history in the app and mark items as read.',
      'If you allow browser notifications, the system uses the Web Push standard. Your subscription is registered with the push service operated by your browser vendor, and message content is sent to that service to reach your device. Encryption is applied to that content.',
      'An SMS integration exists in the codebase but is not active. There is currently no place in the system where a phone number is stored, so no SMS is sent and no phone number is held. If that changes, this notice must be updated before it does.',
      'A request category suggestion feature exists. It is a deterministic keyword check running inside our own server. It is not an AI or machine-learning model, no data is sent to any external provider, and it only suggests a category — it never decides anything for you.',
    ],
  },
  {
    id: 'security',
    heading: 'How we protect your information',
    items: [
      'Passwords are stored as Argon2id hashes, never in readable form.',
      'Sessions use signed, short-lived access tokens, and refresh tokens are stored only as hashes in an HttpOnly cookie that scripts cannot read.',
      'If a refresh token is presented twice in a way that suggests theft, every session for that account is revoked immediately.',
      'Authorization is enforced on the server for every request. The interface cannot grant access the server would not.',
      'Sign-in attempts are rate limited, and a successful sign-in to an account that was suspended or disabled is refused.',
      'Uploads are restricted by size and validated by file content. Stored file references cannot be used to escape the storage area.',
      'Responses carry standard security headers, and access is limited to an explicit list of allowed web origins.',
      'Security-relevant events — sign-in successes and failures, administrator account changes, verification decisions, document access, and data exports or deletions — are recorded so they can be investigated. Those records deliberately contain no passwords, tokens, document contents or your personal details.',
      'The system does not store your IP address anywhere. It was deliberately left out of the security records rather than added as a matter of course.',
    ],
  },
  {
    id: 'retention',
    heading: 'How long we keep information',
    paragraphs: [
      'Some categories have a defined retention rule and are cleaned up automatically when an operator runs the documented cleanup process: expired sign-in sessions, and old notifications you have already read.',
      'For other categories — accounts, service requests, offers, reviews and verification documents — no retention period has been finalised. A documented proposal now exists, and each period in it is marked as requiring confirmation before it is treated as final. Until that confirmation happens, those records are retained for as long as the account exists.',
      'When you delete your account, your data is deleted rather than hidden. One narrow exception: security and audit events are kept in a minimised form (no name, email, request text or document content) so that a record of what happened to the account still exists.',
    ],
  },
  {
    id: 'rights',
    heading: 'Your rights and controls',
    items: [
      'See your data — you can request a complete copy of the information held about your account at any time, in a structured JSON format.',
      'Delete your account — you can permanently delete your account from your privacy settings. You must confirm with your password, and the action cannot be undone.',
      'Notifications — you can read your notification history, mark items as read, and turn off browser notifications.',
      'Verification documents — you can withdraw a document you have uploaded while your verification is still editable.',
      'Change your profile — you can edit your biography, skills and availability yourself.',
    ],
    paragraphs: [
      'Some outcomes are unavoidable and are described honestly above. If you delete your account, reviews that other customers wrote about your technician profile are removed with that profile, because a review cannot exist without the person or profile it describes. Your rating and completed-jobs totals also disappear.',
    ],
  },
  {
    id: 'providers',
    heading: 'External providers',
    paragraphs: [
      'The system stores its data in a PostgreSQL database. Where that database is physically hosted has not been established for this deployment, and no claim is made about its location.',
      'Browser push notifications are delivered through the push service operated by your browser vendor, which receives an encrypted message and a subscription identifier. That provider is outside our control.',
      'An SMS gateway integration exists in the code but is inactive and is not currently sending anything.',
      'There is no advertising, analytics or tracking provider integrated, and no third-party AI service is connected.',
      'A full register of providers, their status, and the points that still require confirmation is maintained separately and is reviewed before launch.',
    ],
  },
  {
    id: 'incidents',
    heading: 'If something goes wrong',
    paragraphs: [
      'Security-relevant events are recorded: sign-in successes and failures, administrator changes to an account, verification decisions, access to verification documents, data exports, and account deletions. These records do not contain passwords, tokens, document contents or your personal details.',
      'A written incident-response procedure — including who to notify, within what timeframe, and what evidence to preserve — has NOT yet been established. It is an identified requirement and is recorded as such. If you believe your account or data has been misused, contact the project team through the channel advertised on this site.',
    ],
  },
  {
    id: 'status',
    heading: 'Status of this notice and open items',
    paragraphs: [
      'This is an academic prototype being prepared for production readiness. This notice is not a legal document and does not claim that the system complies with any law.',
      'The following points require confirmation before this system is used in a real deployment: the lawful basis for each processing purpose; whether any registration with a supervisory authority is required; whether a data protection officer must be appointed; retention periods; provider locations and any agreements with them; and the incident-response procedure.',
    ],
    items: [
      'Contact and escalation route — a named contact point and an escalation path for complaints have not yet been established and must be added before launch. Until then, complaints should go to the project team through the channel advertised on this site.',
    ],
  },
];

/** Flat document version stamp. Not a compliance claim. */
export const PRIVACY_NOTICE_VERSION = 'Draft 0.3 — prepared for Task 28.3 (academic prototype)';
