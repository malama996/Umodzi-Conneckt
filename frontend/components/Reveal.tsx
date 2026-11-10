import { cloneElement, type CSSProperties, type ReactElement } from 'react';

export default function Reveal({
  children,
  as: Boundary = 'div',
  delay,
}: {
  children: ReactElement<{ className?: string }>;
  as?: 'div' | 'li';
  delay?: number;
}) {
  return (
    <Boundary
      className="reveal-boundary"
      style={
        delay === undefined ? undefined : ({ '--reveal-delay': `${delay}ms` } as CSSProperties)
      }
    >
      {cloneElement(children, {
        className: `${children.props.className ?? ''} reveal`.trim(),
      })}
    </Boundary>
  );
}
