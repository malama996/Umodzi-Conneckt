import Link from 'next/link';
import {
  LuArrowRight,
  LuArrowUpRight,
  LuDroplets,
  LuFan,
  LuMapPin,
  LuPlug,
  LuSearch,
  LuShieldCheck,
  LuSnowflake,
  LuSparkles,
  LuStar,
  LuWrench,
  LuZap,
} from 'react-icons/lu';
import { PublicFooter, PublicHeader, BrandAsset } from '@/components/ui';
import HomeAuthRedirect from '@/components/HomeAuthRedirect';
import { landingPageConfig, services } from '@/lib/data';

const serviceIcons = [
  <LuDroplets key="plumbing" aria-hidden="true" />,
  <LuZap key="electrical" aria-hidden="true" />,
  <LuWrench key="automotive" aria-hidden="true" />,
  <LuFan key="hvac" aria-hidden="true" />,
  <LuPlug key="appliance" aria-hidden="true" />,
  <LuSnowflake key="refrigeration" aria-hidden="true" />,
];

export default function Home() {
  const hero = landingPageConfig.hero;
  return (
    <>
      <HomeAuthRedirect />
      <PublicHeader />
      <main>
        <section
          className="hero theme-b-hero"
          style={{
            backgroundImage: `url(${hero.backgroundImage})`,
            backgroundPosition: hero.backgroundPosition,
          }}
        >
          <div className="hero-curve hero-curve-one" />
          <div className="hero-curve hero-curve-two" />
          <div className="hero-content">
            <div className="eyebrow">
              <i /> LOCAL SKILLS. REAL SOLUTIONS.
            </div>
            <h1>
              Local Skills.
              <br />
              <em>Real Solutions.</em>
            </h1>
            <p>Connect with verified technicians in Ndola and Kitwe. Fast. Safe. Reliable.</p>
            <div className="hero-trust-grid">
              <span>
                <LuShieldCheck aria-hidden="true" />
                <b>
                  Verified
                  <br />
                  Profiles
                </b>
              </span>
              <span>
                <LuSparkles aria-hidden="true" />
                <b>
                  Smart
                  <br />
                  Matching
                </b>
              </span>
              <span>
                <LuMapPin aria-hidden="true" />
                <b>
                  Live
                  <br />
                  Location
                </b>
              </span>
              <span>
                <LuStar aria-hidden="true" />
                <b>
                  Trusted
                  <br />
                  Reviews
                </b>
              </span>
            </div>
            <div className="hero-search">
              <span aria-hidden="true">
                <LuSearch />
              </span>
              <input
                aria-label="Search for a service"
                placeholder="Search for a service (e.g. electrician, plumber...)"
              />
              <Link href="/matching" className="search-button">
                Search
              </Link>
            </div>
            <div className="hero-actions">
              <Link href="/matching" className="button button-coral">
                Find a Technician <LuArrowRight size={14} aria-hidden="true" />
              </Link>
              <Link href="/register?role=technician" className="text-action">
                Become a Technician{' '}
                <span>
                  <LuArrowRight size={11} aria-hidden="true" />
                </span>
              </Link>
            </div>
          </div>
          <div className="hero-location-card">
            <span className="hero-location-pin">
              <LuMapPin aria-hidden="true" />
            </span>
            <div>
              <strong>Ndola · Kitwe</strong>
              <small>Starting service areas</small>
            </div>
          </div>
          <div className="hero-bottom">
            <span>BUILT FOR LOCAL COMMUNITIES</span>
            <span>
              NDOLA <i /> KITWE <i /> ZAMBIA
            </span>
          </div>
        </section>

        <section className="section white" id="services">
          <div className="section-head">
            <div>
              <div className="eyebrow eyebrow-dark">POPULAR SERVICES</div>
              <h2>
                Find the right skill
                <br />
                for the job.
              </h2>
            </div>
            <p>
              Start with a service category or describe the problem and let Umodzi Connect assist
              with classification.
            </p>
          </div>
          <div className="service-grid">
            {services.slice(0, 6).map((service, i) => (
              <Link
                className="service-card"
                href={`/matching?service=${encodeURIComponent(service)}`}
                key={service}
              >
                <span className="service-icon">{serviceIcons[i]}</span>
                <span>
                  <b>{service}</b>
                  <small>Find local specialists</small>
                </span>
                <span className="arrow">
                  <LuArrowUpRight aria-hidden="true" />
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="section dark-section" id="how">
          <div className="eyebrow">HOW IT WORKS</div>
          <h2 className="light-heading">
            From problem to
            <br />
            <em>peace of mind.</em>
          </h2>
          <div className="steps">
            {[
              [
                '01',
                'Describe the job',
                'Tell us what is wrong, select the service area and confirm the suggested category.',
                '/illustrations/service-request.svg',
                'Illustration: a customer completes a service request on a phone',
              ],
              [
                '02',
                'Match local skills',
                'Compare technicians by relevant skills, service area, availability and trust signals.',
                '/illustrations/smart-dispatch.svg',
                'Illustration: a service request routed through Smart Dispatch to ranked technician candidates',
              ],
              [
                '03',
                'Connect and complete',
                'Review the match, send a request and track the service through completion.',
                '/illustrations/technician-offers.svg',
                'Illustration: a technician receives and responds to a service offer on a phone',
              ],
            ].map(([n, t, d, art, artAlt]) => (
              <article key={n}>
                <span>{n}</span>
                <h3>{t}</h3>
                <p>{d}</p>
                <BrandAsset className="step-art" src={art} alt={artAlt} width={640} height={480} />
              </article>
            ))}
          </div>
        </section>

        <section className="section white" id="technicians">
          <div className="section-head">
            <div>
              <div className="eyebrow eyebrow-dark">FEATURED TECHNICIANS</div>
              <h2>
                Skills in your
                <br />
                community.
              </h2>
            </div>
            <Link href="/matching" className="section-link">
              Browse all technicians <LuArrowRight size={12} className="ic" aria-hidden="true" />
            </Link>
          </div>
          <p className="form-note">
            Technician availability is shown from live platform records after you sign in. We do not
            display demo profiles or browser-stored availability on the public site.
          </p>
        </section>

        <section className="section split-section" id="about">
          <div>
            <div className="eyebrow eyebrow-dark">WHY UMODZI CONNECT</div>
            <h2>
              Good work builds
              <br />
              <em>stronger communities.</em>
            </h2>
            <BrandAsset
              className="about-wordmark"
              src="/branding/umodzi-connect-wordmark.svg"
              alt="Umodzi Connect"
              width={414}
              height={86}
            />
            <BrandAsset
              className="split-art"
              src="/illustrations/trust-reviews.svg"
              alt="Illustration: a verified technician profile with ratings and customer reviews"
              width={640}
              height={480}
            />
          </div>
          <div className="principles">
            <p>
              Umodzi Connect makes technician discovery clearer, more accessible and more
              accountable while keeping the final decision with the user.
            </p>
            <div>
              <b>01 / Trust with transparency</b>
              <span>
                Verification, ratings and completed-job signals are visible as part of the decision
                context.
              </span>
            </div>
            <div>
              <b>02 / Local by nature</b>
              <span>
                The initial service areas are Kitwe and Ndola, aligned with the study scope.
              </span>
            </div>
            <div>
              <b>03 / Built for low-data use</b>
              <span>
                Responsive pages, restrained imagery and lightweight interaction support constrained
                connections.
              </span>
            </div>
          </div>
        </section>

        <section className="city-band">
          <div className="city-band-overlay">
            <div>
              <div className="eyebrow">SERVICE AREAS</div>
              <h2 className="light-heading">
                Local support starts
                <br />
                <em>where you are.</em>
              </h2>
              <p>
                Umodzi Connect begins with selected urban service areas in Zambia, starting with
                Ndola and Kitwe.
              </p>
            </div>
            <div className="city-pills">
              <span>
                <LuMapPin size={11} className="ic" aria-hidden="true" /> Ndola
              </span>
              <span>
                <LuMapPin size={11} className="ic" aria-hidden="true" /> Kitwe
              </span>
            </div>
          </div>
        </section>
        <section className="cta-band">
          <div>
            <div className="eyebrow">READY TO START?</div>
            <h2 className="light-heading">Tell us what needs fixing.</h2>
          </div>
          <Link href="/matching" className="button button-coral">
            Request a Technician <LuArrowRight size={14} aria-hidden="true" />
          </Link>
        </section>
      </main>
      <PublicFooter />
    </>
  );
}
