import { applicationService } from './ApplicationService';
import { currentApplication, currentApplicationPlatform, currentProductLineId } from './ProductLineContext';
import { ApplicationServiceId, hasApplicationServices, selectedServices } from './ApplicationServiceCatalog';

export class ApplicationServiceUnavailableError extends Error {}
export function currentServiceApplication() {
  const app = currentApplication();
  // Re-read selection so revocation also applies to pending AI actions and long requests.
  return app ? applicationService.get(app.id, app.productLineId) || app : undefined;
}
export function hasCurrentApplicationServices(...ids: ApplicationServiceId[]) {
  const app = currentServiceApplication();
  return app?.active !== false && hasApplicationServices(app, ids);
}
export function assertApplicationServices(...ids: ApplicationServiceId[]) {
  if (!hasCurrentApplicationServices(...ids)) throw new ApplicationServiceUnavailableError(`当前应用未启用所需服务：${ids.join('、')}，请在“应用接入”中选配`);
}
export function applicationServiceStatus() {
  const app = currentServiceApplication();
  return { platform: currentApplicationPlatform(), productLineId: currentProductLineId(), services: selectedServices(app), serviceOptions: app?.serviceOptions || {} };
}
