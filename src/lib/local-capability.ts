const STORAGE_KEY = 'feishu-pet-local-capability'

export function getLocalCapability() {
  const fromUrl = new URLSearchParams(window.location.search).get('cap') || ''
  if (fromUrl) {
    sessionStorage.setItem(STORAGE_KEY, fromUrl)
    return fromUrl
  }
  return sessionStorage.getItem(STORAGE_KEY) || ''
}

export function withLocalCapability(url: string) {
  const capability = getLocalCapability()
  if (!capability) return url
  const parsed = new URL(url, window.location.href)
  parsed.searchParams.set('cap', capability)
  return parsed.toString()
}

export function addLocalCapability(headers?: HeadersInit) {
  const result = new Headers(headers)
  const capability = getLocalCapability()
  if (capability) result.set('X-Feishu-Pet-Capability', capability)
  return result
}
