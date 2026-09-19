import type { FloorInfo } from '@shared/types';
import type { FloorAdapter, SiteAdapter } from './types';
import { dmmSite } from './dmm';
import { dlsiteSite } from './dlsite';

/** サイトを増やすときはここに足すだけでUIとIPCに載る */
export const SITES: SiteAdapter[] = [dmmSite, dlsiteSite];

export function getSite(siteId: string): SiteAdapter {
  const site = SITES.find((s) => s.siteId === siteId);
  if (!site) throw new Error(`unknown site: ${siteId}`);
  return site;
}

export function getFloor(floorKey: string): { site: SiteAdapter; floor: FloorAdapter } {
  const [siteId, floorId] = floorKey.split(':');
  const site = getSite(siteId);
  const floor = site.floors.find((f) => f.floorId === floorId);
  if (!floor) throw new Error(`unknown floor: ${floorKey}`);
  return { site, floor };
}

export function listFloors(loggedInSites: Set<string>): FloorInfo[] {
  return SITES.flatMap((site) =>
    site.floors.map((floor) => ({
      key: `${site.siteId}:${floor.floorId}`,
      siteId: site.siteId as FloorInfo['siteId'],
      floorId: floor.floorId,
      label: floor.label,
      enabled: loggedInSites.has(site.siteId)
    }))
  );
}
