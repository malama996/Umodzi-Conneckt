import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicHeader, PublicFooter } from '@/components/ui';
import { TERMS_SECTIONS, TERMS_VERSION } from '@/lib/legal/terms';

/**
 * Public Terms and Conditions (Task 32).
 *
 * Same conventions as the /privacy notice page: server-rendered with no
 * client-side data fetching, content from a single-source module
 * (`lib/legal/terms.ts`), breadcrumb + table of contents for small screens
 * and keyboard users, shared PublicHeader/PublicFooter, existing
 * `.privacy-*` styles (the two documents share one visual language).
 *
 * The text is a DRAFT: it describes only behaviour verified in the codebase
 * and states plainly that legal review is still required.
 */
export const metadata: Metadata = {
  title: 'Terms and Conditions | Umodzi Connect',
  description:
    'The draft Terms and Conditions for Umodzi Connect — written for an academic prototype.',
};

export default function TermsPage() {
  return (
    <>
      <PublicHeader />
      <main className="privacy-page">
        <div className="privacy-shell">
          <nav className="privacy-breadcrumb" aria-label="Breadcrumb">
            <Link href="/">Home</Link>
            <span aria-hidden="true"> / </span>
            <span aria-current="page">Terms and Conditions</span>
          </nav>

          <header className="privacy-header">
            <div className="eyebrow eyebrow-dark">THE RULES</div>
            <h1>Terms and Conditions</h1>
            <p className="privacy-lede">
              The rules for using Umodzi Connect, written to describe the service as it is built
              today — including what the platform does not promise.
            </p>
            <p className="legal-draft" role="note">
              Draft — this document has not been reviewed by a lawyer and must receive legal review
              before production use.
            </p>
            <p className="privacy-version">{TERMS_VERSION}</p>
          </header>

          <div className="privacy-body">
            <nav className="privacy-toc" aria-label="On this page">
              <h2>On this page</h2>
              <ol>
                {TERMS_SECTIONS.map((section) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`}>{section.heading}</a>
                  </li>
                ))}
              </ol>
            </nav>

            <div className="privacy-content">
              {TERMS_SECTIONS.map((section) => (
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
                  Registration asks you to agree to these terms and confirm you have read the
                  privacy notice.
                </p>
                <div className="privacy-cta-actions">
                  <Link href="/register" className="button button-coral">
                    Create an account
                  </Link>
                  <Link href="/privacy" className="outline-button">
                    Read the privacy notice
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
