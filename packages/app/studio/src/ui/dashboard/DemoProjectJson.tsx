// Same-origin path, proxied to https://api.opendaw.studio/music/ (see nginx.conf.template and
// vite.config.ts's dev proxy) so the browser's COEP/CORS checks see a same-origin request instead
// of hitting api.opendaw.studio's origin allowlist, which doesn't include this fork's domain.
export const OpenDawMusicProxyPath = "/proxy/opendaw-music"

export type DemoProjectJson = {
    metadata: {
        name: string
        artist: string
        description: string
        tags: Array<string>
        created: string
        modified: string
        coverMimeType?: string
    }
    hasCover: boolean
    id: string
    bundleSize: number
}