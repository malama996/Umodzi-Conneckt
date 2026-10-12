import { LuCircleCheck, LuClock } from 'react-icons/lu';
import { Badge } from '@/components/ui';
import type { TechnicianOfferView } from '@/lib/services/technicianOfferService';

interface TechnicianOfferCardProps {
  offer: TechnicianOfferView;
  onAccept: (offer: TechnicianOfferView) => void;
  onReject: (offer: TechnicianOfferView) => void;
}

/** Format an ISO timestamp for display. */
function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Technician offer card.
 *
 * Displays an existing ServiceRequest and DispatchOffer
 * exactly as provided by the technician offer service —
 * the card constructs no technician or request data.
 * Only fields that exist on the domain models are shown.
 */
export default function TechnicianOfferCard({
  offer,
  onAccept,
  onReject,
}: TechnicianOfferCardProps) {
  const { request } = offer;

  return (
    <article
      className="match-card technician-offer-card"
      aria-label={`Service request ${request.id}`}
    >
      <div className="avatar" aria-hidden="true">
        {request.category
          .split(' ')
          .map((word) => word[0])
          .join('')}
      </div>
      <div className="match-main">
        <div className="match-title">
          <div>
            <h3>{request.category}</h3>
            <p>{request.description}</p>
          </div>
          <Badge tone="warning">
            <LuClock size={10} aria-hidden="true" /> Awaiting your response
          </Badge>
        </div>
        <dl className="technician-offer-details">
          <div>
            <dt>Request</dt>
            <dd>{request.id}</dd>
          </div>
          <div>
            <dt>Customer location</dt>
            <dd>{request.city}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatCreatedAt(request.createdAt)}</dd>
          </div>
          <div>
            <dt>Offer status</dt>
            <dd>{offer.offer.status}</dd>
          </div>
          <div>
            <dt>Candidate position</dt>
            <dd>
              Candidate {offer.offer.candidateIndex + 1} of {offer.totalCandidates}
            </dd>
          </div>
        </dl>
      </div>
      <div className="match-action technician-offer-actions">
        <button
          type="button"
          className="button button-coral button-small"
          onClick={() => onAccept(offer)}
        >
          <LuCircleCheck size={12} className="ic" aria-hidden="true" />
          Accept Request
        </button>
        <button type="button" className="outline-button" onClick={() => onReject(offer)}>
          Reject
        </button>
      </div>
    </article>
  );
}
