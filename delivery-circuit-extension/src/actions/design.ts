// The Confluence design page of a Feature (no vscode import). The project module fills Feature.design from Jira and
// Confluence; the feature's confluence link is the fallback.
import type { DeepLink, Feature } from "../core/contracts";

/** https link of the feature's Confluence design page, if the project module knows it. */
export function designPageOf(f: Feature | undefined): string | undefined {
  if (!f) return undefined;
  const d = f.design;
  if (d && typeof d.url === "string" && /^https:\/\/[^\s]+$/.test(d.url)) return d.url;
  const l = (f.links ?? []).find((x: DeepLink) => x.kind === "confluence" && /^https:\/\//.test(x.target));
  return l?.target;
}
