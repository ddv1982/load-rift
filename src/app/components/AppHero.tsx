import appIconUrl from "../../assets/app-icon.svg";
import type { CollectionInfo } from "../../lib/loadrift/types";
import { formatCount } from "../utils";

interface AppHeroProps {
  collection: CollectionInfo | null;
  displayedTestStatus: string;
  displayedVerdict: string;
}

function AppIcon() {
  return <img className="app-icon" src={appIconUrl} alt="" aria-hidden="true" />;
}

export function AppHero({
  collection,
  displayedTestStatus,
  displayedVerdict,
}: AppHeroProps) {
  return (
    <header className="app-hero">
      <div className="app-hero-copy">
        <p className="eyebrow">Load Testing Workspace</p>
        <div className="app-title-row">
          <span className={`status-pill is-${displayedTestStatus}`}>
            {displayedTestStatus.replace("_", " ")}
          </span>
        </div>
        <div className="app-brand-row">
          <AppIcon />
          <h1>Load Rift</h1>
        </div>
        <p className="app-subtitle">
          {collection
            ? `${collection.name} is ready. Configure, run, and review without dashboard clutter.`
            : "Import a Postman collection, set runtime inputs, and run local k6 checks."}
        </p>
      </div>

      <dl className="overview-grid">
        <div className="overview-card">
          <dt>Collection</dt>
          <dd>{collection?.name ?? "No collection loaded"}</dd>
        </div>
        <div className="overview-card">
          <dt>Requests</dt>
          <dd>
            {collection ? formatCount("request", collection.requestCount) : "0 requests"}
          </dd>
        </div>
        <div className="overview-card">
          <dt>Variables</dt>
          <dd>
            {collection
              ? formatCount("variable", collection.runtimeVariables.length)
              : "0 variables"}
          </dd>
        </div>
        <div className="overview-card">
          <dt>Runner</dt>
          <dd>{displayedVerdict}</dd>
        </div>
      </dl>
    </header>
  );
}
