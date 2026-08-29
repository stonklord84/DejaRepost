/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

/** The current counter state for this post. */
export type GetCounterRsp = {count: number}

/** Increment the post counter by a signed amount. */
export type IncCounterReq = {amount: number}
export type IncCounterRsp = {count: number}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  GetCounter: 'api/counter',
  IncCounter: 'api/counter/inc',
  OnMenuNewPost: 'internal/on/menu/new-post',
  OnPostSubmit: 'internal/on-post-submit',
  OnAppInstall: 'internal/on-app-install',
  SeedFingerprints: 'internal/scheduler/seed-fingerprints',
  OnModAction: 'internal/on-mod-action'
  
} as const

export const EndpointMethod = {
  [Endpoint.GetCounter]: 'GET',
  [Endpoint.IncCounter]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
  [Endpoint.OnPostSubmit]: 'POST',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.SeedFingerprints]: 'POST',
  [Endpoint.OnModAction]: 'POST'
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
