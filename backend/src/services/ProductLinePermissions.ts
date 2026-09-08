// Shared by API authorization and the web client; the grant is scoped to one membership.
export function allowsAppStoreRelease(role?: string, appStoreRelease = false) {
  return role === 'admin' || role === 'product' || (role === 'developer' && appStoreRelease === true);
}
