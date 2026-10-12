import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicHeader, PublicFooter } from '@/components/ui';
import { PRIVACY_NOTICE_SECTIONS, PRIVACY_NOTICE_VERSION } from '@/lib/privacy/notice';

/**
 * Public privacy notice (Task 28.3B).
 *
 * Rendered on the server with no client-side data fetching, so it stays
 * low-data and is readable with JavaScript unavailable. The text comes from
 * `lib/privacy/notice.ts`, the same module the registration disclosure uses,
 * so the summary and the full notice cannot drift apart.
 *
 * A table of contents links to each section so a long notice stays navigable
 * on a small screen and by keyboard.
 */
export const metadata: Metadata = {
  title: 'Privacy notice | Umodzi Connect',
  description:
    'How Umodzi Connect collects, uses, protects and deletes your personal data — written for an academic prototype.',
};

export default function PrivacyPage() {
  return (
    <>
      <PublicHeader />
      <main className="privacy-page">
        <div className="privacy-shell">
          <nav className="privacy-breadcrumb" aria-label="Breadcrumb">
            <Link href="/">Home</Link>
            <span aria-hidden="true"> / </span>
            <span aria-current="page">Privacy notice</span>
          </nav>

          <header className="privacy-header">
            <div className="eyebrow eyebrow-dark">YOUR DATA</div>
            <h1>Privacy notice</h1>
            <p className="privacy-lede">
              This notice explains what Umodzi Connect actually does with your information. It
              describes the software as it is built today, and is honest about the decisions that
              are still open.
            </p>
            <p className="privacy-version">{PRIVACY_NOTICE_VERSION}</p>
          </header>

          <div className="privacy-body">
            <nav className="privacy-toc" aria-label="On this page">
              <h2>On this page</h2>
              <ol>
                {PRIVACY_NOTICE_SECTIONS.map((section) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`}>{section.heading}</a>
                  </li>
                ))}
              </ol>
            </nav>

            <div className="privacy-content">
              {PRIVACY_NOTICE_SECTIONS.map((section) => (
                <section key={section.id} id={section.id} className="privacy-section">
                  <h2>{section.heading}</h2>
                  {section.paragraphs?.map((paragraph) => (
                    <p key={paragraph.slice(0, 48)}>{paragraph}</p>
                  ))}
                  {section.items && (
                    <ul>
                      {section.items.map((item) => (
                        <li key={item.slice(0, 48)}>{item}</li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}

              <section className="privacy-cta">
                <h2>Ready to create an account?</h2>
                <p>
                  You can create an account and, once signed in, view a copy of your data or delete
                  your account permanently.
                </p>
                <div className="privacy-cta-actions">
                  <Link href="/register" className="button button-coral">
                    Create an account
                  </Link>
                  <Link href="/login" className="outline-button">
                    Sign in
                  </Link>
                </div>
              </section>
            </div>
          </div>
        </div>
      </main>
      <PublicFooter />
    </>
  );
}
