/** Grey placeholder blocks shown while the first status loads, shaped like the page they stand in for. */
export function Skeleton({ width, height = 14, className }: { width?: number | string; height?: number; className?: string }) {
  return <span className={`skeleton ${className ?? ""}`} style={{ width, height }} aria-hidden="true" />;
}

/** Stands in for the Overview page: header, identity card with four metrics, and the two summary cards. */
export function OverviewSkeleton() {
  return (
    <div className="skeleton-page" role="status" aria-label="Loading">
      <header className="page-header">
        <div className="stack-tight">
          <Skeleton width={120} height={22} />
          <Skeleton width={180} height={12} />
        </div>
      </header>
      <section className="card identity">
        <div className="identity-head">
          <Skeleton width={44} height={44} className="round" />
          <div className="identity-text stack-tight">
            <Skeleton width={90} height={16} />
            <Skeleton width={300} height={12} />
          </div>
        </div>
        <div className="metrics">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="metric stack-tight">
              <Skeleton width={70} height={11} />
              <Skeleton width={110} height={18} />
            </div>
          ))}
        </div>
      </section>
      <div className="grid-2">
        <section className="card stack-tight">
          <Skeleton width={56} height={30} />
          <Skeleton width={150} height={12} />
          <Skeleton width={100} height={11} />
        </section>
        <section className="card stack-tight">
          <Skeleton width={80} height={11} />
          <Skeleton width={140} height={30} />
          <Skeleton width={120} height={12} />
        </section>
      </div>
    </div>
  );
}
